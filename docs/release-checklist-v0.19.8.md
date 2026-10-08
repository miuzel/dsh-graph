# dsh-graph v0.19.8 发布检查清单

> **本文件状态：Windows 真机复验 = 已执行 ⇒ PASS；macOS = 本次未执行（如实登记）。** 发布准备（含真机结论回填与终版包重打）已在隔离 worktree 内完成，只登记**已实测**的结论。
>
> **红线 1（Windows）：已执行 ⇒ PASS（2026-10-08，原生 Windows）。** 负责人在**原生 Windows**（`win32/x64`，Node `v24.21.0`，宿主 `0.2.0-rc.2`）上对**被测产物 = §4 的 RC**（`dsh-graph-0.19.8.tgz`，**694847 B**，sha256 `16cbe277…`，与 §4 逐字一致）执行：
>
> ```sh
> node scripts/win-smoke-test.mjs --tarball dsh-graph-0.19.8.tgz
> ```
>
> ⇒ **通过 15 / 失败 0 / 告警 1**（T3 看板文件系统生命周期 **32/32 步**）；另在仓库根补跑 `node scripts/win-smoke-test.mjs --static-only .`
> ⇒ **通过 2 / 失败 0 / 告警 0**（台账 **66 项 / 258 处命中 / 未登记 0**；**该次运行平台为 Linux，非 Windows，如实标注**）。
> 唯一告警为**设计内**（`--tarball` 模式发布包内不含 `core/*.ts` ⇒ 台账对账改在仓库根完成），非缺陷。
> 逐字报告（含两段回传原文）见 `docs/platform-gate.md` **§7.6**。
> **经过说明（已满足）**：`docs/platform-gate.md` §7.1–§7.4 已登记的历史真机 PASS 覆盖的是 **v0.19.7 及更早的产品代码**（§7.3 = v0.19.7 发布候选包），
> 而 v0.19.8 含 16 项目标的产品改动 ⇒ 它们**不能替代**本次 RC 门禁 —— 故本清单先如实记为「待回填」，
> 待负责人对 §4 的 RC 真机执行后才回填为上述结论；**回填现已按 §7 完成**。

> 流程沿用 v0.10.0 起确立的做法：主管完成准备并（经负责人授权后）合并 `main` + 打 annotated tag，
> 再由**负责人手动执行 `npm publish`**。
> 本文件同时承载 v0.19.8 的 Release Notes 与发布前 / 发布后检查项。
> 版本线说明：v0.19.8 泳道（16 项目标）承接上一发布版本 `v0.19.7`；开发线版本串为 `0.19.8-alpha`。
> 集成分支 `v0.19.8-test`（发布准备合入后 tip **`5f08af4`**；发布准备提交 `1eaad28`，基线 `6d62af6`）已含 v0.19.8 全部工作，`v0.19.7-test` 为其祖先。
> 合并提交 `5f08af4` 与发布准备提交 `1eaad28` **同树**（`docs/` 不入包）⇒ §4 的 RC 指纹对最终集成 tip 同样成立（已在 `5f08af4` 上重建复核，指纹一致）。
> 本清单结构对照 [`docs/release-checklist-v0.19.7.md`](release-checklist-v0.19.7.md)。

> **准备阶段未执行任何发布动作**：未 `npm publish`、未打 tag、未创建 GitHub release、未 `git push`、
> 未合并 `main`、未改写 git 历史、未触碰 `engines` 与 `peerDependencies`。
> 是否合并 `main` / 打 tag / 发布由负责人在人工 gate 决定。

