# patches

## liangshen-workflow-engine.patch

**Target:** `@linxin666/dsh-liangshen` — `presets/liangshen/agent.cordis.yml`
**Verified against:** `0.3.23` and `0.3.24` (the bug is still present in 0.3.24,
published 2026-09-20) on `dsh@0.1.6-alpha.2`

The preset's roster names a workflow engine that does not exist:

```yaml
- id: workflow-worker-thread
  name: '@deepseek-ai/dsh-workflow-worker-thread'
```

No released dsh ships `@deepseek-ai/dsh-workflow-worker-thread`; the engine that actually
exists in the runtime is `@deepseek-ai/dsh-workflow-ptc`. The row is both unresolvable and
load-bearing: `tool-ralph` sits a few rows below, is enabled, and needs a workflow engine to
inject `workflowEngine`.

Of the 25 `@deepseek-ai/dsh-*` references in the 0.3.24 preset, this is the **only** one that
does not resolve. The patch replaces those two lines; nothing else changes.

### Apply

```bash
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

### After the fix, re-sync the preset

The plugin copies its preset into `$DSH_HOME/.agent-presets/liangshen/` when it mounts, and
that copy is what sessions actually read. Patch the packaged file **and** refresh the synced
copy, or the old preset keeps being used. Mirror the whole directory rather than copying
named files — between 0.3.23 and 0.3.24 the preset gained `paging.mjs`, `tool-activate.mjs` and
`working-context.mjs`, and dropped `custom-bash.mjs`:

```bash
PKG=node_modules/@linxin666/dsh-liangshen/presets/liangshen
SYNC=$DSH_HOME/.agent-presets/liangshen
for f in "$SYNC"/*; do [ -e "$PKG/$(basename "$f")" ] || rm -f "$f"; done   # prune extras
cp -f "$PKG"/* "$SYNC"/                                                     # refresh
diff -r "$PKG" "$SYNC" && echo synced
```

The plugin re-syncs on every mount, so this is really only needed to take effect without a
restart.

## A separate issue that looks the same: the plugin mounting twice

Patching the preset is necessary but not sufficient — the package also has to be **mounted
exactly once**. This bit twice on the same host, in opposite directions:

```yaml
# in profiles/web/cordis.patch.yml
- insert:
    - id: liangshen-mode
      name: "@linxin666/dsh-liangshen"
```

That row exists because the package was once listed under `dependencies` but **not** in
`dsh.profile.bundles`, so its own bundle patch (which carries `id: liangshen`) never applied
and no row referenced the plugin at all — while a leftover `- id: liangshen` / `disabled: true`
in the same file suppressed anything that did.

Once the package is listed in `dsh.profile.bundles` again, its own patch applies, and that
extra row becomes a **second** loader row for one package — the "duplicate plugin enabled"
condition the host warns about in its "本机连接被占用 / 请检查是否重复启用了插件" message. The
plugin then mounts twice and its client surface registers twice.

The rule: **exactly one owner per package.** Prefer the bundle row (it is what the plugin
manager maintains); own the row in the user layer only while the package is missing from
`dsh.profile.bundles`. If you do own it there, use a different id from the bundle's, because
duplicate loader entry ids throw and break the host boot.

