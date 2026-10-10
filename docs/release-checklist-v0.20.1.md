# dsh-graph v0.20.1 发布检查清单

> **本文件状态：发布准备 = 已完成（版本串转正 / g352 夹具复冻 / CHANGELOG 与守卫 / 发布正文真源 / 本清单 /
> 独立构建路径产物与对账 / 自证闸门 全部落地）；平台回填 + 重建重打 = 已完成（第 1 轮 Windows 真机门禁结论回填、
> 产物重建重打并使「被测 == 发布」（§5 / §7））；**Windows 闭环轮 = 已完成**（第 2 轮真机门禁 PASS、被测产物 ==
> 发布产物 ⇒ 闭环成立；该轮只改 `docs/` 回填、**未重建 / 未重打发布产物**，产物指纹只读复算逐字未变，§7 / §7.9）；发布态动作
> （合并 `main`、打 tag、`push`、`npm publish`、GitHub release、profile 安装升级）一律**未执行**，逐条列于 §8「待负责人执行」。**
> **平台真机结论：原生 Windows = 两轮均 PASS（第 1 轮候选包轮宿主 `0.2.0-rc.2` + 第 2 轮闭环轮宿主
> `0.2.1-alpha.2`，T1–T5 均 15/0/1、T3 32/32 步）⇒「被测产物 == 发布产物」闭环成立；两轮都只覆盖安装 / 启动 / REST 层，
> 不覆盖「派发可用」维度（T1–T5 不含派发）；原生 macOS = 本版未验证** ⇒ 两份 README 的平台状态表与发布正文已按此如实
> 标注（**macOS 不得读出「已通过」；Windows 不得读作三维度齐全**）。
> 结构对照 [`docs/release-checklist-v0.20.0.md`](release-checklist-v0.20.0.md)。

**本次执行树**：发布准备 = worktree `.worktrees/g-471-att-01`，分支 `g-471-att-01`，基线 **`499805cf0010d2e6b453ee64effd5ff8dbfcbfbe`**（= `v0.20.1-test` 顶点 = g-469 派发修复合入点）；**平台门禁回填 + 重建重打 = worktree `.worktrees/g-471-att-02`**，分支 `g-471-att-02`，基线 **`39a47c81be7917d897c37c700c7aa4f30680ae13`**（= att-001 候选包合入后的 `v0.20.1-test` 顶点）；**闭环轮结论回填（只改 `docs/`）= worktree `.worktrees/g-471-att-03`**，分支 `g-471-att-03`，基线 **`a95721998898a21d89ae2f7c10681f0b01c65d3b`**（= att-002 终态发布候选合入后的 `v0.20.1-test` 顶点）。

**发布源**：`v0.20.1-test` 分支（**发布时以 `git rev-parse v0.20.1-test` 为准**，不要照抄本行短 sha —— 本清单自身的补正提交也会推进该 tip）。发布时由负责人合入 `main`。

**纪律（准备阶段，逐条可核对）**：

- 全部构建 / 测试 / 打包**只在 worktree 内**完成；**未写主树 `dist/`** —— 主树 `git status --porcelain` = **0** 行，
  主树 `dist/` mtime 保持 **`2026-10-06 12:31:23`**（构建前后逐字未变）。
- worktree 的 `node_modules` 是指向主树的**符号链接**（只读复用）：全程**未执行任何 `pnpm` / `npx`**
  （`pnpm run` 在 pnpm ≥ 11 下会先做依赖检查、可能隐式触发 `prepare` = 完整构建并原子替换主树 `dist/`）。
  构建只用 `bash scripts/build.sh`，编译 / 检查只用 `./node_modules/.bin/*`；打包用 `npm pack`（`dist/package.json`
  无 `scripts` ⇒ 无生命周期脚本可跑），并把 `npm` 缓存放进 worktree 内 `tmp/`（系统 `~/.npm` 在本沙盒只读）。
- 全部产物、日志与证据落在 worktree 内 `tmp/`（gitignored，不入 git）；**打包后立即移除 `dist/*.tgz`**（见 §5 与手册 g-470 条目）。

---

## 0. 相对上一版（v0.20.0）的变更（4 条用户可见）

1. **在 DSH 0.2.1 系宿主上派发不再失效**：宿主把子代理启动接口换了名字后，新宿主上任何派发都会直接失败
   （报 `startContinuable is not a function`）；本版把全部派发入口收口到同一处兼容层 —— 新宿主走新接口、
   旧宿主自动回退旧接口，两者都没有时明确报错，不再静默失败。
