# dsh 0.1.2-alpha.2 子代理实时输出实现指南（Agent 用）

> 面向「需要在 dsh **0.1.2-alpha.2** 中实现子代理实时输出（flowing text / 工具活动 / 定稿输出）」的 agent 与插件作者。
> 本文给出**权威 API 参考、可复用的实现配方、向前兼容策略与踩坑清单**；所有事实均对照 dsh 0.1.2-alpha.2 权威类型定义逐项核实（见 §9），**不依赖任何特定插件仓库**。
>
> 适用范围：dsh web 客户端里的轻量实时预览（会话头部、浮窗、列表行），读取运行中子代理当前在写什么、在调用什么工具。

---

## 0. 先明确：要在 dsh 0.1.2-alpha.2 里拿子代理实时输出，你需要什么

无论哪种 UI 形态，核心都是同一件事：**拿到一个子代理会话绑定的「实时事件流」，然后从原始事件里推导出可显示的文本/活动**。

实现分四步：

1. 解析子代理的**会话绑定**（`binding`）。
2. 配置子代理传输地址并**打开发送窗口**（拉取历史尾部）。
3. 从 `binding.eventSource` **读取实时事件**（`getSnapshot()` / `subscribe()`）。
4. 把事件**推导成显示**：流式文本、进行中/已完成工具调用、定稿输出。

下面逐一展开。

---

## 1. 先确认版本与权威代码位置

- **harness 版本**：`dsh` `0.1.2-alpha.2`（全局安装与各 profile 一致）。
- **客户端 sessions 服务定义包**：`@deepseek-ai/dsh-api-session-controller`（版本 `0.1.2-alpha.2`）。这是唯一权威来源——`binding` / `eventSource` / `configureSubagent` / `subagentsByParent` 等客户端符号的定义都在它的 `lib/types/client/` 下。
- **权威文件的两种定位方式**：
  - 在 profile 解析的核心包：`…/profiles/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/`；
  - 或在全局 dsh checkout 的 `node_modules/@deepseek-ai/dsh-api-session-controller/…`（与运行版本一致时以此为准）。
- 排查技巧：若某个客户端符号（如 `configureSubagent`）在已安装包里 grep 不到，说明该符号在当前版本的「客户端 sessions 服务」里**已不存在或已改名**——这正是 API 变更的信号，应去权威包里重新核对。

---

## 2. 核心变化（必须知道）：实时数据从「会话快照」迁到了「事件源」

在 0.1.2-alpha.2 里，`session.getSnapshot()` 返回的 **`SessionSnapshot` 不再包含 `chat` 字段**。它只保留生命周期/控制状态：

```ts
interface SessionSnapshot {
  sessionId; queue: readonly QueuedMessage[];
  pendingSubmissions: readonly PendingSubmission[];
  running: boolean;
  subagent: { address: SubagentAddress; parentAvailable?: boolean } | null;
  removed: boolean;
  openState: 'cold' | 'loading' | 'open' | 'error';
  openError: RemoteFailure | null;
  hasMore: boolean; loadingOlder: boolean;
  promptError: PromptError | null;
  blank: boolean; lastAgentError: string | null;
  promptAttempted: boolean; awaitingFirstTurn: boolean;
}
```

**实时输出的新家是 `SessionBinding.eventSource`**，不是 `binding.session.getSnapshot()`：

```ts
interface SessionBinding {
  sessionId;
  session: SessionFace;          // 行为动词 + 生命周期快照（无实时输出）
  eventSource: SessionEventSource; // ← 实时事件源（新 API）
  ctx: AgentContext;
}
```

> 结论：读实时输出请从 `binding.eventSource` 取；`binding.session` 只用于调用（`cancel` 等）和生命周期快照。

---

## 3. 拿实时输出的完整步骤（推荐配方）

