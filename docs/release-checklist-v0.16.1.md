# dsh-graph v0.16.1 发布检查清单

> 流程沿用 v0.10.0 起确立的做法：主管完成准备并（经负责人授权后）合并 `main` + 打 annotated tag，
> 再由**负责人手动执行 `pnpm publish`**。
> 本文件同时承载 v0.16.1 的 Release Notes 与发布前/后检查项。
> 版本线说明：本次为 `v0.16.1`（上一发布版本为 `v0.16.0`；版本号连续，属**补丁线**）。
> 本清单结构对照 [`docs/release-checklist-v0.16.0.md`](release-checklist-v0.16.0.md)。

**负责人 2026-09-26 的指示**（本次发布的授权边界）：

> 「准备发布，当前版本无跨平台敏感内容，可省略 win/mac 门禁，linux 已测试过，请跑一下门禁。」

据此：**Windows / macOS 原生门禁本次裁定省略**（发布红线 1 的**例外**，结论见 §3.1，**不得视为 PASS**）；
Linux 门禁由主管在 worktree 内**实跑**（§4）。**合并 `main` 与打 tag 经负责人 2026-09-26 授权后由主管在本机执行；`git push` 与 `pnpm publish` 仍由负责人人工 gate。**

**本次执行树**：worktree `.worktrees/g-368-att-02`，分支 `g-368-att-02`，基线 **`e345386`**
（= `v0.16.1-test` HEAD，含 g-362 + g-365 + g-366）。
**纪律（准备阶段）**：全部构建/测试/门禁均在 worktree 内完成；准备阶段**未写主树 `dist/`**、**未 push / 未 publish / 未打 tag**、
**未执行 `pnpm add` / `npm install`**（worktree 缺 `node_modules`，经**符号链接**指向主树只读复用，不入 git）。
**发布阶段（负责人授权后，2026-09-26）**：主管在本机合并 `v0.16.1-test` → `main`（`10045ca`）并创建 annotated tag `v0.16.1`；
**发布物在主树 tag 树重切并复算指纹**（见 §3.3 末「终值确认」）。`git push` 与 `pnpm publish` **仍未执行**。

---

## 1. v0.16.1 版本内容集（3 个交付目标）

版本主题：**宿主兼容声明落地 + 侧边栏窄档搜索可用性修复 + macOS/Linux 门禁执行件合并。**

### 1.1 g-365 —— 宿主兼容声明 `engines.dsh`（+ 三处 README 同步）

`dsh-graph-host/package.json` 新增 `engines.dsh = ">=0.1.5-rc.2 <0.1.8-0"`（上界 `-0` 排除 `0.1.8`
的**一切预发布与正式版**），供 dsh-market 等**宿主感知型市场**在卡片展示与安装/更新预检中读取；
市场的判定是 `engines.dsh` 与各 peer 范围的**合取**，且发现阶段**不读** `peerDependenciesMeta.optional`。
声明与 `@deepseek-ai/dsh-settings` peer `^0.1.5-rc.2` 取交集后自洽。
**用户可见效果**：市场卡片与安装预检能读到本插件的宿主兼容范围（自包含它的版本**发布后**生效 —— 市场读 registry 上已发布版本的清单且有缓存）。

### 1.2 g-366 —— 侧边栏窄档搜索改为单列「搜索结果」聚合泳道（bug 修复）

**已发布缺口**：v0.16.0（g-352 / g-358 引入）中，窄档分支的**全部**派生都把「搜索激活」当挂起条件
（`kanban.js` 逐条带 `!searchActiveQuery`），故窄档下激活搜索时看板会**退出单泳道收窄、退回横向多泳道
「全宽」网格**，面板比网格窄 ⇒ 横向裁切/滚动。搜索激活时所有卡片其实仍在渲染（只加高亮类），
⇒ 问题不是「隐藏非命中」而是**布局档位被切换**。

**修法（负责人裁定：方案 a）**：窄档 + 搜索激活时改为**单列「搜索结果」聚合泳道**，渲染跨分区命中卡、
非命中不渲染；既保住 g-233「搜索命中不得被视图过滤藏掉」，又保持窄档纵向单列。
**约束**：不新增状态真源、不新增持久化键；宽档（≥480px）搜索行为与视觉**零变化**。
**用户可见效果**：侧边栏窄档里搜索不再横向溢出/被裁，命中结果以单列聚合泳道呈现。

