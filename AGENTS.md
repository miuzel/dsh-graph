# Agent Guidelines for dsh-graph Repository

## Generated File Policy

### Build Output: `dist/` Directory

All build artifacts are output to a standalone `dist/` directory (gitignored). `dsh-graph-host/` is a **pure source directory** — it contains no build products.

- `core/*.ts` is the single source of truth for the core layer.
- `dsh-graph-host/lib/client/*.js` are the source modules for the client bundle.
- Build automatically via `pnpm build` or `pnpm prepack` (chains `sync-core.sh` + `build-client.sh` + asset copy).
- GitHub source installs (`github:owner/repo`) trigger `prepare` script automatically on `npm install`.
- `core-dist/` is a build intermediate and stays gitignored.

### `dist/core/*.js` (compiled core)

These are **auto-generated** from `core/*.ts`. Never edit them directly.

### `dist/lib/client.js`

This file is **auto-generated** and must **NOT** be edited directly.

- `dist/lib/client.js` is assembled from modular source files in `dsh-graph-host/lib/client/*.js`
- Direct editing will be overwritten on next build

#### Source Modules
`dsh-graph-host/lib/client/*.js` — edit these, then rebuild.

### Unified Build Command

```bash
pnpm build          # or: bash scripts/build.sh
```

This runs `sync-core.sh` (core/*.ts → dist/core/*.js), `build-client.sh` (client modules → dist/lib/client.js), and copies all release assets to `dist/`.

**Atomic publish (g-348)**: `build.sh` never wipes the live `dist/`. All artifacts are first assembled in a staging root inside the repository (`.dist-stage.XXXXXX/`, same filesystem as `dist/`); only after every step succeeds is the tree switched with a single `mv -T --exchange` (`renameat2(RENAME_EXCHANGE)`). A failed build leaves the previous `dist/` byte-for-byte intact and removes the staging root via an EXIT trap. Where `mv --exchange` is unavailable (needs GNU coreutils ≥ 9.6; macOS/BSD), it falls back to two renames and warns on stderr. `DIST_DIR` / `CORE_DIST` let `sync-core.sh` and `build-client.sh` write into the staging root; their standalone defaults are unchanged.

### Verification
After modifying source and rebuilding:
1. Run `node --check dist/lib/client.js` to verify syntax
2. Run the full test suite: `node --test core/tests/*.test.ts`
3. Verify pack: `cd dist && pnpm pack --dry-run`

## Build Isolation（构建隔离：禁止在主树跑实验性构建）

**实验性构建禁止在主树进行 —— 一律在隔离 worktree 或仓库内私有副本中进行。**

- 主树 `dist/` 是**正在运行的宿主的资产来源**：宿主对 `dist/prompts/*.md` 等资产是**每次调用现读**（非启动缓存）。在主树跑构建会与运行中的宿主、以及任何会读 prompt 资产的 worker 争用该目录；历史上由此产生过 `dsh-graph prompt asset missing or unreadable: guide-hint.zh.md`，并**直接终止进行中的轮次**（g-346 att-001/att-002 均因此静默死亡、零提交）。
- 验证构建请用专属 worktree（`.worktrees/g-<goal>-att-<NN>`）或 `tmp/` 下的私有副本；主树只在发布/复核的明确时点构建。
- `pnpm typecheck` 会连带触发本包 `prepare`（= 完整构建）⇒ 在主树改用 `./node_modules/.bin/tsc --noEmit -p tsconfig.json`。
- g-348 的原子发布保护的是「读者的可读性」，**不改变**本条纪律：原子发布消除的是构建自身的窗口，而「不要在主树跑实验构建」避免的是与运行中宿主的一切争用。
- 回归守卫：`core/tests/g348-atomic-build.test.ts`（结构性守卫禁止对活动 `dist` 执行 `rm -rf`；3 个并发读者 × 3 轮构建断言 0 缺失；并把「改回旧模式」的负向对照钉住 ⇒ 人为回退必红）。

## Development Workflow

1. **Always work with source files** — never edit files in `dist/` directly
2. **Rebuild after changes** — run `pnpm build` (or `bash scripts/build.sh`)
3. **Verify compatibility** — ensure all tests pass
4. **Commit only source files** — `dist/` is generated and gitignored; `dsh-graph-host/` is pure source

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

## Isolated Dev/Test dsh Instance

开发/验证在**与主 dsh 完全隔离**的实例中进行：隔离边界是 **`DSH_HOME`**（默认 `./tmp/dsh-test/<稳定版本>/home`，workspace 默认 `./tmp/dsh-test/<完整版本>/workspace`），主 GUI（3080）不受影响。
启动：`bash scripts/dsh-test-web.sh <DSH版本> [--port PORT] [--host HOST] [--host-dir PATH] [--proxychains] [--skip-install]`（默认端口 3082；拒绝端口 3080 与受管参数透传）；插件经 `link:` 指向 `--host-dir`（默认 `dist/`），改完源码须先 `pnpm build`。
参数表、开发回路、看板数据落点与已归档的 `dev-dsh-instance.sh` 说明见 [`docs/dev-instance-guide.md`](docs/dev-instance-guide.md)。

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

- 改已有文本文件前先 `read`（否则 `edit`/`write` 会报 "edit requires reading ... first"）；`old_string`/`new_string` 只按**正文**逐字匹配——read 输出每行前缀的行号、冒号及其后**一个**分隔空格都不属于文件内容。
- 多行匹配时每一行都要先去掉那一个分隔空格，只保留正文空格（空行/纯空白行、以及每个 `\n` 之后的行同样处理）：read 显示 `132:    first` 与 `133:    second`（冒号后第一个空格是工具添加的分隔符，正文是三格），故多行 `edit` 应写 `   first\n   second`，不是 `   first\n    second`；匹配失败先重读上下文逐行核对，不要只修第一行或盲目重试。
- `grep` 的模式按 ripgrep 正则解析、不会自动转义：按字面搜索时自行转义元字符（如写 `Card\(g,`，以及 `[ ] . ? + * | ^ $` 等）。

## 协作规范导航

以下规范由 dsh-graph 插件体系维护，不在本文件重复：

- **主管工作指南**：`dsh-graph-host/supervisor-guide.zh.md`（skill `dsh-graph-supervisor`）——
  目标生命周期、判据门禁、人工 gate、执行派发、复核纪律、记忆分级。
- **长期记忆索引**：`.dsh-graph/memory/long-term/INDEX.md`——架构模式、历史教训、环境事实。
- **Worktree 隔离规范**：`executor-worktree-isolation` 记忆条目——隔离级别、快速通道、清理验收。
- **Review 边界**：`review-boundary-local-dev` 记忆条目——威胁模型、强制基线、PASS/BLOCK/UNVERIFIED。
