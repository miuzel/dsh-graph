# dsh-graph v0.20.1 发布检查清单

> **本文件状态：发布准备 = 已完成（版本串转正 / g352 夹具复冻 / CHANGELOG 与守卫 / 发布正文真源 / 本清单 /
> 独立构建路径产物与对账 / 自证闸门 全部落地）；发布态动作（合并 `main`、打 tag、`push`、`npm publish`、
> GitHub release、profile 安装升级、真机门禁）一律**未执行**，逐条列于 §8「待负责人执行」。**
> **平台真机结论：原生 Windows = 本版未验证；原生 macOS = 本版未验证** ⇒ 两份 README 的平台状态表与发布正文
> 均按「本版未验证」如实标注（**不得读出「已通过」**）。最近一次真机结论（`v0.20.0`）只覆盖 v0.20.0 的产品代码。
> 结构对照 [`docs/release-checklist-v0.20.0.md`](release-checklist-v0.20.0.md)。

**本次执行树**：worktree `.worktrees/g-471-att-01`，分支 `g-471-att-01`，基线 **`499805cf0010d2e6b453ee64effd5ff8dbfcbfbe`**（= `v0.20.1-test` 顶点 = g-469 派发修复合入点）。

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
   拿到真实子代理标识。原生 Windows 与 macOS 真机门禁**本版未执行**，如实标注为「未验证」，不得读作「已通过」。
4. **配置与行为零变化**：宿主兼容声明范围、设置项与看板行为均未改动；从 v0.20.0 升级无需任何手工动作。

## 1. 目标与范围

| 目标 | 状态 | 说明 |
|---|---|---|
| `g-469` | `delivered`（已合入基线） | 宿主派发 API 双版本兼容收口：`132494d` → 合入 `499805c`（= 本目标基线）。5 处派发点统一收口到 `startSubagentCompat`（新名优先 → 旧名回退 → 两者皆无 fail-closed 抛错）。 |
| `g-471` | 本清单（发布准备） | v0.20.1 补丁版转正：版本串 / 夹具复冻 / CHANGELOG / 发布正文真源 / 本清单 / 产物对账 / 闸门。 |

## 2. 检查项

- [x] 版本串转正三处一致：`package.json` version / `PLUGIN_VERSION` / 两份 README 的版本表述，全部 = `0.20.1`（§3）
- [x] `engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh-settings"]` **未动**（保持 `>=0.1.5-rc.2 <0.2.2-0`，§3）
- [x] README 平台状态表按「本版未验证」如实标注（Windows 行由 v0.20.0 的「已实测通过」改为「未验证」并标注历史结论归属，§7）
- [x] README 三处「最新亮点 / What's new」随本版更新为 `v0.20.1`（沿用每次发版替换该节的既有惯例）
- [x] `CHANGELOG.md` 新增 `## v0.20.1 — 2026-10-10` 节（**4 条**、用户语言、无过程痕迹）；`g371` 快照同步 `{ version: "v0.20.1", bullets: 4 }`（§6）
- [x] 发布正文真源 `docs/release-notes-v0.20.1.md` 入库（结构同 v0.20.0 模板：要点 + 安装/升级 + 验证与产物，§6）
- [x] `g352` 冻结签名 fixture 按维护者通道复冻：**仅** `source-commit` / `source-sha256` 变化（hunk `2,3c2,3`），正文与 `content-sha256` 逐字节未变（§6）
- [x] 发布手册补 g-470 条目：`cd dist && npm pack` 会把 tgz 留在 `dist/` ⇒ 同树跑闸门必红，应先跑闸门再打包或打包后移除（§6）
- [x] 本清单建立：状态 / 执行树 / 版本一致性 / 三维度兼容口径 / 独立构建路径产物对账 / 闸门 / 平台诚实性 / 待负责人执行（全文）
- [x] 产物在隔离 worktree 内构建并打包：记录文件名 + 字节数 + sha256 + sha1 + **43 成员** + `docs/` 成员 0 + 包版本 `0.20.1`；**两次重复打包 sha256 逐字一致**；打包后移除 `dist/*.tgz`（§5）
- [x] 自证闸门全绿：`node scripts/run-tests.mjs` + `tsc --noEmit` + `node --check dist/lib/client.js`（§6）
- [ ] **原生 Windows 真机门禁（红线 1）** —— **本版未执行**（§7）
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

