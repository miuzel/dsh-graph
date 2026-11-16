# dsh-graph 使用说明（g-314）

`dsh-graph` 是 dsh-graph 的**轻量命令行**（除 `sync`、`claim`、`submit` 外全部只读）：直接读写工作区里的 `.dsh-graph/` 资产，
不起常驻服务、不联网、不引入任何第三方 CLI 框架。面向单兵 CLI 工具（Claude Code、Codex、
OpenCode 等）里「看一眼看板」的场景：一条命令、毫秒级返回。

## 安装与运行形态

两种形态共用同一入口源码 `bin/dsh-graph.mjs`：

| 形态 | 入口 | 加载的核心 |
| --- | --- | --- |
| 发布形态（全局/项目本地安装） | 包内 `dist/bin/dsh-graph.mjs` | 同目录上层 `dist/core/cli/*.js`（编译产物） |
| 源码形态（本仓库开发） | 仓库根 `bin/dsh-graph.mjs` | `core/cli/main.ts`（Node ≥ 22.6 原生 type-stripping） |

`dsh-graph-host/package.json` 的 `bin` 字段注册了 `dsh-graph`，因此：

```bash
# 全局
npm i -g dsh-graph && dsh-graph info
# 项目本地（package.json devDependencies）
npm i -D dsh-graph && npx dsh-graph info      # 或 ./node_modules/.bin/dsh-graph info
# 不预先安装的一次性用法（临时拉包后执行其 bin）
npx --package dsh-graph dsh-graph info
# 本仓库开发（先构建）
bash scripts/build.sh
node dist/bin/dsh-graph.mjs info
```

> **平台**：本 CLI 的实测平台是 **Linux / WSL2**；**Windows / macOS 未验证** —— 未做真机兼容性
> 测试，尤其是 Windows 下的 `npx` 调用链与路径分隔符处理，勿据本文推定「已支持」。

## 命令

```text
dsh-graph info             环境自检：Node 版本、graph root、初始化状态、关键文件可读性
dsh-graph status           看板状态：目标数、事件数、最近事件、规则库版本、问题列表
dsh-graph goal list        列出目标（默认不含归档；--all 含归档）
dsh-graph goal show <id>   显示单个目标（元信息 + 正文）
dsh-graph sync             把常驻硬性事实与目标概览投影到 .claude/CLAUDE.md 与 AGENTS.md 的受控区段（g-315）
dsh-graph claim <goal-id>  认领目标：推进到 in_progress 并输出轻量任务单（目标 + 判据 + 边界）（g-316）
dsh-graph submit [goal-id] 提交：跑全量自检门禁 + Git 变更统计 → 推进到 review + review.requested（g-317）
dsh-graph version          显示版本
dsh-graph help             显示帮助
```

选项：`--root <path>`（显式指定 graph root）、`--json`（机器可读输出）、
`--all/-a`（`goal list` 含归档）、`--full` / `--active-only` / `--target <path>`（仅 `sync`，见下）、
`--skip-tests`（仅 `submit`，**默认关闭**，见下）、`--help/-h`、`--version/-V`。

### 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 运行期失败：非工作区、未初始化、目标不存在、损坏配置/事件流、非法路径、claim/submit 的可判定拒绝（含 `submit --skip-tests` 的「未验证」降级） |
| `2` | 用法错误：未知命令/子命令/选项、缺参、多余参数 |

失败一律给出**中文可读原因**，且**零副作用**（不 init、不记事件、不建目录）。

### 路径定位

- 默认从当前目录**向上查找** `.dsh-graph`，命中最近的祖先即用；
- `--root` 支持绝对路径与相对路径（相对当前目录），可指向看板目录本身（`.../.dsh-graph`）
  或它所在的 workspace（构建时按 core 的默认相对 root 补齐 `.dsh-graph`）；
- **危险路径拦截只对显式 `--root` 生效**：文件系统根、家目录本身、用户全局配置目录
  （`$DSH_HOME`，默认 `~/.dsh`）及其子目录一律拒绝，符号链接目录同样拒绝。
  默认的「向上查找」路径不做这套拦截（它只认 `.dsh-graph` 目录本体，见下一条）；
