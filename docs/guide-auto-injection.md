# g-118：dsh-graph 引导提示词自动注入 + graph_help 命令（调研 + 实现）

> 最终设计（负责人 2026-08-22 定案，取代早期「自动注入完整 supervisor 守则」方案）：
> **否决**「自动注入 supervisor 角色/完整守则」——临时会话若被注入主管角色会争抢 supervisor。
> 改为在所有会话注入**简短引导提示词**（告知如何 claim / 如何看 help，不授予角色），
> 完整 supervisor 守则仍走显式 `skill dsh-graph-supervisor` 调用。
> 背景：2026-08-22 新会话接手时未调用 skill，裸奔自实现 g-117，撑爆会话、认知降级——
> 根因是 skill 按需调用、不保证注入。
> 配套：g-117（graph_handoff/claim_supervisor）管「换会话状态」，本目标管「换会话后如何引导接管」。

## 1. 调研：DSH 自动注入机制（三选一）

### 1.1 `dsh-agent-instructions`（AGENTS.md/CLAUDE.md 自动装载）—— 否决

- 机制：`agent/pre-step` 钩子按会话 cwd 发现 `$DSH_HOME/AGENTS.md` 与项目各级 `AGENTS.md/CLAUDE.md`，
  渲染进 `<system-reminder>` 帧的 user 消息（`dsh-agent-instructions/lib/index.js` L1271-1288）。
- 作用域：**cwd/项目根**，不是 session.id；同一 workspace 的所有会话（含执行子代理，其 cwd 继承父会话）一视同仁。
- 结论：**无会话级判定能力**。若把主管守则放进 AGENTS.md，执行子代理也会收到——违反隔离约束，否决。

### 1.2 skill 自动触发标记 —— 无此机制

- `dsh-tool-skill` 只把 skill 的 name+description 注入 catalog（`<available_skills>`），正文仍需 `skill` 工具调用。
- `whenToUse` 只是元数据，无自动匹配/自动装载逻辑。
- 结论：**不存在「不调用 skill 也能看到正文」的现成机制**。

### 1.3 host 插件注册 system prompt 段（正规注入点）—— 采用 ✅

- `ctx.systemPrompt.section({name, order, text})`（`dsh-system-prompt/lib/index.js`）注册 system 提示词段落：
  - `text` 可以是 `(context) => string` 函数，组装时按上下文动态渲染（L271）；
  - 空文本段落被 `renderPrompt` 丢弃（L66 filter）→ 零 token 成本；
  - 组装上下文携带 agent：`assembleContextFor(agent)` → `{agent, scope, signal}`（`dsh-agent/lib/index.js` L384-390），
    因此 `c.agent.session.id` 可拿（如需条件渲染）。
- 本目标最终实现：所有会话注入恒定 `GUIDE_HINT`（无条件渲染分支），内容轻量无害。

## 2. 实现（dsh-graph-host/index.js）

### 2.1 引导提示词（systemPrompt.section，所有会话注入）

```js
const GUIDE_HINT = [
  "dsh-graph 是把工作组织成「目标看板」的插件。本会话可用 graph_* 工具管理目标/判据/卡片/执行。",
  "想接管 supervisor？调用 graph_claim_supervisor（更新 project.yaml 的 supervisor.session 并返回 HANDOFF 交接全文，g-117）。",
  "查看 dsh-graph 使用说明与 claim 指引：调用 graph_help。",
  "（完整 supervisor 工作守则不自动注入；如需，显式调用 skill dsh-graph-supervisor 加载。）",
].join("\n");

// apply() 的 ctx.effect 内：
const sp = ctx.get?.("systemPrompt");
if (sp) {
  sp.section({ name: "dsh-graph-guide-hint", order: 10, text: () => GUIDE_HINT });
}
```

- 注入**所有会话**（主管/普通/执行子代理）：内容只告知「如何」接管（claim 用法 + help 命令存在），
  不授予主管角色、不含完整守则 → 无害、轻量（< 500 字）。
- `systemPrompt` 服务可能晚激活：轮询注册（20s 上限，同 webServer 模式）；缺失时静默跳过。

### 2.2 graph_help 命令（graph_* 工具）

- 新增 `graph_help` 工具：无参，输出 `HELP_TEXT`（dsh-graph 使用说明：工具清单 + 换会话
  graph_handoff/graph_claim_supervisor 步骤 + 完整守则走 skill 的说明）。
- 与引导提示词呼应：引导提示词告知 help 命令存在，help 给出完整说明。

### 2.3 主管纪律提醒（g-131，仅主管会话注入）