2. **兼容性结论从此必须验「派得出去」**：新宿主上「装得上、起得来」不等于可用；宿主兼容判定固定为
   **安装 / 启动 / 派发可用**三个维度，缺一不得判定兼容。
3. **本版这样验证**：用与用户相同的安装包在干净环境里装上后实测派发 —— 新宿主与旧宿主各成功派发一次并
   拿到真实子代理标识。原生 Windows 真机门禁已在本版候选包上执行，覆盖**安装 / 启动 / REST 层**（**不含「派发可用」维度**）；原生 macOS 真机门禁**本版未执行**，如实标注为「未验证」，不得读作「已通过」。
4. **配置与行为零变化**：宿主兼容声明范围、设置项与看板行为均未改动；从 v0.20.0 升级无需任何手工动作。

## 1. 目标与范围

| 目标 | 状态 | 说明 |
|---|---|---|
| `g-469` | `delivered`（已合入基线） | 宿主派发 API 双版本兼容收口：`132494d` → 合入 `499805c`（= 本目标基线）。5 处派发点统一收口到 `startSubagentCompat`（新名优先 → 旧名回退 → 两者皆无 fail-closed 抛错）。 |
| `g-471` | 本清单（发布准备） | v0.20.1 补丁版转正：版本串 / 夹具复冻 / CHANGELOG / 发布正文真源 / 本清单 / 产物对账 / 闸门。 |

## 2. 检查项

- [x] 版本串转正三处一致：`package.json` version / `PLUGIN_VERSION` / 两份 README 的版本表述，全部 = `0.20.1`（§3）
- [x] `engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh-settings"]` **未动**（保持 `>=0.1.5-rc.2 <0.2.2-0`，§3）
- [x] README 平台状态表按本轮真机结论回填：**Windows 行改为「✅ 已实测通过」**并写明实测事实与 caveat（**只覆盖安装 / 启动 / REST 层，不覆盖「派发可用」维度**）；**macOS 行保持「本版未验证」**（§7）
- [x] README 三处「最新亮点 / What's new」随本版更新为 `v0.20.1`（沿用每次发版替换该节的既有惯例）
- [x] `CHANGELOG.md` 新增 `## v0.20.1 — 2026-10-10` 节（**4 条**、用户语言、无过程痕迹）；`g371` 快照同步 `{ version: "v0.20.1", bullets: 4 }`（§6）
- [x] 发布正文真源 `docs/release-notes-v0.20.1.md` 入库（结构同 v0.20.0 模板：要点 + 安装/升级 + 验证与产物，§6）
- [x] `g352` 冻结签名 fixture 按维护者通道复冻：**仅** `source-commit` / `source-sha256` 变化（hunk `2,3c2,3`），正文与 `content-sha256` 逐字节未变（§6）
- [x] 发布手册补 g-470 条目：`cd dist && npm pack` 会把 tgz 留在 `dist/` ⇒ 同树跑闸门必红，应先跑闸门再打包或打包后移除（§6）
- [x] 本清单建立：状态 / 执行树 / 版本一致性 / 三维度兼容口径 / 独立构建路径产物对账 / 闸门 / 平台诚实性 / 待负责人执行（全文）
- [x] 产物在隔离 worktree 内构建并打包：记录文件名 + 字节数 + sha256 + sha1 + **43 成员** + `docs/` 成员 0 + 包版本 `0.20.1`；**两次重复打包 sha256 逐字一致**；打包后移除 `dist/*.tgz`（§5）
- [x] **平台门禁回填 + 重建重打**（att-002）：第 1 轮 Windows 真机结论回填两份 README / 发布正文 / 本清单 / `docs/platform-gate.md`（新增 §7.9），随后 `bash scripts/build.sh` + `dist/` 内 `npm pack` 重建重打；旧候选包另存 `tmp/uat-v0201/dsh-graph-0.20.1.round1-9b3e3e37.tgz`，新包指纹回填 §5（§5 / §7）
- [x] 自证闸门全绿：`node scripts/run-tests.mjs` + `tsc --noEmit` + `node --check dist/lib/client.js`（§6）
- [x] **原生 Windows 真机门禁（红线 1）第 1 轮（候选包轮）** —— 已由负责人执行（2026-10-10，`win32/x64` + Node `v24.21.0` + 宿主 `0.2.0-rc.2`，T1–T5 = **15/0/1 PASS**，逐字报告见 `docs/platform-gate.md` §7.9）；**只覆盖安装 / 启动 / REST 层，不覆盖「派发可用」维度**（§7）
- [x] **原生 Windows 真机门禁 第 2 轮（被测产物 == 发布产物 闭环轮）** —— 已由负责人执行（2026-10-10，`win32/x64` + Node `v24.21.0` + 宿主 **`@deepseek-ai/dsh@0.2.1-alpha.2`**（经 `--dsh` 显式锁定），T1–T5 = **15/0/1 PASS**、T3 32/32 步；被测产物 = 终态发布候选 `dsh-graph-0.20.1.tgz` sha256 `94459a16…`）⇒ **「被测产物 == 发布产物」闭环成立**（§7；逐字报告见 `docs/platform-gate.md` §7.9）
- [x] **闭环轮结论回填**（att-003，**只改 `docs/`**）：第 2 轮结论回填 `docs/platform-gate.md`（回填表新增闭环轮行 + §7.9 闭环轮小节）、`docs/release-notes-v0.20.1.md`、本清单 §7 / §8；**未改任何入包文件、未重建 / 未重打发布产物**，产物指纹只读复算逐字未变（§5 / §7）
- [ ] **原生 macOS 真机门禁** —— **本版未执行**（§7）
- [ ] 合并 `main` / 打 annotated tag / `push` / `npm publish` / GitHub release / profile 安装升级 —— **待负责人执行**（§8）