```js
// 1) 解析绑定（子代理 id → binding）
const binding = sessions.binding(childId)        // SessionBinding | undefined

// 2) 配置子代理传输地址（跨版本安全：单参调用，address 含 parentSessionId/childSessionId/mode）
binding?.session?.configureSubagent?.({
  parentSessionId, childSessionId, mode,         // mode: 'one-shot' | 'continuable'
})

// 3) 打开发送窗口（拉历史尾部，填充事件窗口，幂等）
await binding?.session?.open?.()

// 4) 读取实时事件源
const window = binding?.eventSource?.getSnapshot?.()
// window = { entries, hasMore, revision, change }
// entries: [{ type:'event', event: SessionEvent }, { type:'chunks', event: ChunkRowEvent }]

// 5) 订阅实时更新（推送式）
const unsubscribe = binding?.eventSource?.subscribe?.(notify)   // notify → 触发重渲染
```

**关键点**：
- `eventSource` 在 `binding` 上，**不在** `binding.session` 上；`session` 上只有 `getSnapshot()`/`subscribe()`（生命周期快照）与行为动词。
- `open()` 会拉取尾部历史页，`eventSource` 窗口随之填充；实时追加用 `subscribe` 监听。
- 实时追加的 `change.kind` 一定是 `'append'`，且只追加 `{ type:'event' }`；`{ type:'chunks' }`（压缩的历史增量）只出现在历史页（`prepend`/`replace`），做实时展示时可直接跳过。

---

## 4. 事件词汇 / 数据模型（API 参考）

### 4.1 `SessionEvent` 事件类型全集

| 事件类型 | 负载要点 | 与实时输出的关系 |
|---|---|---|
| `turn/start` | `{ turn }` | 回合开始 |
| `turn/end` | `{ turn, reason }` | 回合结束（`completed/aborted/blocked/error/max-tokens/interrupted`） |
| `step/start` / `step/end` | `{ turn, step }` | 一次模型调用边界 |
| `user/message` | `UserMessage` | 用户消息 / 上下文注入 |
| `assistant/chunk` | `{ turn, step, chunk: StreamChunk }` | **流式增量（文本/推理/工具参数）** |
| `assistant/message` | `{ turn, step, message: AssistantMessage, usage?, interrupted? }` | **定稿输出**（`interrupted: true` 表示中断前缀） |
| `tool/call` | `{ turn, step, callId, name, arguments }` | 工具调用（`arguments` 为原始 JSON 串） |
| `tool/result` | `{ turn, step, message: ToolResultMessage, error?, meta? }` | 工具结果（`message.content[0]` 为 `ToolResultBlock`） |
| `request/header` / `request/context` | 请求配置/路由 | 与实时输出无关 |
| `session/end-seed` | 空 | 种子边界 |

事件对象统一形态：`{ type, seq, time, data, ignorable?, sourceEventSeqs?, surfaceOp? }`。词汇表是 merge-extensible 的：未知类型带 `ignorable` 守卫可安全跳过，未来增删不会破坏读取。

### 4.2 `StreamChunk`（`assistant/chunk` 负载）

```ts
type StreamChunk =
  | { type:'block-start'; index; blockType }
  | { type:'text-delta'; index; text }                                  // 流式文本
  | { type:'reasoning-delta'; index; text }                             // 流式推理
  | { type:'tool-call-delta'; index; id; name?; argumentsDelta }        // 流式工具参数
  | { type:'block-end'; index; block }                                  // 块定稿（含最终参数）
  | { type:'usage'; usage }
  | { type:'finish'; reason; replayState? };
```

### 4.3 `ContentBlock`（定稿消息的块）

```ts
'text':       { type:'text'; text }
'reasoning':  { type:'reasoning'; text }
'image':      { type:'image'; attachment }
'tool-call':  { type:'tool-call'; id; name; arguments }                 // arguments 原始 JSON
'tool-result':{ type:'tool-result'; toolCallId; content; isError? }
```

`ToolResultMessage`：`role:'user'`、`content:[ToolResultBlock]`、`source:{ kind:'tool'; callId }`。

### 4.4 地址 / 目录 / 行数据

```ts
type SubagentAddress = {
  parentSessionId; childSessionId;
} & ({ mode:'one-shot' } | { mode:'continuable' });

type SubagentListEntry =
  | { kind:'child'; id; activity:'running'|'inactive'; hasChildren }
    & ({ mode:'one-shot'; label? } | { mode:'continuable'; label })
  | { kind:'diagnostic'; id; reason:'corrupt'|'unsupported'|'unavailable' };

interface SubagentCatalog { entries: readonly SubagentListEntry[]; parentAvailable: boolean }
```

