# Agent Guidelines for dsh-graph Repository

## Generated File Policy

### Build Output: `dist/` Directory

All build artifacts are output to a standalone `dist/` directory (gitignored). `dsh-graph-host/` is a **pure source directory** — it contains no build products.

- `core/*.ts` is the single source of truth for the core layer.
- `dsh-graph-host/lib/client/*.js` are the source modules for the client bundle.
- Build automatically via `pnpm build` (= `bash scripts/build.sh`; chains `sync-core.sh` + `build-client.sh` + asset copy). There is **no** root `prepack` — `build` and `prepare` are the same single entry (g-353).
- Packaging = build first, then pack inside the artifact dir: `bash scripts/build.sh && (cd dist && npm pack)`.
- **Pure read-only check (never builds, never repairs, writes nothing): `node --test core/tests/dist-freshness-g312.test.ts`.** It does not go through pnpm, so no dependency check and no lifecycle script can run.
- ⚠️ `pnpm check:dist` is **not** a read-only entry (g-408). `pnpm <script>` is `pnpm run <script>`, and pnpm runs its `verifyDepsBeforeRun` check before `run`/`exec` (default `install` since pnpm 11; `false` back in pnpm 10). When `node_modules` is not up to date, it **silently runs `pnpm install`**, which runs the root lifecycle script `prepare` = `bash scripts/build.sh` ⇒ **full build + atomic replacement of `dist/`** — only then does the freshness guard run. Reproduced 2026-10-02 with pnpm 12.3.4: a sentinel file placed in `dist/` was wiped by a single `pnpm check:dist` run (`dist` treehash `fbd6df9be2bf1684` → `ae66501b8d4d2166`). Treat it exactly like `pnpm typecheck`: **never run it in the main tree.**
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

**Fallback hardening (g-353)**: on the two-rename path the capability probe (`mv --exchange --help`, binary capability) is kept distinct from an actual runtime `RENAME_EXCHANGE` failure (filesystem/mount does not support it) — the latter warns and still falls back to two renames. If the second rename fails, `build.sh` first **rolls back** (`mv dist.prev.<pid> dist`), so the live path is byte-for-byte the old tree again; if the rollback also fails it goes **fail-closed**: the old tree is the only intact copy, the EXIT trap never deletes it, and the recovery command is printed. A leftover `dist.prev.<pid>` with a missing `dist/` (e.g. after SIGKILL) is auto-restored by the next build. Recovery command: `mv dist.prev.<pid> dist`. Standalone `build-client.sh` (no `DIST_DIR`) rewrites the live `dist/lib/client.js` **non-atomically** and warns on stderr — publishing always goes through `build.sh`.

### Verification
After modifying source and rebuilding:
1. Run `node --check dist/lib/client.js` to verify syntax
2. Run the full test suite: `node --test core/tests/*.test.ts`
3. Verify pack: `cd dist && pnpm pack --dry-run`

**整套件自证闸门（g-350 / g-407 R1 / g-413 / g-415 / g-416）**：`node scripts/run-tests.mjs` —— 跨平台入口，先摘除
`NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID` 再起 runner，并**自证**「退出码 `0` 且确实跑了 `tests > 0`
且 `skipped == 0` 且 `fail == 0` 且 `cancelled == 0` 且 `todo == 0` 且计数口径自洽
（`pass + fail + cancelled + skipped + todo == tests`）」；计数取自
`scripts/test-reporter-events.mjs` 的**带类型事件**通道（测试自己打印的 `ℹ tests …` 伪造汇总无法污染），
并与人类可读汇总、子进程退出码**三方交叉校验**。注入形态（`NODE_TEST_CONTEXT=… node --test core/tests/*.test.ts`
会被 `node --test` 静默 skip 全部文件并 `exit 0`）下只有它可判定。它**不替换**上面的命令，
两者共用同一 glob `core/tests/*.test.ts`（守卫见 `core/tests/g350-test-hygiene.test.ts`、
`core/tests/g413-gate-integrity.test.ts`、`core/tests/g415-gate-hardening.test.ts` 与
`core/tests/g416-nested-runner-coverage.test.ts`）。

