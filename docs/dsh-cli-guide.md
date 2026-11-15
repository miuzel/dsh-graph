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
dsh-cli version          显示版本
dsh-cli help             显示帮助
```

选项：`--root <path>`（显式指定 graph root）、`--json`（机器可读输出）、
`--all/-a`（`goal list` 含归档）、`--help/-h`、`--version/-V`。

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
