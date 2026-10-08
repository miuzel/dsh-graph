# dsh-graph v0.19.8 发布检查清单

> **本文件状态：发布准备中（Windows 真机复验 = 待回填；macOS = 未执行）。** 发布准备阶段创建，只登记**已实测**的结论。
>
> **红线 1（Windows）：本次发布候选包尚未在原生 Windows 上执行门禁 ⇒ 结论为「待回填」，本清单与两份 README 均不得读出「Windows 已通过」。**
> 待负责人在**原生 Windows** 上对本次 RC 执行（逐条命令见 §6）：
>
> ```sh
> node scripts/win-smoke-test.mjs --tarball dsh-graph-0.19.8.tgz
> ```
>
> 回填方式：逐字报告落 `docs/platform-gate.md` §7，并把本节与 §2 / §6 的 Windows 行同步改为实测结论（回填说明见 §7）。
> **注意**：`docs/platform-gate.md` §7.1 / §7.2 / §7.3 已登记的真机 PASS 覆盖的是 **0.19.7 及更早的产品代码**（§7.3 = v0.19.7 发布候选包），
> 而 **v0.19.8 含 16 项目标的产品改动、从未在原生 Windows 上跑过** ⇒ 它们**不是**对本次 RC 门禁的替代，
> 故本清单 Windows 行如实记为「待回填」，不得以历史记录推出「本版已通过」。

> 流程沿用 v0.10.0 起确立的做法：主管完成准备并（经负责人授权后）合并 `main` + 打 annotated tag，
> 再由**负责人手动执行 `npm publish`**。
> 本文件同时承载 v0.19.8 的 Release Notes 与发布前 / 发布后检查项。
> 版本线说明：v0.19.8 泳道（16 项目标）承接上一发布版本 `v0.19.7`；开发线版本串为 `0.19.8-alpha`。
> 集成分支 `v0.19.8-test`（tip **`6d62af6`**）已含 v0.19.8 全部工作，`v0.19.7-test` 为其祖先。
> 本清单结构对照 [`docs/release-checklist-v0.19.7.md`](release-checklist-v0.19.7.md)。

> **准备阶段未执行任何发布动作**：未 `npm publish`、未打 tag、未创建 GitHub release、未 `git push`、
> 未合并 `main`、未改写 git 历史、未触碰 `engines` 与 `peerDependencies`。
> 是否合并 `main` / 打 tag / 发布由负责人在人工 gate 决定。

**本次执行树**：worktree `.worktrees/g-455-att-01`，分支 `g-455-att-01`，基线 **`6d62af6`**（= `v0.19.8-test` HEAD）。
**纪律（准备阶段）**：全部构建 / 测试 / 打包**均在 worktree 内**完成；**未写主树 `dist/`**
（主树 `dist/` 是运行中宿主的资产来源，历史上有 worker 因主树构建争用而静默死亡；主树 `dist/` mtime 保持 `2026-10-06 12:31:23`）；

worktree 缺 `node_modules`，经**符号链接**指向主树只读复用（不入 git，不改 `pnpm-workspace.yaml` / lockfile）；
worktree 内**未执行任何 `pnpm` 命令**（`pnpm run` 会先做依赖检查、可能隐式触发 `prepare` = 完整构建）。

---

## 0. 相对上一版（v0.19.7）的变更（5 条用户可见）

1. **设置页修好、也补齐了**：升级宿主后设置页不再变空；全局设置在两处入口（「设置」里的插件页与右侧栏插件入口）都能打开，
   读写的是同一份配置；评审条件（按项目目录结构登记的区域、冻结契约、哪些算产品改动）可直接查看与编辑，
   尚未按本项目校准时明确标注为「缺省（普适）」；主管自动化开关也不再只是存着。
2. **「机器快速放行」的证据不再只靠自报**：改动了多少行、还有没有未跟踪文件，改由引擎自己从版本库取，采集不到就不放行；
   没有登记过的区域自动升级为严格评审；评审子代理可以从正式入口独立派发，缺独立评审的交付会在看板上如实标注（不阻断放行）。
3. **长期记忆只有一个真源**：记忆统一由结构化条目管理（常驻 / 按需两档的语义与权限不变），不再要求手工维护长期记忆索引文件；
   历史文档保留为可选说明，可一次性、可追溯地迁入，重复执行不会重复导入。
