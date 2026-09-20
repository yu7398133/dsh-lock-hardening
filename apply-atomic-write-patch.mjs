#!/usr/bin/env node
/**
 * Re-apply the "dead-owner reclaim" hardening to @deepseek-ai/dsh-atomic-write.
 *
 * WHY THIS EXISTS
 * withFileLock mints <file>.lock (holding the writer's PID) and releases it only
 * from a finally block. Any abrupt end -- Ctrl-C (SIGINT), a parent killing the
 * process group (SIGTERM), a closed terminal (SIGHUP), OOM or power loss
 * (SIGKILL) -- skips that block and orphans the lock. The stock contender never
 * reclaims it: its own comment says "orphan recovery is an operator action", but
 * no such action ships in dsh, so the lock wedges the file forever.
 *
 * Observed on this host: 2026-09-19 23:34 a cancelled plugin install orphaned
 * profiles/web/package.json.lock; every plugin install and update then failed
 * for ~15 hours, through two dsh restarts, until the file was deleted by hand.
 *
 * WHAT IT CHANGES (one behaviour, ~20 lines)
 * On contention, read the lock's PID and reclaim the lock when that PID is
 * provably gone on this host (kill(pid, 0) -> ESRCH). Everything else is
 * untouched: an unknown or unparsable owner, a live owner, or EPERM (another
 * user's live process) never triggers a reclaim, so the failure mode stays
 * conservative -- worst case the contender times out exactly as before.
 *
 * SAFETY
 * - PID reuse can only make a dead owner look alive -> no reclaim (safe).
 * - The check is same-host by construction. On a shared filesystem a lock held
 *   by another host would look dead here; do not run this against a profile
 *   directory served over NFS/SMB.
 *
 * This file is the durable copy. dsh upgrades replace node_modules and drop the
 * patch, so re-run it after every upgrade:
 *   node /vol1/@appdata/deepseek.harness/dsh-data/lock-hardening/apply-atomic-write-patch.mjs
 * It is idempotent and self-verifying: it exits 0 only when the patched module
 * passes the five behavioural checks below.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH_HOME = process.env.DSH_HOME || '/vol1/@appdata/deepseek.harness/dsh-data'
const MARKER = 'ownerGone'
const FD_IMPORT_OLD = 'import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";'
const FD_IMPORT_NEW = 'import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";'
const ANCHOR_CONTENTION = '/** Whether an exclusive create found an existing lock. */'
const ANCHOR_DEADLINE = 'if (Date.now() >= deadline) throw new Error('
const RECLAIM = 'if (await ownerGone(lockPath)) { await rm(lockPath, { force: true }); continue; }\n\t\t'

const PROBE = [
  '/**',
  " * Whether the lock's recorded owner is provably gone. The lock carries the",
  " * holder's PID; when that PID no longer exists on this host the lock cannot",
  ' * still be held, so the contender reclaims it instead of waiting out a',
  ' * deadline for an owner that will never release it. Only an explicit ESRCH',
  ' * counts: an unknown or unparsable owner, a live owner, and EPERM (a live',
  ' * process owned by someone else) all keep the lock, so an unreadable or',
  ' * foreign lock is never stolen. Same-host by construction.',
  ' */',
  'async function ownerGone(lockPath) {',
  '\tlet raw',
  '\ttry { raw = await readFile(lockPath, "utf8") } catch (error) { return error?.code === "ENOENT" }',
  '\tconst pid = Number.parseInt(String(raw).trim(), 10)',
  '\tif (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false',
  '\ttry { process.kill(pid, 0); return false }',
  '\tcatch (error) { return error?.code === "ESRCH" }',
  '}',
  '',
].join('\n')

/** Locate every installed copy; upgrades keep the same layout. */
function locateTargets() {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 6 || !existsSync(dir)) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (entry.name === '@deepseek-ai') {
        const candidate = join(path, 'dsh-atomic-write', 'lib', 'index.js')
        if (existsSync(candidate)) found.push(candidate)
        continue
      }
      if (entry.name === 'node_modules') walk(path, depth + 1)
    }
  }
  walk(join(DSH_HOME, 'dsh-runtime', 'node_modules'), 0)
  walk(join(DSH_HOME, 'profiles'), 0)
  return [...new Set(found)]
}

