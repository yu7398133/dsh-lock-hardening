/**
 * lock-sweeper -- reclaim DSH writer locks whose owning process is gone.
 *
 * WHY
 * @deepseek-ai/dsh-atomic-write mints "<file>.lock" holding the writer's PID and
 * releases it only from a finally block. Any abrupt end (Ctrl-C, a parent
 * killing the process group, a closed terminal, OOM, power loss) skips that
 * block and orphans the lock. The stock contender refuses to reclaim it -- its
 * comment calls orphan recovery "an operator action" -- but dsh ships no such
 * action, so one interrupted plugin install wedges the file permanently. On
 * this host a single cancelled install at 2026-09-19 23:34 left
 * profiles/web/package.json.lock behind and broke every plugin install and
 * update for ~15 hours, across two dsh restarts.
 *
 * This plugin is the automatic recovery layer for the paths the in-place
 * native patch does not cover -- settings.yaml, credentials, llm state -- and
 * for any future dsh upgrade that replaces node_modules and drops that patch.
 * It does NOT prevent orphans; it only makes them self-healing.
 *
 * WHAT IT WILL AND WILL NOT TOUCH
 * A file is reclaimed only when all of these hold:
 *   - its name ends in ".lock";
 *   - its ENTIRE content is a bare decimal PID (whitespace allowed);
 *   - that PID no longer exists on this host (kill(pid, 0) -> ESRCH).
 * Anything else is left strictly alone, which matters in practice:
 *   - task-board/ledger-v2.lock holds JSON ({"pid":...,"token":...}) and is
 *     routinely held by a LIVE process -- never matched;
 *   - session.lock files are empty markers -- never matched;
 *   - a lock whose owner is alive, or owned by another user (EPERM), is kept.
 * Before unlinking, the file is re-read and its identity (inode) and content
 * are compared with the inspected copy, so a lock that was released and
 * re-minted in between is not deleted.
 *
 * CAVEAT: the liveness probe is same-host by construction. Do not point this at
 * a profile directory on shared storage (NFS/SMB) where another host may hold
 * the lock; use "extraRoots" only for local paths.
 *
 * Config (all optional, set on this row in cordis.patch.yml):
 *   enabled          default true
 *   intervalSeconds  default 60   (0 disables the periodic sweep)
 *   maxDepth         default 1    (directory depth walked under each root)
 *   dryRun           default false (report without deleting)
 *   extraRoots       default []   (additional absolute local directories)
 */
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'lock-sweeper'

const DEFAULTS = { enabled: true, intervalSeconds: 60, maxDepth: 1, dryRun: false, extraRoots: [] }
const SKIP_DIRS = new Set(['node_modules', '.git', 'cache'])
const BARE_PID = /^[0-9]+$/

function readConfig(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: value.enabled !== false,
    intervalSeconds: Number.isFinite(value.intervalSeconds) ? Number(value.intervalSeconds) : DEFAULTS.intervalSeconds,
    maxDepth: Number.isInteger(value.maxDepth) && value.maxDepth >= 0 ? value.maxDepth : DEFAULTS.maxDepth,
    dryRun: value.dryRun === true,
    extraRoots: Array.isArray(value.extraRoots) ? value.extraRoots.filter(function (p) { return typeof p === 'string' && p !== '' }) : [],
  }
}

function dshHome() {
  const raw = process.env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return join(homedir(), '.dsh')
}