4. **插件不再污染用户项目、也不再假设本仓库的结构**：插件自有的目录与工作树不会再把用户仓库判成「有未提交改动」，
   也不会再挡住机器快速放行；面向模型与用户的提示词、工具描述去掉了只适用于本仓库的路径、分支与脚本假设。
5. **跨看板更安全、测试结论更可信**：同一仓库存在多块看板时，同号的目标不会互相误复用、也不会误删对方的工作树；
   自定义图根下的卡片路径指向真正的那张卡片；整套测试不再有间歇性假红，「全绿」不再受概率影响。

> 两份 README（根 `README.md` + 包内 `dsh-graph-host/README.md`，中英）已同步「最新亮点（v0.19.8）」，
> 并把**三处平台状态表的 Windows / macOS 行如实化**（`f5fb6b9` 同形做法）：Windows 行明确
> 「**v0.19.8 发布候选包尚未在原生 Windows 上执行门禁，不得读出「已通过」**」，并注明历史真机记录只覆盖
> v0.19.7 及更早的产品代码、**不能替代本次 RC**；macOS 行同样保持「本次未执行真机门禁」；
> Linux / WSL2 保持已实测通过。仓库根 `CHANGELOG.md` 新增 `## v0.19.8 — 2026-10-08` 节（5 条要点），
> 一并把「逐版本门禁结论」链接指向本清单。

## 1. v0.19.8 版本内容集

版本主题：**把「配置面 / 评审可信度 / 记忆真源」收口，并让插件在别人的项目里也干净可用** ——
设置页两入口与失效修复、评审策略 fail-closed 与快速放行证据真源化、长期记忆单一真源、
插件自有目录不污染用户项目、跨看板归属保护与门禁稳定性。

| 主题 | 目标 | 用户 / 维护者可见效果 |
|---|---|---|
| 设置与配置面 | g-453、g-442、g-435、g-439 | 全局设置页按 dsh-market 同形**占两个席位**（`settings.plugins.tab` + `plugins.bundle.config`，key = `dsh-graph`）并修掉宿主 0.2.0-rc.2 上「`settingsScope` 缺失 ⇒ 整页降级为空」；评审条件三组列表可见可编辑（非法条目保存前拒绝、失败零副作用、保留注释与未知键）；未配置时标注「缺省（普适）」；`supervisor.automation` 六键经动态主管提示真正消费（未配置时行为与旧版逐字一致） |
| 评审可信与证据真源 | g-436、g-437、g-438 | 未登记区域**安全升级 strict**（fail-closed，`unknown_region`）；`fast_track` 门禁③「改动行数 / 未跟踪文件」由**引擎自算**（`git diff --numstat -z` + `status --porcelain`，解析不了即拒绝，禁回退主树），①②仍为调用方证据但事件留痕命令原文/时间/来源；reviewer 经一等入口独立派发（评审者身份与产出可审计、不得自行 accept），缺独立评审**可见化但不硬阻断**；本版**保留类型派生默认策略**（负责人裁决，记录性收口） |
| 记忆单一真源 | g-445 | 结构化记忆（`memory.jsonl` + `graph_memory_*`）为唯一真源；主管指南 zh/en 不再强制读取 / 手工维护 `INDEX.md`；旧 `memory/long-term/*.md` 保留为可选项目自述文档；一次性、明确触发、可追溯且幂等的迁移（不静默截断、不擅自晋升常驻） |
| 插件不污染用户项目 / 去仓库特有假设 | g-443、g-444、g-446 | 插件自有状态/生成路径（`.dsh-graph` / `.worktrees` / `handoffs`）不再让外部项目判脏、不再让 `fast_track` 永久不可用（不放宽对**真**未跟踪用户文件的判定）；提示词与执行代码去掉本仓库特有路径、分支模型、脚本与内部编号（模型必读的工具描述零 `g-XXX` 残留） |
| 跨看板归属与路径正确性 | g-447、g-448、g-449 | 自定义 root 下卡片路径以**实际图根**为真源（默认根同名卡片负向对照不被误读）；同仓库多板同号 attempt **明确拒绝**而非误复用（零副作用、点名已绑定看板根）；`cleanWorktree` 同源归属核验 ⇒ B 板不得删除 A 板工作树，且既有无标记树不被永久锁死 |
| 门禁稳定性 | g-452 | `standing-budget` 门禁间歇假红（约 5–10%）根因消除（贪心填充 + `updated_at` 毫秒并列 + 稳定排序）⇒「全绿」不再是概率结论 |
| 开发线开线 | g-441 | 0.19.8 开发线版本串置 `0.19.8-alpha` + 签名 fixture 按维护者通道重冻结（本轮再转正为 `0.19.8`） |

