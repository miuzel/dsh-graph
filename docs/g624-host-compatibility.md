# DSH 0.2.2-rc.3 / rc.1 compatibility investigation (g-624 + g-625, v0.24.1 patch line)

本文件记录 dsh-graph 在 DSH **0.2.2-rc.3**（新宿主）与 **0.2.2-rc.1**（旧宿主）之间的兼容性排查。
权威依据是 rc.3 安装包自带的 `docs/upgrade-guide/`（安装树路径见文末「证据来源」），
加上两版真实安装的 `@deepseek-ai/dsh-subagent` / `@deepseek-ai/dsh-agent` 类型声明与实现体核对。
**未实测的项不得写成通过。**

## 已修复 / 已验证

- **已修复：provider 探测（rc.3 删除 `list()`）**。rc.3 的 `@deepseek-ai/dsh-subagent` 只提供
  `getProvider(name)`，不再有 `list()`；旧代码 `subagents.list?.() ?? []` 会误报「已注册：无」。
  五处派发点统一改用 `probeContinuableProvider()`（rc.1 有 `list` 则枚举；无 `list` 则具名查询
  官方默认 `spawn`/`fork`，并如实说明自定义名称不可枚举）。
  证据：`core/tests/g624-provider-compat.test.ts`；rc.3 隔离实例真机派发前的 provider 探测已通过
  （负责人侧实测）。**诊断措辞**：rc.3 下不再声称「已注册：无」；无枚举 API 时明确写「仅探测官方默认名」。
- **已修复：`SubagentActivationSpec` 形态（rc.3 删除嵌套 `request`）**。rc.3 要求 `prompt` / `parent` /
  可选执行设置**直接在 spec 外层**；旧代码把 `parent`/`prompt` 放进 `request`，rc.3 读 `spec.parent.id`
  得到 `Cannot read properties of undefined (reading 'id')`、`child_id: null`（真机报错）。
  修复方式：5 个调用点只提交**扁平 payload**，由唯一收口点 `startSubagentCompat()` 内
  `buildSubagentActivationSpec()` 按能力探测构建形态（详见下节）。
  证据：`core/tests/g624-activation-spec-compat.test.ts`（伪 rc.1 / 伪 rc.3 严格校验 + 倒置形态对照）；
  两版真实 `.d.ts` 与 rc.3 `startActivation` 实现体核对。**真机未验证**：rc.3 隔离实例上从
  「探测通过 → startActivation 真实建出 child」的完整链路本次未重跑（见文末未验证清单）。
- **已验证（静态核对）：`startActivation` / `startContinuable` 双 API 兼容未破坏**。
  `startActivation` 优先、`startContinuable` 回退、两者皆无 fail-closed；g469 结构守卫与 A/B/C 组用例全绿。

- **已修复：`interruptByParent` 被删 → rc.3 本地用 `interrupt(child, {kind:"ancestor", agent})`（g-625）**。
  rc.3 删除了 `interruptByParent(child, parent, 'continuable')`；**本地服务面**是
  `subagents.interrupt(targetSessionId, authority)`，authority 为 `{kind:"ancestor", agent}`（模型/祖先侧）
  或 `{kind:"user"}`（受信宿主操作）。唯一收口 `interruptChildCompat()`：旧宿主（`interruptByParent` 在位）
  走三参原路径、逐字保持 v0.24.0；rc.3 用 `interrupt(childId, {kind:"ancestor", agent: <派发时的确切父 Agent>})`
  —— 插件持有该 Agent，且宿主会校验「该 Agent 是目标真实祖先」，不拥有则抛
  `SubagentError(UNAUTHORIZED)`（按「归属不可确认/未中断」如实上报）。**不使用** `interruptByUser`：
  它只是 **Remote face**（Gateway 授权、`{kind:"user"}` 语义），拿它冒充本地收敛会绕过归属校验。
  两者皆无 ⇒ `requested:false` + 可读「无法中断该 child」。3 处收敛路径（executor / reviewer / collector）
  全部经该收口。证据：`core/tests/g625-subagent-api-compat.test.ts` C/F 组（旧三参 / rc.3 ancestor 严格夹具、
  UNAUTHORIZED 负向、Remote face 禁调用、authority 倒置判红）；**真机未验证**（由主管在 rc.3 实例另行取证）。