**本次执行树**：（发布准备）worktree `.worktrees/g-455-att-01`，分支 `g-455-att-01`，基线 **`6d62af6`**（= 合入前的 `v0.19.8-test` HEAD）；发布准备提交 **`1eaad28`**（worktree tip），已并入 `v0.19.8-test`（`5f08af4`）。
**本次执行树**：（真机结论回填 + 终版包重打）worktree `.worktrees/g-455-att-02`，分支 `g-455-att-02`，基线 **`27b0880`**（= `v0.19.8-test` tip；`27b0880` 为 `5f08af4` 之上的 docs-only 提交，故 §4 的 RC 指纹对本基线同样成立，本轮已重建复核一致）。
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
> 并把**三处平台状态表的 Windows / macOS 行如实化**（`f5fb6b9` 同形做法）：准备期 Windows 行先如实记为
> 「**v0.19.8 发布候选包尚未在原生 Windows 上执行门禁，不得读出「已通过」**」，并注明历史真机记录只覆盖
> v0.19.7 及更早的产品代码、**不能替代本次 RC**；**真机结论回来后已按 §7 回填为实测口径**
> （Windows = v0.19.8 RC 已在原生 Windows 实测 **PASS**：15/0/1、T3 32 步、台账 2/0/0 与 66 项/258 处命中/未登记 0）；
> macOS 行保持「本次未执行真机门禁」不变；
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
- [x] README 三处渠道（根 + 包内 zh/en）版本表述与「最新亮点」更新为 v0.19.8；平台状态行**已回填为实测口径**（Windows = v0.19.8 RC 已在原生 Windows 实测 PASS：15/0/1、T3 32 步、台账 2/0/0 与 66 项/258 处命中/未登记 0；macOS = 本次未执行；Linux/WSL2 = 已实测）（§0 引文、§6）
- [x] `CHANGELOG.md` 新增 `## v0.19.8 — 2026-10-08`（5 条用户语言、无过程痕迹）；`g371` 快照补 `{ version: "v0.19.8", bullets: 5 }`；顶部链接指向本清单
- [x] 本清单建立：状态 / 集成 HEAD / RC 指纹 / 整版门禁数字 / 16 项目标映射 / 待负责人 Windows 命令 / 回填说明（§1 / §4 / §5 / §6 / §7）
- [x] RC 产物在隔离 worktree 内构建并记录（§4）
- [x] **Windows 真机门禁（红线 1）—— 已执行 ⇒ PASS**：负责人在原生 Windows（`win32/x64`，Node `v24.21.0`）上对 §4 的 RC（以 sha256 对账一致）
      执行 `node scripts/win-smoke-test.mjs --tarball dsh-graph-0.19.8.tgz` ⇒ **通过 15 / 失败 0 / 告警 1**，T3 看板文件系统生命周期 **32/32 步**；
      另在仓库根执行 `node scripts/win-smoke-test.mjs --static-only .` ⇒ **通过 2 / 失败 0 / 告警 0**（台账 66 项 / 258 处命中 / 未登记 0；**该次运行平台为 Linux，如实标注**）。逐字报告见 `docs/platform-gate.md` §7.6（§6）
- [x] 终版包在隔离 worktree 内重建重打并记录（§4 终版产物表）：与 RC 经 `diff -rq` 实拍**仅 `README.md` 不同**（其余 36 个文件逐字节相同）；可复现性复核 sha256 一致（§6）
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
（**回填轮的例外，如实登记**：`docs/platform-gate.md` 在**真机结论回填**时**接续追加** `### 7.6`（§7.5 之后）——
这是清单结构要求的回填落点，**§7.1–§7.5 与全文其余部分逐字未动**；见 §7.1 实际改动清单。）

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
**终版产物（真机结论回填后重打；本版发布产物）**：

| 项 | 值 |
|---|---|
| 产物 | `tmp/release-0198-final/dsh-graph-0.19.8.tgz`（worktree `.worktrees/g-455-att-02` 内，gitignored） |
| 打包命令 | `bash scripts/build.sh` + `(cd dist && npm pack --pack-destination <worktree>/tmp/release-0198-final --cache ../tmp/npm-cache --logs-dir ../tmp/npm-logs)` |
| 字节数 | **694954** |
| sha256 | `8915d7dd201bfa14d3551358984e2a9a254c8d55d1fd5e32257edaa473d081b1` |
| sha1 | `64bfd8d1834daaf3527a6db5d65881eb15c39221` |
| 成员文件数 | **37** |
| 与 RC 的差异 | `diff -rq` 输出**仅 1 行**：`package/README.md` 不同 ⇒ 其余 **36 个文件逐字节相同**（实拍见下与 `docs/platform-gate.md` §7.6） |
| 包内版本实锤 | `package/package.json` version = `0.19.8`；`package/lib/client.js` `PLUGIN_VERSION = "0.19.8"` |
| `dist/` 内 `.tgz` 残留 | **0** |