- 向上查找**只认 `.dsh-graph` 目录本体**，到根仍没有即报「非工作区」，
  **不会**回落到用户全局配置 —— 隔离项目不会误用 `~/.dsh` 下的东西。

`--root` 接受兄弟目录写法（`cd src && dsh-graph --root ../.dsh-graph`），这是最常见的用法。
最终 root 一律经 core 的 `resolveCanonicalRoot` 归一（Git linked worktree 归一、scratch 边界、
symlink 拒收），CLI 不重写这套语义。

## `dsh-graph sync`：上下文投影（g-315）

把 `.dsh-graph` 里的**常驻硬性事实**与**版本目标概览**投影成 `.claude/CLAUDE.md` 与 `AGENTS.md`
里的受控区段，供 Claude Code / Codex 等单兵工具作为稳定前缀。设计目的只有一个：让前缀**尽量不变**，
从而吃到 Prompt 缓存（缓存按前缀匹配，前缀一变整段失效）。

```bash
dsh-graph sync                        # 写两个文档
dsh-graph sync --target AGENTS.md     # 只写其中一个
dsh-graph sync --full                 # 不折叠目标列表（默认单次最多列 40 个）
dsh-graph sync --active-only          # 跳过终态目标（delivered）
dsh-graph sync --json                 # 机器可读：written/unchanged/prefix_sha256/problems
```

### 写入位置

| 文档 | 位置 | 说明 |
| --- | --- | --- |
| `.claude/CLAUDE.md` | **发起调用的 workspace 根** | Claude Code 的项目级指令文件；不存在则新建 |
| `AGENTS.md` | **发起调用的 workspace 根** | 与本仓库自己的 `AGENTS.md` 是同一套约定 |

「发起调用的 workspace」= 你运行命令时所在的 Git 工作树根（非 git 目录则就是当前目录）。
**在主树的 tracked 子目录**（如 `core/`、`docs/`）里运行时，写入位置解析到这里所属的工作树根
（即主树根），**不是**那个子目录；在 linked worktree 的子目录里运行同理，写到该 worktree 根。

> 为什么不直接取「看板根的父目录」：在 Git **linked worktree** 里，任何 dsh-graph 命令的看板根都会被
> core 归一到**主树**（`mode: "canonicalized"`）。若按看板根反推写入位置，在 worktree 里 sync 就会
> 悄悄改写**主树**的 `AGENTS.md`，而 worktree 自己的文件纹丝不动。g-315 实测复现过这个坑，
> 现在的实现按「调用方工作树」独立解析写入位置（`resolveWorkspaceForSync`），
> 跨树（看板不属于调用方工作树）时**直接拒绝**，不替用户猜。

### 输出结构：稳定前缀 + 动态概览

区段内部是固定两段，顺序不可交换：

```text
<!-- dsh-graph:sync:begin -->
### A. 硬性事实（稳定前缀，勿手改）     ← standing 记忆，逐条一行，按 id 排序
### B. 动态概览（目标状态，可随时变化） ← 版本、状态计数、目标清单
<!-- dsh-graph:sync:end -->
```

- **A 段只由 standing 记忆自身决定**：不含计数、不含时间戳、不含绝对路径。因此记忆集合不变时，
  A 段逐字节不变（`--json` 的 `prefix_sha256` 可直接对比）；增删一个目标、改一个状态**不会**影响它。
- **A 段不受 `updated_at` 重排影响**：条目终序按记忆 **id** 固定（core 的排序末级是更新时间，
  修订一条记忆会重排整段，那正好毁掉前缀）。
- **B 段允许变化**：它本来就在尾部，变化只影响尾部。
- **输出是输入的纯函数**：刻意不写「生成时间」——这两个文档是要入库的，时间戳会让每次运行都
  「有变更」（提交噪音 + 「无变更不写」形同虚设）。

### 写入策略（受控区段 / 追加 / 原子写）