闸门另有三道 **fail-closed** 防线（g-415）：①`NODE_OPTIONS` 含测试选集/分片开关（`--test-only` /
`--test-name-pattern` / `--test-skip-pattern` / `--test-shard`）时**拒绝运行**并 `exit≠0`（内存/告警等
不改变选中集合的合法选项不受影响）；②**目标文件覆盖断言**：`glob`/入参匹配到的文件集合必须与真正产出
**完成事件**（逐文件 `test:summary`，带 `file`）的文件集合一致，据此关闭 shard/pattern 与测试内提前退出
等**静默少跑**；③收尾只设 `process.exitCode`、**不调 `process.exit`**，避免大输出经 pipe 时未 flush 的
缓冲被丢弃（旧版实测 `exit 0` 且 stdout 恰 64 KiB、自证行不可见）。结构守卫
`core/tests/g415-gate-hardening.test.ts` 另禁止被收集集合 `core/tests/*.test.ts` 出现选集式 only 标记与
直接退出进程调用（`process.exit` / `process.exitCode`，含 hook 内同型调用）。

**同一覆盖判据也已下沉到共享 helper（g-416）**：任何**嵌套** `node --test`（经
`core/tests/fixtures/nested-runner.ts` 启动）都由 `nestedSuitePassProblems` / `assertNestedSuitePassed`
**自身**核对「目标文件集合 ≡ 逐文件**完成事件**（带 `file` 的 `test:summary`）集合且 `>0`」，并与人类可读
汇总 + 事件通道逐字段交叉校验；**fail-closed、无 opt-out**，既有 `code`/`fail`/`cancelled`/`skipped`/`todo`
/计数口径断言只增不减。目标集合由 helper 从调用参数（`--test` 后的位置参数）推导，支持多文件 / 目录 /
`<dir>/*<suffix>` glob（与网关同口径）；**可推导时必须以推导集合为准**，同时给出的 `opts.targets` 必须与推导
集合**精确一致**（realpath 归一后集合相等），不一致即**抛错拒绝执行**（g-418①：声明子集不得掩盖真实目标，
如 argv 里的早退文件被声明集合漏掉 ⇒ 其失败断言从未执行却判绿）；**仅无法推导时**才允许使用 `opts.targets`，
两者皆无则**抛错拒绝执行**（不存在「跳过覆盖断言」的静默路径）。私有事件通道经 `NODE_OPTIONS` 注入，
argv / shell 两形态统一生效；消费点 `g350`/`g353`/`g407`/`g413`/`g415` 共用同一实现。

**同一 helper 的嵌套运行入口**还按 g-417/g-418 收口：**同样拒绝**测试选集/分片开关 —— **生效** `NODE_OPTIONS`
（`process.env` 与 `opts.env` 合并后、即子进程真正拿到的值）**以及实际传给子进程的 argv**（`runNestedArgv`
的 `args`；`runNestedCommand` 经 shell 语义切分出的等价 argv，含 `=值` / 独立取值 / 多重空格等变体）
含 `--test-only` / `--test-name-pattern` / `--test-skip-pattern` / `--test-shard` 时**在 spawn 之前抛错拒绝执行
并点名开关**（复用 g-415 的 `findTestSelectionOption` 同源 token 口径，不另立口径 —— 用例级选集既不计 `fail`
也不计 `skipped`，文件级覆盖断言看不出来；argv 形态见 g-418②），`--no-warnings` / `--max-old-space-size=…` /
`--test-reporter` / `--test-reporter-destination` 等合法项与文件路径不受影响；同时通道路径按 Node 的
`NODE_OPTIONS` 引号规则编码（双引号分组 + 转义 `\`/`"`）⇒ 含空格（乃至 Windows 形态反斜杠）的 `TMPDIR` 下
通道照常挂上、不再误红。

## Build Isolation（构建隔离：禁止在主树跑实验性构建）

**实验性构建禁止在主树进行 —— 一律在隔离 worktree 或仓库内私有副本中进行。**

