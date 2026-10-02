# 大小写别名：真实命名入口的保护现状与平台限制（g-364）

**范围**：本项目在**大小写不敏感卷**（APFS 默认、WSL 的 drvfs `/mnt/*`、部分网络挂载）上，
**仅大小写不同**的名字会折叠到**同一实体**。本页只记录**实际存在的命名入口**在这一点上的保护现状，
并把「已有保护（明确拒绝 / 幂等）」「本轮修掉的真实缺口」「范围外的相邻发现」分开写清 ——
**不泛称「所有入口都已覆盖」**，也不扩到纯显示标签。

**不做什么**（负责人裁决的边界）：不新建全仓命名注册表/第二状态真源；**不自动**改名、删数据或迁移引用
（旧别名只做**只读诊断**）；不把大小写一致性提升为写入许可（大小写敏感卷上的正常路径逐字不变）。

---

## 1. 逐实际命名入口的保护现状

「现状」列的三分类：**版本拒绝** = 已有/新增的显式拒绝（要求改名）；**附件幂等** = 已有幂等契约；
**真实缺口** = 本轮修掉的行为缺陷。

| # | 入口（实现） | 名字来源 | 现状 | 复现/结论 |
| --- | --- | --- | --- | --- |
| 1 | 附件存储 `storeAttachment` | 请求的相对路径（可含子目录） | **真实缺口（已修）** | 不敏感卷上请求 `Report.md` 而磁盘已有同内容 `report.md`：修复前返回**请求拼写** `Report.md`（磁盘上并不存在该条目）⇒ `@att/Report.md` 在 ext4 上悬空。现按卷语义解析到**磁盘实际名** `report.md` 并返回它；异内容仍走唯一名（以磁盘实际基名为基准），同内容重复存储**幂等**返回同一实际名（修复前会误报「唯一名目标已存在」） |
| 2 | 附件子目录段 `resolveAttachmentPath` | 路径中的目录段 | **真实缺口（已修）** | 不敏感卷上 `docs/b.md` 会落进既有 `Docs/`：修复前返回 `docs/b.md`（磁盘无此路径）。现用磁盘实际段名解析、读写与返回，且不新建第二个大小写不同的目录 |
| 3 | 附件删除守卫 `deleteAttachment` / `attachmentReferenceCount` | 请求名 | **真实缺口（已修）** | 引用计数此前按**字面相等**：卡片写 `@att/Report.md`、磁盘是 `report.md` 时，对 `report.md` 的计数为 0 ⇒ 删除会删掉**仍被引用**的文件（悬空）。现按「解析到同一 canonical 文件」计数（别名拼写计入）；删除事件记录**磁盘实际名** |
| 4 | `@att` 引用诊断 `attachmentProblems` → `validate` | 正文里的引用拼写 | **只读诊断（新增）** | 引用拼写与磁盘实际名仅大小写/规范化不同 → 报告「依赖卷的大小写别名（磁盘实际名 …）——在大小写敏感卷上会悬空」。**只报告**，不改写正文、不迁移引用。大小写敏感卷上异名引用根本解析不到文件，走既有「引用不存在」分支，**不会误报**成别名 |
| 5 | 版本创建 `createVersion` | slug | **版本拒绝** | 不敏感卷上 `V0.19.3` 命中既有 `v0.19.3` ⇒ 拒绝；本轮把消息改为点明**磁盘实际 slug** 并要求改用（不自动改名）。敏感卷上仅大小写不同的 slug 仍照常独立创建 |
| 6 | 版本重命名 `renameVersion` | 新 slug | **版本拒绝** | 同上口径：新 slug 只与既有目录大小写不同 ⇒ 拒绝并点明实际 slug |
| 7 | 目标创建带版本 `createGoal({version})` | version 参数 | **真实缺口（已修）** | 修复前 `mkdir` 静默复用别名泳道 ⇒ 目标落在 `versions/v0.19.3/` 而 `meta.version` 写 `V0.19.3`（`validate` 的位置/归属校验必报「version 字段与目录不一致」），事件也记下磁盘上不存在的 slug。现在**任何副作用之前**（含 `g-337` 的高水位预留）明确拒绝并要求改用实际 slug。敏感卷上照常新建独立泳道 |
| 8 | 目标迁移到版本 `moveGoal({to:"version"})` | version 参数 | **真实缺口（已修）** | 与 #7 同口径拒绝（目标未移动、`meta.version` 未被改写） |
| 9 | 版本删除/发布/状态/详情 `deleteVersion` / `releaseVersion` / `setVersionStatus` / `versionDetail` | slug | **按 FS 解析（残余，未改）** | 这些是**读/既定 slug 的破坏性操作**：真实不敏感卷上 `existsSync(versions/<slug>)` 会经别名命中，操作落在真实泳道上（行为符合「就是那条泳道」的意图）；但事件/details 仍记录**请求拼写**。大小写敏感卷上请求异名 slug 直接「不存在」。**本轮不改**（避免扩大：改它要动版本读路径与事件口径）；需要时按「只读诊断」先给出磁盘实际 slug 再操作 |
| 10 | 卡片 id `card-…` / `shared-…` | `randomUUID()` 前 8 位十六进制 | **N/A（无大小写变体）** | id 只含小写十六进制，没有「仅大小写不同」的两个合法名字；越权请求走 `context_cards` 引用守卫，**fail-closed** |
| 11 | 目标 id `g-<seq>` | 单调序号 | **N/A** | 纯数字序号（`g-337` 高水位），无大小写变体 |
| 12 | 记忆 id `mem-…` | `randomUUID()` 前 8 位 | **N/A** | 同 #10 |
| 13 | worktree / 分支 `.worktrees/g-<goal>-att-<NN>` | 由目标 id 派生 | **N/A** | 由纯数字目标 id 派生，无大小写变体 |