1. **有标记**：只替换 `BEGIN`/`END` 之间的内容。**区段之外的字节逐字保留**（不重排、不重写行尾、
   不 trim）——用户手写的任何内容都不会被碰。
2. **无标记**（首次使用 / 用户自己写的 AGENTS.md）：追加到文件**末尾**，原有内容完整保留在最前面。
   补行尾的规则是确定的：原文不以换行结尾则补一个（沿用原文 `\r\n`/`\n` 风格），绝不整文件覆盖。
3. **标记畸形**（多个 `BEGIN`、只有一端、顺序颠倒）：**拒绝并退出 1**，一个字节都不写。
   不猜哪段是受控区段——猜错会把用户手写内容夹进区段里，下次 sync 直接吞掉。
4. **无变更不写**：新内容与磁盘逐字节相同则跳过该文件（mtime / inode 都不变）。
5. **原子写**：有变更时经 core 的 `atomicWrite`（同目录临时文件 + fsync + rename），失败不留半文件。
6. **先全部成功再写**：推广到两个文件时，**先完成全部渲染与可写性预检**，任一输入或目标出问题
   就整体失败、两个文件都不写（不存在「写了一个、第二个失败」的部分写入）。

### 边界与退出码

| 场景 | 退出码 | 行为 |
| --- | --- | --- |
| 空记忆 / 无未发布版本 | `0` | 写入带「（没有常驻记忆）」「（无未发布版本）」的可读区段（新仓库也要能 sync 成功） |
| 目标文件缺失 | `0` | 新建（从区段开始） |
| **目标文件损坏**（frontmatter 非 JSON 等无法解析） | `1` | 点名坏文件，**不写任何文件**（core 的看板投影会静默跳过坏目标 ⇒ 目标会从投影里无声消失；与 `goal list` 的报错口径一致） |
| `memory.jsonl` 有坏行 | `1` | 报行号与原因，**不写任何文件**（core 读取会静默跳过坏行 ⇒ 硬性事实会无声消失） |
| 事件流损坏 | `1` | 报错，不写 |
| 目标目录只读 / 目标不可读 / 目标是目录 | `1` | 报错，**两个文件都不写** |
| 锁定标记畸形 | `1` | 报错，不写 |
| `--target` 值非法 | `2` | 用法错误 |

### 投影范围与取舍（如实记录）

- 记忆：**只投影 `scope: "standing"`**。`kind: "user"` 的 standing 记忆**也投影**——core 的
  `recallMemory` 对 user 条目按 owner 隔离，而 CLI 没有身份上下文；若照 host 的无身份路径过滤，
  用户亲手登记的常驻约束会被静默排除。sync 写的是本工作区自己的文件，故按「本工作区全部
  standing 事实」投影（测试里对这一取舍有交叉断言）。
- 目标：**只投影未 `released` 的版本**（`released` 属历史）；版本内目标**不按状态过滤**
  （`delivered` / `blocked` 也是真实状态，静默过滤会让投影看起来比看板干净）。需要只看在做的
  事项时用 `--active-only`。
- 折叠：B 段单次最多列 40 个目标（按状态优先级 + id 排序），其余折叠成一行计数；
  `--full` 展开。完整清单仍用 `dsh-graph goal list`。
- 只读资产：sync **不写 `.dsh-graph` 的任何字节**（测试用整树快照 + mtime/inode 断言）。

## `dsh-graph claim <goal-id>`：认领目标 + 判据注入（g-316）

单兵工具写代码快，但容易「需求走偏」或「遗漏非功能约束」。`claim` 在动手前把目标与判据摊在
终端上，并把看板状态推进到 `in_progress`，让「先看判据再改代码」成为默认动作。

```bash
dsh-graph claim g-42            # 人类可读任务单
dsh-graph claim g-42 --json     # 结构化（供脚本/Agent 读取）
```

输出（示例）：