### 1.3 g-362 —— macOS / Linux 门禁合并为一份跨平台执行件

`scripts/platform-smoke-test.mjs` 成为**唯一一份** macOS/Linux 门禁实现：**转发**既有
`win-smoke-test.mjs` 的 T1–T5（在原生 macOS/Linux 上取得**平台效力**：T3–T5 真跑）+ **六项平台无关探针
P1–P6**（大小写敏感性 / 软链 root 边界 / 挂载类型识别 / 并发 CAS + 原子写 / 跨 FS rename(EXDEV) /
locale 编码逐字节往返）+ 平台无关审计 **M4**（Linux-only 假设扫描，承自 g-359）。
旧路径 `scripts/macos-smoke-test.mjs` 降为**一行转发 shim**，原实现归档在 `scripts/archived/`。
运行手册（命令序列、逐项判读、回填表）见 [`docs/platform-gate.md`](platform-gate.md)。
**用户可见效果**：macOS/Linux 侧结论的表达不再依赖两份并行实现（消除双份维护与漂移）。

> **文档口径校正（复核意见，2026-09-26）**：v0.16.0 小节内的「**`v0.17.0` 起** macOS 与 Linux 门禁已合并」
> 是**面向用户的现状陈述**（会随 `v0.16.1` 发布物出厂），原计划 `v0.17.0` 但**实际随 `v0.16.1` 发布** ⇒
> 出厂即不实。故**只改版本身份**：`v0.17.0 起` → **`v0.16.1` 起**（并注明「原计划 `v0.17.0`，实际随
> `v0.16.1` 发布」）。**同段内关于 v0.16.0 周期的历史事实一律未动**（Windows 10/0/0、macOS 2/0/3、
> 「用 v0.16.0 发布物 tarball 复验」等逐字保留）。校正范围见本清单「发布前检查项」与 §7.5。

## 2. 发布前检查项

- [x] `dsh-graph-host/package.json` version = **`0.16.1`**
- [x] `dsh-graph-host/lib/client/constants.js` 的 `PLUGIN_VERSION` = **`0.16.1`**，并 `bash scripts/build.sh`
      重建 `dist/lib/client.js`（含该常量）
- [x] **版本号三处一致**（发布门禁红线 2）：见 §3.2 实测输出
- [x] 两份 README（中/英）新增 **v0.16.1 小节**（engines.dsh / 窄档搜索单列聚合泳道 / 跨平台门禁执行件合并），
      **历史小节原文逐字保留**（`README.md` 的 `### 🚀 v0.16.0 新功能`、`dsh-graph-host/README.md` 的
      `### 🚀 v0.16.0 新功能` 与 `### 🚀 What's new in v0.16.0` 均为在其**上方**新增）
- [x] 包内 README（= `dsh-graph-host/README.md` 的副本）补「**当前版本** / **Current version**」行，
      使版本表述在**发布物内**亦可核对
- [x] **平台声明如实（发布红线 1 例外条款）**：两份 README 均写明本版**未**在原生 Windows/macOS 执行门禁
      （负责人裁定省略 + 理由）、**不得视为 PASS**，并注明最近真机结论出处（`docs/release-checklist-v0.16.0.md` §3 / §3.4）
- [x] **版本身份陈述校正（复核意见）**：把面向用户的「门禁合并」现状陈述由 `v0.17.0 起` 校正为
      **`v0.16.1` 起**（注明「原计划 `v0.17.0`，实际随 `v0.16.1` 发布」），共 **8 处文档/README + 2 处测试注释**；
      **v0.16.0 周期的历史结论逐字未动**（详见 §7.5）
- [x] g-352 冻结签名 fixture 随 `PLUGIN_VERSION` 变更**重新冻结**：正文与 `content-sha256`
      （`0e6b7094…`）**逐字节未变**，仅 provenance 三行更新（description / source-commit / source-sha256）
      —— 维护者工具 + `G352_SIG_ACK=1` 显式 ack，与 v0.16.0 同一做法