## 3. 版本号一致性（红线 2）逐处证据

红线 2 的来源是 0.11.0 教训：`PLUGIN_VERSION` 常量**不参与构建校验**，版本串漂移只有人工核对才查得出。

| 落点 | 文件:行 | 实际值 |
|---|---|---|
| 包清单（真源） | `dsh-graph-host/package.json:3` | `"version": "0.20.1",` |
| 客户端常量（源） | `dsh-graph-host/lib/client/constants.js:12` | `const PLUGIN_VERSION = "0.20.1";` |
| 客户端常量（构建产物） | `dist/lib/client.js:2457` | `const PLUGIN_VERSION = "0.20.1";` |
| 构建产物包清单 | `dist/package.json:3` | `"version": "0.20.1",` |
| 根 `package.json` | `package.json:3` | `"private": true`，**无 `version` 字段（未动，符合预期）** |
| README（根，中）当前版本 | `README.md:18` | `**当前版本 v0.20.1**` |
| README（根，中）最新亮点 | `README.md:20` | `**最新亮点（v0.20.1）**` |
| README（包内，中）当前版本 | `dsh-graph-host/README.md:43` | `**当前版本**：v0.20.1` |
| README（包内，中）最新亮点 | `dsh-graph-host/README.md:57` | `**最新亮点（v0.20.1）**` |
| README（包内，英）Current version | `dsh-graph-host/README.md:285` | `**Current version**: v0.20.1` |
| README（包内，英）What's new | `dsh-graph-host/README.md:299` | `**What's new (v0.20.1)**` |
| CHANGELOG 本版节 | `CHANGELOG.md:10` | `## v0.20.1 — 2026-10-10` |
| CHANGELOG 守卫快照 | `core/tests/g371-changelog-guard.test.ts:39` | `{ version: "v0.20.1", bullets: 4 },` |
| tarball 内包清单 | `package/package.json:3`（`dsh-graph-0.20.1.tgz`） | `"version": "0.20.1",` |
| tarball 内客户端常量 | `package/lib/client.js:2457`（`dsh-graph-0.20.1.tgz`） | `const PLUGIN_VERSION = "0.20.1";` |

**`engines.dsh` / `peerDependencies` 未动（本版有意保持）**：

| 落点 | 文件:行 | 值 |
|---|---|---|
| `engines.dsh`（供 dsh-market 等宿主感知型市场读取） | `dsh-graph-host/package.json:30` | `>=0.1.5-rc.2 <0.2.2-0` |
| `peerDependencies["@deepseek-ai/dsh-settings"]`（**宿主门禁唯一真源**） | `dsh-graph-host/package.json:35` | `>=0.1.5-rc.2 <0.2.2-0` |

⇒ 兼容声明面在 v0.20.0 已放宽，本补丁版**只改派发实现、不动声明面**（改声明面会改变安装门禁语义，超出补丁范围）。

**开发线版本串留痕（说明性，保留）**：`dsh-graph-host/README.md:43` / `:285` 仍注明 `0.20.1-alpha` 为开发线版本串 ——
这是历史标注，不是「当前版本」声明。