```text
已认领 g-42：实现 xxx
类型：feature @v1.0.0	状态：planning → in_progress

质量判据（3 项，逐条自检后再声明完成）：
  · 1. 命令必须精确解析描述与判据
  √ 2. 状态迁移复用 core 状态机（已验）
  · 3. 重复 claim 幂等

边界提示：
  - 状态：planning → in_progress（已写入一条 goal.transition 事件，事件先于文件）
  - 本次只做状态认领 + 任务单：不派发子代理、不建 attempt 目录、不改任何代码。
  - 看板根：/path/to/ws/.dsh-graph（本次写操作只落此目录）
```

行首 `·`/`√` 标记该判据是否已带「已验」标记（判定复用 core 的 `isCriterionVerified`）。

### 它能做什么 / 不做什么

| | 说明 |
| --- | --- |
| ✅ 读 | 目标元信息（id/标题/类型/版本/状态）、「质量判据」小节逐条判据 |
| ✅ 写 | **只**把状态推进到 `in_progress`（经 core `transition`：状态机校验 → 事件先行 → 写目标文件） |
| ❌ 不做 | 不派发子代理、不建 attempt 目录、不改代码、不写 `.claude/` 或 `AGENTS.md` |
| ❌ 不做 | 不对已有判据做任何修改（判据是质量红线，claim 只读不写） |

### 状态迁移与幂等

- 合法入边：`planning` / `collecting` / `ready` → `in_progress`（core 状态机 `machine.ts` 的定义，
  CLI 不复制也不放宽）。进入 `in_progress` 的前置条件由 core 强制：判据小节非空、`rules_snapshot`
  已记录、存在 `criteria.confirmed` 事件。
- **已是 `in_progress` ⇒ 幂等成功**（退出 `0`，`--json` 的 `changed=false`）：**不写任何事件**、
  不改任何字节，仍输出完整任务单（可直接重复执行）。
- **并发**：同一目标的 claim 经 core 的 `withLocalLock(.lock.claim-<id>)` 串行化；后到者在锁内
  重读到 `in_progress` 即走幂等路径 ⇒ 并发 N 路只产生**一条** `goal.transition`。若锁被另一活进程
  持有超过 1.5s，则明确拒绝（`claim-lock-busy`）而不是无限等待。

### 事件先行（判据 3）

写路径唯一，且顺序由 core 的 `commitPrepared` 决定：**先** `appendEvent`（`events.jsonl`）**再**
`saveGoal`（目标文件）。

- 事件阶段失败 ⇒ 目标文件**逐字节未变**，报「事件阶段」并注明「目标文件未改动」；
- 持久化阶段失败 ⇒ 事件**已落盘**、目标文件未更新；core 补记 `tx.persist_failed`，CLI 报
  「事件已落盘、重试同一命令即可收敛」（`--json`/stderr 均如实标注，不假装零写入）。

### 边界与退出码

| 场景 | 退出码 | 行为 / 原因 |
| --- | --- | --- |
| 成功（含幂等命中） | `0` | 输出任务单 |
| 缺目标 ID / 多参 / 未知选项 | `2` | 用法错误 + 「运行 dsh-graph help 查看用法」 |
| 目标不存在 | `1` | `目标不存在：<id>` |
| **目标文件损坏** | `1` | 点名损坏文件（`goal-file-corrupt`），**不**伪装成「不存在」 |
| 已归档 | `1` | `goal-archived` |
| 无判据 / 空判据（只有模板占位） | `1` | `criteria-missing`，并提示用 `graph_set_criteria` 登记 |
| 判据未确认（无 `criteria.confirmed`） | `1` | `criteria-unconfirmed` |
| 缺 `rules_snapshot` | `1` | `rules-version-missing` |
| 状态不允许（`review`/`delivered`/`blocked`/`draft`） | `1` | `state-not-allowed`，并列出可认领的入边 |
| 非 dsh-graph 工作区 | `1` | 提示在项目根运行或 `--root`；**不**初始化、不回落全局配置 |
| 看板未初始化（缺 `events.jsonl`） | `1` | 提示先初始化 |
| 只读看板目录 | `1` | `board-unwritable`；预检在**取锁之前** ⇒ 连锁文件都不建 |
| 并发认领（锁被占用） | `1` | `claim-lock-busy` |
| 事件阶段失败 | `1` | 目标文件零改动 |
| 持久化阶段失败 | `1` | 事件已落盘，如实标注 |

