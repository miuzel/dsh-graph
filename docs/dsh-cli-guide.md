# dsh-cli 使用说明（g-314）

`dsh-cli` 是 dsh-graph 的**轻量只读命令行**：直接读写工作区里的 `.dsh-graph/` 资产，
不起常驻服务、不联网、不引入任何第三方 CLI 框架。面向单兵 CLI 工具（Claude Code、Codex、
OpenCode 等）里「看一眼看板」的场景：一条命令、毫秒级返回。

## 安装与运行形态

两种形态共用同一入口源码 `bin/dsh-cli.mjs`：

| 形态 | 入口 | 加载的核心 |
| --- | --- | --- |
| 发布形态（全局/项目本地安装） | 包内 `dist/bin/dsh-cli.mjs` | 同目录上层 `dist/core/cli/*.js`（编译产物） |
| 源码形态（本仓库开发） | 仓库根 `bin/dsh-cli.mjs` | `core/cli/main.ts`（Node ≥ 22.6 原生 type-stripping） |

`dsh-graph-host/package.json` 的 `bin` 字段注册了 `dsh-cli`，因此：

```bash
# 全局
npm i -g dsh-graph && dsh-cli info
# 项目本地（package.json devDependencies）
npm i -D dsh-graph && npx dsh-cli info      # 或 ./node_modules/.bin/dsh-cli info
# 不预先安装的一次性用法（临时拉包后执行其 bin）
npx --package dsh-graph dsh-cli info
# 本仓库开发（先构建）
bash scripts/build.sh
node dist/bin/dsh-cli.mjs info
```

> **平台**：本 CLI 的实测平台是 **Linux / WSL2**；**Windows / macOS 未验证** —— 未做真机兼容性
> 测试，尤其是 Windows 下的 `npx` 调用链与路径分隔符处理，勿据本文推定「已支持」。

## 命令

```text
dsh-cli info             环境自检：Node 版本、graph root、初始化状态、关键文件可读性
dsh-cli status           看板状态：目标数、事件数、最近事件、规则库版本、问题列表
dsh-cli goal list        列出目标（默认不含归档；--all 含归档）
dsh-cli goal show <id>   显示单个目标（元信息 + 正文）
dsh-cli sync             把常驻硬性事实与目标概览投影到 .claude/CLAUDE.md 与 AGENTS.md 的受控区段（g-315）
dsh-cli version          显示版本
dsh-cli help             显示帮助
```

选项：`--root <path>`（显式指定 graph root）、`--json`（机器可读输出）、
`--all/-a`（`goal list` 含归档）、`--full` / `--active-only` / `--target <path>`（仅 `sync`，见下）、
`--help/-h`、`--version/-V`。

### 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 运行期失败：非工作区、未初始化、目标不存在、损坏配置/事件流、非法路径 |
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

`--root` 接受兄弟目录写法（`cd src && dsh-cli --root ../.dsh-graph`），这是最常见的用法。
最终 root 一律经 core 的 `resolveCanonicalRoot` 归一（Git linked worktree 归一、scratch 边界、
symlink 拒收），CLI 不重写这套语义。

## `dsh-cli sync`：上下文投影（g-315）

把 `.dsh-graph` 里的**常驻硬性事实**与**版本目标概览**投影成 `.claude/CLAUDE.md` 与 `AGENTS.md`
里的受控区段，供 Claude Code / Codex 等单兵工具作为稳定前缀。设计目的只有一个：让前缀**尽量不变**，
从而吃到 Prompt 缓存（缓存按前缀匹配，前缀一变整段失效）。

```bash
dsh-cli sync                        # 写两个文档
dsh-cli sync --target AGENTS.md     # 只写其中一个
dsh-cli sync --full                 # 不折叠目标列表（默认单次最多列 40 个）
dsh-cli sync --active-only          # 跳过终态目标（delivered）
dsh-cli sync --json                 # 机器可读：written/unchanged/prefix_sha256/problems
```

### 写入位置

| 文档 | 位置 | 说明 |
| --- | --- | --- |
| `.claude/CLAUDE.md` | **发起调用的 workspace 根** | Claude Code 的项目级指令文件；不存在则新建 |
| `AGENTS.md` | **发起调用的 workspace 根** | 与本仓库自己的 `AGENTS.md` 是同一套约定 |

「发起调用的 workspace」= 你运行命令时所在的 Git 工作树根（非 git 目录则就是当前目录）。
**在主树的 tracked 子目录**（如 `core/`、`docs/`）里运行时，写入位置解析到这里所属的工作树根
（即主树根），**不是**那个子目录；在 linked worktree 的子目录里运行同理，写到该 worktree 根。

> 为什么不直接取「看板根的父目录」：在 Git **linked worktree** 里，任何 dsh-cli 命令的看板根都会被
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
  `--full` 展开。完整清单仍用 `dsh-cli goal list`。
- 只读资产：sync **不写 `.dsh-graph` 的任何字节**（测试用整树快照 + mtime/inode 断言）。

## 复用与安全边界