## 4. 宿主兼容与「派发可用」维度（本版核心）

本版修复的根因与三维度口径见 [`docs/release-handbook.md`](release-handbook.md) §5.1：

- DSH `0.2.1-alpha.2` 起 `@deepseek-ai/dsh-subagent` 把 `startContinuable(spec)` 改名为 `startActivation(spec)`，
  旧调用在**新宿主上全部派发点**报 `subagents.startContinuable is not a function`（不影响安装与启动 ⇒
  只看「可装可跑」会把「派发完全不可用」误判为兼容）。
- 修复：`dsh-graph-host/index.js` 的唯一收口 helper `startSubagentCompat(subagents, spec)`（新名优先 → 旧名回退 →
  两者皆无则 fail-closed 抛错），5 处派发点全部收口；回归守卫 `core/tests/g469-host-subagent-api-compat.test.ts`。
- 本版发布前的验证方式：**按用户安装方式（本地安装包）在隔离实例中安装后实测派发**，
  新宿主（`startActivation` 形态，DSH `0.2.1-alpha.2`）与旧宿主（`startContinuable` 形态）**各成功派发一次并
  拿到真实子代理标识（childId）** ⇒ 三维度（安装 / 启动 / 派发可用）齐全。
- 历史留痕：`v0.20.0` 的兼容判定只覆盖维度 1（安装）+ 维度 2（启动），**不满足**本口径 —— 手册 §5.1 已如实记录、
  不回改历史结论措辞。

## 5. 发布产物与独立构建路径对账

**本次产物由隔离 worktree 的独立构建路径产出**（`bash scripts/build.sh` → `dist/` 内 `npm pack`）。
**下表为第 3 轮起生效的「发布产物」指纹**（att-004 把包内 README 平台行改为**按宿主代际陈述的跨轮稳定措辞**后**重建重打**；构建树 `.worktrees/g-471-att-04`，基线 `69d1e9cd…`）：

| 项 | 值 |
|---|---|
| 文件名 | `dsh-graph-0.20.1.tgz` |
| 本地绝对路径 | `tmp/uat-v0201/dsh-graph-0.20.1.tgz`（仓库主树，gitignored，不入 git；由 worktree `.worktrees/g-471-att-04` 内构建 + `npm pack` 后另存） |
| 字节数 | **1,437,812** |
| sha256 | `44dc4473940d41a7f1141e7b9b96f1e89e49788c7f070a818c8913a5e716f6ee` |
| sha1 | `9c3762046271b36021e81bb376ba93fd8346d3dc` |
| 成员数 | **43** |
| `docs/` 成员数 | **0**（`docs/` 不随包发布） |
| 包内 `package.json` version | `0.20.1` |
| 包内 `lib/client.js` `PLUGIN_VERSION` | `0.20.1` |
| 包内 `README.md` == 提交源码 `dsh-graph-host/README.md` | **逐字节相同**，双方 sha256 `490686f7dc00236e0fd0086164daec662d5a3abed9230ce696a94780a951909c` |
| 包内 `index.js` == 源码（代码零变化） | **逐字节相同**，双方 sha256 `d24c5e1f8493bf88c93956384b621ff85eff48fdfdbc92f535e039aeae97b213`（与第 2 轮包同值） |
| 重复打包 | 同一构建树内**两次 `npm pack` 得同一 sha256**（逐字节可复现，实测两次均为 `44dc4473…`） |
| 校验和文件 | `tmp/uat-v0201/SHA256SUMS`（`sha256sum` 格式，随 release 附件上传） |

**历史轮次被测产物（均已另存）**：第 1 轮（候选包轮，回填前候选）sha256
`9b3e3e37afec42e40ebdce0c567f75c69e383b512fe8a3d37e7409fd4c83709b` / 1,437,282 B ⇒
`tmp/uat-v0201/dsh-graph-0.20.1.round1-9b3e3e37.tgz`；第 2 轮（闭环轮，被测 == 当轮发布产物）sha256
`94459a16ae7d8dd378230d4c8daaf0f7885d2cd68b08e67b743d28d3b2d9c22c` / 1,437,660 B ⇒
`tmp/uat-v0201/dsh-graph-0.20.1.round2-94459a16.tgz`。两轮 Windows 真机门禁均 PASS
（宿主代际分别 `0.2.0-rc.2` / `0.2.1-alpha.2`，T1–T5 = 15/0/1、T3 32/32 步）。