**除「持久化阶段失败」（事件先行的固有余量）外，所有拒绝路径都是零副作用**：判定全部发生在
任何写入之前；测试用「整树内容哈希 + inode + mtime」快照逐字节比对。

## `dsh-graph submit [goal-id]`：机器化完成闭环（g-317）

写命令链的最后一环：跑项目自检、取**可信**结论、收集 Git 变更统计，然后把目标经 core 状态机推进到
`review` 并写入 `review.requested` —— 用机器证据完成交接，而不是自然语言扯皮。

```bash
dsh-graph submit                # 推断唯一在途目标（状态 in_progress）
dsh-graph submit g-317          # 显式指定目标
dsh-graph submit --json         # 结构化结果（字段稳定，供脚本/Agent 读取）
```

**目标推断（判据 1）**：「在途」的唯一口径是状态 `in_progress`。省略 goal-id 时若在途目标不是恰好
1 个 ⇒ **报错并列出候选**（`goal-ambiguous` / `goal-none-in-flight`），绝不猜。已在 `review` 的目标
**不算在途** —— 否则「重复提交」与「从在途推断」必然互相矛盾（见下方幂等）。
唯一的 `review` 目标只在**没有任何在途目标**时才被用来做**幂等重放推断**（`submit` 回一次
`changed=false` 的成功，不迁移、不写事件）；只要还有在途目标，它就不参与推断。

### 自检为什么必须可信（判据 2，本命令最关键的点）

项目 `scripts.test` 是 `node --test core/tests/*.test.ts`，而它**无法区分伪绿**：注入
`NODE_TEST_CONTEXT` 时 `node --test` 会静默 skip 全部文件并 `exit 0`；被取消 / 跳过 / 待办的用例
只计入 `cancelled` / `skipped` / `todo` 而非 `fail`。因此 `submit`：

- 只调用 **`node scripts/run-tests.mjs`**（含三方交叉校验的整套件自证闸门，即 AGENTS.md 里的
  全量门禁），并以**它的退出码**为准；**从不**把 `node --test` 的原始退出码当权威；
- 额外核对自证行，**任一条即阻断**：退出码非 0、退出码 0 却解析不到自证行（未运行 / 空选集）、
  `tests=0`、`skipped`/`todo`/`cancelled` 任一非 0、退出码 0 但 `fail>0`（计数自相矛盾）；
- 阻断时在简报里**点名原因**，而不是只回一个裸退出码。注意门禁的两种自证行**形态不同**，
  原因也来自不同的地方：

  | 结局 | 门禁自证行 | 转述来源 |
  | --- | --- | --- |
  | 通过 | `[run-tests] ✔ 自证通过：tests=… (>0) skipped=… fail=… cancelled=… todo=… pass=… exit=0 …`（**带计数**） | 计数逐个核对 |
  | 失败 | `[run-tests] ✖ 自证失败：<原因串>`（**只有原因，没有计数**） | 摘冒号后的原因串 |

  失败行**不含**计数，所以原因取自那一句本身——例如真实门禁跑出
  `✖ 自证失败：整套件自证闸门不达标 —— 有用例被**跳过**（skipped=1）` 时，`submit` 报的是
  「门禁原因：整套件自证闸门不达标 —— 有用例被**跳过**（skipped=1）」，而不是笼统的
  「测试未运行」。只有输出里**完全没有**任何自证行（测试真的没跑起来 / 输出被截断）时，
  才会报「未解析到自检自证行」。

不使用 `pnpm test` / `npx`：pnpm 的 `verifyDepsBeforeRun` 会隐式 install 并触发构建（AGENTS.md 明令禁项）。

### Git 变更统计口径（判据 4）