- [x] Linux 完整门禁实跑（§4.1–4.4），原始输出落 worktree 内 `tmp/release-0161/*.log`
- [x] 全量测试 `TMPDIR=/tmp node --test core/tests/*.test.ts` = **1386/1386，fail 0**（§5）
- [x] `./node_modules/.bin/tsc --noEmit -p tsconfig.json` = **exit 0**（§5）
- [x] tarball 已产出并记录 sha256（发布门禁红线 3）：见 §3.3
- [x] 生产看板污染守卫（g-363 未修 ⇒ 必须自查）：见 §6
- [x] `g-368-att-02` 合并 → `v0.16.1-test`（`c40fe95`）→ 陈旧文档一行校正（`18ac316`）→ `v0.16.1-test` 合并 → `main`（`--no-ff`，`10045ca`）—— 负责人 2026-09-26 授权
- [x] annotated tag `v0.16.1` —— 主管在本机创建，指向 `main` 上含本清单定稿的提交
- [x] **发布树重切产物并复算指纹**：`v0.16.1-test` 与 `main` 两次重切均 = `1e34ec34…` / 492,955 B（与门禁所测包**逐位相同**，见 §3.3）
- [ ] 负责人执行 `pnpm publish`（npm 官方 registry；**发布目录是 `dist/`，不是 `dsh-graph-host/`**）
      —— 命令序列见 [`docs/release-handbook.md`](release-handbook.md) §4
- [ ] 发布后核验：全新隔离 profile 安装 → 工具/看板/skill 注册正常；`npm view dsh-graph version` = `0.16.1`

## 3. 三条发布红线逐条结论

### 3.1 红线 1 —— Windows 兼容性：**本版未执行（负责人裁定省略），不得视为 PASS**

| 项 | 值 |
|---|---|
| 是否已执行（本版 `v0.16.1`） | ❌ **未执行** —— **未**在原生 Windows 上跑 T1–T5 |
| 是否已执行（macOS，本版） | ❌ **未执行** —— **未**在原生 macOS 上跑门禁 |
| 裁定与理由 | **负责人 2026-09-26 裁定省略**，理由：**本版无跨平台敏感内容** |
| 理由的事实支撑 | `g-365` = 元数据（`engines.dsh`）+ 文档；`g-366` = **纯客户端渲染逻辑**（`lib/client/*.js` 的布局档位）；`g-362` = **门禁执行件本身**重构（`scripts/` 与文档）。三者**均未触碰** `core/platform.ts`、文件锁实现与 `core/ops.ts` 的 POSIX 常量路径 |
| Linux/WSL2 侧 | ✅ **已实跑全绿**（§4：P1–P6 + M4 + 转发 T1–T5 = 通过 9/失败 0/告警 0，转发 T1–T5 = 通过 10/失败 0/告警 0） |
| **结论标注** | **「Windows 未验证」/「macOS 未验证」** —— 两份 README 已按此如实标注，**不得读出 PASS** |
| 最近一次真机结论（Windows） | **v0.16.0 周期**，原生 `win32/x64` / node `v24.13.0`（2026-09-25）：被测产物 `fe852e23…`（488,218 B），**通过 10 / 失败 0 / 告警 0**，退出码 0 —— 出处 [`docs/release-checklist-v0.16.0.md`](release-checklist-v0.16.0.md) **§3 / §3.1** |
| 最近一次真机结论（macOS） | **v0.16.0 周期**，`darwin/arm64` / node `v26.8.2`（2026-09-25）：**Mac 专检 通过 2 / 失败 0 / 告警 3**，转发 T1–T5 = 10/0/0 —— 出处 [`docs/release-checklist-v0.16.0.md`](release-checklist-v0.16.0.md) **§3.4** |

> **为什么不能把 Linux 全绿当作红线 1 的满足**：`AGENTS.md`「发布门禁」段明确「Linux/WSL2 全绿
> **不能替代** Windows 真机结论」。本次是**负责人对红线的显式例外裁定**（有理由、有留痕），
> 不是「跑过了」；故本版的平台声明一律写作**未验证**。
>
> **发布前如负责人改变裁定**：在原生 Windows 上执行
> `node win-smoke-test.mjs --tarball <path>\dsh-graph-0.16.1.tgz --dsh "npx -y @deepseek-ai/dsh@0.1.7-rc.2"`
> （产物见 §3.3），并把结论回填本表后，方可改为 PASS；否则保持「未验证」。

