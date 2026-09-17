# Agent Guidelines for dsh-graph Repository

## Generated File Policy

### `dsh-graph-host/core/*.js` (compiled core)

These are compiled from `core/*.ts` and are **tracked in git** — GitHub source installs
(`github:owner/repo`) do not run prepack, so the plugin would fail to load without them.

- `core/*.ts` is the single source of truth. Never edit `dsh-graph-host/core/*.js` by hand.
- After changing `core/*.ts`, run `bash scripts/sync-core.sh` and **commit the regenerated
  `dsh-graph-host/core/*.js` together with the source**.
- `core-dist/` is a build intermediate and stays gitignored.

### `dsh-graph-host/lib/client.js`

This file is **auto-generated** and must **NOT** be edited directly.

#### Why?
- `dsh-graph-host/lib/client.js` is assembled from modular source files by `scripts/build-client.sh`
- Direct editing will be overwritten on next build
- Maintains consistency between source modules and final bundle

#### How to modify client code:
1. Edit the source modules in `dsh-graph-host/lib/client/*.js`
2. Run the build script: `bash scripts/build-client.sh`
3. Verify the generated file reflects your changes

#### Build Command
```bash
bash scripts/build-client.sh
```

#### Source Module Location
`dsh-graph-host/lib/client/*.js`

### Verification
After modifying source modules and rebuilding:
1. Run `node --check dsh-graph-host/lib/client.js` to verify syntax
2. Run the full test suite: `node --test core/tests/*.test.ts`
3. Ensure the generated file contains the `⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY` marker

## Development Workflow

1. **Always work with source modules** — never edit `dsh-graph-host/lib/client.js` directly
2. **Rebuild after changes** — run `bash scripts/build-client.sh`
3. **Verify compatibility** — ensure ModuleLoader contract and all tests pass
4. **Commit source modules and generated file** — commit changes to `dsh-graph-host/lib/client/*.js` **and** the rebuilt `dsh-graph-host/lib/client.js`

## Worktree Naming

Use a stable, auditable name for every isolated attempt worktree:

```text
.worktrees/g-<goal-number>-att-<NN>
```

Examples: `.worktrees/g-125-att-03`, `.worktrees/g-163-att-03`.

- `<NN>` is the zero-padded attempt number for that goal.
- The worktree branch should use the same suffix, such as `g-125-att-03`.
- Do not use ambiguous names such as `.worktrees/att-003`, `.worktrees/g165-att001`, or names that omit the goal id.
- Existing active/review worktrees are not renamed automatically; apply this convention to new attempts and explicit follow-up work.

## Isolated Dev/Test dsh Instance (two profiles)

Development and verification run in a profile that is **fully isolated** from the main
dsh, so an in-progress plugin can never break the production GUI.

- **Main web profile** (`dsh --profile web`, port 3080) uses the **published** `dsh-graph`
  npm package.
- **Test profile** (`dsh --profile dsh-graph-test`, port 3082) binds the **local**
  `dsh-graph-host` via `link:` — live dev/verification always happens here.
- The two are switched and managed by `scripts/dev-dsh-instance.sh` (self-contained,
  idempotent, default values overridable via env vars):

```sh
bash scripts/dev-dsh-instance.sh run [--port N] [--host H] [--open]  # setup + start test instance (default 3082)
bash scripts/dev-dsh-instance.sh setup            # create/install profile only, don't start
bash scripts/dev-dsh-instance.sh main-published   # point main profile at published dsh-graph (^0.11.0) + reinstall
bash scripts/dev-dsh-instance.sh main-dev         # point main profile back at local link: dev host
bash scripts/dev-dsh-instance.sh status           # show both profiles' dsh-graph dep + port usage
```

### Development loop

- **Node-side changes** (`dsh-graph-host/index.js`, `core/*.js`, `cordis.patch.yml`):
  the test profile references the host via `link:`, so re-running `run` picks up the
  latest source — no reinstall needed (`setup` is just idempotent write + `pnpm install`).
- **Browser/kanban changes** (`dsh-graph-host/lib/client/*.js`): these are source modules.
  Per the Generated File Policy above, never edit `lib/client.js` directly. Rebuild the
  generated bundle and refresh the **test instance (3082)** page:

```sh
bash scripts/build-client.sh
node --check dsh-graph-host/lib/client.js
node --test core/tests/*.test.ts
```

  dsh-graph's own client bundle has no live-reload watcher, so it's "rebuild + refresh".