- **复用 core**：`project.yaml` 走 `readProjectConfig`（含 `*_malformed` fail-closed 标志）、
  事件流走 `readEvents`、目标文件走 `listGoalFiles`/`loadGoal`/`findGoalFile`、
  frontmatter 与状态机全部来自 `core/domain/*`。CLI 不复制 frontmatter 解析、事件解析、
  状态机或锁逻辑（由 `core/tests/g314-dsh-cli.test.ts` 的可执行代码静态扫描守卫）。
- **只读**：当前命令集不写任何文件。写操作留待后续目标，且须遵守 core 的锁与 CAS。
- **不读凭据、不联网**：源码不含 `node:http/https/net/dns/tls` 或 `fetch`。
- **隔离**：不触碰用户全局配置，不写其他项目数据。

## 冷启动实测（判据 2）

口径：同机 `spawnSync(node, [entry, ...cmd])` **全进程**耗时（含 Node 启动、模块加载、
命令执行与退出），每条命令重复 30 次取 **best / median**。
机器：WSL2（Arch Linux，内核含 `microsoft-standard-WSL2`）；Node `v26.7.0`；
基线 `node -e 0` ≈ **20ms**（纯启动开销）。入口：`dist/bin/dsh-cli.mjs`（发布形态）。

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

### 真实大看板（本仓主看板：406 目标 / 18404 事件 / 74MB）

| 命令 | best (ms) | median (ms) | 判据 2 |
| --- | --- | --- | --- |
| `version` | 23.2 | 27.6 | ✅ |
| `help` | 23.1 | 27.9 | ✅ |
| `info` | 38.1 | 47.7 | ✅ |
| `status` | 141.9 | 147.9 | ❌ **未达标** |
| `goal list` | 92.0 | 97.7 | ✅ |
| `goal show g-314` | 90.0 | 95.6 | ✅ |

**如实报告**：在 18404 条事件的超大看板上，`status` 的 best 为 142ms、median 148ms，
**超过 100ms**。未通过降低判据或改写口径来掩盖；成本结构如下（均为实测分项）：

- Node 启动 ≈20ms（不可压缩）；
- `core/ops.ts` 冷加载 ≈41ms（判据 3 要求复用 core，其模块图含 `yaml` 等，CLI 不得绕开）；
- root 定位（含一次 `git` 子进程）≈16ms；
- 看板计算：事件流逐行校验 ≈34ms（18404 行）+ 目标枚举/配置解析 ≈30ms。

即 `status` 的耗时**随事件流线性增长**：事件流越大越慢，与「启动」无关。
小看板（典型用户场景）为 76ms，已达标；大看板未达标是**数据规模**导致的，
不是可再压缩的实现缺陷（`goal list`/`goal show` 在同样大看板上分别为 92/90ms，
已是「加载 ops 41ms + 实际计算」的下限结构）。

后续若需在超大看板上达标，可选路径（本次未做，留给后续目标）：
为 `events.jsonl` 建增量索引（apex count + 末事件指针），使 `status` 不再线性扫全量事件流。

> 复现：`node --test core/tests/g314-dsh-cli.test.ts`；手工粗测
> `for i in $(seq 1 30); do /usr/bin/time -f %e node dist/bin/dsh-cli.mjs status >/dev/null; done`

**为什么 `info`/`version` 快**：入口只静态依赖 node 内置模块与 `core/root.ts`；
`info` 走轻量 `core/cli/health.ts`（stat 级探针 + 只读 1 字节确认），
而会连带 `ops.ts` + `yaml` 的 `core/cli/diagnostics.ts` 被 `status`/`goal` 命令**动态 import**。

## 测试

```bash
node --test core/tests/g314-dsh-cli.test.ts   # 本目标专项：21 条用例
node scripts/run-tests.mjs                     # 整套件自证闸门
./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

专项套件覆盖：参数解析（含负向）、路径定位（向上查找 / 绝对 / 相对 / 危险路径 / 非工作区）、
环境容错（未初始化 / 损坏事件流 / 损坏 `project.yaml` / 损坏目标 frontmatter）、
退出码分层、零副作用快照（内容哈希 + inode + mtime）、复用 core 的静态与行为断言。

**反向变异对照（判据 7）据实分三类，共 4 条**：

- **真源码副本变异（2 条）**：把 `core/` 与入口 `bin/dsh-cli.mjs` 复制进 `tmp/` 沙箱，就地改坏关键行后用
  真进程实测 —— ①拆掉危险路径守卫（`$DSH_HOME` 子目录）后「必须拒绝」的断言变红；②把 `failure()`
  的退出码吞成 `0` 后「运行期失败必须退出 1」的断言变红。两条都先断言**未变异副本**与仓内实现一致，
  且变异锚点**恰好命中 1 处**，避免「失败其实来自别的原因」的假阳性。
- **真变异（1 条）**：复制真实入口源码到没有 `../core/cli` 的位置 ⇒ 必须报「找不到可执行核心模块」并非零退出。
- **敏感性对照（1 条）**：向看板树写入一个文件后，零副作用快照断言必红（证明快照口径能抓住写入；
  它不是源码变异，口径已在该用例注释与标题中写明）。