**第 3 轮（本轮）⇒ 上表新产物的由来与待办**：包内 README 平台行由「候选包 + 单一宿主代际」措辞改为
**按宿主代际陈述的跨轮稳定措辞**（覆盖 `0.2.0-rc.2` 与 `0.2.1-alpha.2`；**不写轮次计数** ⇒ 后续轮次通过后无需再改包内文件）
⇒ **重建重打**得上表新产物。新包相对第 2 轮包**逐文件差异实拍 = 仅 `README.md`（两处 hunk `52c52` / `294c294`）**、
其余 **42/43 逐字节相同**，产品代码 / 客户端 bundle 零变化（包内 `index.js` 仍 `d24c5e1f…b213`），
见 [`docs/platform-gate.md`](platform-gate.md) §7.9。**第 3 轮真机门禁待负责人执行**（见 §8）⇒ 回填前**不得**读作
新产物的「被测产物 == 发布产物」闭环已成立；att-003 及更早只改 `docs/`、**未重建 / 未重打发布产物**。

**构建 / 打包过程的两条实测纪律（对应手册 g-470 条目）**：

- `npm pack` **会就地生成 `dist/dsh-graph-0.20.1.tgz`** ⇒ 本次每次打包后都立即移除，`find dist -name '*.tgz' | wc -l` 实测 **0**；
  实测反例：把第一次的 tgz 留在 `dist/` 内再打包，第二次产物 sha256 与成员集合随即改变（tgz 被当作普通文件打进新包）
  ⇒ **`dist/` 必须干净后再跑闸门、再打包**。
- 本沙盒 `~/.npm` 只读 ⇒ `npm pack` 必须 `npm_config_cache=<worktree>/tmp/...`，否则报 `EROFS`。

**发布时的对账要求（待负责人执行）**：在 **tag 树**上重建重打同一包，sha256 必须与上表**逐字相等**（跨树可复现性）；
`npm publish` 推荐**直发该 tarball**（手册步骤 4'）⇒ registry 的 `dist.shasum` 与本地 sha1、`dist.integrity` 与本地
sha512 可做**字节级**对账，保证「被测产物 == 发布产物 == release 附件」。

## 6. 夹具复冻 / CHANGELOG 与守卫 / 发布正文 / 测试与静态检查

**g352 冻结签名 fixture 的重冻结口径（与 v0.20.0 / v0.19.8 同形，非削弱）**：本版必改 `constants.js` 的
`PLUGIN_VERSION`，而该 fixture 的 `source-sha256` 头覆盖 `kanban,constants,narrow-width,helpers` 四个客户端源模块
⇒ 该头必然失配（改前实测红在「fixture 与源码不同步」）。处理方式与逐项结论：

| 步骤 | 命令 / 比对 | 结论 |
|---|---|---|
| ① 手工前置首行 note | 在既有 note 前插入本轮记录（`# ` 行不参与 hash） | 保留完整历史链（g-471 → g-469 → v0.20.0 → g-462 → g-461 → g-456） |
| ② 导出到临时路径 | `G352_SIG_DUMP=<tmp> node --test --test-name-pattern="会话内看板页签签名" core/tests/g352-narrow-width.test.ts` | 1 / 1 pass，导出成功 |
| ③ 与基线比对 | `diff`（基线 = `git show 499805c:core/tests/fixtures/g352-conv-signature.txt`） | 除首行 note 外**恰 1 个 hunk `2,3c2,3`**；第 4–6 行（`source-files` / `content-sha256` / `board-width`）与正文 **0 行差异** |
| ④ `G352_SIG_ACK=1` 写回 | 覆盖后 `cmp` 与 dump **逐字节相同** | `source-commit` → `499805cf…`（基线）；`source-sha256` `3a31acd1…` → `ba533c85…`；`content-sha256` `0e6b7094…` **未变** |

**零手填 hash、零断言放宽**；重冻后套件 `core/tests/g352-narrow-width.test.ts` = **63 / 63 pass**。

**CHANGELOG 与守卫**：`## v0.20.1 — 2026-10-10` 节 **4 条**（用户语言、无 `g-XXX` / 门禁数字 / 指纹等过程痕迹）；
`g371` 快照新增 `{ version: "v0.20.1", bullets: 4 }`，**未**放宽 `MAX_BULLETS_PER_SECTION`（= 5）或任何既有断言；
守卫负向对照（删整节 / 删一条 / 乱序 / 去日期 / 超上限 / 混入审计数字）保持原样必红。