**本次产物由隔离 worktree 的独立构建路径产出**（`bash scripts/build.sh` → `dist/` 内 `npm pack`）：

| 项 | 值 |
|---|---|
| 文件名 | `dsh-graph-0.20.1.tgz` |
| 本地绝对路径 | `.worktrees/g-471-att-01/tmp/uat-v0201/dsh-graph-0.20.1.tgz`（gitignored，不入 git） |
| 字节数 | **1,437,282** |
| sha256 | `9b3e3e37afec42e40ebdce0c567f75c69e383b512fe8a3d37e7409fd4c83709b` |
| sha1 | `eae514760eab054bfa0e596e50050744c3ad3d86` |
| 成员数 | **43** |
| `docs/` 成员数 | **0**（`docs/` 不随包发布） |
| 包内 `package.json` version | `0.20.1` |
| 包内 `lib/client.js` `PLUGIN_VERSION` | `0.20.1` |
| 重复打包 | 同一构建树内**两次 `npm pack` 得同一 sha256**（逐字节可复现） |
| 校验和文件 | `tmp/uat-v0201/SHA256SUMS`（`sha256sum` 格式，随 release 附件上传） |

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

## 7. 平台门禁（**如实标注**）

| 平台 | 本版（`v0.20.1`）状态 | README 落点 |
|---|---|---|
| Linux / WSL2 | ✅ 已实测通过（本版整套件自证闸门 fail 0） | 两份 README 平台表首行 |
| 原生 Windows（红线 1） | ⏳ **本版未验证** —— `v0.20.1` **未**在原生 Windows 上执行真机门禁 | `README.md:34` / `dsh-graph-host/README.md:52` / 英文镜像 `:294` |
| 原生 macOS | ⏳ **本版未验证** —— `v0.20.1` **未**在原生 macOS 上执行真机门禁 | `README.md:35` / `dsh-graph-host/README.md:53` / 英文镜像 `:295` |

两点必须写死、不得误读：

- **不得沿用 `v0.20.0` 的「已通过」表述**：README 的 Windows 行由原来的「✅ **已实测通过** … 本版终版包」
  改为「⏳ **本版未验证**（`v0.20.1` 未在原生 Windows 执行真机门禁）」，并把既有结论明确标注为
  「**最近一次真机结论为 `v0.20.0` … 只覆盖 v0.20.0 的产品代码**」；发布正文同口径。
- 红线 1 要求「每个版本发布前必须在原生 Windows 上做一次兼容性测试；Windows 验证缺失时 README 须如实标注
  「Windows 未验证」」⇒ **本版缺该项真机结论**，故 README 与发布正文一律按「未验证」呈现；
  若负责人在发布前补跑真机门禁，须在 README / 发布正文 / 本清单三处同步回填，并**重建重打产物**使被测 == 发布。

## 8. 待负责人执行（发布态动作 —— **本清单准备阶段一律未执行**）

- [ ] **（可选，先决）原生 Windows 真机门禁**：用 §5 的 tarball 跑 `scripts/win-smoke-test.mjs`（T1–T5）+ 看板文件系统
      生命周期检查（红线 1）；若执行，回填 README / 发布正文 / 本清单并重建重打（被测 == 发布）。
- [ ] **（可选）原生 macOS 真机门禁**：按 [`docs/platform-gate.md`](platform-gate.md) §5 命令序列执行；
      未执行则维持「本版未验证」。
- [ ] **合并 `main`**：`v0.20.1-test` → `main`（`--no-ff`），并核对 `HEAD^{tree}` 与分支 tip tree 逐字相等。
      ⚠️ **必须先合 `main` 再发布**：见 §9（README / 文档的图链接解析到 `blob/main`，否则 404）。
- [ ] **打 annotated tag `v0.20.1`**（非轻量 tag），并核对 tag 对象解引用到合并提交。
- [ ] **`git push`**（`main` + tag）。
- [ ] **`npm publish`**：推荐**直发 §5 的 tarball**（手册步骤 4'，registry 不重打）⇒ `npm view dsh-graph@0.20.1 dist --json`
      的 `shasum` 应 == 本地 sha1 `eae51476…`、`fileCount` == **43**；`integrity` 与本地 sha512 逐字对账。
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
