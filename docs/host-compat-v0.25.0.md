# v0.25.0 宿主兼容升级说明与移除清单

> 面向**从 v0.24.x 升级**的用户与维护者。本文是 v0.25.0 清理旧宿主兼容面的**唯一说明文档**；
> 逐项证据（调用位置、宿主版本归属、去留理由）见同批交付的删除清单与守卫
> `core/tests/g627-host-compat-narrowing.test.ts`。

## 1. 结论先说

| 项 | v0.24.x | **v0.25.0** |
| --- | --- | --- |
| `engines.dsh` | `>=0.1.5-rc.2 <0.2.3-0` | **`>=0.2.2-rc.3 <0.2.3-0`** |
| `peerDependencies["@deepseek-ai/dsh-settings"]` | 同上 | 同上（两处必须逐字相等，真源唯一） |
| 最低 DSH | `0.1.5-rc.2` | **`0.2.2-rc.3`** |
| 上界 | 不变 | 不变（`0.2.3` 尚未实测） |

- **不再支持**：`0.1.x`、`0.2.0` 全系、`0.2.1` 全系，以及 **`0.2.2-rc.1` / `0.2.2-rc.2`**。
  这些版本上的插件**可能仍能安装**（历史留存），但**不再验证、不再修复**，其专用兼容分支已在 v0.25.0 删除。
  ⇒ `rc.1` / `rc.2` 所需的**嵌套 activation spec** 分支已随之删除，在它们上面派发**不再受支持**。
- **仍支持**：`0.2.2` 线的 `0.2.2-rc.3` 起至 `0.2.2` 正式版（上界 `<0.2.3-0`）。
  本轮在 `0.2.2-rc.3` 上完成安装、启动、派发、子代理生命周期与看板验证。
- **下限取 rc.3 的理由**：`rc.1` / `rc.2` **从未做过真机验证**，声称支持它们本身不实在；
  真机实测过的只有 `rc.3`，故下限落到 `rc.3`。

## 2. 升级步骤

1. 确认宿主版本：`dsh --version` 必须 ≥ `0.2.2-rc.3`。低于该版本（含 `0.2.2-rc.1` / `0.2.2-rc.2`）时请先升级 DSH 宿主。
2. 升级插件（任一方式）：
   - `dsh plugin --profile <profile> add dsh-graph@<version>`（重新 `add` 会覆盖既有条目）；
   - 或手工把 profile `package.json` 里的 `dsh-graph` 依赖改到新版本后重启宿主。
3. 重启宿主（或 `dsh plugin --profile <profile> reload dsh-graph`），确认插件行未被禁用。
4. **数据与配置无需迁移**：`.dsh-graph/` 看板数据、profile 级设置、旧 `settings.yaml` 节迁移
   逻辑**逐字保留**（见 §4），升级不需要手工动作。

## 3. 低于下限时的诊断

- **安装/启用期**（`0.2.2-rc.3` 实测）：宿主 `unmetRequirements` 只读 `engines.dsh`，不满足时
  `dsh plugin add` 打印 `pluginCompatibilityWarning`（点名 `engines.dsh` 范围与运行版本）并**拒绝启用**
  该插件行；宿主未被授权做版本豁免时不会自动放行。
- **运行期**（插件被强制加载时）：插件按**能力探测** fail-closed，错误文案点名所需 API 与最低版本，例如
  `subagents 服务缺少派发 API（需 startActivation，DSH ≥ 0.2.2-rc.3；本插件已不再支持更早宿主）`。
  绝不会静默降级成「派发成功但实际没派发」。

## 4. 明确保留（**不是**旧宿主兼容，勿删）

以下路径与「旧宿主」无关，v0.25.0 **逐字保留**，并由回归测试钉住：

- 缺能力/异常时一律判 `unknown` 的 **fail-closed** 逻辑（归属、子级目录、中断、provider 探测）；
- **无 child 时不得虚构**、**未确认目录不结算 `dispatch_in_flight`**；
- **祖先中断授权**（只用 `{kind:"ancestor", agent}`，绝不退回 `interruptByUser` Remote face）；
- **归属证据不足拒绝复用**（`rootOf` 抛错 ⇒ 不可确认，另见 g-628 的陈旧实例用例）；
- **g-626 `parentSession` 回退**：它是 `rootOf` 抛错时的归属证据回退策略，**不是**旧宿主分支；
  `ownershipProbeOf(..., { requireLiveTree: true })` 的严格模式同样保留；
- LLM 摘要失败降级、metadata 错误处理、headless/web 可选接线（部署形态，与宿主版本无关）；
- **数据与配置迁移**：旧 `settings.yaml` 的 `dsh-graph` 节一次性迁移、`settings.register`（0.1.6 线）
  与设置表单投影两代 Settings 服务的能力探测分流 —— 用户数据仍可能存在，迁移不随宿主下线删除。

## 5. 已移除的兼容分支（逐项）

