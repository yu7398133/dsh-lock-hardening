# patches

## liangshen-workflow-engine.patch

**Target:** `@linxin666/dsh-liangshen` — `presets/liangshen/agent.cordis.yml`

The preset's roster names a workflow engine that does not exist:

```yaml
- id: workflow-worker-thread
  name: '@deepseek-ai/dsh-workflow-worker-thread'
```

No released dsh ships `@deepseek-ai/dsh-workflow-worker-thread`; the engine that actually
exists in the runtime is `@deepseek-ai/dsh-workflow-ptc`, and `ralph` (declared further down
the same roster, and enabled) needs a workflow engine to inject `workflowEngine`. The row is
therefore both unresolvable and load-bearing.

Verified against `@linxin666/dsh-liangshen@0.3.23` and `dsh@0.1.6-alpha.2`. The patch is the
entire difference between the published preset and a working one — three lines replaced.

### Apply

```bash
# inside an installed package
cd node_modules/@linxin666/dsh-liangshen
patch -p1 < /path/to/liangshen-workflow-engine.patch
```

Or edit the file directly and swap the row:

```yaml
- id: workflow-ptc
  name: '@deepseek-ai/dsh-workflow-ptc'
  config:
    provider: spawn
```

The preset is copied into `$DSH_HOME/.agent-presets/liangshen/` on mount, so re-apply after an
upgrade of the package (or delete the synced copy and let it re-sync).

## A separate local issue that looks like the same bug

Patching the preset is necessary but not sufficient: the package also has to be **mounted**.
In the profile this came from, `@linxin666/dsh-liangshen` was listed under `dependencies` but
absent from `dsh.profile.bundles`, so its own bundle patch (which carries `id: liangshen`)
never applied and no loader row referenced the plugin at all — while a leftover
`- id: liangshen` / `disabled: true` entry in the profile's user layer suppressed anything that
did.

Own the row in the profile's `cordis.patch.yml` instead — the plugin manager rewrites
`package.json` on every install/update but leaves the user layer alone:

```yaml
- insert:
    - id: liangshen-mode
      name: "@linxin666/dsh-liangshen"
```

Use a **different** id from the one in the package's own bundle patch. Duplicate loader entry
ids throw and break the host boot; with a distinct id both rows can coexist, and the plugin's
own `mountOnce()` makes the second host apply a no-op.