- **Test instance isolation:** `.dsh-graph` data lives under `~/.dsh/dev-workspace/dsh-graph-test/.dsh-graph`,
  separate from the main repo's data — the g-149 canonical root logic does not merge these.
- **Main profile:** only switched via `main-published` / `main-dev`. After switching, the
  main GUI (3080) must be restarted/refreshed to load the new version. Always verify in the
  test instance first, then switch the main profile.

## 发布门禁（Release Gate）

以下为**跨版本发布红线**（本段为权威定义；g-295 未修改发布手册正文）：

- **Windows 兼容性**：每个版本发布前必须在原生 Windows 上做一次兼容性测试（T1–T5 分层检查，执行件 `scripts/win-smoke-test.mjs`），Linux/WSL2 全绿不能替代 Windows 真机结论；Windows 验证缺失时 README 须如实标注「Windows 未验证」。
- **版本号一致性**：发布前必须核对 `package.json` version、`PLUGIN_VERSION`、README 中的版本表述一致（0.11.0 教训：常量不参与构建校验，只有人工核对才能发现）。
- **产物传递纪律**：跨机器传递唯一渠道为 tarball，记录 sha256 对账。

> **与发布手册的职责边界**：[`docs/release-handbook.md`](docs/release-handbook.md) 记录 v0.3/v0.4
> 发布操作流程（npm publish、GitHub repo、awesome-dsh-plugin PR）；上述三条跨版本红线不在手册内，
> 以本段为唯一真源。

## kimi_webbridge_* 工具

- Kimi WebBridge daemon 跑在 **Windows 宿主**，与 WSL2 不同系统。
- 使用 `kimi_webbridge_*` 时**不要先做 daemon 可达性检查/探测，也不要调 `kimi_webbridge_start_daemon`**
  （它会在 WSL2 内 spawn 本地二进制，本环境无效）。
- 正确做法：**直接调用目标工具**（navigate / snapshot / click / fill / screenshot 等）。
- 仅当调用**实际失败**（daemon unreachable / 超时等）时，再提示负责人手动确认宿主 WebBridge 状态，
  不要反复重试 start_daemon。
- **截图路径**：WebBridge 截图保存到 Windows 临时目录（如 `C:\Users\...\AppData\Local\Temp\...`），
  在 WSL 中需通过 `/mnt/c/...` 路径读取（如 `/mnt/c/Users/mingxuan/AppData/Local/Temp/...`）。

## Harness Text-File Editing Notes

- Before using `edit` or `write` on an existing text file, always read it first; otherwise the tool may trigger "edit requires reading ... first".
- In read output such as `132:     text`, `132:` is tool-added line-number metadata, and the first space after the colon is also a separator; neither belongs to the file content. Match `old_string`/`new_string` against the actual body text exactly; copy indentation and spaces only from the body after that separator, never the line number or separator space. If `old_string` does not match, re-read the surrounding content and adjust rather than retrying blindly.
- For multiline `edit`, read output adds a line number, colon, and exactly one separator space to every line. When constructing multiline `old_string`/`new_string`, remove exactly that one separator space from every line, including the second and later lines after each `\n`; preserve any remaining spaces that belong to the body. This also applies to blank or whitespace-only lines: after each `\n`, discard the displayed line's first space before counting body spaces. For example, if read shows `132:    first` and `133:    second` (the first space after each colon is metadata, leaving three body spaces), use `   first\n   second`, not `   first\n    second`. Do not fix only the first line; if matching fails, re-read the surrounding multiple lines and check each line individually.
- `grep` patterns are parsed as ripgrep regular expressions and are not automatically escaped. When searching for literal text, escape regex metacharacters yourself (for example, write `Card\(g,` rather than `Card(g,`), and escape `[ ] . ? + * | ^ $` and other metacharacters as needed.
- These notes describe current Harness tool behavior; if the official read output format changes, follow the format actually returned at that time.

## 协作规范导航

以下规范由 dsh-graph 插件体系维护，不在本文件重复：

- **主管工作指南**：`dsh-graph-host/supervisor-guide.zh.md`（skill `dsh-graph-supervisor`）——
  目标生命周期、判据门禁、人工 gate、执行派发、复核纪律、记忆分级。
- **长期记忆索引**：`.dsh-graph/memory/long-term/INDEX.md`——架构模式、历史教训、环境事实。
- **Worktree 隔离规范**：`executor-worktree-isolation` 记忆条目——隔离级别、快速通道、清理验收。
- **Review 边界**：`review-boundary-local-dev` 记忆条目——威胁模型、强制基线、PASS/BLOCK/UNVERIFIED。