## 2. 检查项

- [x] 版本串转正：`dsh-graph-host/package.json` version 与 `lib/client/constants.js` `PLUGIN_VERSION` = `0.19.8`（§3）
- [x] 仓库内其余 `0.19.8-alpha` 出现点已核查并说明处置（§3）
- [x] `g352` 冻结签名 fixture 走 `G352_SIG_ACK=1` 重冻结：仅 provenance（含维护者 note）变化，正文与 `content-sha256` 逐字节不变；
      负向对照双红（手改正文 ⇒ 「内容 hash 与正文不一致」；源码变异 ⇒ 「fixture 与源码不同步」）（§5）
- [x] README 三处渠道（根 + 包内 zh/en）版本表述与「最新亮点」更新为 v0.19.8；平台状态行如实（Windows = RC 待回填、不得读出已通过；macOS = 本次未执行；Linux/WSL2 = 已实测）（§0 引文）
- [x] `CHANGELOG.md` 新增 `## v0.19.8 — 2026-10-08`（5 条用户语言、无过程痕迹）；`g371` 快照补 `{ version: "v0.19.8", bullets: 5 }`；顶部链接指向本清单
- [x] 本清单建立：状态 / 集成 HEAD / RC 指纹 / 整版门禁数字 / 16 项目标映射 / 待负责人 Windows 命令 / 回填说明（§1 / §4 / §5 / §6 / §7）
- [x] RC 产物在隔离 worktree 内构建并记录（§4）
- [ ] **Windows 真机门禁（红线 1）** —— **待回填**：负责人在原生 Windows 上对 §4 的 RC（以 sha256 对账）执行 §6 命令
- [ ] **macOS 真机门禁** —— **本次未执行**（如实登记，不得读出已通过）
- [ ] 合并 `main` / 打 annotated tag / `npm publish` —— **准备阶段未执行**，由负责人人工 gate 决定

## 3. 版本号一致性（红线 2）逐处证据

| 落点 | 文件:行 | 实际值 |
|---|---|---|
| 包清单 | `dsh-graph-host/package.json:3` | `"version": "0.19.8"` |
| 客户端常量（源） | `dsh-graph-host/lib/client/constants.js:12` | `const PLUGIN_VERSION = "0.19.8";` |
| 客户端常量（构建产物） | `dist/lib/client.js:2429` | `const PLUGIN_VERSION = "0.19.8";` |
| 构建产物包清单 | `dist/package.json:3` | `"version": "0.19.8"` |
| 根 `package.json` | `package.json:3` | `"private": true`，**无 `version` 字段（未动，符合预期）** |
| README（根，中）当前版本 | `README.md:18` | `**当前版本 v0.19.8**` |
| README（根，中）最新亮点 | `README.md:20` | `**最新亮点（v0.19.8）**` |
| README（包内，中）当前版本 | `dsh-graph-host/README.md:43` | `**当前版本**：v0.19.8` |
| README（包内，中）最新亮点 | `dsh-graph-host/README.md:57` | `**最新亮点（v0.19.8）**` |
| README（包内，英）Current version | `dsh-graph-host/README.md:276` | `**Current version**: v0.19.8` |
| README（包内，英）What's new | `dsh-graph-host/README.md:290` | `**What's new (v0.19.8)**` |
| CHANGELOG 新节 | `CHANGELOG.md:10` | `## v0.19.8 — 2026-10-08` |
| CHANGELOG 守卫快照 | `core/tests/g371-changelog-guard.test.ts:39` | `{ version: "v0.19.8", bullets: 5 },` |
| tarball 内包清单 | `package/package.json`（`dsh-graph-0.19.8.tgz`） | `"version": "0.19.8"` |
| tarball 内客户端常量 | `package/lib/client.js:2429`（`dsh-graph-0.19.8.tgz`） | `const PLUGIN_VERSION = "0.19.8";` |