| 字段 | 命令 | 口径 |
| --- | --- | --- |
| `files_changed` / `insertions` / `deletions` | `git diff --numstat HEAD` | 相对 **HEAD** ⇒ **已暂存与未暂存一并计入**；**不含**未跟踪文件（它对 HEAD 没有 diff）；二进制文件按 0 行计但文件仍计 1 个 |
| `untracked_files` | `git ls-files --others --exclude-standard` | 未跟踪文件数；已被 `.gitignore` 忽略的**不计入**（它们本来就不会入库） |
| `clean` | `git status --porcelain` | 为空即干净 |

两种情况的行为都明确、都不静默：

- **工作区不干净**（正常情况：提交前本就有改动）⇒ 照常提交，统计写入事件作为机器证据；
- **无变更**（0 文件 / 0 行）⇒ **继续提交**，但在边界提示里明确标注「工作区无任何改动」；
- **非 git 工作区** ⇒ `changes=null` 并在边界里说明，不伪造 0。

### 状态迁移与事件顺序（判据 5）

写路径全部复用 core，CLI 不手写 events、不写 `goal.md`、不绕锁：

1. `core.requestAcceptReview` 写 **`review.requested`**（既有入口：`details` 含 `targetStage` /
   `what` / `snapshot`（截断 200 字），并追加机器证据摘要 `command` / `exit_code` / `verified` /
   `tests` / `pass` / `fail` / `skipped` / `todo` / `cancelled` / `changes` 计数）；
2. `core.transition` 把状态推进到 `review`（`goal.transition` 事件先行、再写 frontmatter）。

**顺序由测试钉住**：真源码副本里给 `transition` 注入失败后，`review.requested` 已落盘、状态未变，
`--json` 的 `events_written=true` 且 stderr 如实说明「事件已先行落盘」。

**幂等（判据 8）**：目标已在 `review` ⇒ **幂等成功**（退出 `0`、`changed=false`、`events=[]`、
**不产生任何事件、不改任何字节**）。为了让「重跑确认」始终可用，幂等命中**仍会重跑一次自检**并把
当前结论放进输出（不写看板）——否则一份短暂失败过的测试会让「已提交」永远无法被重复确认。

### 长文本零污染（判据 6）

测试输出与 diff 全文**绝不**进 `events.jsonl`、`--json` 与看板字段：进程内只保留输出尾部（≤400 字）
供人类简报使用；`--json` 只给计数、退出码与耗时；事件里只有计数摘要。测试对事件行长度与字段做
断言。

### `--skip-tests`（显式降级，默认关闭）

**默认关闭**。显式给出时跳过自检：看板仍然照常迁移到 `review`（事件里 `verified=false`），但

- 退出码为 **1**（不是 0 —— 未验证绝不伪装成通过）；
- 人类简报与 stderr 都**大声标注「未验证」**，`--json` 给 `verified=false` / `unverified=true`。

### 边界与退出码

| 场景 | 退出码 | code / 行为 |
| --- | --- | --- |
| 成功 | `0` | 输出完成简报（`--json` 为结构化结果） |
| 已在 `review`（幂等命中） | `0` | `changed=false`，零事件、零字节改动 |
| 缺目标 >1 个参数 / 未知选项 / `--skip-tests` 用在别的命令 | `2` | 用法错误 |
| 多个 / 没有在途目标（省略 goal-id） | `1` | `goal-ambiguous`（列候选）/ `goal-none-in-flight` |
| 目标不存在 | `1` | `goal-not-found` |
| **目标文件损坏** | `1` | `goal-file-corrupt`（**不**伪装成「不存在」） |
| 已归档 | `1` | `goal-archived` |
| 状态不允许（`draft`/`planning`/`collecting`/`ready`/`blocked`） | `1` | `state-not-allowed`，提示先 `claim` |
| **自检未通过 / 伪绿 / 空选集 / 未运行** | `1` | `self-check-blocked`，点名原因（转述门禁失败行里 `✖ 自证失败：` 之后的原因串）；看板零改动 |
| 非 dsh-graph 工作区 | `1` | 提示在项目根运行或 `--root`；零副作用 |
| 看板未初始化 | `1` | 提示先初始化 |
| 只读看板目录 | `1` | `board-unwritable`；预检在**取锁之前** ⇒ 连锁文件都不建 |
| 并发 submit（锁被占用） | `1` | `submit-lock-busy` |
| `review.requested` 写入失败 | `1` | `review-request-failed`，状态未变 |
| 迁移失败 | `1` | `transition-*`；`review.requested` 已先行落盘，如实标注 |
| `--skip-tests`（未验证降级） | `1` | 看板已写入，但 `verified=false` + 大声告警「未验证」 |

