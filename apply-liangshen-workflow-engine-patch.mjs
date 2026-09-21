#!/usr/bin/env node
/**
 * Re-apply the "workflow engine" fix to @linxin666/dsh-liangshen.
 *
 * WHY THIS EXISTS
 * The preset's roster names a workflow engine that no released dsh ships:
 *
 *   - id: workflow-worker-thread
 *     name: '@deepseek-ai/dsh-workflow-worker-thread'
 *
 * The engine that actually exists in the runtime is @deepseek-ai/dsh-workflow-ptc
 * (dsh's own `standard` and `ptc` presets both use it). The row is unresolvable AND
 * load-bearing: `tool-ralph` sits a few rows below, is enabled, and needs a workflow
 * engine to inject `workflowEngine` -- so the preset fails to compose and the mode
 * cannot be selected at all. The bug is still present in 0.3.24 (published
 * 2026-09-20) and on the upstream `dev` branch.
 *
 * Applying the patch once is not durable. A plugin update reinstalls node_modules and
 * restores the broken row, and the plugin then re-syncs the copy sessions actually
 * read -- so the mode breaks again after every upgrade. Re-run this afterwards:
 *   node apply-liangshen-workflow-engine-patch.mjs
 *
 * WHAT IT TOUCHES
 *   source  <DSH_HOME>/profiles/<profile>/node_modules/@linxin666/dsh-liangshen/
 *           presets/liangshen/agent.cordis.yml          (one per profile that has it)
 *   synced  <DSH_HOME>/.agent-presets/liangshen/agent.cordis.yml
 *           -- global, NOT per profile: the agent-presets loader mounts this copy.
 * One row is swapped in each file. Nothing else changes, in any of them.
 * Directories whose name starts with "." are skipped: dsh leaves half-deleted
 * profiles behind as `.desktop.deleting-<pid>-<uuid>/`.
 *
 * WHY IT IS NOT A DIRECTORY MIRROR
 * The obvious recipe is `cp -f "$PKG"/* "$SYNC"/`. That is wrong on any host whose
 * operator has changed the plugin's settings: sync.ts writes the operator's choices
 * into the synced tree as an overlay, and the only overlaid key is the `tool-catalog`
 * row's `presentation`. Mirroring the packaged tree over the synced one silently
 * reverts `presentation` to the shipped default ('both') until the next mount
 * re-applies the overlay. Swapping only the workflow row leaves every other line --
 * including `presentation` -- exactly as it was.
 *
 * That also lands the synced copy on sync.ts's fixed point: sync.ts compares the
 * synced file against `render(source, overlay)` and rewrites it when they differ, so
 * a targeted swap makes the two byte-equal and the plugin reports the preset
 * `current` instead of re-syncing the fix away. The self-test proves that equality.
 * It is checked against every profile's source, because several plugin versions can
 * coexist behind the single global synced copy and only one of them can match it.
 *
 * SAFETY
 * - Idempotent: a second run reports `already` and still verifies.
 * - Byte-preserving: read and written as UTF-8 with LF endings kept, so the CJK and
 *   em-dash characters in the preset survive.
 * - The pre-patch bytes of each file are kept beside it as `<file>.orig`, written
 *   once. A re-sync prunes the synced tree's `.orig`; the next run recovers it.
 * - Dependency-free: no YAML parser; every check is regex- or byte-based.
 * - The engine row is kept ENABLED (no `disabled:`), required here because
 *   `tool-ralph` is enabled. The shipped `ptc` preset disables both together.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

const PKG_REL = join('node_modules', '@linxin666', 'dsh-liangshen', 'presets', 'liangshen', 'agent.cordis.yml')
const SYNC_REL = join('.agent-presets', 'liangshen', 'agent.cordis.yml')

const STALE_ID = 'workflow-worker-thread'
const FIXED_ID = 'workflow-ptc'
const ENGINE = '@deepseek-ai/dsh-workflow-ptc'

const OLD_BLOCK = `    - id: ${STALE_ID}\n      name: '@deepseek-ai/dsh-${STALE_ID}'`
const NEW_BLOCK = [
  `    # PATCHED (0.3.24 still ships the broken row): the shipped name below is`,
  `    # '@deepseek-ai/dsh-workflow-worker-thread', a package no released dsh`,
  `    # ships, so the row cannot resolve; the engine that actually exists in this`,
  `    # runtime is workflow-ptc. Unresolvable AND load-bearing, because 'ralph'`,
  `    # further down is enabled and injects the engine.`,
  `    - id: ${FIXED_ID}`,
  `      name: '${ENGINE}'`,
].join('\n')

/** The packaged preset of every real profile under <DSH_HOME>/profiles. */
function locateTargets() {
  const profilesRoot = join(DSH_HOME, 'profiles')
  const found = []
  if (!existsSync(profilesRoot)) return found
  for (const entry of readdirSync(profilesRoot)) {
    if (entry.startsWith('.')) continue
    const source = join(profilesRoot, entry, PKG_REL)
    if (existsSync(source) && statSync(source).isFile()) found.push({ profile: entry, source })
  }
  return found
}

/**
 * The body of one `- id: <rowId>` row, ending at the next row marker. The preset is
 * a single comma-less YAML sequence, so the next entry is the next `- id:` at this
 * nesting depth (0-4 spaces of indent); anchoring on that -- rather than on the
 * first unindented line -- is what keeps `disabled:` from a *later* row from being
 * misread as this row's.
 */
function rowBlock(text, rowId) {
  const marker = `- id: ${rowId}\n`
  const at = text.indexOf(marker)
  if (at < 0) return undefined
  const rest = text.slice(at + marker.length)
  const next = rest.search(/^ {0,4}- id: /m)
  return next < 0 ? rest : rest.slice(0, next)
}