### 3.2 红线 2 —— 版本号三处一致：**✅ 满足（实测输出如下）**

| 位置 | 命令 | 实测输出 |
|---|---|---|
| `dsh-graph-host/package.json` | `node -p "require('./dsh-graph-host/package.json').version"` | `0.16.1` |
| `dsh-graph-host/lib/client/constants.js` | `grep -n 'const PLUGIN_VERSION' dsh-graph-host/lib/client/constants.js` | `12:    const PLUGIN_VERSION = "0.16.1";` |
| `README.md`（单包发布段） | `grep -n '当前版本' README.md` | `30:单包发布：npm 包名 dsh-graph（当前版本 v0.16.1，与 package.json / PLUGIN_VERSION 一致）。一个包同时提供：` |
| （构建产物）`dist/lib/client.js` | `grep -n 'const PLUGIN_VERSION' dist/lib/client.js` | `2144:    const PLUGIN_VERSION = "0.16.1";` |
| （包内清单）`dist/package.json` | `node -p "require('./dist/package.json').version"` | `0.16.1` |
| （包内 README）`dsh-graph-host/README.md` 中文 | `grep -n '当前版本' dsh-graph-host/README.md` | `31:> **当前版本**：v0.16.1（与 package.json 的 version、看板 PLUGIN_VERSION 三处一致；发布门禁红线 2）。` |
| （包内 README）`dsh-graph-host/README.md` 英文 | 同上 | `198:> **Current version**: v0.16.1 (consistent across package.json version, the board's PLUGIN_VERSION, and this README; release-gate red line 2).` |

原始输出：`tmp/release-0161/version-strings.log`（worktree 内）。
对照历史改法 `git show 9893914`（v0.16.0 的同类改动）。三处**一致** ⇒ **红线 2 满足**。

### 3.3 红线 3 —— 产物传递纪律（tarball + sha256）：**✅ 满足**