**除上述「事件已先行落盘」的固有余量外，所有拒绝路径都是零副作用**：判定全部发生在任何写入之前；
测试用「整树内容哈希 + inode + mtime」快照逐字节比对。注意自检本身会跑测试（可能写临时文件），
判据要求的「零副作用」指的是**看板状态与事件零改动**。

## 复用与安全边界

- **复用 core**：`project.yaml` 走 `readProjectConfig`（含 `*_malformed` fail-closed 标志）、
  事件流走 `readEvents`、目标文件走 `listGoalFiles`/`loadGoal`/`findGoalFile`、
  frontmatter 与状态机全部来自 `core/domain/*`。CLI 不复制 frontmatter 解析、事件解析、
  状态机或锁逻辑（由 `core/tests/g314-dsh-graph.test.ts` 的可执行代码静态扫描守卫）。
- **写命令只有三个**：`sync`（写 workspace 根的受控区段，不碰 `.dsh-graph`）、`claim` 与 `submit`
  （经 core 的锁 + 事件先行写看板状态）。其余命令不写任何文件。
  `claim` 的迁移一律经 core 的 `transition`；`submit` 一律经 core 的 `requestAcceptReview` +
  `transition`（CLI 不拼事件行、不自己写目标文件）；分别由 `core/tests/g316-claim.test.ts` 与
  `core/tests/g317-submit.test.ts` 的可执行代码静态扫描守卫。
- **不读凭据、不联网**：源码不含 `node:http/https/net/dns/tls` 或 `fetch`。
- **隔离**：不触碰用户全局配置，不写其他项目数据。

## 冷启动实测（判据 2）

口径：同机 `spawnSync(node, [entry, ...cmd])` **全进程**耗时（含 Node 启动、模块加载、
命令执行与退出），每条命令重复 30 次取 **best / median**。
机器：WSL2（Arch Linux，内核含 `microsoft-standard-WSL2`）；Node `v26.7.0`；
基线 `node -e 0` ≈ **20ms**（纯启动开销）。入口：`dist/bin/dsh-graph.mjs`（发布形态）。

### 典型小型看板（12 目标 / 1 事件）

| 命令 | best (ms) | median (ms) |
| --- | --- | --- |
| `version` | 24.3 | 30.3 |
| `help` | 23.9 | 29.5 |
| `info` | 42.3 | 47.4 |
| `status` | 75.8 | 81.9 |
| `goal list` | 74.3 | 81.8 |
| `goal show g-314` | 73.3 | 81.9 |

**全部 < 100ms**（含 median），满足判据 2。

### 真实大看板（本仓主看板：g-630 实测）

看板规模：**401 目标 / 18658 事件 / 18MB**。同机、同 Node `v26.7.0`、同入口 `dist/bin/dsh-graph.mjs`，
`spawnSync` 全进程耗时，每项 **n=21**（median / p95 / min / max，单位 ms）：

| 版本 | median | p95 | min | max | 判据（<100ms） |
| --- | --- | --- | --- | --- | --- |
| **优化前** `a93216f` | 158.3 | 169.8 | 151.5 | 170.5 | ❌ 未达标 |
| **优化后**（索引命中） | **83.9** | **96.2** | 75.6 | 97.2 | ✅ 达标 |
| 优化后（强制无索引、每次清缓存） | 188.9 | 200.7 | 180.6 | 203.7 | ❌（对照，见下） |

**小看板（12 目标 / 49 事件）**：优化前 median 65.9 / p95 72.8；优化后 median 65.4 / p95 78.7
（p95 的差异在噪声范围内：小看板本来就不是瓶颈，索引命中省下的时间淹没在启动抖动里）。