与 RC 的 `diff -rq` **实拍输出**（两包各自解包后逐文件对比）：

```text
$ diff -rq tmp/rc-extract/package tmp/final-extract/package
Files tmp/rc-extract/package/README.md and tmp/final-extract/package/README.md differ
```

⇒ **差异文件数 = 1（仅 `README.md`），逐字节相同 = 36 / 37**；差异内容**全部是用户可见文案** ——
两份平台状态表的 Windows 行由「RC 尚未实测、待回填」改为「已在原生 Windows 上实测 PASS」的实测口径
（含 15 / 0 / 1、T3 32 步、台账 2 / 0 / 0 与 §7.6 指针）。产品代码（`core/*.js`）、客户端 bundle（`lib/client.js`）、
`prompts` 资产与 `package.json` 均**逐字节相同**。

**被测产物 vs 发布产物（红线 3 口径）**：真机门禁跑在**上表的 RC**（**694847 B**，sha256 `16cbe277…`）上，
发布用的是**终版包**（**694954 B**，sha256 `8915d7dd…`）。两者差异**仅 `README.md`**（用户可见文案：
平台状态行 / 版本表述）⇒ 产品代码与客户端 bundle 逐字节相同 ⇒ 真机结论对发布产物**继续有效**
（与 v0.19.7 同形做法，先例见 §7.5）。若负责人认为需要，可对终版包按 §6 命令再跑一次 `--tarball` 门禁（期望同结果）。

> **负责人裁决放置位**：**待负责人裁决：差异仅 `README.md`，是否接受不对终版包重跑门禁。**
> （v0.19.7 先例裁决为「接受 ⇒ 不重跑」；本版是否照此由负责人决定 —— 本条由负责人填写后 §4 即定稿。）

**可复现性实证（本次）**：在同一 worktree 内再次 `bash scripts/build.sh` + `npm pack` 到
`tmp/release-0198-final-repro/`，得**同一 sha256** `8915d7dd…`，且与终版包 **`cmp` 逐字节一致**
（**694954 B / 37 成员**）⇒ 发布 worktree 在发布提交上打出的包即此产物，发布前直接比 sha256 即可。

## 5. 测试与静态检查（RC：worktree `.worktrees/g-455-att-01` 内；回填 + 终版包：worktree `.worktrees/g-455-att-02` 内）

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
| **Windows 真机门禁（`--tarball`，红线 1）** | `node scripts/win-smoke-test.mjs --tarball dsh-graph-0.19.8.tgz`（**负责人，原生 Windows**） | **PASS：通过 15 / 失败 0 / 告警 1**；`覆盖=T3生命周期=32步（…，每步盘面断言）`；`平台=win32/x64 node=v24.21.0`；被测产物指纹 = §4 RC（694847 B / sha256 `16cbe277…`，脚本自报与 §4 完全一致）。唯一告警为设计内（包内无 `core/*.ts`） |
| **仓库根台账对账（`--static-only .`）** | `node scripts/win-smoke-test.mjs --static-only .`（**主管，仓库根；平台 = Linux/WSL2，非 Windows，如实标注**） | **PASS：通过 2 / 失败 0 / 告警 0**；`覆盖=台账=66项/258处命中（忽略0行，未登记即判红）`；`平台=linux/x64 node=v26.7.0`。脚本自身尾注要求「在原生 Windows 上再跑一次」⇒ 按 v0.19.7 同形登记为**仓库根台账对账**，红线 1 的真机结论以 Windows `--tarball` 轮为准 |
| **终版**整套件自证闸门（回填 + 终版包后） | `node scripts/run-tests.mjs`（worktree `.worktrees/g-455-att-02`） | **tests=2272 / pass=2272 / fail=0 / skipped=0 / cancelled=0 / todo=0，exit 0**（最终一次自证行：`tests=2272 (>0) skipped=0 fail=0 cancelled=0 todo=0 pass=2272 exit=0 ms=36913 glob=core/tests/*.test.ts`；同一 tree 上两次全量均绿，另一次 ms=36048） |
| **终版**类型检查 | `./node_modules/.bin/tsc --noEmit -p tsconfig.json` | **exit 0** |
| **终版**产物语法 | `node --check dist/lib/client.js` | **通过**（exit 0） |
| **终版**只读新鲜度 | `node --test core/tests/dist-freshness-g312.test.ts` | **5 / 5 pass，fail 0**（exit 0） |
| **终版**产物重建 / 重打 | `bash scripts/build.sh` + `npm pack`（`tmp/release-0198-final/`；再复算一轮 `-repro/`） | **694954 B / sha256 `8915d7dd…` / sha1 `64bfd8d1…` / 37 成员**；两轮 `cmp` **逐字节一致**（可复现性实证，§4） |
| **终版**与 RC 逐文件对比 | `diff -rq tmp/rc-extract/package tmp/final-extract/package` | 输出**仅 1 行**（`README.md` 不同）⇒ 其余 **36 个文件逐字节相同**（§4 实拍） |