**仓库内其余 `0.19.8-alpha` 出现点核查与处置**：`grep -rn '0\.19\.8-alpha'`（排除 `node_modules/` / `dist/` / `.worktrees/`）后**仅剩 1 处**：

| 位置 | 内容 | 处置与理由 |
|---|---|---|
| `core/tests/g425-cold-boot-optional-service.test.ts:670` | `["三等号比较带预发布后缀的版本",` 后接一段 `if (pkg.version === "0.19.8-alpha") {}` 样本字符串 | **保留不改**。它是「版本号守卫判别力自检」的**正向样本输入字符串**（喂给 `versionComparisonFindings` 断言「必命中」），不是任何版本声明；该样本的判定语义**要求带预发布后缀**（此即 `===` 比较预发布版本的危险写法）⇒ 改成 `0.19.8` 会抽掉后缀、削弱样本判别力。仓库内无其他 `0.19.8-alpha` 残留（`constants.js` / `package.json` 已转正）。 |

**历史文档中的既有版本记载逐字未改**：`docs/platform-gate.md`、`docs/release-checklist-v0.19.7.md` 及更早清单、
`docs/release-handbook.md`、`docs/event-first-commit-contract.zh.md`、`docs/reviews/` **零改动**；
`CHANGELOG.md` 的 diff 只含顶部「逐版本清单」链接一行 + 新节（`## v0.19.7` 及其以下各节逐字未动）。

> **注（g352 冻结签名 fixture 的 provenance 刷新）**：本目标必须改 `constants.js` 的 `PLUGIN_VERSION`，而
> `g352` 冻结签名的 `source-sha256` 头覆盖 `kanban, constants, narrow-width, helpers` 四个客户端源模块 ⇒
> 该头必然失配（改前全量测试实测 `fail=1`，红在 `fixture 与源码不同步`）。按仓库既有发布准备口径
> （`36c35a9` / `f5fb6b9` 同形）处理：
> ① 先按该 fixture 自身约定手工更新**首行 note**（note 行以 `# ` 开头 ⇒ 由 `parseSignatureFixture` 当作头部丢弃，
> **不参与** `content-sha256` / `source-sha256` 计算；dump 工具**原样保留**既有 note，只更新 provenance）；
> ② `G352_SIG_DUMP=<临时路径> node --test --test-name-pattern="会话内看板页签签名" core/tests/g352-narrow-width.test.ts` 导出到**临时路径**；
> ③ 与改前 fixture（`git show HEAD:…`）比对：diff 恰为 **1 个 hunk `1,3c1,3`**（note 行 / `source-commit` / `source-sha256` 三行），
> 第 4–6 行（`source-files` / `content-sha256` / `board-width`）**逐字节相同**，正文 `diff` = **0 行**，
> `content-sha256` 两侧同为 `0e6b7094deafa61e0525d617f792a8da30b9aeba1a3c72cb221ee4061f783ed3`（未变）；
> ④ 用该 dump 经 **`G352_SIG_ACK=1` 显式确认通道**更新 fixture 本体（`cmp` 逐字节等于 dump），
> `source-commit` 记为基线 `6d62af6`（= 发布树的祖先，满足 fixture 自校验判据①；先例 `f5fb6b9` 记基线 `0ca63b6` 同形）。
> **未删除或放宽任何断言与守卫，未手填任何 hash。**

## 4. 产物与指纹（红线 3：跨机器传递唯一渠道为 tarball）

**发布候选包（RC，被测产物）**：

| 项 | 值 |
|---|---|
| 产物 | `tmp/release-0198/dsh-graph-0.19.8.tgz`（worktree 内，gitignored） |
| 打包命令 | `bash scripts/build.sh` + `(cd dist && npm pack --pack-destination <worktree>/tmp/release-0198 --cache ../tmp/npm-cache --logs-dir ../tmp/npm-logs)`（`npm pack` 在沙箱下需把 cache / logs 指向 `tmp/` 内） |
| 字节数 | **694847** |
| sha256 | `16cbe277d9a273bfe8fe82804e6efff66ba0cc058377983f513fe0a170fd43c6` |
| sha1 | `2ec2a77ac61bb32b8bc2f199805d3d93b3c8e9a1` |
| 成员文件数 | **37**（`npm pack --dry-run` = `total files: 37`，与 v0.18.0 起口径一致） |
| 包内版本实锤 | `package/package.json` version = `0.19.8`；`package/lib/client.js:2429` `PLUGIN_VERSION = "0.19.8"` |
| `dist/` 内 `.tgz` 残留 | **0** |

