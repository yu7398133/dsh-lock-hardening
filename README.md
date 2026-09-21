# dsh-lock-hardening

Self-healing recovery for **DeepSeek Harness (DSH)** writer locks that an interrupted
process leaves behind.

`deepseek-ai/dsh-atomic-write` releases its `<file>.lock` only from a `finally` block, so any abrupt
end of the writer orphans the lock. The contender deliberately refuses to reclaim it, and
no operator-facing recovery ships with dsh — so one interrupted plugin install can wedge
that file **permanently**, surviving restarts of both the program and the machine.

On the host this came from, a single cancelled plugin install left
`profiles/web/package.json.lock` behind and every plugin install and update failed for
**~15 hours**, through two dsh restarts, until the file was deleted by hand.

## The failure, reproduced

| How the lock holder ended | `state.json.lock` | Next writer |
| --- | --- | --- |
| returned normally | removed | acquires immediately |
| Ctrl-C (SIGINT) | **left behind** | times out |
| killed process group (SIGTERM) | **left behind** | times out |
| closed terminal / SSH drop (SIGHUP) | **left behind** | times out |
| OOM / container restart / power loss (SIGKILL) | **left behind** | times out |

The library is explicit about the missing half of the protocol:

> The contender never removes an existing lock because file age cannot prove that its
> owner stopped; orphan recovery is an operator action.

That action does not exist in dsh: no command, no UI affordance, no boot-time sweep. And
nothing in the boot path touches `*.lock` files, which is why restarting is useless — the lock
is an ordinary file on disk.

The same primitive guards `settings.yaml`, credentials and llm state, where the default
wait is 2 s. There the identical root cause surfaces as "settings will not save", which is
much harder to attribute than a failing plugin install.

## Two layers

### 1. The fix — `apply-atomic-write-patch.mjs`

On contention, read the lock's PID and reclaim the lock when that PID is **provably gone
on this host** (`kill(pid, 0)` -> ESRCH). ~20 lines, one behaviour changed.

Deliberately conservative: an unknown or unparsable owner, a live owner, or EPERM (someone
else's live process) never triggers a reclaim, so an unreadable or foreign lock is never
stolen and the worst case degrades to exactly today's behaviour.

```bash
node apply-atomic-write-patch.mjs
```

The script is idempotent (re-running reports `already`) and self-verifying: it exits 0 only
when the patched module passes five behavioural checks.

### 2. The safety net — `plugin/lock-sweeper.mjs`

A profile plugin that sweeps at startup and every 60 s, reclaiming locks whose owner is
gone. It does **not** prevent orphans; it is the layer that survives a dsh upgrade and
covers the paths the native patch does not.

Copy it into the profile directory (the loader resolves a relative `name` against the
profile directory) and add the row to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: lock-sweeper
      name: "./lock-sweeper.mjs"
```

## ⚠️ After every dsh upgrade

An upgrade replaces `node_modules` and **drops the native patch**. Re-run:

```bash
node apply-atomic-write-patch.mjs
```

The plugin layer keeps working regardless; if you forget, recovery is simply delayed by up
to one sweep interval.

## Verify

```bash
# the sweeper's own audit trail: what it scanned, reclaimed, and deliberately kept
cat "$DSH_HOME/lock-sweeper/status.json"
```

## Safety notes

- The liveness probe is **same-host by construction**. Do not use this on a profile
  directory served over NFS/SMB, where another host may legitimately hold the lock.
- PID reuse produces a false "still alive" -> no reclaim. This fails safe.
- Only files whose **entire** content is a bare decimal PID are ever considered. JSON
  locks (`{"pid":...,"token":...}`) and empty marker locks such as `session.lock` are never touched.
- Before unlinking, the sweeper re-reads the file and compares inode and content, so a lock
  released and re-minted in between is not deleted.

## Contents

| File | Purpose |
| --- | --- |
| `apply-atomic-write-patch.mjs` | The fix: idempotent, self-verifying patch |
| `atomic-write-reclaim.patch` | The raw diff against `dsh-atomic-write` 0.1.6-alpha.2 |
| `patches/liangshen-workflow-engine.patch` | Fix for an unrelated third-party plugin (`@linxin666/dsh-liangshen`) |
| `patches/README.md` | The liangshen write-up: the one-line fix, the preset re-sync, the duplicate-mount trap, upstream status |
| `patches/liangshen-evidence.png` | Evidence screenshot for the liangshen report |
| `plugin/lock-sweeper.mjs` | Recovery layer that survives upgrades |
| `upstream-issue.md` | Ready-to-file bug report: repro, evidence, root cause, fix |
| `README.zh-CN.md` | Chinese version of this document |

## License

MIT