**发布正文真源**：`docs/release-notes-v0.20.1.md`，必需小节齐备（手册 §4.1）：
`## v0.20.1 — 2026-10-10` + 要点（与 CHANGELOG 同文，4 条）+ `### 安装 / 升级` + `### 验证与产物`
（含平台门禁如实标注 / 派发可用维度 / 产物 sha256 + sha1 + 成员数 / 发布记录链接 / 可复现性）。

**发布手册新增条目（g-470，原句）**：

> ⚠️ **打包与整套件自证闸门的先后顺序（g-470）**：`cd dist && npm pack` 会把 `dsh-graph-X.Y.Z.tgz` **留在 `dist/` 内**
> ⇒ 之后在**同一棵树**跑整套件自证闸门**必红**：`g-348` 判据 2 会报该 tgz 在原子发布期间缺失（ENOENT），
> `g-353` 会报 dist 树 hash 前后不一致。⇒ 应**先跑闸门再打包**；或打包后**先移除 `dist/*.tgz`**（tarball 另存 `tmp/`）再跑闸门。

**测试与静态检查（worktree `.worktrees/g-471-att-01` 内，打包后已移除 `dist/*.tgz`）**：

| 项 | 命令 | 结果 |
|---|---|---|
| 整套件自证闸门 | `node scripts/run-tests.mjs` | **tests=2369 / pass=2369 / fail=0 / skipped=0 / cancelled=0 / todo=0，exit 0** |
| CHANGELOG 守卫（含负向对照） | `node --test core/tests/g371-changelog-guard.test.ts` | **3 / 3 pass，fail 0** |
| 冻结签名 fixture 套件 | `node --test core/tests/g352-narrow-width.test.ts` | **63 / 63 pass，fail 0** |
| 类型检查 | `./node_modules/.bin/tsc --noEmit -p tsconfig.json` | **exit 0**（零错） |
| 产物语法 | `node --check dist/lib/client.js` | **exit 0** |

**att-002（平台回填 + 重建重打）后的复跑**：在 worktree `.worktrees/g-471-att-02` 的全部文档回填**之后**（且已移除
`dist/*.tgz`）复跑同一套件 —— **tests=2369 / pass=2369 / fail=0 / skipped=0 / cancelled=0 / todo=0，exit 0**
（自证行：`tests=2369 (>0) skipped=0 fail=0 cancelled=0 todo=0 pass=2369 exit=0`）；`tsc --noEmit` **exit 0**；
`node --check dist/lib/client.js` **exit 0**。**未复冻夹具**（本 attempt 不动 `constants.js` 与看板源码 ⇒ `g352` 签名未失配，63/63 绿）。

**att-003（闭环轮结论回填，只改 `docs/`）后的复跑**：在 `docs/` 回填**之后**复跑同一套件（worktree `.worktrees/g-471-att-03`）
—— **tests=2369 / pass=2369 / fail=0 / skipped=0 / cancelled=0 / todo=0，exit 0**（自证行：
`tests=2369 (>0) skipped=0 fail=0 cancelled=0 todo=0 pass=2369 exit=0 glob=core/tests/*.test.ts`）；
`./node_modules/.bin/tsc --noEmit -p tsconfig.json` **exit 0**（零错）。本 attempt **未改任何入包文件、未打包**；
因 `dist/` 是 gitignored 生成物、新 worktree 内本不存在（闸门自身的失败提示即要求 `bash scripts/build.sh` 先建 dist），
故在 att-03 worktree 内执行了一次**本地** `bash scripts/build.sh`（只写 worktree 内 `dist/`；**不打包、不触碰主树 `dist/`、
不改动任何入包文件**）：产出 `dist/` 树 hash `9318c2159ad9d898` 与产出发布候选 `94459a16…` 的 att-02 构建树**逐字相同**，
`dist/package.json` version = `0.20.1`、`dist/` 内 `*.tgz` = 0。

## 7. 平台门禁（**如实标注**）