> 读子代理目录行 `sessions.list.getSnapshot().subagentsByParent[parentId].entries`，用 `entry.mode` 作为 `configureSubagent` 的 `mode`。`child` 条目带 `activity`（'running'|'inactive'）可作运行态补充。

### 4.5 `sessions` 服务（`ctx.sessions`，`ISessions`）可用方法

`list`（`byId/current/subagentsByParent/jobsBySession/currentAddress`）、`open(id)`、`openSubagent(address)`、`refreshSubagents(parentId)`、`setSubagentCatalogOpen(parentId, open)`、`refresh()`、`clear()`、`subagentAddress(id)`、`binding(id)`、`scope(id)/scopeOf(ctx)/sessionOf(ctx)`、`create(opts)`、`fork(opts)`、`search(query, signal)`。

---

## 5. 把事件推导成显示（设计建议）

### 5.1 两条路径 + 能力探测（向前兼容核心）

用**能力探测**而非版本号判断：

```js
const feed    = binding?.eventSource;             // 新 API：实时事件源
const session = binding?.session;
// 新 API 走 feed；否则回退旧 API（如老 harness 的 session.getSnapshot().chat.legacy.*）
const source  = feed || session;
```

### 5.2 归一化提取函数（参考实现）

> 以下为**通用参考实现**（命名与结构可自由调整）。它把 `entries` 归一化成同一形状 `{ pendingCount, activity, streamText, finalText }`，UI 只消费这个形状，两条路径产出保持一致。

```js
function deriveLive(entries, running, toolDetail) {
  const tail = s => {
    const lines = String(s || '').split('\n').map(x => x.trim()).filter(Boolean)
    return lines.length ? lines.slice(-2).join('\n') : ''
  }
  const finalOf = blocks => {
    const list = Array.isArray(blocks) ? blocks : []
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i]
      if (b?.type === 'text' || b?.type === 'reasoning') {
        const t = tail(b.text); if (t) return (b.type === 'reasoning' ? '💭 ' : '') + t
      }
      if (b?.type === 'tool-call' && b.name) return '⚙ 调用工具 ' + b.name
    }
    return ''
  }
  const upsert = (map, arr, id, init) => {
    let rec = map.get(id)
    if (!rec) { rec = Object.assign({ complete: false, running: true }, init); map.set(id, rec); arr.push(rec) }
    return rec
  }

  let text = '', reasoning = '', finalText = '', hasStream = false, lastKind = 'text'
  const pending = [], done = [], byCall = new Map()

  for (const entry of entries) {
    if (!entry || entry.type !== 'event') continue   // chunkrow 压缩历史跳过
    const e = entry.event
    if (!e || typeof e.type !== 'string') continue
    switch (e.type) {
      case 'assistant/chunk': {
        const c = e.data?.chunk; if (!c) break
        if (c.type === 'text-delta') { text += c.text || ''; hasStream = true; lastKind = 'text' }
        else if (c.type === 'reasoning-delta') { reasoning += c.text || ''; hasStream = true; lastKind = 'reasoning' }
        else if (c.type === 'tool-call-delta' && c.id) {
          const rec = upsert(byCall, pending, c.id, { name: c.name || '工具调用', args: '' })
          if (c.name) rec.name = c.name
          rec.args += c.argumentsDelta || ''          // 关键：累积，勿覆盖
        } else if (c.type === 'block-end' && c.block?.type === 'tool-call') {
          const rec = upsert(byCall, pending, c.block.id, { name: c.block.name || '工具调用', args: '' })
          if (c.block.name) rec.name = c.block.name
          rec.args = c.block.arguments || rec.args     // 完整参数覆盖增量
          rec.complete = true
        }
        break
      }
      case 'assistant/message': {
        finalText = finalOf(e.data?.message?.content)
        text = ''; reasoning = ''; hasStream = false
        break
      }
      case 'tool/call': {
        const rec = upsert(byCall, pending, e.data?.callId, { name: e.data?.name || '工具调用', args: '' })
        if (e.data?.name) rec.name = e.data?.name
        if (e.data?.arguments != null) { rec.args = e.data?.arguments; rec.complete = true }
        rec.running = true; break
      }
      case 'tool/result': {
        const rec = byCall.get(e.data?.message?.source?.callId)
        const block = e.data?.message?.content?.[0]
        if (rec) { rec.running = false; done.push({ name: rec.name, args: rec.args, complete: rec.complete, isError: block?.isError }) }
        break
      }
      default: break
    }
  }

  const open = pending.filter(r => r.running !== false)
  return {
    pendingCount: open.length,
    activity: [
      ...open.slice(-2).map(r => `▶ ${r.name || '工具调用'}${r.complete && r.args ? ` · ${toolDetail(r.args)}` : ''}`),
      ...done.slice(-2).map(r => `${r.isError ? '✖' : '✓'} ${r.name || '工具调用'}${r.complete && r.args ? ` · ${toolDetail(r.args)}` : ''}`),
    ],
    streamText: hasStream ? ((lastKind === 'reasoning' ? '💭 ' : '') + tail(lastKind === 'reasoning' ? reasoning : text)) : '',
    finalText,
  }
}
```