`tmp/` 为 gitignored 临时目录，tarball 不入 git（跨机器传递时以上表指纹对账）。
**打包时序留痕（本轮实证）**：`dist/README.md` 由构建从 `dsh-graph-host/README.md` 拷贝而来，
故 **RC 必须在 README / CHANGELOG 全部定稿之后再构建打包** —— 本轮首包（`693825 B` / `7054224c…`）是在 README 定稿前
那次构建上打的，`diff -rq` 实拍其 `package/README.md` 仍是旧版文案（1 个文件的 3 处差异）⇒ **已作废**、不入交付；
定稿后重建（`bash scripts/build.sh`）再打包得到上表的正式 RC（`694847 B` / `16cbe277…`，`package/README.md` 与源
`dsh-graph-host/README.md` 经 `cmp` 逐字节相同）。
**被测产物 vs 发布产物（红线 3 口径）**：本 RC 是发布准备的唯一候选；若后续按负责人指示回填真机结论而重打终版包，
须在 §4 追加终版表并（按 v0.19.7 先例）用 `diff -rq` 实拍差异，差异仅限 `README.md` 时方可沿用本次真机结论。

## 5. 测试与静态检查（全部在 worktree `.worktrees/g-455-att-01` 内）

| 项 | 命令 | 结果 |
|---|---|---|
| 整套件自证闸门 | `node scripts/run-tests.mjs` | **tests=2272 / pass=2272 / fail=0 / skipped=0 / cancelled=0 / todo=0，exit 0**（自证行：`tests=2272 (>0) skipped=0 fail=0 cancelled=0 todo=0 pass=2272 exit=0 ms=36954 glob=core/tests/*.test.ts`；与集成分支 tip `6d62af6` 的整版自证一致） |
| CHANGELOG 守卫（含负向对照） | `node --test core/tests/g371-changelog-guard.test.ts` | **3 / 3 pass，fail 0**（「正文无过程痕迹」+ 删整节 / 删一条 / 乱序 / 去日期 / 超上限 / 混入审计数字 逐项必红） |
| CHANGELOG 守卫负向对照（针对**新节**） | 临时给 v0.19.8 节加一条 `- 详见 g-455。` 后重跑 | **实拍判红（3/3 fail）**：`v0.19.8（第 10 行）要点数 6 ≠ 快照 5` + `有 6 条要点，超过每节上限 5 条`（改后已还原、`git diff --stat` 复核） |
| 冻结签名 fixture 套件 | `node --test core/tests/g352-narrow-width.test.ts` | **63 / 63 pass，fail 0** |
| 冻结签名正文比对 | `G352_SIG_DUMP=<tmp> … --test-name-pattern="会话内看板页签签名"` + `diff` | 正文 **diff 0 行**；`content-sha256` 仍为 `0e6b7094…`，仅 `source-sha256` / `source-commit` / note 变化 |
| 负向对照①（手改正文） | 临时改 `div key=kanban-0` → `kanban-X` 后重跑 | **实拍判红**：`AssertionError: fixture 内容 hash 与正文不一致（被手改过？）`（改后已还原、`cmp` 校验） |
| 负向对照②（源码变异） | 临时改 `helpers.js` 注释后重跑 | **实拍判红**：`AssertionError: fixture 与源码不同步：确认改动后按维护者工具重新冻结`（改后已还原、`git status` 干净） |
| 产物语法 | `node --check dist/lib/client.js` | **通过**（exit 0） |
| 类型检查 | `./node_modules/.bin/tsc --noEmit -p tsconfig.json` | **exit 0**（不经 pnpm ⇒ 不触发 `prepare` 构建） |
| 只读新鲜度 | `node --test core/tests/dist-freshness-g312.test.ts` | **5 / 5 pass，fail 0**（exit 0） |

> 一条红线纪律的留痕：本轮所有构建 / 测试 / 打包**只在 worktree 内**执行；主树 `dist/` mtime 保持 `2026-10-06 12:31:23`、
> 主树 `git status --porcelain` 零改动（发布准备禁止写主树资产来源）。