> 一条红线纪律的留痕：两轮（RC 与终版）所有构建 / 测试 / 打包**只在各自 worktree 内**执行；主树 `dist/` mtime 保持 `2026-10-06 12:31:23`、
> 主树 `git status --porcelain` 零改动（发布准备禁止写主树资产来源）。

## 6. 执行与未执行项（如实登记）

**已执行 ⇒ PASS：Windows 真机门禁（红线 1）。** 负责人对**被测产物 = §4 的 RC**（`dsh-graph-0.19.8.tgz`，**694847 B**，
sha256 `16cbe277…`；**脚本自报指纹与 §4 完全一致**）在**原生 Windows**（`win32/x64`，Node `v24.21.0`，宿主 `0.2.0-rc.2`，
隔离 DSH_HOME/profile 均为 `win-smoke` 临时目录、跑完已清理）上执行 6.2 命令
⇒ **通过 15 / 失败 0 / 告警 1**（`覆盖=T3生命周期=32步（…，每步盘面断言）`；T1 静态门禁扫描 15 个文件无 POSIX 专有常量具名导入；
T2 安装版本 `0.19.8`、插件自带 `yaml` 已落地；T4 实例就绪 `http://127.0.0.1:3088/`；T5 路由已注册、看板载荷可读、Web UI 可达 HTTP 303）。
另由主管在**仓库根**执行 6.3 命令 ⇒ **通过 2 / 失败 0 / 告警 0**（`覆盖=台账=66项/258处命中（忽略0行，未登记即判红）`）。

- **该次台账对账在 `linux/x64`（Node `v26.7.0`）上取得，非 Windows —— 如实标注**；执行件自身尾注要求
  「发布门禁要求在原生 Windows 上再跑一次本脚本」⇒ 按 v0.19.7 同形做法（§7.3）登记为**仓库根台账对账**，
  红线 1 的真机结论以 Windows `--tarball` 轮为准。
- 逐字报告（负责人回传原文 + 主管 `--static-only` 原文）见 `docs/platform-gate.md` **§7.6**。

**未执行：macOS 真机门禁。** 负责人本次未在 macOS 上执行 ⇒ 本清单与两份 README 的 macOS 行保持
「**本次未执行真机门禁**（不得读出『已通过』）」如实口径（最近一次 macOS 真机结论见 `docs/platform-gate.md` §7.4，
其覆盖的是 **v0.19.7** 产品代码，不能替代本版）。