> **「强制无索引」一行是诚实的边界**：索引缺失时 `status` 仍会全量校验（这是 fail-safe 的一部分，
> 见 `docs/events-index-g630.md`）。首次运行、缓存被系统清理、或切换 `DSH_GRAPH_CACHE_HOME` 后，
> 会付一次全量成本；之后命中。

成本结构（优化后，实测分项）：Node 启动 ≈20ms（不可压缩）；`core/root.ts` + locate ≈30ms；
`core/cli/diagnostics.ts` 加载 ≈13ms；`collectStatus` 本体 ≈13ms（其中事件流已从
整档 `readFileSync` + 逐行 JSON 解析的 ≈36ms 降为 O(1) 探测 ≈1ms）。
`core/ops.ts`（≈69ms）改为**按需**加载——只用于 project.yaml 的畸形判定。

### g-630：事件流增量索引（判据 2 的达标路径）

旧实现在大看板上线性扫全量事件流；g-630 引入**增量索引**（`core/cli/events-index.ts`），
按 `size + inode + 头部指纹` 判定「未变 / 纯追加 / 截断 / 改写 / 替换」，只有前两者才给数，
其余一律 fail-safe 回退 `core.readEvents` 全量校验并给出可读告警。
索引落在**用户缓存目录**（`$XDG_CACHE_HOME/dsh-graph/`，可用 `DSH_GRAPH_CACHE_HOME` 覆盖），
**不写 `.dsh-graph`、不写源码树**，是纯缓存（可随时删除）。
设计与失效策略见 [`docs/events-index-g630.md`](events-index-g630.md)；测试见
`core/tests/g630-events-index.test.ts`（22 用例，含 3 组真源码副本反向变异）。

**为什么 `info`/`version` 快**：入口只静态依赖 node 内置模块与 `core/root.ts`；
`info` 走轻量 `core/cli/health.ts`（stat 级探针 + 只读 1 字节确认），
而会连带 `ops.ts` + `yaml` 的 `core/cli/diagnostics.ts` 被 `status`/`goal` 命令**动态 import**。

## 测试

```bash
node --test core/tests/g314-dsh-graph.test.ts   # g-314 专项：21 条用例
node --test core/tests/g315-sync-projection.test.ts  # g-315 专项
node --test core/tests/g316-claim.test.ts     # g-316 专项：22 条用例（含 4 条真源码副本反向变异）
node --test core/tests/g317-submit.test.ts    # g-317 专项（含真实门禁链路 + 2 条真源码副本反向变异）
node scripts/run-tests.mjs                     # 整套件自证闸门
./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

专项套件覆盖：参数解析（含负向）、路径定位（向上查找 / 绝对 / 相对 / 危险路径 / 非工作区）、
环境容错（未初始化 / 损坏事件流 / 损坏 `project.yaml` / 损坏目标 frontmatter）、
退出码分层、零副作用快照（内容哈希 + inode + mtime）、复用 core 的静态与行为断言。

**反向变异对照（判据 7）据实分三类，共 4 条**：

- **真源码副本变异（2 条）**：把 `core/` 与入口 `bin/dsh-graph.mjs` 复制进 `tmp/` 沙箱，就地改坏关键行后用
  真进程实测 —— ①拆掉危险路径守卫（`$DSH_HOME` 子目录）后「必须拒绝」的断言变红；②把 `failure()`
  的退出码吞成 `0` 后「运行期失败必须退出 1」的断言变红。两条都先断言**未变异副本**与仓内实现一致，
  且变异锚点**恰好命中 1 处**，避免「失败其实来自别的原因」的假阳性。
- **真变异（1 条）**：复制真实入口源码到没有 `../core/cli` 的位置 ⇒ 必须报「找不到可执行核心模块」并非零退出。
- **敏感性对照（1 条）**：向看板树写入一个文件后，零副作用快照断言必红（证明快照口径能抓住写入；
  它不是源码变异，口径已在该用例注释与标题中写明）。