- 主树 `dist/` 是**正在运行的宿主的资产来源**：宿主对 `dist/prompts/*.md` 等资产是**每次调用现读**（非启动缓存）。在主树跑构建会与运行中的宿主、以及任何会读 prompt 资产的 worker 争用该目录；历史上由此产生过 `dsh-graph prompt asset missing or unreadable: guide-hint.zh.md`，并**直接终止进行中的轮次**（g-346 att-001/att-002 均因此静默死亡、零提交）。
- 验证构建请用专属 worktree（`.worktrees/g-<goal>-att-<NN>`）或 `tmp/` 下的私有副本；主树只在发布/复核的明确时点构建。
- `pnpm typecheck` 会连带触发本包 `prepare`（= 完整构建）⇒ 在主树改用 `./node_modules/.bin/tsc --noEmit -p tsconfig.json`。
- **同类陷阱（g-408）：`pnpm check:dist` 不是安全入口** —— `pnpm run` 在每个脚本前先做 `verifyDepsBeforeRun` 检查（pnpm ≥ 11 默认 `install`；pnpm 10 为 `false`），`node_modules` 不新鲜时会**隐式 `pnpm install` ⇒ 根 `prepare` ⇒ 完整构建并原子替换 `dist/`**，之后才跑 dist-freshness 守卫。2026-10-02 已因此在**主树**真实重建 `dist/`（mtime 02:44:14 → 13:35:53）。**纯只读检查一律用 `node --test core/tests/dist-freshness-g312.test.ts`**（不经 pnpm；实测运行前后 `dist` mtime + 全树 hash 逐字节不变）。
- g-348 的原子发布保护的是「读者的可读性」，**不改变**本条纪律：原子发布消除的是构建自身的窗口，而「不要在主树跑实验构建」避免的是与运行中宿主的一切争用。
- 回归守卫：`core/tests/g348-atomic-build.test.ts`（结构性守卫禁止对活动 `dist` 执行 `rm -rf`；3 个并发读者 × 3 轮构建断言 0 缺失；并把「改回旧模式」的负向对照钉住 ⇒ 人为回退必红）。

### 派发即隔离：返回语义与「隔离三件套核验」（g-406）

`graph_start_attempt` 的返回必须**可据以判定隔离** —— 不要只看 `worktree` 是否为 `false`：

| 字段 | 含义 |
| --- | --- |
| `isolated` | 本次是否真的建了独立 worktree，并据此启动子代理 |
| `worktree` | 已建时为 `{path, relative_path, branch, head}`；未建为 `false` |
| `worktree_reason` | 未建时的原因枚举：`explicit` / `type_default` / `dirty_workspace` / `type_default_unknown` |
| `worktree_created` / `worktree_reused` | 创建结果（新建 / 幂等复用，二者恰一为真） |

- 隔离解析（g-283/g-289）：显式 `worktree` 参数优先；未传时按**目标类型 × 工作区干净度**解析 —— 干净工作区下 `patch`/`chore`/`task` 默认**不建树**（微小改动快速通道），`feature`/`bug`/`improvement` 默认建树；可靠判脏（`clean=false`）时任何类型都升级为建树。
  ⇒ 因此「批量派发时某个 attempt 返回 `false`」是**类型默认**，与 batch 位置无关（g-406 用私有板副本 N=2/N=5 实证并回归）；单独派发结果完全相同。
- 无主树窗口：`prepareAttemptWorktree` 是**同步**调用，位于子代理启动之前、且两者之间无 `await`（同一同步临界区）⇒ 子代理启动时工作树**必已创建并注册**；建树失败一律抛 `GraphError`（零副作用：不迁移状态、不建 attempt、不启动子代理，**且不预建 `attempts/`** —— attempt ID 预测是只读的，目录不存在按 0 项计；`attempts/` 只在建树成功之后才创建），**绝不**静默降级为主树执行。
- 响应构造是**白名单**：工具入口与 HTTP/GUI 入口各自手写返回字段；新增隔离语义字段必须**两处同时登记**，否则主管拿到的响应不可判定。
- 结构性守卫：`core/tests/g406-dispatch-isolation-verdict.test.ts`（N=2/N=5 逐 attempt 一致性 + 启动时刻实拍注册状态 + 负向对照：旧响应形状必红、创建晚于启动/中间插 `await` 必红、白名单漏登记必红）；建树失败路径的目录零残留与 ID 预测口径见 `core/tests/g414-dispatch-prediction-readonly.test.ts`（g-414）。

派发后**隔离三件套核验**（主管/执行者自查，任一不合即按未隔离处理）：

1. `git worktree list` 命中该 attempt 的工作树路径（`.worktrees/<goal>-att-<NN>`，注意是两位序号）；
2. 主树 `git status --porcelain` 为 0 改动；
3. 主树 `dist/` mtime 未变（未在主树构建）。

`isolated:false` 时**不要**臆断为「隔离失败」：该 attempt 按策略在工作区根目录运行（`minor-task`/`no-isolation` 指引）。若本次任务**确实需要**隔离（例如要跑构建），主管应在派发时**显式传 `worktree:true`**，不要依赖任何「默认强制隔离」的旧表述。

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