| 平台 | 本版（`v0.20.1`）状态 | README 落点 |
|---|---|---|
| Linux / WSL2 | ✅ 已实测通过（本版整套件自证闸门 fail 0） | 两份 README 平台表首行 |
| 原生 Windows（红线 1） | ✅ **已实测通过（2026-10-10）** —— **第 1 轮 = 候选包轮**（宿主 `0.2.0-rc.2`）+ **第 2 轮 = 闭环轮**（宿主 `@deepseek-ai/dsh@0.2.1-alpha.2`，经 `--dsh` 显式锁定）；两轮真机 T1–T5 均通过 15 / 失败 0 / 告警 1、T3 生命周期均 32/32 步 ⇒ **`0.2.0-rc.2` 与 `0.2.1-alpha.2` 两个宿主代际均已覆盖**；第 2 轮被测产物 == 当轮发布产物（`94459a16…`）⇒ **该轮闭环成立**。**第 3 轮（跨轮稳定措辞后重建重打的新产物 `44dc4473…`）待负责人执行**（见 §8）。**各轮都只覆盖安装 / 启动 / REST 层，不覆盖「派发可用」维度**（T1–T5 不含派发）。出处：`docs/platform-gate.md` §7.9（① 候选包轮 / ② 闭环轮 / ③ 第 3 轮待执行） | `README.md:34` / `dsh-graph-host/README.md:52` / 英文镜像 `:294` |
| 原生 macOS | ⏳ **本版未验证** —— `v0.20.1` **未**在原生 macOS 上执行真机门禁 | `README.md:35` / `dsh-graph-host/README.md:53` / 英文镜像 `:295` |

三条必须写死、不得误读：

- **历史处置（已执行）**：发布准备阶段 README 的 Windows 行曾由 `v0.20.0` 的「✅ 已实测通过」改为
  「⏳ 本版未验证」（当时 `v0.20.1` 未在原生 Windows 执行真机门禁），并把既有结论明确标注为「最近一次真机结论为
  `v0.20.0` … 只覆盖 v0.20.0 的产品代码」。
- **本轮回填（已执行）**：负责人于 **2026-10-10** 补跑第 1 轮真机门禁（候选包轮）⇒ 两份 README 的 Windows 行改为
  「✅ **已实测通过**」并写死 caveat：**只覆盖安装 / 启动 / REST 层，不覆盖「派发可用」维度**（该维度本版在
  Linux/WSL2 隔离实例上验证）；**不得**把该行读作 Windows 三维度（安装 / 启动 / 派发可用）齐全。
  **macOS 行保持「本版未验证」**（未执行真机门禁，不得顺带改读作已通过）。
- **红线 1 闭环已成立（第 2 轮 = 闭环轮，已执行）**：第 1 轮被测产物是**回填前**候选包（`9b3e3e37…`）；README
  回填后 att-002 已**重建重打**（§5）⇒ 负责人于 2026-10-10 在**新包**（`94459a16…`）上补跑**第 2 轮（闭环轮）**：
  宿主锁定 **`@deepseek-ai/dsh@0.2.1-alpha.2`**（补上第 1 轮 `npx -y @deepseek-ai/dsh` 拿到 npm `latest` =
  `0.2.0-rc.2` 的**代际缺口**），T1–T5 = **15/0/1 PASS**、T3 32/32 步 ⇒ **被测产物 == 发布产物 闭环成立**。
  逐字报告见 [`docs/platform-gate.md`](platform-gate.md) §7.9（① 候选包轮 / ② 闭环轮）。
- **第 3 轮（跨轮稳定措辞后重建重打，待负责人执行）**：包内 README 的 Windows 行已改为**按宿主代际陈述**（覆盖
  `0.2.0-rc.2` 与 `0.2.1-alpha.2`，**不写轮次计数** ⇒ 后续轮次通过后无需再改包内文件）；att-004 据此**重建重打**得
  上表新发布产物 `44dc4473…`，新包相对第 2 轮包**只改 `README.md` 两处 hunk（`52c52` / `294c294`）**、42/43 逐字节相同
  （产品代码零变化）。**第 3 轮真机门禁待负责人执行**（§8）；执行前**不得**读作新产物的「被测产物 == 发布产物」闭环成立。

## 8. 待负责人执行（发布态动作 —— **本清单准备阶段一律未执行**）

- [x] **原生 Windows 真机门禁 第 2 轮（被测产物 == 发布产物 闭环轮）** —— **已完成（2026-10-10，负责人）**：用 §5 的
      **新** tarball（sha256 `94459a16…`）跑 `scripts/win-smoke-test.mjs`（T1–T5）+ 32 步看板文件系统生命周期检查
      （红线 1），宿主**锁定 `@deepseek-ai/dsh@0.2.1-alpha.2`**（第 1 轮拿到的是 npm `latest` = `0.2.0-rc.2`）⇒
      T1–T5 = **15/0/1 PASS**、T3 **32/32 步**、**被测产物 == 发布产物 闭环成立**。第 1 轮（候选包轮，`9b3e3e37…`）
      同样已于 2026-10-10 完成；两轮逐字报告见 [`docs/platform-gate.md`](platform-gate.md) §7.9。第 2 轮结论已回填
      `docs/platform-gate.md` / 发布正文 / 本清单 §7 三处（att-003，仅 `docs/`；**未改入包文件**）。