/** The PID a lock records, or undefined when the file is not a bare-PID lock. */
function recordedPid(text) {
  const trimmed = String(text).trim()
  if (!BARE_PID.test(trimmed)) return undefined
  const pid = Number.parseInt(trimmed, 10)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/** True when the PID exists on this host (EPERM counts as alive). */
function alive(pid) {
  if (pid === process.pid) return true
  try { process.kill(pid, 0); return true }
  catch (error) { return !(error && error.code === 'ESRCH') }
}

/** Directories to scan: the harness home plus every profile root. */
function rootsFor(config) {
  const home = dshHome()
  const roots = []
  if (existsSync(home)) roots.push(home)
  const profiles = join(home, 'profiles')
  if (existsSync(profiles)) {
    roots.push(profiles)
    try {
      for (const entry of readdirSync(profiles, { withFileTypes: true })) {
        if (entry.isDirectory()) roots.push(join(profiles, entry.name))
      }
    } catch { /* unreadable profiles dir: keep the two roots we have */ }
  }
  for (const extra of config.extraRoots) if (existsSync(extra)) roots.push(extra)
  return [...new Set(roots)]
}

/** Every "<...>.lock" file at or below root, bounded by maxDepth. */
async function lockFilesUnder(root, maxDepth) {
  const out = []
  const walk = async (dir, depth) => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) await walk(path, depth + 1)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.lock')) out.push(path)
    }
  }
  await walk(root, 0)
  return out
}

/** One pass. Never throws: the caller keeps the host alive regardless. */
async function sweepOnce(config, logger) {
  const summary = { at: new Date().toISOString(), scanned: 0, reclaimed: [], kept: [], errors: [] }
  const seen = new Set()
  for (const root of rootsFor(config)) {
    for (const path of await lockFilesUnder(root, config.maxDepth)) {
      if (seen.has(path)) continue
      seen.add(path)
      summary.scanned += 1
      try {
        const before = await stat(path)
        const pid = recordedPid(await readFile(path, 'utf8'))
        if (pid === undefined) { summary.kept.push({ path, reason: 'not-a-bare-pid' }); continue }
        if (alive(pid)) { summary.kept.push({ path, reason: 'owner-alive', pid }); continue }
        // Re-read: only delete the exact file we judged, so a lock released and
        // re-minted in between is never removed.
        const after = await stat(path)
        const recheck = await readFile(path, 'utf8')
        if (after.ino !== before.ino || recordedPid(recheck) !== pid) {
          summary.kept.push({ path, reason: 'changed-during-check', pid })
          continue
        }
        if (!config.dryRun) await rm(path, { force: true })
        summary.reclaimed.push({ path, pid, dryRun: config.dryRun })
        if (logger && typeof logger.warn === 'function') {
          logger.warn('lock-sweeper: reclaimed stale lock ' + path + ' (owner pid ' + pid + ' is gone)')
        }
      } catch (error) {
        summary.errors.push({ path, error: String(error && error.message) })
      }
    }
  }
  summary.kept = summary.kept.slice(0, 50)
  summary.errors = summary.errors.slice(0, 20)
  return summary
}

async function writeStatus(summary) {
  const dir = join(dshHome(), 'lock-sweeper')
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'status.json'), JSON.stringify(summary, null, 2) + '\n')
  } catch { /* status is observability only; never let it break the sweep */ }
}

export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  let stopped = false
  let timer

  const run = async (trigger) => {
    if (stopped) return
    try {
      const summary = await sweepOnce(config, ctx && ctx.logger)
      summary.trigger = trigger
      await writeStatus(summary)
      if (summary.reclaimed.length > 0 && ctx && ctx.logger && typeof ctx.logger.info === 'function') {
        ctx.logger.info('lock-sweeper: reclaimed ' + summary.reclaimed.length + ' stale lock(s); see status.json')
      }
    } catch (error) {
      if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('lock-sweeper: sweep failed: ' + String(error && error.message))
      }
    }
  }

  const stop = () => {
    stopped = true
    if (timer !== undefined) clearInterval(timer)
  }

  if (!config.enabled) {
    if (ctx && ctx.effect) ctx.effect(() => stop)
    return
  }

  // Sweep once at mount, before any plugin operation can contend on an orphan,
  // then keep watching: the orphan that caused this plugin's existence was
  // created by a CLI process killed while the host was up.
  void run('startup')
  if (config.intervalSeconds > 0) {
    timer = setInterval(() => { void run('interval') }, config.intervalSeconds * 1000)
    if (typeof timer.unref === 'function') timer.unref()
  }
  if (ctx && ctx.effect) ctx.effect(() => stop)
}