| 项 | 值 |
|---|---|
| 文件名 | `dsh-graph-0.16.1.tgz` |
| 产出方式 | worktree 内 `bash scripts/build.sh` 后 `(cd dist && pnpm pack --pack-destination <worktree>/tmp/)` |
| 相对路径 | `tmp/dsh-graph-0.16.1.tgz`（worktree 内） |
| 包内版本 | `0.16.1`（`dist/package.json` 实测） |
| 包内文件数 | **37**（`pnpm pack --dry-run` 清单实测，与 `find dist -type f` 实数一致） |
| 包内构建中间物 | **零**：清单内无 `*.ts`、无 `core-dist/`、无 `*.map`（`grep -cE '\.ts$\|core-dist\|\.map$'` = **0**） |
| 体积 | **492,955 B** |
| sha256 | **`1e34ec342eaaccb53553a02c5e33a0de90e3c978769ae71acc8a023fa07e2ecc`** |
| 门禁自报指纹 | 门禁 T2 打印 `dsh-graph-0.16.1.tgz  492955 B  sha256=1e34ec34…` —— 与上表**逐位一致** |
| Windows 侧可达路径（UNC） | `\\wsl.localhost\archlinux\home\miuzel\workspace\personal\dsh-graph\.worktrees\g-368-att-02\tmp\` |
| 原始输出 | `tmp/release-0161/4.3-pack.log`、`4.3-sha256.log`、`4.3-pack-dryrun.log` |

> **指纹沿革（只保留最终值作为结论）**：本清单**只以 `1e34ec34…` / 492,955 B 为最终值**。
> 版本身份校正（§1.3 括注）之前的候选值为 `36d38bc402c1ff3b7d945343b1eb003cda3b173749e58afb327df893d49310d3`
> / 492,967 B（**已作废** —— 包内 `README.md` 是该校正的一部分 ⇒ 换包）。
> 与 v0.16.0 周期的教训一致：**任何包内 README 调整都会换包、使旧指纹作废**。
>
> **终值确认（2026-09-26，负责人授权合并+打 tag 后）**：`1e34ec34…` / 492,955 B 即**发布物终值**。证明链：
> ① worktree 内门禁所测包（§4 的 T2 自报指纹逐位一致）＝ ② `v0.16.1-test` 合并后**主树重切**（`c40fe95` 树）
> ＝ ③ `main` 合并后**主树重切**（`10045ca` 树）—— 三者 **sha256 逐位相同**；
> ④ 独立评审（子代理 a8cf0aba）在私有副本从 `2387c17` 全新 `build+pack` 亦得**同一 sha256**，且两包解包 `diff -r` **37/37 零差异**。
> ⇒「门禁所测产物 == 发布树产物」由**字节**证明。（`docs/` 不在包内 ⇒ 本清单定稿与 `dev-instance-guide` 一行校正不影响包内容，tag 树重切后复算仍为同一指纹。）
>
> **发布前确认 `dist/` 内无 `.tgz`**：`find dist -name '*.tgz' | wc -l` = **0**（实测）；`find dist -type f | wc -l` = **37**。

## 4. Linux 完整门禁实跑（`docs/platform-gate.md` §4.1–4.4）：**✅ 全绿**

**执行环境**：原生 Linux（WSL2 内 Arch Linux）/ `linux x64` / node `v26.7.0` / 2026-09-26。
**所有命令均在 worktree 内**，`export npm_config_cache="$PWD/tmp/npm-cache"`。
**本节全部数据来自「版本身份校正后」的最终一轮重跑**（tree = 提交 `9c5365d` + 清单回填，产物 = §3.3 最终值）。
**命令与原始日志**（日志路径相对 worktree）：

```bash
# 4.1 秒级预检（不联网、不安装、不需要已构建 dist）
node scripts/platform-smoke-test.mjs --skip-build          # → tmp/release-0161/4.1-skip-build.log
# 4.2 静态门禁（需要已构建 dist）
bash scripts/build.sh                                      # → tmp/release-0161/4.2-build.log
node scripts/platform-smoke-test.mjs --static-only .       # → tmp/release-0161/4.2-static-only.log
# 4.3 完整门禁（P1–P6 + M4 + 转发 T1–T5；npx 安装 DSH 并起隔离实例）
(cd dist && pnpm pack --pack-destination "$OLDPWD/tmp/")   # → tmp/release-0161/4.3-pack.log
node scripts/platform-smoke-test.mjs --tarball "$PWD/tmp/dsh-graph-0.16.1.tgz"   # → tmp/release-0161/4.3-tarball.log
# 4.4 离线自检（确认执行件自身没坏）
node scripts/platform-smoke-test.mjs --self-test           # → tmp/release-0161/4.4-self-test.log
```

### 4.1 逐项判读（以 §4.3 完整门禁为准）

| 项 | 判定 | 关键实测值 |
|---|---|---|
| P1 大小写敏感性 | **PASS** | `fsType=ext4 大小写敏感=true`（`A`/`a` 是两个不同实体，entries=`A,A-dir,a`） |
| P2 软链 root 边界 | **PASS** | 软链 root 被拒=`true`、物理路径被拒=`false`（显式软链 root 报 `graph root symlink is not allowed`，realpath 后解析通过） |
| P3 挂载类型识别 | **PASS** | `fsType=ext4 mount=/home/miuzel/workspace/personal/dsh-graph`、`network=false tmpfs=false overlay=false drvfs=false`（本地盘，非网络/内存/WSL drvfs） |
| P4.a 并发 CAS（4 抢 1） | **PASS** | `成功=1 冲突=3 异常=0`（恰好 1 成功） |
| P4.b 原子写（16 写者 + 轮询读者） | **PASS** | `写者=16/16 读次数=26 撕裂读=0 最终完整=true 残留=0` |
| P5 跨 FS rename(EXDEV) | **PASS** | `secondFs=/dev/shm(tmpfs)`、`rename=EXDEV`、源保留=`true`、目标未落地=`true`、`replaceFileAtomic 抛出=true`（**不静默降级为拷贝**） |
| P6 locale/编码 | **PASS** | `locale=C`、标题逐字节=`true`、正文逐字节=`true`、goal.md 往返=`true`、prompts=`14`（非 ASCII 14）逐字节=`true` |
| M4 Linux-only 假设扫描 | **PASS** | 发布路径命中 **20 处全部已被特性探测/回退覆盖**（`renameat2` / `mv-exchange` / `sha256sum`）；`archived/` 另 41 处仅 INFO（非发布路径，不计门禁） |
| T1 静态门禁 | **PASS** | 无 POSIX 专有常量的 ESM 具名导入（已扫描 15 个文件） |
| T2 安装 | **PASS** | 全新隔离 profile 安装 `dsh-graph-0.16.1.tgz`；自带依赖 `yaml` 已落地；安装版本实测 `0.16.1` |
| T3 核心运行时 | **PASS** | 建目标/判据/标签锁/CAS/validate 6 步全通过、`validate` 返回空；跨进程并发 CAS **恰好 1 成功 3 冲突被拒** |
| T4 实例启动 / 插件加载 | **PASS** | 就绪：`http://127.0.0.1:3088/?token=***` |
| T5 REST 冒烟 | **PASS** | 路由已注册 / 看板载荷可读 / Web UI 可达 `HTTP 303` |

