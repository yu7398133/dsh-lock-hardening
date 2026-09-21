# lock-hardening —— DSH 写锁自愈（两层）

## 为什么有这个东西

`@deepseek-ai/dsh-atomic-write` 的 `withFileLock` 会创建 `<文件>.lock`（内容是持有者的 PID），
并且**只在 `finally` 里释放**。任何非正常结束都会跳过这段释放：

| 结束方式 | 锁 |
| --- | --- |
| 正常返回 | 正常释放 |
| Ctrl-C（SIGINT） | **残留** |
| 父进程杀进程组（SIGTERM） | **残留** |
| 终端关闭 / SSH 断线（SIGHUP） | **残留** |
| OOM / 容器重启 / 掉电（SIGKILL） | **残留** |

而竞争者**从不回收**已有锁。库里的原话是：

> The contender never removes an existing lock because file age cannot prove that its
> owner stopped; orphan recovery is an operator action.

问题是 dsh 里**没有这个 operator action** —— 没有命令、没有按钮、没有启动清扫。
于是锁会把那个文件**永久**卡死。重启程序、重启整机都没用（锁是磁盘上的普通文件，
启动路径里没有任何代码碰 `.lock`）。

**实际事故**：2026-09-19 23:34，一次被取消的插件安装把
`profiles/web/package.json.lock` 变成了孤儿锁，之后所有插件安装/更新全部失败，
持续约 15 小时，跨了两次 dsh 重启，直到手工删掉文件。

## 装了什么（两层）

### 第一层：补丁（治病）—— `apply-atomic-write-patch.mjs`

改 `@deepseek-ai/dsh-atomic-write`：争锁时读锁里的 PID，**只有**确认该进程在本机
已不存在（`kill(pid, 0)` 返回 ESRCH）才回收这把锁。约 20 行，只改一个行为。

保守性：无法解析的内容、活着的持有者、EPERM（别人的活进程）**都不会**触发回收，
所以最坏情况就退化成原来的行为（超时失败），不会误抢活锁。

这个脚本是**持久副本**。dsh 升级会替换 `node_modules` 从而冲掉补丁，
**升级后重新跑一次即可**：

```bash
node /vol1/@appdata/deepseek.harness/dsh-data/lock-hardening/apply-atomic-write-patch.mjs
```

它是幂等的（已打过就报 `already`）且自带 5 项行为自检，退出码 0 才代表真的生效：

- 死持有者的锁 → 被回收
- 活持有者的锁 → 不被抢
- JSON 格式锁（task-board 那种）→ 不碰
- 空锁（session.lock）→ 不碰
- 正常结束时锁被释放

原文件备份在同目录 `index.js.orig`。

### 第二层：自愈插件（兜底）—— `plugin/lock-sweeper.mjs`

挂在 profile 里，**启动时扫一遍 + 每 60 秒扫一遍**，自动回收"持有者已死"的锁。
它不阻止孤儿锁产生，但它是**唯一能活过 dsh 升级**的那一层，并且覆盖补丁管不到的地方
（`settings.yaml`、凭据库、llm 状态——这些默认只等 2 秒，孤儿锁落上去症状会变成
"设置存不上"，更难查）。

扫描规则（三个条件同时满足才删）：

1. 文件名以 `.lock` 结尾；
2. 文件**完整内容就是一个裸十进制 PID**；
3. 该 PID 在本机已不存在。

删除前会重新读一次并比对 inode 与内容，避免删掉"检查期间刚被释放又重建"的锁。
扫描范围：`$DSH_HOME` 根目录 + 每个 `profiles/<name>/`（深度 1，跳过 `node_modules`）。

> 这不会碰 `task-board/ledger-v2.lock`（它是 JSON `{"pid":...,"token":...}` 且通常由活着的
> 主进程持有），也不会碰那些 0 字节的 `session.lock`。

## 怎么确认它在工作

```bash
cat /vol1/@appdata/deepseek.harness/dsh-data/lock-sweeper/status.json
```

每次扫描都会写这个文件：扫了几个、回收了哪些、保留了哪些以及原因。

## 怎么关掉

- 插件：编辑 `profiles/web/cordis.patch.yml`，给 `lock-sweeper` 行加 `config: { enabled: false }`；
- 补丁：`cp index.js.orig <...>/lib/index.js` 还原。

## 注意

- 存活检测是**本机语义**。如果 profile 目录放在共享存储（NFS/SMB）上，别的主机持有的锁
  在本机看会是"死的"。不要在这种目录上启用。
- PID 复用只会让死锁看起来像"活着" → 不回收（偏保守，安全）。

## 另外：梁神模式（@linxin666/dsh-liangshen）的修复

跟锁无关，只是放在同一个仓库里，详见 [patches/README.md](patches/README.md)。

1. **预设引用了不存在的包**：`@deepseek-ai/dsh-workflow-worker-thread` 在 dsh 0.1.6 已被移除，
   而该行同时是启用的 `tool-ralph` 的引擎依赖。0.3.24 与上游 `dev` 分支**都还没修**。
   修法是换成实际存在的 `@deepseek-ai/dsh-workflow-ptc`（与 dsh 自带 `standard` 预设同一行）。
2. **插件被挂载两次**：包一旦回到 `dsh.profile.bundles`，它自带的 loader 行就会生效；此时用户层
   再补一行就变成"重复启用插件"。**一个包只能有一个挂载点**，可用
   `dsh --profile web --dump-config | grep -cE '^- id: liangshen`' 验证（应为 1）。

注意：插件 mount 时会把预设复制到 `$DSH_HOME/.agent-presets/liangshen/`，session 实际读的是那份副本；
改完包内文件必须让副本重新同步，否则会误以为"改了没用"。
