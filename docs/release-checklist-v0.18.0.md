# dsh-graph v0.18.0 发布检查清单

> **本文件状态：发布准备中（运行中，待回填）。** 发布准备阶段创建，只登记**已实测**的结论；
> **Windows / macOS 真机门禁本次未执行**，对应行保持空白并标注「待回填」——**不得读出「已通过」**。
>
> 流程沿用 v0.10.0 起确立的做法：主管完成准备并（经负责人授权后）合并 `main` + 打 annotated tag，
> 再由**负责人手动执行 `pnpm publish`**。
> 本文件同时承载 v0.18.0 的 Release Notes 与发布前 / 发布后检查项。
> 版本线说明：本次为 `v0.18.0`（上一发布版本为 `v0.17.0`；开发线版本串为 `0.18.0-alpha`，属 **feature 线**）。
> 本清单结构对照 [`docs/release-checklist-v0.17.0.md`](release-checklist-v0.17.0.md)。

> **准备阶段未执行任何发布动作**：未 `npm publish`、未打 tag、未创建 GitHub release、未 `git push`、
> 未合并 `main`、未改写 git 历史、未触碰 `engines` 与 `peerDependencies`。
> 是否合并 `main` / 打 tag / 发布由负责人在人工 gate 决定。

**本次执行树**：worktree `.worktrees/release-0180`，分支 `release-0180`，基线 **`298dd75`**
（= `v0.18.0-test` HEAD）。
**纪律（准备阶段）**：全部构建 / 测试 / 打包**均在 worktree 内**完成；**未写主树 `dist/`**
（主树 `dist/` 是运行中宿主的资产来源，历史上有 worker 因主树构建争用而静默死亡）；
worktree 缺 `node_modules`，经**符号链接**指向主树只读复用（不入 git，不改 `pnpm-workspace.yaml` / lockfile）。

---

## 0. 相对上一版（v0.17.0）的变更（5 条用户可见）

1. **目标间关系标记**：新增「取代 / 调整 / 补充 / 相关」四类关系，关系只记在目标文件（frontmatter）
   这一处真源，看板与工具读到的永远是同一份；依赖声明与关系严格分开，不再混写在同一个字段里。
2. **新增 `graph_set_relation` 工具**：可标记也可解除目标间关系，重复标记同一条关系不会产生第二条，
   并拒绝形成互相取代的环。
3. **看板与弹窗都能看到关系**：卡片显示关系徽标；目标弹窗在「**目标描述**」正下方直接列出只读关系清单
   （分开呈现「本目标发出的标记」与「指向本目标的标记」，并标注跨版本与已归档的对端目标）。
4. **标记对端改为搜索式选择**：输入编号或标题关键字即可定位对端目标（候选复用看板搜索的同一套匹配实现）；
   候选过多时提示继续输入以缩小范围。
5. **派发前先写目标描述**：主管派发前收到提醒；目标描述为空、只剩占位符或仅注释时 `graph_start_attempt`
   直接拒绝派发并提示用 `graph_set_description` 补写后重试（拒绝时零副作用）。

> 两份 README（根 `README.md` + 包内 `dsh-graph-host/README.md`，中英）已同步「最新亮点（v0.18.0）」；
> 仓库根 `CHANGELOG.md` 新增 `## v0.18.0 — 2026-10-02` 节（5 条要点）。

## 1. v0.18.0 版本内容集

版本主题：**目标间关系（标记 / 呈现 / 搜索式选择）+ 派发前描述门禁。**

| 目标 | 内容 | 用户 / 维护者可见效果 |
|---|---|---|
| g-378 | 派发前「先写目标描述」提醒 + `graph_start_attempt` 描述门禁 | 空描述目标的派发被一次机器检查拦下；拒绝零副作用 |
| g-379 | 目标间覆盖 / 调整 / 补充关系与单一真源标记（落法 A） | 关系可标记；`relations` 单一真源，`depends_on` 不得混入 |
| g-380 | `graph_set_relation` 关系标记工具 + 目标描述右侧 GUI 标记入口 | 关系可增可删；看板卡片显示关系徽标 |
| g-381 | 关系标记面板对端选择改为搜索式（编号 / 关键字） | 对端选择可搜索；全仓唯一搜索实现 `search-match.js` |
| rel-display-018 | 目标弹窗「目标描述」下方直接渲染只读关系清单 | 弹窗内直接看到关系清单（含跨版本 / 已归档标注） |

---

## 2. 发布前检查项

- [x] `dsh-graph-host/package.json` version = **`0.18.0`**（第 3 行）
- [x] `dsh-graph-host/lib/client/constants.js` 的 `PLUGIN_VERSION` = **`0.18.0`**（第 12 行），
      并 `bash scripts/build.sh` 重建 `dist/lib/client.js`（第 2294 行含该常量）
- [x] **版本号一致**（发布门禁红线 2）：见 §3 逐处 `文件:行` 实测输出
- [x] 两份 README（中 / 英）+ 根 README 同步 v0.18.0 版本表述与「最新亮点（v0.18.0）」，
      并把新增能力补进功能列表；工具计数六面一致，仍为 **50**