**汇总**：平台探针 **通过 9 / 失败 0 / 告警 0**（P1–P6 + M4），转发执行件 **exit=0**
（其内部 T1–T5 **通过 10 / 失败 0 / 告警 0**）。整体退出码 **0**。

> **平台效力声明**：本机是**原生 Linux** ⇒ 上表 T1–T5 结论**对 Linux 具平台效力**（T3–T5 在本机真跑）。
> `win-smoke-test.mjs` 自带的「非 win32 上 T3–T5 只能证明脚本与代码可跑」是**针对 Windows 真机结论**的
> 免责声明（红线 1），**不削弱**本机结论，**也不能替代** Windows 真机门禁。

### 4.2 其余三段（判读与用途）

| 段 | 汇总 | 用途与判读 |
|---|---|---|
| §4.1 `--skip-build` | `逐项=P1=PASS P2=PASS P3=PASS P4=WARN P5=WARN P6=WARN M4=PASS`，**通过 4 / 失败 0 / 告警 4**，退出码 0 | 秒级预检（自身不构建）。4 条 WARN **全部是「依赖 `dist/core/*.js` 的项未实测而跳过」**（P4.a/P4.b/P5/P6），非缺陷；它们在 §4.2/§4.3（构建后）**全部转 PASS**。P2 取决于**运行时 `dist` 是否已存在**：本轮重跑时 `dist` 已构建 ⇒ P2 载入真实 `resolveRoot` 实测并转 **PASS**；首轮（`dist` 尚未构建）时为 WARN「未构建 dist ⇒ 未能实测」，**两种口径都不冒充通过**。**WARN 不致非零退出**，故单独列出逐项判读 |
| §4.2 `--static-only .` | `逐项=P1=PASS P2=PASS P3=PASS P4=PASS P5=PASS P6=PASS M4=PASS`，**通过 9 / 失败 0 / 告警 0**，转发 T1 亦 OK，退出码 0 | 静态门禁（需要已构建 `dist`）；不联网、不装插件 |
| §4.4 `--self-test` | **通过 1 / 失败 0 / 告警 0**，转发 exit=0（执行件自检区 **70 项** `[ OK ]` 全通过、**0 失败**；转发段另有「自检全部通过」），退出码 0 | 确认**执行件自身**没坏：对 P1–P6/M4 与转发的**判读函数**做「好样本 PASS / 坏样本 FAIL」的判别力自检（如「P2 软链 root 未被拒 ⇒ FAIL」「静默降级为拷贝 ⇒ FAIL」「未运行过的项是 SKIP（不冒充 PASS）」），并自校验沙箱根、命令行引号与包目录解析 |

**未出现 PASS/WARN/FAIL 之外的第四态**；**无 FAIL**，**无 UNVERIFIED**（T3–T5 所需的 `npx` 安装与
隔离实例启动均**成功**，未触发「网络不可用 ⇒ 如实记 UNVERIFIED」分支）。

## 5. 全量测试与类型门禁

| 项 | 命令 | 结果 |
|---|---|---|
| 全量测试 | `TMPDIR=/tmp node --test core/tests/*.test.ts` | **tests 1386 / pass 1386 / fail 0**，suites 9，exit **0** |
| 类型门禁 | `./node_modules/.bin/tsc --noEmit -p tsconfig.json` | **exit 0**（无诊断输出） |
| 构建产物语法 | `node --check dist/lib/client.js` | **OK** |
| 打包校验 | `(cd dist && pnpm pack --dry-run)` | 通过，目标 `dsh-graph-0.16.1.tgz`，**37 个文件**，dry-run **不产生** `.tgz` |