**被测产物 vs 发布产物（红线 3 口径）**：真机门禁跑在 **§4 的 RC**（694847 B / sha256 `16cbe277…`）上；回填后在同一隔离 worktree 内
重建重打**终版包**（694954 B / sha256 `8915d7dd…`）。两者 `diff -rq` 实拍**仅 `README.md` 不同**（其余 **36 / 37 逐字节相同**；
包内 `package.json` / `lib/client.js` / `core/*.js` / `prompts/**` 逐字节相同）⇒ 真机结论对发布产物**继续有效**
（v0.19.7 先例见 §7.5）。**是否接受该 README-only 差异、不再对终版包重跑门禁：待负责人裁决（§4 裁决放置位）。**

**可复现性实证**：终版包在同一 worktree 内再 `bash scripts/build.sh` + `npm pack` 一轮，得**同一 sha256** 且 `cmp` **逐字节一致**（§4）。

**终版相对 RC 的改动面（仅文档）**：两处 `README`（根 + 包内 zh/en 的 Windows 平台行）、`docs/release-checklist-v0.19.8.md`、
`docs/platform-gate.md`；**零产品代码 / prompts / 客户端源码 / 测试断言改动**（产品代码与 bundle 与 RC 逐字节相同，由 `diff -rq` 实拍为证）。

**未执行（不可逆动作，均由负责人在人工 gate 执行）**：`npm publish`、annotated tag、GitHub release、`git push`、合并 `main`。

### 6.1 已执行的命令序列（逐条，供复核 / 重跑）

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

## 7. 回填说明（**已按本节完成回填**；以下 1–4 项保留回填前的说明原文作留痕）

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

### 7.1 实际改动的文件清单（本轮回填，**docs-only**）

| 文件 | 改动 | 落点 |
|---|---|---|
| `README.md`（根） | Windows 平台行 → 实测口径（PASS：15/0/1、T3 32 步、台账 2/0/0 与 66 项/258 处/未登记 0、§7.6 指针）；macOS / Linux 行不变 | `README.md:35` |
| `dsh-graph-host/README.md`（包内 **zh**） | 同上（含 GitHub 绝对链接） | `dsh-graph-host/README.md:52` |
| `dsh-graph-host/README.md`（包内 **en**） | 同上（英文）；macOS / Linux 行不变 | `dsh-graph-host/README.md:285` |
| `docs/release-checklist-v0.19.8.md` | 状态行 → 「Windows 已执行 ⇒ PASS；macOS = 未执行」；红线 1 提示段 → 结论段（保留历史记录不能替代的说明作为已满足经过）；执行树补 att-02 / 基线 `27b0880`；§2 勾选 Windows + 新增终版行；§4 **终版产物表** + `diff -rq` 实拍 + 被测/发布口径 + 负责人裁决放置位 + 可复现性；§5 补真机门禁 / 台账对账 / 终版自证行；§6 执行与未执行项登记；§7 本文 | 本文件 |
| `docs/platform-gate.md` | 接续现有编号追加 `### 7.6 v0.19.8 发布候选包真机报告（逐字粘贴，2026-10-08）` 与回填表一行 | `docs/platform-gate.md`（§7.5 之后） |

**未改动**：产品代码（`core/*.ts` 与编译产物）、客户端源（`dsh-graph-host/lib/**`）、`prompts/**`、测试与断言、
`CHANGELOG.md`、`docs/release-checklist-v0.19.7.md` 及更早清单、`docs/platform-gate.md` §1–§7.5、主树 `dist/`。

**发布剩余步骤（待负责人执行，主管不代做）**：
① ~~在原生 Windows 上执行 §6~~ → **已完成 ⇒ PASS**；
② ~~按本节回填（清单 + `platform-gate.md` + README ×3）~~ → **已完成（见 §7.1）**；
③ **裁决 §4 的「README-only 差异是否接受、不再对终版包重跑门禁」**（§4 裁决放置位，待负责人填写）→
④ 合并 `main` + 打 annotated tag `v0.19.8` → ⑤ `npm publish`（负责人手动）→
⑥ 发布后对账：`npm view dsh-graph@0.19.8 dist.shasum` 与本包 sha1 对账（registry 规范化差异口径见 `docs/release-handbook.md`）→
⑦ 由负责人在看板决定是否把 v0.19.8 泳道标为 `released`。