```js
// 逐条镜像 dsh-graph-host/prompts/discipline.zh.md（该文件是唯一真源）——
// 本副本此前已漂移（缺记忆管理纪律与测试力度分级），同步时请整段对齐，不要只补最后一条。
const SUPERVISOR_DISCIPLINE = [
  "⚠️ **主管纪律提醒**（每 turn 自动注入）：",
  "1. **只做规划、派发、把关、复核**——绝不自己实现常规功能大任务、一律派发子代理；",
  "2. **轻量改动自主特权**：一句话决策与低风险微小改动（patch / chore 类目标、一两行修改），主管可直接在当前会话使用 edit/write 执行，无需繁琐派发子代理；",
  "3. **阶段变化与关键节点自报进展**：调用 graph_report_supervisor_status（看板实时显示状态，常规细微动作无需机械汇报）；",
  "4. **记忆管理纪律**：自发总结默认记 on_demand；仅人类钦定或隔离禁令才记 standing（≤200字）；remove 仅限明确撤回/证实过时；",
  "5. **review→delivered 必须等负责人 verdict**——绝不自行 delivered；",
  "6. **测试力度按改动性质分级**：零行为逻辑改动（文案/注释/文档/纯样式）不强制新增单测，但必须有全量既有测试全绿或真机目视的实际证据；**绝不因「轻量/文案」跳过、删改或削弱既有测试**；",
  "7. **证据形式（断言化，禁长文倾倒）**：交付与核验证据以自动化断言为准，只写单行结构化概要 `evidence: suite=<id> passed=<n> failed=<n> exit=<code> ms=<n> diff=<files>f/+<a>/-<d> commit=<sha7>`（一套件一行、单条 ≤160 字符）；禁止向证据台账、评论区或回复倾倒多行 JSON、DOM dump、切片数据、原始日志与围栏代码块；UI/视觉层不可代码化部分保留轻量截图核验；",
  "8. 完整守则见 skill dsh-graph-supervisor（显式调用加载）。",
].join("\n");

// apply() 的 registerGuideSection 内：
sp.section({
  name: "dsh-graph-supervisor-discipline",
  order: 11,
  text: (context) => {
    try {
      const sessionId = context?.agent?.session?.id;
      if (!sessionId) return "";
      const supervisorId = readSupervisorSession(root);
      if (!supervisorId || supervisorId !== sessionId) return "";
      return "\n" + SUPERVISOR_DISCIPLINE;
    } catch {
      return "";
    }
  },
});
```

- **仅主管会话注入**：通过 `context.agent.session.id` 与 `project.yaml` 的 `supervisor.session` 比对，
  不匹配时返回空字符串（零 token 成本）；
- **每 turn 开头可见**：order=11，在 GUIDE_HINT (order=10) 之后渲染；
- **内容简短**：每条一句话，强调主管铁律（规划/派发/把关/复核、不自实现、status 汇报、等 verdict、测试力度分级、证据形式）；

### 隔离约束（负责人设计约束）

| 内容 | 注入范围 |
|------|----------|
| 简短引导提示词（GUIDE_HINT） | **所有会话**（含执行子代理），轻量无害 |
| 主管纪律提醒（SUPERVISOR_DISCIPLINE，g-131） | **仅主管会话**（project.yaml supervisor.session 匹配时） |
| 完整 supervisor 守则（supervisor-guide.md） | **绝不自动注入**任何会话；仅经显式 `skill dsh-graph-supervisor` 调用 |

## 3. 验证

- 单测 `core/tests/guide-injection.test.ts`（6 个用例，全绿）：
  1. 注册 `dsh-graph-guide-hint` section；
  2. 所有会话（主管/执行/无 agent）渲染简短引导提示词，含 claim 指引 + help 提示 + 「不自动注入」说明；
  3. **隔离断言**：注入内容不含铁律「绝不自己实现」/「不可妥协」/「主管 Agent」——主管守则不自动注入；
  4. `graph_help` 工具注册且输出使用说明 + claim 指引（不含完整守则）；
  5. systemPrompt 缺失时静默跳过、不阻塞 apply；
  6. 工具注册 18 个（g-116 16 + g-119 graph_bind_collect_card + g-118 graph_help），section 只注册一次。
- 真实 DSH `renderPrompt` 链路验证 6/6 PASS（`tmp/verify-g118-render.mjs`）：引导提示词进 system prompt、
  不含铁律/主管角色、内容简短。
- 全量回归：`node --test core/tests/*.test.ts` → 72/72 通过。

### 实机验收步骤（负责人/主管）

1. **重启 dsh web 服务**（改 host 插件代码必须重启才生效——见 supervisor-guide.md 环境事实）；
2. 任意会话首轮请求的 system prompt 应含 `dsh-graph-guide-hint` 段（claim 指引 + graph_help 提示），
   **不含**主管守则全文；
3. 调用 `graph_help` 工具应返回使用说明 + claim 指引；
4. 显式调用 `skill dsh-graph-supervisor` 仍可加载完整主管守则。

## 4. 边界与已知限制

- **引导提示词是恒定文本**：无 session 条件分支（所有会话一致）；如需按会话定制可改回 text 函数条件渲染
  （方案 A 支持，`assembleContextFor` 携带 agent.session.id）。
- **token 成本**：GUIDE_HINT ~120 字，作为 system prompt 段每步带入，成本可忽略。
- **与 g-119 并行改动兼容**：graph_bind_collect_card 工具（17 个 → 加 graph_help 后 18 个）共存，
  相关断言（plugin.test.ts / root.test.ts / guide-injection.test.ts）已同步更新。