- [ ] **原生 Windows 真机门禁 第 3 轮（跨轮稳定措辞后重建重打的新产物，sha256 `44dc4473…`）** —— **待负责人执行**：
      用 §5 的**新** tarball（sha256 `44dc4473940d41a7f1141e7b9b96f1e89e49788c7f070a818c8913a5e716f6ee` / 1,437,812 B）
      跑 `scripts/win-smoke-test.mjs`（T1–T5）+ 32 步看板文件系统生命周期检查（红线 1）；建议**沿用第 2 轮的显式锁定宿主形态**
      （`--dsh "npx -y @deepseek-ai/dsh@0.2.1-alpha.2"`）以维持宿主代际覆盖（`0.2.0-rc.2` + `0.2.1-alpha.2`）。
      预期 T1–T5 = 15/0/1、T3 32/32 步（与第 1/2 轮同值；新包相对第 2 轮包**只改 `README.md` 两处 hunk**，被检查行为不变）。
      执行后回填 [`docs/platform-gate.md`](platform-gate.md) §7.9 的「被测产物」表第 3 轮行（结果列）与本节。
- [ ] **（可选）原生 macOS 真机门禁**：按 [`docs/platform-gate.md`](platform-gate.md) §5 命令序列执行；
      未执行则维持「本版未验证」。
- [ ] **合并 `main`**：`v0.20.1-test` → `main`（`--no-ff`），并核对 `HEAD^{tree}` 与分支 tip tree 逐字相等。
      ⚠️ **必须先合 `main` 再发布**：见 §9（README / 文档的图链接解析到 `blob/main`，否则 404）。
- [ ] **打 annotated tag `v0.20.1`**（非轻量 tag），并核对 tag 对象解引用到合并提交。
- [ ] **`git push`**（`main` + tag）。
- [ ] **`npm publish`**：推荐**直发 §5 的 tarball**（手册步骤 4'，registry 不重打）⇒ `npm view dsh-graph@0.20.1 dist --json`
      的 `shasum` 应 == 本地 sha1 `9c376204…`、`fileCount` == **43**；`integrity` 与本地 sha512 逐字对账。
- [ ] **GitHub release `v0.20.1`**：附件 = tarball + `SHA256SUMS`；正文用
      `gh release create v0.20.1 -R miuzel/dsh-graph <tarball> SHA256SUMS --title "v0.20.1" --notes-file docs/release-notes-v0.20.1.md`；
      发布后以 `gh release view --json body` 与真源**逐字比对**（唯一可接受差异：文末换行归一化）。
- [ ] **profile 安装 / 升级验证**：全新 profile（隔离 `DSH_HOME`）按用户方式安装 `dsh-graph@0.20.1`，
      复核三维度（安装 / 启动 / **派发可用**：`graph_start_attempt` 返回真实 `child_id`）。
- [ ] **发布源树对账**：在 `v0.20.1` tag 树上重建重打，sha256 与 §5 逐字比对（跨树可复现性）。
- [ ] 在看板决定 `v0.20.1` 泳道状态（`released` 与否）。

## 9. 发布期约束（**必须先合 `main`，否则文档与 README 的图链接 404**）

随包发布的**两张设计哲学交互图**与相关文档，其链接最终都解析到 **`main`** 分支上的文件：

- `dsh-graph-host/README.md`（中 / 英）以**绝对链接**指向 `blob/main/docs/design-philosophy.zh.md` / `...en.md`；
- 这两份文档内以**相对链接**指向 `../dsh-graph-host/diagrams/design-philosophy.{lifecycle,workflow}.html`
  与 `assets/design-philosophy.*.svg` —— GitHub 按**文件所在分支**解析相对链接 ⇒ 同样落到 `main`。

图路由本身（插件自带只读路由 `/api/dsh-graph/diagram/<name>`，从 `dist/diagrams/` 现读）与包内相对资产**不受此约束**。
该约束来自 `g-460` 判据 15，是**发布顺序**要求，不是缺陷。