原始日志：`tmp/release-0161/regression-tests.log`（**末次**为 README 定稿后重跑）、`tmp/release-0161/tsc.log`。

> **测试门禁纪律**：`node --test` 一律 `TMPDIR=/tmp`（与平台门禁自带的「沙箱须同 FS」TMPDIR 纪律
> **分开跑**）。测试改动面为**零行为逻辑**（版本常量 + 文档 + fixture provenance 重冻结）——
> **未新增/删改/削弱**任何既有用例；期间出现过的 1 次红灯（g-352 fixture
> `source-sha256` 与源码不同步）是**预期**的「改坏就会红」信号，已按既定维护者流程重冻结并复跑全绿。

## 6. 生产看板污染守卫（g-363 未修 ⇒ 必须自查）

**背景**：g-363（门禁运行可能向**生产**看板/记忆写入痕迹）**本版未修**，故须实测比对。

**方法**：以**最终产物**（§3.3 的 `1e34ec34…`）为核心，做一次**干净的「量—跑门禁—再量」闭环**
（`tmp/release-0161/6-board-guard.log` 逐字留痕）。

| 观测点 | 基线（brief 给定） | 门禁运行**前**（实测） | 门禁运行**后**（实测） | 门禁引起的差值 |
|---|---|---|---|---|
| `.dsh-graph/project.yaml` md5 | `1c69db65a39cfb0efbda73211b7ff089` | `1c69db65a39cfb0efbda73211b7ff089` | `1c69db65a39cfb0efbda73211b7ff089` | **0（未变）** |
| `.dsh-graph/memory/memory.jsonl` md5 | `f98f689a08349cdc6bf2e563a93a1c5b` | `f98f689a08349cdc6bf2e563a93a1c5b` | `f98f689a08349cdc6bf2e563a93a1c5b` | **0（未变）** |
| `.dsh-graph/events.jsonl` 行数 | `12174` | `12191` | `12191` | **0（未变）** |

该次门禁运行本身：`GATE_EXIT=0`、`逐项=P1=PASS P2=PASS P3=PASS P4=PASS P5=PASS P6=PASS M4=PASS`、
`结果=PASS 通过9/失败0/告警0 转发exit=0`、指纹 `1e34ec34…` / 492,955 B —— 即**门禁确实跑满并通过**，
而**看板零写入**。

**结论**：**门禁运行未向生产看板/记忆写入任何条目** —— 三个观测点在门禁前后**逐位一致**，
无需清理任何条目。门禁的隔离边界（`DSH_HOME` 落在 worktree `tmp/platform-gate/`）**按设计生效**。
（两轮门禁运行 —— 校正前与校正后 —— 均为该结论，独立复现。）

**关于 `12174 → 12191` 的 +17 行**（**非门禁所致**，如实登记）：差值来自 **g-368 自身的看板记账**——
`criteria.confirmed` / `goal.moved` / `goal.directive_set`×2 / `goal.transition`×3 / `attempt.started`×2 /
`attempt.bound`×2 / `attempt.abandoned`（att-001 中断）/ `goal.comment_added`（复核意见）/
`supervisor.status_reported`×2 / `attempt.status_reported`×2，actor 为 `session-3287a541…`（主管）与
`8d0ce9d4…`（att-001 执行者）—— **全部是本次目标生命周期事件，无一由门禁产生**（已逐条核对）。
**未执行任何历史条目清理**（不动历史）。

## 7. 已知限制（不阻断本次发布）

1. **Windows / macOS 原生门禁未执行**（§3.1）：本版为**负责人显式裁定的红线例外**。两份 README 与
   本清单均已**如实标注「未验证 / 不得视为 PASS」**。**发布前若负责人改变裁定**，须按 §3.1 末段补跑并回填。
2. **g-363 未修** —— 门禁运行可能留下生产看板痕迹：本版**实测未发生**（§6），但该风险面**仍未从根上关闭**，
   后续版本的门禁运行仍须沿用本节的自查比对（三观测点）。
