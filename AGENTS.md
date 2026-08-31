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

## Worktree Isolation by Change Risk

Not every task needs a new worktree. Choose isolation level by the risk of the change.

**核心原则**：
- `main` 分支**只承载已发布版本，只读**——任何开发、测试、review 改动不得在 main 上进行；
- Supervisor 为每个版本先建立 `<version>-test`（或等价命名）开发集成分支，再预创建并登记子代理 worktree；
- 子代理直接在给定的 worktree 中工作，**绝不自行拉树、建分支、改分支**；
- 非平凡源码/测试/生成物/有副作用/并行改动仍必须隔离在独立 worktree。

### worktree = true（强制隔离，默认）

适用场景（以下任一即隔离）：
- 修改多文件源码或生成物（编译产物、打包文件等）；
- 会修改源码或测试（包括新增/删除测试文件）；
- 并行执行时可能互相踩踏提交/文件（多 attempt 同时活跃、同一文件多代理修改）；
- 有构建副作用（生成临时文件、改 node_modules、改数据库等）；
- 任何 supervisor 无法预判副作用范围的任务。

要求：
- brief 必须写明**专属 worktree 路径**（如 `.worktrees/g-125-att-03`）；
- brief 必须写明**版本分支**（如 `<version>-test`）与**基线 commit**；
- brief 必须明确**禁止自行拉树/建分支/改分支**，子代理只准在给定树内工作；
- brief 必须明确**禁止直接修改 main、golden、3080、主 DSH_HOME、tmp/test-review 或其他目标分支**；
- 代码改动只能在 worktree 内进行，`.dsh-graph/` 看板数据仍在主工作树写（graph_* 工具写主树，不被 worktree 分支隔离）。

### worktree = false（显式豁免，需理由）

仅以下两类可在 brief 中显式写 `worktree=false` 并记录理由：

1. **只读审计 / 静态检查 / 不可变 commit 验证**：
   - 任务为纯只读 review、代码审计、文档审阅、commit diff 检查；
   - brief 必须**明确禁止写文件**（"禁止修改任何源码、测试、生成物"）；
   - 若审计过程需要构建副作用（如跑测试生成覆盖率），**复用一个已有的 audit worktree**，不重复新建；
   - 只写 graph 数据（看板状态、事件流）可显式不建 worktree，但改源码仍必须隔离。

2. **特别小的独立文档/记忆修改（快速通道）**：
   - 改动范围严格限定于**一个或少量文件**、**无构建副作用**、**无并发冲突风险**；
   - 由 supervisor 直接在当前版本分支做，或子代理显式 `worktree=false` 并记录理由；
   - 子代理不得擅自套用此例外——只有 supervisor 能批准快速通道。

**铁律**：`worktree=false` **绝不意味着可直接修改 main**。即使 worktree=false，仍禁止：
- 修改 main 分支（main 只读）；
- 修改多文件源码、修改生成物、修改测试；
- 在任意分支上直接提交碎提交（review 后统一收口）；
- 绕过 golden/3080/主 DSH_HOME 隔离、绕过人工 review/delivered gate。

## Worktree 安全清理

删除旧 worktree 前必须逐项确认，**禁止批量 `rm -rf`**：

1. **无未提交改动**：`git -C <worktree> status --short` 输出为空；
2. **无活跃代理**：确认该 worktree 无 running/idle 子代理（`list_agents` 排查）；
3. **无唯一审计证据**：确认该 worktree 内无未归档的测试报告、覆盖率、日志等唯一证据；
4. **可由 commit 恢复**：确认 worktree 内所有有价值改动已 commit 到其分支，必要时已 push 到远程；
5. **逐项确认后**再 `git worktree remove <path>`，不可脚本化批量清理。

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
bash scripts/dev-dsh-instance.sh main-published   # point main profile at published dsh-graph (^0.7.2) + reinstall
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

## Important Notes

- The generated file maintains the `window.__ModuleLoader__.load` contract required by the dsh client
- The generated marker is added at the top of the file before any module content
- This policy prevents accidental modification of generated code and ensures build consistency

## Harness Text-File Editing Notes

- Before using `edit` or `write` on an existing text file, always read it first; otherwise the tool may trigger "edit requires reading ... first".
- In read output such as `132:     text`, `132:` is tool-added line-number metadata, and the first space after the colon is also a separator; neither belongs to the file content. Match `old_string`/`new_string` against the actual body text exactly; copy indentation and spaces only from the body after that separator, never the line number or separator space. If `old_string` does not match, re-read the surrounding content and adjust rather than retrying blindly.
- For multiline `edit`, read output adds a line number, colon, and exactly one separator space to every line. When constructing multiline `old_string`/`new_string`, remove exactly that one separator space from every line, including the second and later lines after each `\n`; preserve any remaining spaces that belong to the body. This also applies to blank or whitespace-only lines: after each `\n`, discard the displayed line's first space before counting body spaces. For example, if read shows `132:    first` and `133:    second` (the first space after each colon is metadata, leaving three body spaces), use `   first\n   second`, not `   first\n    second`. Do not fix only the first line; if matching fails, re-read the surrounding multiple lines and check each line individually.
- `grep` patterns are parsed as ripgrep regular expressions and are not automatically escaped. When searching for literal text, escape regex metacharacters yourself (for example, write `Card\(g,` rather than `Card(g,`), and escape `[ ] . ? + * | ^ $` and other metacharacters as needed.
- These notes describe current Harness tool behavior; if the official read output format changes, follow the format actually returned at that time.

## Security & Review Boundary (v0.8)

> 本章节固化 v0.8 本地开发工具的审查边界，防止 fresh review 对本地工具无限升级攻击模型。
> 来源：g-206（负责人确认）。

### 威胁模型：单用户本地、owner-trusted

- **适用场景**：dsh-graph 作为本地 dsh 插件运行，工作区由单一用户拥有并信任。
- **强制基线（必须阻断）**：
  1. **跨 workspace 越界**——插件不得访问当前工作区之外的文件系统路径；
  2. **凭据泄漏**——API key、token、密码不得明文写入非受控日志或返回给无权限调用方；
  3. **明显 symlink / 路径错误**——对 `..`、符号链接、绝对路径拼接等常见路径操纵必须有防御；
  4. **普通并发数据丢失**——单用户本地多进程场景下，必须保证有限本地锁 / CAS 和正常数据完整性；
  5. **未授权破坏性写入**——不得在无确认情况下执行 `rm -rf`、覆写生产配置等不可逆操作；
  6. **错误输入崩溃**——对畸形输入、空值、超大值等必须返回可控错误，不得未捕获异常导致进程崩溃。
- **边界外（不作为每个功能的强制 BLOCK，若功能确实需要再单独提高等级）**：
  - 同 UID 恶意 FD 复用；
  - 内核级全量 TOCTOU；
  - 分布式一致性；
  - 无限递归 rollback。

### 并发模型：单用户本地多进程

- 要求**有限本地锁 / CAS**和正常数据完整性；
- **不要求**分布式系统语义（如分布式事务、线性一致性、Paxos/Raft）。

### `@att/` 路径语法：明确受限

- `@att/` 采取**明确受限语法**，仅用于引用附件/资源；
- 已知限制必须记录在相关目标或长期记忆中；
- **不无限扩张 regex 边界**——每新增一种 `@att/` 变体需单独评估并记录。

### 共享基础设施优先

- 共享事务 / 错误处理与 REST schema middleware 优先于各功能重复修复；
- 新增功能应先复用现有中间件，再考虑局部补丁。