- **已修复：`listChildren` → `sessionQuery.subagentCatalog`（g-625）**。rc.3 删除服务方法
  `subagents.listChildren(parent)`；唯一收口 `readChildCatalogCompat()`：旧方法优先、缺失时用
  `ctx.sessionQuery.observeSession(parent)` 读 `projections.values.subagentCatalog` 并在 `finally`
  释放观察。**缺 catalog 投影 ⇒ `ok:false`（unavailable）**，调用方（孤儿判定）只能按 unknown 保留
  `dispatch_in_flight`，不得当「无 child」。语义差异须注意：`subagentCatalog` 是「直接子级、catalog 事件序、
  排除 fork 继承」，与旧 `listChildren` 的读取面**不完全等价**；需要递归发现时 `listDescendants(root)` 在
  rc.3 仍然存在（返回 pre-order 行 + 分支诊断），但插件当前只做「直接子级 label 判定」。
  证据：`g625` B/E 组（present/absent/missing 三态、观察释放计数）；**真机未验证**。
- **已修复：`agents.isOwnedBy` → `subagents.rootOf`（g-625）**。rc.3 删除
  `AgentRegistry.isOwnedBy()`；唯一收口 `ownershipProbeOf()`：旧 API 优先；缺失时用
  `rootOf(agent)` **比较 Agent 对象**判同树，再用公开 `session.header.parentSession` 收紧到
  「直接创建者」。`rootOf` 对未管理/陈旧实例抛 `UNAUTHORIZED` ⇒ 只能判 `unknown`（fail-closed），
  绝不是「无归属」。旧代码 19 处文本面收敛为 8 个功能面（keepalive runningChildren / capabilityOf /
  status 能力探测、care entry / sampleTasks / capabilitiesOf / submitOutcome、g-613 复用准入）。
  证据：`g625` A/D/E 组（rc.1/rc.3 归属夹具、恢复准入三态、结构收口守卫）；**真机未验证**。
## 激活 spec 形态判别依据（可核实的能力探测）

判别不猜版本号，用同一批真实安装核对过的能力差：

| 宿主能力面 | 实际版本（已核对） | spec 形态 |
| --- | --- | --- |
| 有 `list()`，有 `startActivation` | 0.2.1-alpha.2 … 0.2.2-rc.1/rc.2 | **嵌套** `{ provider, label, request: { prompt, parent, … }, signal, delivery }` |
| 有 `list()`，只有 `startContinuable` | 0.2.0-rc.2 / 0.2.1-alpha.1 | **嵌套**（同上；旧宿主全部早于扁平化） |
| 无 `list()`，只有 `startActivation` | 0.2.2-rc.3+ | **扁平** `{ provider, label, prompt, parent, …, signal, delivery }` |

- `list()` 被删除与 spec 扁平化落在**同一版**（rc.3 自带 `docs/upgrade-guide/v0.2.1-rc.2/`：
  `subagent-service-methods` 与 `subagent-activation-options` 同属该版升级项），因此
  `typeof subagents.list === "function"` 是可核实的判别依据；「只有 `startContinuable`」的宿主
  全部早于扁平化（g469 夹具两版真实实现的 spec 读取面都只有 `spec.request.*`）。
- 代码位置：`dsh-graph-host/index.js` 的 `buildSubagentActivationSpec()` / `startSubagentCompat()`；
  判别依据与理由写在两函数上方的注释里。
- 两形态都**显式**传 `delivery: "parent"`：rc.1 与 rc.3 的声明都把 `delivery` 标为必填；rc.1 未传时
  `spec.delivery === "caller"` 恒假、碰巧退化为 parent，显式传值后不再依赖该巧合。语义保持
  「子代理结果通知父代理」，绝不改成 `caller`。旧宿主（0.2.0-rc.2 / 0.2.1-alpha.1）的 spec 类型
  没有 `delivery` 字段，多传该键被忽略（已核对这两版真实实现不读取它）。
- 可选字段 `cwd` / `agentPreset` / `agentOptions` / `toolFilter` 在两种形态下都保留：
  嵌套形态全部落入 `request`，扁平形态保持在顶层；显式 `undefined` 不会生成键
  （保持旧调用形态，不改变宿主读取面）。
- 5 个调用点（summarizer / executor / reviewer / collector / REST start）不再各自拼 `request`；
  结构守卫（g624 A⑧）禁止 `const request = {` 重新出现在 `index.js`。

## 其余升级指南项（逐项状态）