3. **P1/P3 的平台限制（非缺陷，只报告）**：本机 ext4 大小写**敏感**（PASS）；但在**大小写不敏感**的卷
   （macOS APFS 默认、Linux 上的 vfat/exfat/ntfs/CIFS）上，**仅大小写不同**的 goal id / version slug
   会互相别名、后写覆盖前者 ⇒ 脚本按设计给 **WARN 并附影响说明**；是否改引擎行为由负责人另行决策。
4. **macOS/Linux 门禁的 M4 只覆盖发布路径**：`scripts/archived/` 内仍存在 **41 处** Linux-only 假设
   （`sha256sum` / `mktemp -d` 无模板 / `readlink -f` / `stat -c` / `md5sum` / `sed -i` 无备份 / `grep -P` /
   `date -d` / `cp --reflink`）。这些**是非发布路径的归档脚本**，按设计只列 INFO、不计门禁。
5. **版本身份陈述已校正（原「v0.17.0 起」，实际随 `v0.16.1` 发布）**：g-362 的门禁合并在起草期按
   `v0.17.0` 排期，但**实际归入 `v0.16.1`**，而两处「`v0.17.0` 起 …」是**面向用户的现状陈述**（随发布物出厂）
   ⇒ 出厂即不实，**已校正为 `v0.16.1` 起**（并注明「原计划 `v0.17.0`，实际随 `v0.16.1` 发布」）。
   校正点：`README.md`（跨平台段 / 平台范围段）、`dsh-graph-host/README.md`（中英各一处 v0.16.1 小节内括注）、
   `docs/platform-gate.md` 状态行、`docs/macos-gate.md` 取代说明、`scripts/archived/README.md` 取代关系行，
   以及两处测试文件注释（`core/tests/g359-macos-gate.test.ts` / `g362-platform-gate.test.ts`）。
   **同段内 v0.16.0 周期的历史结论（Windows 10/0/0、macOS 2/0/3、tarball 复验原文）逐字未动。**
   > 说明：测试夹具里的 `dsh-graph-0.17.0.tgz` / `dsh-graph@0.17.0` 是**参数转发的任意样本数据**
   > （不是版本身份声明），故按原样保留。
6. **门禁「平台效力」的边界**：本清单 §4 的 PASS **只对 Linux 成立**。其中 P1/P3 是**平台相关**探针
   （判定口径随手性），P2/P4/P5/P6/M4 为平台无关；在 macOS 上应由负责人按其卷实况重跑后再回填
   `docs/platform-gate.md` 的回填表，**不得把 Linux 结论外推到 macOS**。
7. **tarball 指纹已定稿（原「候选值」风险已消解）**：`v0.16.1-test` 与 `main` 两次发布树重切均与门禁所测包
   **sha256 逐位相同**（§3.3），独立评审另在私有副本复现同一指纹 ⇒ 不再存在「tag 树重切换包」的悬置风险。
   仍需注意：**registry 侧**（npm 会重写 tarball）sha256 必然不同 —— 跨机器对账用 sha256，**registry 侧用内容级判据**
   （见 v0.16.0 清单 §3.3 的 414,753 B vs 414,102 B 实证）。

## 8. 发布操作（**人工 gate，主管不自行执行**）

完整命令序列见 [`docs/release-handbook.md`](release-handbook.md) **§4「pnpm publish 单包（发布树标准流程）」**。
**本次发布必须确认的三个易错点**（沿用 v0.16.0）：

1. **发布目录是 `dist/`，不是 `dsh-graph-host/`** —— 后者是纯源码形态，发出 TS 源码会缺编译产物、宿主 loader 直接失败。
2. **发布前确认 `dist/` 内无 `.tgz`、文件数 37**：`find dist -name '*.tgz' | wc -l` == **0**；
   `find dist -type f | wc -l` == **37**。
3. **`npm login` 是前置**：`npm whoami --registry=https://registry.npmjs.org` 返回 `E401 Unauthorized` 时
   token 已失效，**必须先重新登录**再 publish。

**本次已执行（负责人 2026-09-26 授权范围内）**：合并 `v0.16.1-test` → `main`（`10045ca`）、创建 annotated tag `v0.16.1`（本机）、
主树发布构建与重切指纹复算（`1e34ec34…`）。
**仍未执行且不应自行执行**：`git push`（含 tag）、`pnpm publish` —— 等负责人执行或明确授权。