## 6. 待负责人在原生 Windows 执行的逐条命令

**前提**：在**原生 Windows** 上（PowerShell 或 CMD 均可），Node ≥ 22；把 §4 的 RC tarball 拷到本地盘（跨机器唯一渠道 = tarball）；
执行件 `scripts/win-smoke-test.mjs` 是单文件、无第三方依赖，可单独拷过去。

```powershell
:: 6.1 先对账指纹（Windows 无 sha256sum，用 certutil；PowerShell 可用 Get-FileHash -Algorithm SHA256 .\dsh-graph-0.19.8.tgz）
certutil -hashfile dsh-graph-0.19.8.tgz SHA256
::     期望 = 16cbe277d9a273bfe8fe82804e6efff66ba0cc058377983f513fe0a170fd43c6（§4），694847 字节

:: 6.2 真机门禁（T1–T5，清单式全覆盖；安装来源 = 该 tarball，真实安装语义）
node scripts/win-smoke-test.mjs --tarball dsh-graph-0.19.8.tgz

:: 6.3 台账对账（同一轮必须另跑：--tarball 模式发布包内不含 core/*.ts，台账对账改在仓库根完成）
::     在仓库根执行；输出须含 `覆盖=台账=…项/…处命中（忽略0行，未登记即判红）`
node scripts/win-smoke-test.mjs --static-only .
```

**判读要求（照 `docs/platform-gate.md` §3.4 / §7）**：

- 6.2 的结论后须带 `覆盖=T3生命周期=32步（…，每步盘面断言）` 一行 ⇒ **回填时必须连同该行一起粘贴**；
  若该行缺失、或 6.3 显示 `忽略处数 > 0`（须在 §3.4.1 补登理由），视为回填不完整。
- 6.2 的 `--tarball` 模式会（按设计）产生 1 条告警「未找到产品源码 `core/*.ts`」⇒ 由 6.3 补偿，**非缺陷**。
- 退出码：`0` = 全部通过；`1` = 有失败项；`2` = 用法错误。

## 7. 回填说明（本次真机结论回来后要改哪几处）

1. **本清单**：把标题下的**状态行**改为实测结论；§2 的 Windows 复选框勾选并写明
   「通过 N / 失败 N / 告警 N + T3 生命周期 32/32 步」；§5 追加一行真机门禁结果；
   §6 下补一段「实测产物指纹 = §4 RC（sha256 对账一致）」。
2. **`docs/platform-gate.md` §7**：新增 `### 7.x v0.19.8 发布候选包真机报告（逐字粘贴，<日期>）`，
   并在 §7 回填表追加一行（平台 / 日期 / 架构 / Node / 转发的 T1–T5 / 结论 / 执行人），
   **连同 6.2 的 `结果=` 与 `覆盖=` 两行、以及 6.3 的台账行一起粘贴**。
3. **两份 README 的平台状态表**（根 `README.md` + `dsh-graph-host/README.md` 中 / 英，共 **3 处表**）：
   把 Windows 行从「**RC 尚未执行门禁、待回填**」改为用户可读的**支持 / 验证结果**口径
   （按 v0.19.7 先例，回填后的用户口径**不含**内部工作编号、门禁机制与「待回填」等开发过程信息）。
   若 macOS 仍不执行，其行保持「本次未执行真机门禁」不变。
4. **（仅当因回填重打终版包时）** 在 §4 追加终版产物表：路径 / 字节数 / sha256 / sha1 / 成员数，
   并用 `diff -rq` 实拍与 RC 的差异（v0.19.7 先例：仅 `README.md` 不同 ⇒ 其余 36 个文件逐字节相同 ⇒ 真机结论继续有效；
   若差异超出 `README.md`，须重新跑门禁，不得沿用）。

**发布剩余步骤（待负责人执行，主管不代做）**：
① 在原生 Windows 上执行 §6 → ② 按本节回填（清单 + `platform-gate.md` + README ×3）→
③ 合并 `main` + 打 annotated tag `v0.19.8` → ④ `npm publish`（负责人手动）→
⑤ 发布后对账：`npm view dsh-graph@0.19.8 dist.shasum` 与本包 sha1 对账（registry 规范化差异口径见 `docs/release-handbook.md`）→
⑥ 由负责人在看板决定是否把 v0.19.8 泳道标为 `released`。