状态口径：**已修复** = 本补丁已改；**已验证** = 真机或可核实证据核对通过；**未验证** = 未实测；
「已验证（静态核对：不涉及）」= 代码未使用该 API、以源码检索核对，但未逐项真机演练。

| 升级项（指南位置） | 状态 | 依据 / 影响 |
| --- | --- | --- |
| `subagent-activation-options`（v0.2.1-rc.2） | **已修复** | 见上节；单测覆盖两形态；真机完整链路未验证 |
| `subagent-service-methods`（v0.2.1-rc.2，删 `list`/`listChildren`/`drainChildren`） | **已修复（单测）/ 真机未验证** | `list()` 探测（g-624）与 `listChildren` 迁移（g-625）均已收口：旧方法优先，rc.3 走 `sessionQuery.subagentCatalog`；缺投影显式 unknown。`drainChildren` 未使用 |
| `subagent-user-controls`（v0.2.1-rc.2，删 `interruptByParent`） | **已修复（单测）/ 真机未验证** | 3 处收敛点统一经 `interruptChildCompat()`：rc.1 三参旧路径、rc.3 `interrupt(child, {kind:"ancestor", agent})`（不使用 Remote face `interruptByUser`）；UNAUTHORIZED/失败如实上报「未中断」。rc.3 真机中断未演练 |
| `subagent-runtime-ownership`（v0.2.1-rc.3，删 `AgentRegistry.isOwnedBy` 等） | **已修复（单测）/ 真机未验证** | 8 个功能面统一经 `ownershipProbeOf()`：rc.1 旧名优先、rc.3 `rootOf` 对象比较 + `header.parentSession`；`UNAUTHORIZED` ⇒ unknown（fail-closed）。rc.3 真机复用/主列表未演练 |
| `subagent-control-tools`（v0.2.1-rc.1，`modelSelection`/`modelDiscovery`/`/list-agents`） | **已验证（静态核对：不涉及）** | 源码与 prompt 资产未引用 `modelSelection` / `modelDiscovery` / `list-agents` / `/list-agents`；插件只注册并调用 `graph_*` 工具。未真机逐项演练 |
| `subagent-names`（v0.2.2-alpha.3，`send_message`/`interrupt_agent` 改按名称、`list_agents` 行格式、catalog v3） | **已验证（静态核对：不涉及宿主 API）** | 插件不直接调用 `send_message` / `interrupt_agent` / `list_agents` 工具，也不读 `list_agents` 行；prompt 资产同样未引用这些工具名。插件派发时不传 `name`（可选），依赖宿主的 `agent-N` 默认命名。**未验证**：catalog payload v3 的跨版本会话互开（旧进程能否打开创建过子代理的新会话）不在本补丁范围 |
| `subagent-interrupt-default`（v0.2.2-rc.1，内置预设关闭 `interrupt_agent`） | **已验证（静态核对：不涉及）** | 插件不依赖 `interrupt_agent` 工具；子代理中断走服务 API（g-625 已迁到 `interruptByUser`，见上条）。未真机演练预设开关 |
| `working-directory`（v0.2.1-alpha.1，删 `{{cwd}}` 变量与 provider `cwd` 配置） | **已验证（静态核对：不涉及）** | 插件 prompt 资产无 `{{cwd}}`；未配置 ACP/DSH-SDK subagent provider 的 `cwd`；派发时不传 `cwd`（由宿主继承父会话当前目录）。插件把 `session.header.cwd` 当作 workspace/权限根使用（属指南允许的「原始项目身份/权限根」用法），未另读「当前执行目录」。未真机演练 `working_directory()` 切换后的子代理目录 |
| `session-projection-handles`（v0.2.1-rc.2） | **已验证（静态核对：不涉及）** | 插件未调用 `ctx.sessionProjections.register/stateOf`，也未引用 `SessionProjectionStateMap`；只经公开 `ctx.get(...)` 读服务 |
| `tool-executor-plugins`（v0.2.1-rc.2） | **已验证（静态核对：不涉及）** | 插件未配置 `@deepseek-ai/dsh-tools` 的 `mode` / `maxParallelSubCalls`，未设置 `DSH_TOOLS_MODE`；工具经 `ctx.tools` 注册，不自行选执行器 |
| `archive-worktrees`（v0.2.2-rc.1） | **未验证** | 插件经 `git worktree add/remove` **自行**管理 `.worktrees/g-*`，不经过宿主 worktree 服务，理论上不在「归档会话时清理其登记工作树」的范围内；但**未实测**归档一个创建过 graph 工作树的会话后其工作树是否仍保留（也未验证是否会误删/保留分支）。发布前须真机核对 |
| 其他 rc.3 升级指南项（account/forge/cua/terminal/web-search 等与插件无关项） | **未验证（不适用）** | 插件不使用这些服务；未逐项核对 |