| # | 位置 | 分支用途 | 归属宿主 | 处理 |
| --- | --- | --- | --- | --- |
| 1 | `dsh-graph-host/index.js` `probeContinuableProvider` | `subagents.list()` 枚举 provider | `≤ 0.2.2-rc.2` | 删除（改用具名查询 `getProvider("spawn"/"fork")`） |
| 2 | 同上 `startSubagentCompat` | `startContinuable(spec)` 旧名回退 | `≤ 0.2.1-alpha.1` | 删除（保留 fail-closed） |
| 3 | 同上 `buildSubagentActivationSpec` | 嵌套 `request` spec 形态 | `≤ 0.2.2-rc.2` | 删除（只产出扁平 spec） |
| 4 | 同上 `ownershipProbeOf` | `agents.isOwnedBy` 优先分支 | `≤ 0.2.2-rc.2` | 删除（只走 `subagents.rootOf`） |
| 5 | 同上 `readChildCatalogCompat` | `subagents.listChildren()` | `≤ 0.2.2-rc.2` | 删除（只走 catalog 投影） |
| 6 | 同上 `interruptChildCompat` | `interruptByParent` 三参 | `≤ 0.2.2-rc.2` | 删除（只走 ancestor authority） |
| 7 | `lib/client/plugin.js` `openSessionTarget` | `sessions.open/openSubagent` 回退 | `0.1.5-rc.2` | 删除（`uiWorkspace.openSession` 单一入口） |
| 8 | 同上 `resolveWorkspaceOfSession` | `snap.current` / `snap.currentAddress` 口径 | `0.1.5-rc.2` | 删除（只认 `retainedBy.mainView`） |
| 9 | `lib/client/helpers.js` `sessionQueueState` | `getSnapshot().queue` 旧路径 | `0.1.5-rc.2` | 删除（只读 inbox 投影，读不到返回零值） |

## 6. 已知限制

- `0.2.3` 及以上宿主**未验证**：上界仍为 `<0.2.3-0`，升级到下一线前需重新跑宿主兼容回归。
- `0.2.2-rc.1` / `0.2.2-rc.2` **已不在支持范围**（下限为 `0.2.2-rc.3`）：它们所需的嵌套 activation spec
  分支已在 v0.25.0 删除，**不保留**「其所需能力面」；在这两个版本上派发不受支持。
- 兼容声明属于迹，不作为等价集成依据：
  分支上 `v0.24.1`（含 rc.3 修复）尚未与 `v1.0.0-test` 合并，两者存在冲突，**需负责人裁决后再合入**。

## 7. 判断「该删但因风险保留」的项（评审重点）

以下各条在**道理上**属于旧口径或可再收紧，但**保留**了；每条都写明风险，任何进一步清理都必须先复核这些风险。

| # | 保留项 | 表面看「该删」的理由 | 保留的真正原因（风险） |
| --- | --- | --- | --- |
| R1 | `sampleTasks` 的 `requireLiveTree: true` | 它让「无 `subagents` 服务」的部署无从采样 | 放宽后仅凭历史 `session.header.parentSession` 相等即认作在跑 child ⇒ **g-628 的独立恢复子代理防线失效**（实测：放宽后 g-628 立即变红）。采样结果驱动关照计时/投递/预算上限，属授权侧。 |
| R2 | `ownershipProbeOf` 的 `supported = 枚举能力 or rootOf` | 归属只走 `rootOf` 后，「枚举能力」看似无关 | 若只认 `rootOf`，所有 headless/精简组合会被判 `capability_missing` ⇒ **整块关照巡检停止**（实测：g-616 两条用例变红）。裁决面仍严格：无 `rootOf` 时授权调用一律 `unknown`。 |
| R3 | `subagents` 服务**整体缺席**时的 `parentSession` 单证据 | 看起来就是「没有 live 树证据还放行」 | 该形态下调用方已先按 `supported=false` 判能力缺失，根本不做子代理相关动作；此处只服务只读观测。若删，与 R2 同样召回 g-616 回归。 |
| R4 | `parentSessionOf` 兼容读 `agent.meta.parentSessionId` | rc.3 官方字段是 `session.header.parentSession` | 注册表条目上的 `meta.parentSessionId` 与看板 `attempt_binding.parent_session_id` 同源；只读其一会让真实部署的观测面失真。**仅用于只读观测**，不参与授权裁决。 |
| R5 | `dispatch_in_flight` 的结构化结算（`spawnErrorProvesNoChild`） | 属于「新增逻辑」，不是清理 | 不结算则「一次因槽位上限失败的派发」会**永久阻断**该目标，只能主管手动 abandon。只认 `ACTIVATION_LIMIT_REACHED` / `SUBAGENT_DEPTH_EXCEEDED` 两族**发布前拒绝**；其余异常仍保持阻断。 |
| R6 | `settings.register`（0.1.6 线）与设置表单投影两代分流 | 0.1.6 已不在支持范围 | 用户**存量数据与配置**仍可能来自 0.1.x；删掉会让老用户设置静默丢失。属数据迁移，不随宿主下线删除。 |
| R7 | `subagentsByParent` / `snap.items` vs `byId` 形状探测 | 旧快照形状 | 当前 rc.3 仍可能给出两种形状之一；删任一侧会让「转到对话」/工作区解析在部分部署上静默退化。 |
| R8 | `interruptChildCompat` 保留「无法中断该 child（中断失败：…）」两类如实文案 | 可合并为一句 | 二者语义不同（**能力缺失** vs **调用失败**），合并会丢失可追溯性；g-388 有逐字断言。 |
| R9 | `v0.24.1`（含 rc.3 修复）与 `v1.0.0-test` 的冲突未合 | 看起来「顺手就能合」 | 两个分支对同一批函数的改动方向不同，合并需负责人裁决；本轮**不越权合并**。 |

**下限口径（与本表的关系）**：本表保留的是**不依赖宿主下限**的风险项（安全/授权/数据迁移/可观测性），
与「旧宿主兼容」是两件事 —— 第 5 节的 9 项删除**不会**因本表而恢复。特别地 R4/R6/R7 保留的字段读取
在 `rc.3` 上**仍然真实存在**，不属于 rc.1/rc.2 专用面。