### 1.1 复现方式（不依赖真实不敏感挂载）

卷语义是**可注入**的单一注入点：`core/platform.ts` 的
`withCaseInsensitiveVolumeForTesting(true, …)` / `setCaseInsensitiveVolumeForTesting`。
默认 `null` = **不注入**，判定完全来自真实文件系统：

- `readdirSync` 是「磁盘实际拼写」的权威；
- `lstat` 是「该卷是否认为此名存在」的权威；
- **精确名优先**：逐字节同名永远不是别名 —— 大小写敏感卷上只有异名条目时返回 `null`
  （照常新建独立条目），这就是「敏感卷 + 精确名不误伤」的保障。

产物：`core/tests/g364-case-alias-entry.test.ts`（敏感/不敏感 × 同内容/异内容 × 精确名/别名 × 回退负向对照）。

---

## 2. 平台限制与实测状态

| 平台/卷 | 大小写 | 本项目实测状态（g-364 改动） |
| --- | --- | --- |
| Linux / WSL2 **ext4**（大小写敏感，本机开发卷） | 敏感 | **已实测**（全量测试；敏感卷正向回归：精确名与「仅大小写不同的新名」互不干扰） |
| WSL2 **drvfs `/mnt/*`**（桥接 Windows 盘） | 不敏感 | **未实测**（沙箱下 `/mnt/*` 只读，且测试纪律不往真实卷写探针）⇒ 不敏感行为**全部由注入复现** |
| **原生 Windows**（NTFS 默认不敏感） | 不敏感 | **未实测**（本条改动；真机门禁（`scripts/win-smoke-test.mjs`）需在 Windows 上重跑才能给出结论） |
| **原生 macOS**（APFS 默认不敏感） | 不敏感 | **未实测**（本条改动；`scripts/platform-smoke-test.mjs` 的 P1 正向结论需在 macOS 上重跑） |
| 网络挂载（NFS/SMB…） | 视配置 | **未实测** |

> 历史回填（v0.18.0 的 Windows/macOS 真机 T1–T5 全过）**不覆盖本条改动**：那次未针对命名入口的
> 大小写别名做验证。本页因此分别标注为「未实测」，不得读出已通过。

**Unicode 规范化残余**：折叠键 `foldEntryName` 用 `NFC + toLowerCase`，可覆盖 macOS 常见的
NFD 磁盘名 vs NFC 请求名；但**未在 macOS 真机验证**，且更冷僻的规范化形式（如多码位等价序列）
仍可能落到「无法判定 ⇒ 保守按原名」分支（此时不会覆盖，但返回的名字可能与磁盘拼写不同）。

---

## 3. 相关文件

- 注入点与解析器：[`core/platform.ts`](../core/platform.ts)（`resolveExistingEntry` / `foldEntryName` / `withCaseInsensitiveVolumeForTesting`）
- 附件入口：[`core/ops.ts`](../core/ops.ts)（`resolveAttachmentPath` / `storeAttachment` / `attachmentReferenceCount` / `deleteAttachment` / `attachmentProblems`）
- 版本入口：[`core/version-lane.ts`](../core/version-lane.ts)（`caseAliasVersionSlug` / `createVersion` / `renameVersion`）、[`core/ops.ts`](../core/ops.ts)（`createGoal` / `moveGoal`）
- 测试守卫：[`core/tests/g364-case-alias-entry.test.ts`](../core/tests/g364-case-alias-entry.test.ts)
- 平台门禁（P1 大小写敏感性探针）：[`docs/platform-gate.md`](platform-gate.md)

## 4. 范围外的相邻发现（仅报告，本目标未修）

1. `createGoal` / `moveGoal` 的 `version` 参数**未拒绝路径分隔符**（`createVersion` 有校验），
   `version: "../x"` 会拼出 `versions/../x`。与本目标（大小写别名/引用一致性）不同类，
   **未擅自扩大修复**；建议另开目标加与 `createVersion` 同口径的 slug 校验。
2. 版本读/破坏性入口（上表 #9）在真实不敏感卷上按请求拼写记事件；如需账本拼写与磁盘一致，
   应作为独立小项处理（先只读诊断给出实际 slug）。