/** Read one indented key out of a row's block. */
function readRowValue(text, rowId, key) {
  const body = rowBlock(text, rowId)
  if (body === undefined) return undefined
  const match = body.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'))
  return match ? match[1].trim().replace(/^'(.*)'$/, '$1') : undefined
}

/** Present, pointing at the engine that exists, and not disabled. */
function engineRowUsable(text) {
  const body = rowBlock(text, FIXED_ID)
  return body !== undefined && body.includes(`name: '${ENGINE}'`) && !/^\s*disabled:/m.test(body)
}

/**
 * Render `agent.cordis.yml` with the settings overlay applied -- a faithful port of
 * sync.ts's setRowValue()/renderPresetOverrides(), which is the whole of the
 * comparison sync.ts performs before deciding to rewrite the synced tree. The row
 * body boundary is sync.ts's own rule (`^\S`), not rowBlock's, so this stays a port
 * rather than an interpretation.
 */
function renderPresentationOverlay(text, presentation) {
  if (presentation === undefined) return text
  const marker = `- id: tool-catalog\n`
  const rowStart = text.indexOf(marker)
  if (rowStart < 0) return text
  const afterRow = rowStart + marker.length
  const rest = text.slice(afterRow)
  const boundary = rest.search(/^\S/m)
  const body = boundary < 0 ? rest : rest.slice(0, boundary)
  const tail = boundary < 0 ? '' : rest.slice(boundary)
  const pattern = /^(\s*)presentation:\s*.*$/m
  if (!pattern.test(body)) return text
  return text.slice(0, afterRow) + body.replace(pattern, `$1presentation: '${presentation}'`) + tail
}

/**
 * Patch one file and always return the pre-patch bytes as `baseline`, so the
 * `only the row changed` check has something to compare against.
 *
 * When a file is already patched but carries no `.orig` (patched by hand, or the
 * backup was pruned by a re-sync), the pre-patch bytes are recovered by undoing the
 * swap -- deterministic, since the swap is a literal replacement -- and recorded, so
 * the baseline becomes durable for later runs instead of the check failing forever.
 */
function patchFile(path) {
  const text = readFileSync(path, 'utf8')
  const backup = path + '.orig'
  if (text.includes(OLD_BLOCK)) {
    if (!existsSync(backup)) copyFileSync(path, backup)
    return { outcome: 'patched', text: text.replace(OLD_BLOCK, NEW_BLOCK), baseline: readFileSync(backup, 'utf8') }
  }
  if (text.includes(NEW_BLOCK)) {
    const baseline = text.replace(NEW_BLOCK, OLD_BLOCK)
    if (!existsSync(backup)) writeFileSync(backup, baseline)
    return { outcome: 'already', text, baseline }
  }
  return { outcome: 'unexpected', text, baseline: undefined }
}

function versionOf(profile) {
  try {
    const pkg = join(DSH_HOME, 'profiles', profile, 'node_modules', '@linxin666', 'dsh-liangshen', 'package.json')
    return JSON.parse(readFileSync(pkg, 'utf8')).version
  } catch { return 'unknown' }
}

const targets = locateTargets()
if (targets.length === 0) {
  console.error('no @linxin666/dsh-liangshen preset found under ' + join(DSH_HOME, 'profiles'))
  process.exit(2)
}

const synced = join(DSH_HOME, SYNC_REL)
const hasSynced = existsSync(synced)
let failures = 0

const report = (label, result) => {
  if (result.outcome === 'unexpected') failures += 1
  console.log(
    (result.outcome === 'unexpected' ? 'UNEXPECTED  ' : result.outcome + '  ') + label +
    '  (' + statSync(label === 'synced' ? synced : label).size + ' bytes)'
  )
}

const sources = []
for (const target of targets) {
  const result = patchFile(target.source)
  if (result.outcome === 'patched') writeFileSync(target.source, result.text)
  report(target.source, result)
  console.log('    profile ' + target.profile + '  (v' + versionOf(target.profile) + ')')
  sources.push({ ...target, text: readFileSync(target.source, 'utf8'), baseline: result.baseline })
}

let syncedResult
if (hasSynced) {
  syncedResult = patchFile(synced)
  if (syncedResult.outcome === 'patched') writeFileSync(synced, syncedResult.text)
  report('synced', syncedResult)
} else {
  console.log('note  no synced copy yet; the plugin creates it on next mount from the patched source')
}

console.log('')
for (const source of sources) {
  const rows = [
    ['stale row gone', !new RegExp(`^\\s*- id: ${STALE_ID}$`, 'm').test(source.text)],
    ['engine row usable (present, correct name, enabled)', engineRowUsable(source.text)],
    ['only the row changed', source.baseline !== undefined && source.text.replace(NEW_BLOCK, OLD_BLOCK) === source.baseline],
  ]
  let failed = 0
  for (const [name, ok] of rows) {
    if (!ok) failed += 1
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + source.profile + ': ' + name)
  }
  failures += failed
}

if (hasSynced) {
  const syncedText = readFileSync(synced, 'utf8')
  const overlay = readRowValue(syncedText, 'tool-catalog', 'presentation')
  const matching = sources.filter(source => renderPresentationOverlay(source.text, overlay) === syncedText)
  const ok = matching.length > 0
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  sync fixed point: synced == source + overlay' +
    (ok ? '  (matches ' + matching.map(m => m.profile).join(', ') + ')' : ''))
  if (!ok) {
    console.log('        no profile source renders to the synced copy; the plugin will rewrite it on the next mount.')
  }
}

console.log('')
console.log(failures === 0 ? 'OK: liangshen workflow engine verified' : 'FAILED: ' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)