### 5.3 展示优先级（沿用常见 UI 直觉）

```
若 pendingCount>0            → 显示活动行（▶ 进行中 · 说明）
否则若 running && streamText → 显示流式文本（💭 前缀表示推理）
否则若 activity.length       → 显示活动行（✓/✖ 工具结果 · 说明）
否则                          → 显示定稿文本 finalText
```

### 5.4 工具详情（`toolDetail`）取值

把工具参数的原始 JSON 解析成一句话说明：优先取 `description` → `command` → `file_path` → `path` → `prompt`，都取不到再回退原始字符串。示例（dsh 核心工具参数事实）：

| 工具 | 参数关键字段 | 期望显示 |
|---|---|---|
| `bash`（dsh-tool-bash） | **必含 `description`**（校验要求非空，"shown in the UI"） | `bash · {description}` |
| `write`/编辑（dsh-tool-str-replace-editor 等） | `path`（绝对路径）＋ `commands` | `write · <文件名>` |
| `read`（dsh-tool-fs 等） | `path` / `file_path` | `read · <路径>` |

> 说明：这是「说明/文件名」级别。官方会话里 `Bash`/`写入` 这类**本地化标签**来自官方 `dsh-agent-tool-presentation`，如需完全一致需另做 per-tool 展示映射；多数轻量预览只需「原始名 + 说明/文件名」即可。

---

## 6. 向前兼容（老 harness）

- **双路径**：新 API（有 `binding.eventSource`）走事件源推导；否则回退旧 API（如老 harness 的 `session.getSnapshot().chat.legacy.*`）。旧路径代码**原样保留**，能力探测决定走哪条。
- **不要重实现/依赖官方 Conversation 装配器**：`ConversationNodeAssembler` / `BoundConversation` / `uiConversation` 服务是官方 `dsh-client-ui-conversation` 的**内部件**，第三方不宜重建。原始 `SessionEvent` 日志是**最稳定、merge-extensible** 的底层契约，直接消费它即可。
- **非契约成员慎用**：`open()`、`configureSubagent()` 是 `Session` 类的公开成员，但**不在 `SessionFace` 契约上**（`SessionFace = ISession & ObservableSnapshot<SessionSnapshot>`）。调用时用 `?.`，缺失只导致「不显示」，不要让它抛错。

---

## 7. 踩坑清单