- [x] `CHANGELOG.md` 新增 `## v0.18.0 — 2026-10-02` 节（5 条，符合每节 ≤5 条）
- [ ] **平台声明如实（红线 1）**：三处平台状态表（根 + 包内中/英）的 **Windows / macOS 行**
      本次均为「**未执行真机门禁**（不得读出「已通过」）；本版验证结果见发布核对表（运行中，待回填）」；
      **Linux / WSL2 = 已实测通过**（本 worktree 全量测试，见 §5）。**Windows / macOS 结论待回填**（§6）
- [x] 全量测试 `node --test core/tests/*.test.ts` = **1604 / 1604，fail 0**（§5；基线同为 1604，用例数未减少）
- [x] `./node_modules/.bin/tsc --noEmit -p tsconfig.json` = **exit 0**（§5）
- [x] `node --check dist/lib/client.js` = **OK**（exit 0，§5）
- [x] `pnpm pack` 产出 `dsh-graph-0.18.0.tgz` 并记录字节数与 sha256 / sha1（§4）
- [x] **既有断言精确更新（未放宽）**：`g371-changelog-guard` 版本节快照补 `v0.18.0 / 5`；
      `g352` 冻结签名 fixture 走维护者 dump 工具重新冻结（**正文 diff 0 行**，
      `content-sha256` 仍为 `0e6b7094…`，仅 provenance 三行更新）
- [ ] 合并 `main` / 打 annotated tag / `pnpm publish` —— **准备阶段未执行**，由负责人人工 gate 决定

---

## 3. 版本号一致性（红线 2）逐处证据

| 面 | 位置 | 实测值 |
|---|---|---|
| 包清单 | `dsh-graph-host/package.json:3` | `"version": "0.18.0"` |
| 客户端常量（源） | `dsh-graph-host/lib/client/constants.js:12` | `const PLUGIN_VERSION = "0.18.0";` |
| 客户端常量（构建产物） | `dist/lib/client.js:2294` | `const PLUGIN_VERSION = "0.18.0";` |
| 构建产物包清单 | `dist/package.json:3` | `"version": "0.18.0"` |
| README（根，中） | `README.md` 当前版本行 | `**当前版本 v0.18.0**` |
| README（包内，中） | `dsh-graph-host/README.md` 当前版本行 | `**当前版本**：v0.18.0` |
| README（包内，英） | `dsh-graph-host/README.md` Current version 行 | `**Current version**: v0.18.0` |
| tarball 内包清单 | `package/package.json`（`dsh-graph-0.18.0.tgz`） | `"version": "0.18.0"` |

`core/version-lane.ts` 在本次改动中 **零 diff**（`git diff 298dd75 -- core/version-lane.ts` 为空）。

---

## 4. 产物与指纹（红线 3：跨机器传递唯一渠道为 tarball）

| 项 | 值 |
|---|---|
| 产物 | `tmp/release-0180/dsh-graph-0.18.0.tgz`（`cd dist && pnpm pack --pack-destination ../tmp/release-0180`） |
| 字节数 | **570157** |
| sha256 | `3ae728dd8c3525411aba5f71e31b6f744a7ddc4ca3c705a1e99139abd476974c` |
| sha1 | `b85d1e6b38f9a53c6e6fdc2d45cacb4d5fe7cc26` |
| 成员文件数 | 37 |

`tmp/` 为 gitignored 临时目录，tarball 不入 git（跨机器传递时以上表指纹对账）。

---

## 5. 测试与静态检查（worktree `.worktrees/release-0180` 内）

| 项 | 命令 | 结果 |
|---|---|---|
| 全量测试 | `node --test core/tests/*.test.ts` | **1604 tests / 1604 pass / 0 fail / 0 cancelled**（exit 0） |
| 类型检查 | `./node_modules/.bin/tsc --noEmit -p tsconfig.json` | **exit 0** |
| 产物语法 | `node --check dist/lib/client.js` | **exit 0** |
| 打包 | `pnpm pack` | `dsh-graph-0.18.0.tgz`（见 §4） |
| g352 签名 fixture | 维护者 dump 工具（`G352_SIG_DUMP=1 G352_SIG_ACK=1`） | 正文 diff **0 行**，`content-sha256` 未变 |

---

## 6. 未执行项与待回填（如实登记）

- **Windows 真机门禁：本次未执行。** 最近一次真机结论为 **v0.17.0 周期**
  （出处 [`docs/release-checklist-v0.17.0.md`](release-checklist-v0.17.0.md) §3.1）——**不构成本版结论**。
- **macOS 真机门禁：本次未执行。** 最近一次真机结论为 **v0.16.0 周期**
  （出处 [`docs/release-checklist-v0.16.0.md`](release-checklist-v0.16.0.md)）——**不构成本版结论**。
- **未执行**：`npm publish`、annotated tag、GitHub release、`git push`、合并 `main`。
- **未触碰**：`engines` / `peerDependencies` / 产品逻辑语义（本版仅版本串与文案变更）。