function patchFile(target) {
  const source = readFileSync(target, 'utf8')
  if (source.includes(MARKER)) return 'already'
  const count = (needle) => source.split(needle).length - 1
  const anchors = [['fs import', FD_IMPORT_OLD], ['contention anchor', ANCHOR_CONTENTION], ['deadline anchor', ANCHOR_DEADLINE]]
  for (const [label, needle] of anchors) {
    const seen = count(needle)
    if (seen !== 1) throw new Error(label + ': expected 1 occurrence, found ' + seen + ' -- upstream changed; review before re-applying')
  }
  const backup = target + '.orig'
  if (!existsSync(backup)) copyFileSync(target, backup)
  const patched = source
    .replace(FD_IMPORT_OLD, FD_IMPORT_NEW)
    .replace(ANCHOR_CONTENTION, PROBE + '\n' + ANCHOR_CONTENTION)
    .replace(ANCHOR_DEADLINE, RECLAIM + ANCHOR_DEADLINE)
  if (!patched.includes(MARKER) || !patched.includes('if (await ownerGone(lockPath))')) throw new Error('patch did not apply cleanly')
  writeFileSync(target, patched)
  return 'patched'
}

/** Five behavioural checks against the patched module in an isolated dir. */
async function selfTest(target) {
  const module = await import(pathToFileURL(target).href)
  const dir = mkdtempSync('/tmp/lock-selftest-')
  const file = join(dir, 'state.json')
  writeFileSync(file, '{}')
  const lockPath = file + '.lock'
  const attempt = async (waitMs) => {
    try { await module.withFileLock(file, async () => {}, { waitMs: waitMs === undefined ? 400 : waitMs }); return 'acquired' }
    catch (error) { return /timed out waiting for the writer lock/.test(String(error && error.message)) ? 'timed-out' : 'error:' + (error && error.message) }
  }
  const results = []
  try {
    writeFileSync(lockPath, '999999\n')
    results.push(['dead owner reclaimed', await attempt(), 'acquired'])
    rmSync(lockPath, { force: true })
    writeFileSync(lockPath, '{"pid":1,"token":"x"}\n')
    results.push(['foreign-format lock kept', await attempt(), 'timed-out'])
    rmSync(lockPath, { force: true })
    writeFileSync(lockPath, '')
    results.push(['empty lock kept', await attempt(), 'timed-out'])
    rmSync(lockPath, { force: true })
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 5000)'], { stdio: 'ignore' })
    writeFileSync(lockPath, String(child.pid) + '\n')
    results.push(['live owner not stolen', await attempt(), 'timed-out'])
    child.kill('SIGKILL')
    rmSync(lockPath, { force: true })
    await module.withFileLock(file, async () => {})
    results.push(['released on success', existsSync(lockPath) ? 'still-there' : 'gone', 'gone'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  let failed = 0
  for (const row of results) {
    const ok = row[1] === row[2]
    if (!ok) failed += 1
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + row[0] + ': got ' + row[1] + ', want ' + row[2])
  }
  return failed
}

const targets = locateTargets()
if (targets.length === 0) {
  console.error('no @deepseek-ai/dsh-atomic-write found under ' + DSH_HOME)
  process.exit(2)
}
let failures = 0
for (const target of targets) {
  const version = JSON.parse(readFileSync(join(dirname(dirname(target)), 'package.json'), 'utf8')).version
  const outcome = patchFile(target)
  console.log((outcome === 'patched' ? 'patched  ' : 'already  ') + target + '  (v' + version + ', ' + statSync(target).size + ' bytes)')
  failures += await selfTest(target)
}
console.log(failures === 0 ? 'OK: hardening verified' : 'FAILED: ' + failures + ' self-test(s) failed')
process.exit(failures === 0 ? 0 : 1)