1. **`tool-call-delta` 一定要累积 `argumentsDelta`**：若只在第一个 delta 记录一次（如用 `!byCall.has(id)` 守卫），后续分片被丢弃，`args` 停在残缺/空 JSON，`toolDetail` 取不出说明/路径 → 只剩工具名。
2. **参数完整才渲染详情**：流式过程中 `argumentsDelta` 可能是残缺 JSON，`toolDetail` 会解析失败。用 `complete`（在 `block-end` / `tool/call` 提供完整 `arguments` 时置位）门控，避免渲染残缺 JSON。
3. **完成态也要带详情**：工具执行快（`read`/`bash` 等），到渲染时常已完成 → 若完成行（`✓`）不携带 `args`，用户看到的「没改观」。`tool/result` 时把 `rec.args`/`rec.complete` 带进完成记录。
4. **按 `callId` 去重**：`tool/call` 与 `tool-call-delta` 可能都产生同一调用的记录，避免重复 push。
5. **断线重连**：事件窗口可能 `replace`（`change.kind === 'replace'`），此时要全量重扫，不能只按 `append` 增量。
6. **`open()` 是开口**：`eventSource` 窗口靠 `open()` 填充；`open()` 非幂等地重复调用安全（复用 in-flight promise）。
7. **`SessionSnapshot` 已无 `prompt`**：若想显示提示词预览，取不到——契约上就不暴露（消费方应忽略）。
8. **inject 引用过时包**：若客户端 `inject` 列表引用了已不存在的包（如 `dsh-client-runtime`），宿主对未知 inject 宽容跳过（死引用），但应清理。
9. **`running` 来源**：行数据的 `running` 来自 `SessionSummary.running`（经 `handleRunning` 中继），比从事件流推断更直接。

---

## 8. 验证方法

1. **语法**：对客户端入口 `node --check`（或项目既有校验脚本）。
2. **GUI 实测**：运行一个会派生子代理、且子代理会调用工具的任务；确认实时区显示「流式文本 / ▶ 进行中工具 / ✓ 已完成工具」，且都有 ` · 说明/文件名`；一键暂停、历史加载仍可用。
3. **旧 harness**：本机可能只有新版本；旧路径兼容靠「能力探测 + 旧路径原样保留」保证。如需真实测，需在目标旧版本上冒烟，或核对旧版本的 `chat.legacy` 数据结构。

---

## 9. 权威源码索引（后续核对用）

以下均在 dsh `node_modules/@deepseek-ai/` 下；`<dsh>` 为 dsh 安装根（如全局 checkout 的 `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 或 profile 解析目录）。

| 内容 | 路径 |
|---|---|
| `SessionEventMap` / `SessionEvent` | `<dsh>/dsh-session/lib/types/types.d.ts` |
| `StreamChunk` / `ContentBlockMap` / `TokenUsage` | `<dsh>/dsh-llm/lib/types/types.d.ts` |
| `AssistantMessage` / `ToolResultMessage` | `<dsh>/dsh-llm/lib/types/message.d.ts` |
| `SessionSnapshot` | `<dsh>/dsh-api-session-controller/lib/types/client/contract/snapshot.d.ts` |
| `SessionFace` / `ISession` | `<dsh>/dsh-api-session-controller/lib/types/client/contract/session.d.ts` |
| `SessionEventSource` / `SessionEventWindow` | `<dsh>/dsh-api-session-controller/lib/types/client/contract/events.d.ts` |
| `ISessions`（`ctx.sessions` 门面） | `<dsh>/dsh-api-session-controller/lib/types/client/contract/sessions.d.ts` |
| `SessionBinding` / `ClientSessions` / `SessionSummary` | `<dsh>/dsh-api-session-controller/lib/types/client/sessions/service.d.ts` |
| `SessionManager` / `SessionListSnapshot` / `SubagentCatalogSnapshot` | `<dsh>/dsh-api-session-controller/lib/types/client/sessions/manager.d.ts` |
| `Session` 类（`configureSubagent`/`open` 运行时成员；`eventSource` 在 binding 上） | `<dsh>/dsh-api-session-controller/lib/types/client/sessions/session.d.ts` |
| `SubagentAddress` / `SubagentListEntry` / `SubagentCatalog` | `<dsh>/dsh-subagent/lib/types/control-types.d.ts` |
| `TokenUsageProjection` | `<dsh>/dsh-token-meter/lib/types/projection.d.ts` |
| 官方 Conversation 装配参考（只读借鉴，勿依赖） | `<dsh>/dsh-client-ui-conversation/lib/client.js` |
