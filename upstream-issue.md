# atomic-write: an interrupted writer leaves <file>.lock behind permanently, and no recovery path exists

**Version:** @deepseek-ai/dsh-atomic-write 0.1.6-alpha.2 (dsh 0.1.6-alpha.2)
**Environment:** v24.15.0 / 0.1.6-alpha.2 / Linux 6.18.18.c1032-trim, Linux, profile "web", local (non-shared) filesystem
**Severity:** one interrupted operation permanently wedges the file; the only recovery is editing the filesystem by hand

## Summary

`withFileLock` creates `<file>.lock` holding the writer's PID and releases it only from a
`finally` block. When the writer dies abruptly — SIGINT, SIGTERM, SIGHUP, SIGKILL — that block
never runs and the lock is orphaned. The contender deliberately never reclaims an
existing lock, and no operator-facing recovery ships with dsh, so every later writer to
that file fails until a human deletes the lock.

## Impact

Any of these ends a writer abruptly and orphans its lock: Ctrl-C during a long
`dsh plugin` operation, the parent killing the process group, a closed terminal or dropped
SSH session, an OOM kill, a container restart, power loss.

Because the same primitive guards `settings.yaml`, credentials and llm state — with the
default `DEFAULT_LOCK_WAIT_MS = 2000` — the same root cause surfaces as "settings will not
save" or "credentials will not persist", which is harder to attribute than a failing
plugin install.

## Steps to reproduce (minimal, against the library directly)

```js
import { withFileLock } from "@deepseek-ai/dsh-atomic-write";

// holder.js -- dies while holding the lock
await withFileLock("state.json", async () => {
  process.kill(process.pid, "SIGTERM");   // or SIGINT / SIGHUP / SIGKILL
  await new Promise((r) => setTimeout(r, 3000));
});
```

```js
// contender.js
try { await withFileLock("state.json", async () => console.log("acquired")); }
catch (e) { console.log(e.message); }
```

Observed — every signal leaves the lock behind and the next writer fails:

| How the holder ended | `state.json.lock` | Next writer |
| --- | --- | --- |
| returned normally | removed | acquires immediately |
| SIGINT | left behind | `atomic-write: timed out waiting for the writer lock` |
| SIGTERM | left behind | same |
| SIGHUP | left behind | same |
| SIGKILL | left behind | same |

Expected: a lock whose owner no longer exists is reclaimable, so an interrupted writer
delays the next writer rather than blocking it forever.

## Field evidence (this host)

- `2026-09-19 23:33:32` a plugin install starts (it holds `profiles/web/package.json`'s lock).
- `2026-09-19 23:34:38` the operation is cancelled and the process group is killed.
- `2026-09-19 23:38:58` a retry fails with
  `atomic-write: timed out waiting for the writer lock at .../package.json.lock`
  exactly 120.000 s after it started (the CLI passes `lockWaitMs: 12e4`).
- Every plugin install/update then failed for ~15 hours — **through two dsh restarts**,
  because nothing in the boot path touches `*.lock`.
- `dsh plugin --profile web list` hung past 120 s.
- Recovery required manually deleting the lock file.

## Root cause

1. **Release depends on a `finally` block**, so it is skipped whenever the process is
   terminated rather than returning.
2. **The contender never reclaims.** The code says so explicitly:
   `orphan recovery is an operator action` — but no such action exists in dsh: no command,
   no UI affordance, no startup sweep. The comment documents an escape hatch that was
   never implemented.
3. **The critical section is far larger than the invariant it protects.** The lock exists
   to serialize a read-modify-write of `package.json`, but
   `runPluginCommand` holds it across the **entire** `runProfilePnpm` call — a
   network-bound install that can run for minutes (e.g. a git-hosted plugin clone).
   That turns a sub-millisecond critical section into a minutes-long one and makes the
   window in (1) easy to hit. Narrowing the scope would shrink exposure by orders of
   magnitude, though (2) remains the reason the failure is permanent.

## Suggested fix

Reclaim on contention when the recorded owner is provably gone, and keep every other
path conservative (unknown or unparsable owner, live owner, EPERM -> keep the lock, so an
unreadable or foreign lock is never stolen). See `atomic-write-reclaim.patch` — a 42-line
diff adding one helper and one call:

```js
async function ownerGone(lockPath) {
	let raw
	try { raw = await readFile(lockPath, "utf8") } catch (error) { return error?.code === "ENOENT" }
	const pid = Number.parseInt(String(raw).trim(), 10)
	if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
	try { process.kill(pid, 0); return false }
	catch (error) { return error?.code === "ESRCH" }
}
```

and inside the retry loop, before the deadline check:

```js
if (await ownerGone(lockPath)) { await rm(lockPath, { force: true }); continue; }
```

Verified behaviour of that patch in this deployment:

- dead owner -> reclaimed in milliseconds;
- live owner -> not stolen (contender still times out at its own wait);
- JSON lock (`{"pid":...}`) and empty lock -> untouched;
- normal completion -> still released.

Design notes worth deciding upstream:

- `ESRCH` alone is the reclaim trigger; treating `EPERM` as dead would be wrong.
- The probe is same-host by construction. On shared storage a lock held by another host is
  indistinguishable from an orphan, so this should either be opt-in, or the lock should
  record a host/boot identity for a stronger liveness check.
- PID reuse is a false "still alive" — it fails safe (no reclaim), but a boot-id or
  start-time recorded in the lock would remove the ambiguity.
- Independently of the above, a documented recovery path (a `dsh` command or a boot-time
  sweep) would make this failure mode recoverable even without the patch.