## 未验证清单（不得当作通过）

1. **rc.3 真机完整派发链路**：本次只在单元测试中验证 spec 形态与 helper 行为；rc.3 隔离实例上
   「provider 探测 → startActivation 真实建出 child → 绑定/结果截获」的全链路**未重跑**。
2. g-625 的三项迁移（`interruptByUser` / `subagentCatalog` / `rootOf` 归属）只在单测与宿主桩上验证，
   **rc.3 隔离实例真机未演练**：派发失败后的真实中断、真实 catalog 孤儿判定、真实复用准入
   四项须由主管在 rc.3 实例上另行取证。
3. `subagent-names` / `subagent-interrupt-default` / `working-directory` / `session-projection-handles`
   / `tool-executor-plugins`：仅静态核对「不涉及」，未按指南的验收步骤逐项演练。
4. `archive-worktrees`：未实测会话归档对 graph 工作树的影响。
5. 原生 Windows / 其他平台未验证；实际模型调用未验证。
6. 发布、tag、push、合入 main 均未执行（v0.24.1 补丁线禁止；须负责人单独批准）。

## 证据来源（本机只读核对，未修改）

- rc.3 安装树：`tmp/dsh-test/0.2.2-rc.3/node_modules/.pnpm/@deepseek-ai+dsh@0.2.2-rc.3_*/node_modules/@deepseek-ai/dsh/docs/upgrade-guide/`
  （`v0.2.1-rc.2/subagent-activation-options`、`v0.2.1-rc.2/subagent-service-methods`、
  `v0.2.1-rc.2/subagent-user-controls`、`v0.2.1-rc.3/subagent-runtime-ownership`、
  `v0.2.2-alpha.3/subagent-names`、`v0.2.2-rc.1/subagent-interrupt-default` 等，均含中英双语）。
- 类型/实现：rc.3 `@deepseek-ai/dsh-subagent@0.2.2-rc.3` 的 `lib/types/types.d.ts` /
  `lib/types/index.d.ts` / `lib/index.js`；
  rc.1 `@deepseek-ai/dsh-subagent@0.2.2-rc.1` 的同名文件（本机全局安装）。
- `startActivation` 在 rc.3 读取 `spec.parent.id`、在 rc.1 读取 `spec.request.parent.id`；
  rc.3 的 manager 以 `spec.delivery === "caller"` 区分交付策略（显式 `parent` 保持通知父代理）。
- rc.3 三份升级指南：`subagent-service-methods`（删 `list`/`listChildren`/`drainChildren`）、
  `subagent-user-controls`（`interruptByParent` → `interruptByUser`）、
  `subagent-runtime-ownership`（删 `isOwnedBy`/`roots()`/`enter()` owner 参数）。
- rc.3 `SubagentInterruptAuthority` = `{kind:"user"}` | `{kind:"ancestor", agent}`；本地入口是
  `interrupt(targetSessionId, authority)`；`interruptByUser(childSessionId)` 只是 Remote face（Gateway 授权，
  实现体 `interruptByUser → interrupt(child, {kind:"user"})`）⇒ 插件不使用它。
  `interrupt` 在 authority 不拥有目标时抛 `SubagentError(UNAUTHORIZED)`（rc.3 `lib/index.js` 实测）。
  `rootOf(caller)` 对未管理/陈旧实例抛 `SubagentError(UNAUTHORIZED)`；`observeSession` 返回的
  `SessionObservation` 是 `Disposable`（`[Symbol.dispose]`）。
- 代码：`dsh-graph-host/index.js`（`buildSubagentActivationSpec` / `startSubagentCompat` /
  `ownershipProbeOf` / `readChildCatalogCompat` / `interruptChildCompat`）；
  测试：`core/tests/g624-provider-compat.test.ts`、`core/tests/g624-activation-spec-compat.test.ts`、
  `core/tests/g625-subagent-api-compat.test.ts`、
  `core/tests/g469-host-subagent-api-compat.test.ts`（结构守卫与真实宿主契约夹具）。
