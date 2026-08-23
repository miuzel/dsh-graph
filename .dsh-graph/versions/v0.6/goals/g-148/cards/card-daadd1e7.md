---
{
  "id": "card-daadd1e7",
  "goal": "g-148",
  "title": "客户端执行操作的测试、刷新与错误处理基线",
  "kind": "text",
  "status": "reviewed",
  "filled_by": "agent:b85909b7-d48e-45a1-8014-03c9ec521d74",
  "filled_at": "2026-08-23T18:32:29+08:00",
  "content_ref": null,
  "summary": "已定位裸 load() 作用域错误；现无客户端回归测试，建议注入刷新回调并 mock 两步执行链。",
  "child_id": "b85909b7-d48e-45a1-8014-03c9ec521d74",
  "parent_session_id": "session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36"
}
---

## 范围与结论

仅做静态阅读，未改代码、未运行测试、未 review。

现象可由客户端明确复现路径解释：`dsh-graph-host/lib/client.js` 的 `AcceptFeedback.startExecution`（约 1344 行）在成功派发后调用裸标识符 `load()`（1374 行）。`AcceptFeedback` 自身没有定义或从 props 接收 `load`，其词法作用域中也没有该标识符；因此当 `/start-execution` 返回 `{ ok: true, ... }` 后，派发及前一步迁移已经完成，随后刷新语句抛出 `ReferenceError: load is not defined`，被本函数的 `catch` 捕获并呈现为“⚠️ 请求失败：load is not defined”。这与“执行虽可开始但界面报错”完全吻合。

## 现有 client 覆盖与刷新基线

- 发布客户端唯一可见实现为 `dsh-graph-host/lib/client.js`（包 `exports["./client"]` 直指它）；仓库中没有独立 client/DOM/组件测试文件或浏览器测试框架。
- 看板根组件约 2478–2492 行定义 `load`，请求 `/api/dsh-graph`，成功时更新 board，并在挂载时及每 15 秒轮询调用；它的 `load` 不在 `AcceptFeedback` 组件作用域内。
- `GoalModal` 约 1563–1582 行另有局部 `load`，请求 `/api/dsh-graph/goal?id=...`，更新详情且每 20 秒轮询；它同样不在 `AcceptFeedback` 作用域内。
- `AcceptFeedback` 由 `GoalModal` 在约 1667 行以 `{ goalId, status, events, supervisorSession }` 创建，当前没有刷新回调。看板根在约 2864 行创建 `GoalModal`，仅传入 `onRenamed`/`onArchived`（两者均为看板根 `load()` 的封装），说明已有将刷新能力向下传递的模式，但未用于执行按钮。
- 其他成功路径的刷新方式：拖放迁移流程约 2304、创建目标约 2804、移动目标约 2375 均可访问所在组件的 `load()`；重执行 `ReExecBox` 仅写 note/toast，未刷新；`InProgressPrompt` 成功后调用父级 `onConfirm()`，看板根回调中刷新。

## 客户端错误呈现与请求 mock 方式

- `AcceptFeedback.startExecution`：先 POST `/api/dsh-graph/transition`，body 为 `{ goal, to: "in_progress", force: true }`；若 `trData.ok` 为假，note 为“⚠️ 状态迁移失败：…”，显式 `setLoading(false)` 后 return。
- 成功后 POST `/api/dsh-graph/start-execution`，body `{ goal }`。`data.ok` 时按 `child_id` / `child_error` / 两者皆无分别写成功、子代理失败、未启动 note；非 OK 写“⚠️ 执行失败：…”。任何 fetch/json/后续代码异常统一写“⚠️ 请求失败：”+错误文本。这正是裸 `load()` 被 catch 后掩盖为请求失败的原因。
- 端点侧 `dsh-graph-host/index.js` 782–846：读取 body，调用 `startAttempt`，再 `spawnChild`；派发成功时绑定 attempt-child，并尝试常规迁移到 `in_progress`；无论子代理错误或成功均回 200 `{ ok: true, attempt, child_id, child_error, model_route, injected_cards }`。端点的 try/catch 才返回 500 `{ error }`。
- host 测试基线是 `core/tests/client.test.ts`：用 `routes: Map` 捕获 `webServer.register`，`fakeRequest` 存储 data/end listener，`emitBody` 发送 JSON，`fakeResponse` 收集状态与 JSON；`post()` 调 handler 后触发 body 并 await。这可直接复用，不需要真实 HTTP。
- 现有 `start-execution` 测试（289–300）只覆盖“无 subagents 服务”的降级：200/ok、attempt id、`child_id === null`、`child_error` 字符串和 `attempt.started` 事件；未覆盖成功子代理、ready→in_progress、客户端两次 fetch、刷新回调或 note。
- `start-collection` 的成功 mock（141–198）是可复用范式：`ctx.get("subagents")` 返回 `{ list, getProvider, startContinuable }`，`startContinuable` 返回 child/parent id；`ctx.get("agents")` 返回 supervisor session。`start-execution` 的相对路径测试（399–438）也使用该 mock，但只断言 child id 和 prompt 路径。

## ready→in_progress 现有覆盖

- 核心状态机允许 `ready -> in_progress`（`core/machine.ts` 25 行）。`core/tests/core.test.ts` 124–141 测试 ready 状态在无判据时被拒；`setCriteria` 写规则快照后可正常进入 in_progress。该测试不是 GUI force 路径。
- GUI 点击特有的 force transition（`AcceptFeedback` 1347–1358）目前无端到端/host 测试。host 的 `/start-execution` 自己在 child 成功后执行非 force transition（841 行），但 GUI 已先迁移时该调用通常是“已在 in_progress”而被忽略；因此 host 成功测试不能替代 GUI 两步顺序的断言。

## 最小回归测试建议（实施者）

1. **host 行为测试，扩展 `core/tests/client.test.ts`**：以现有 fake request/response 和成功 `subagents` mock 建一个有 version 的目标；通过 `/transition` 发送 force 的 `ready -> in_progress`（准备目标时登记/确认判据，或 force 以匹配 GUI）；再调用 `/start-execution`。断言两响应为 200/ok、child id 非空、`attempt.started` 与绑定事件存在，最终 goal 为 `in_progress`。这固定 GUI 请求序列依赖的 host contract。
2. **客户端专门回归，需补最小可测边界**：将执行成功后的刷新显式作为回调（例如 `AcceptFeedback` 接收 `onRefresh`，由 `GoalModal`/看板根传下）或抽成接受 `fetch` 与 `refresh` 的纯异步 action。以 mock fetch 顺序返回 transition OK、start-execution OK（带 child id），mock refresh 计数；触发 action 后断言：两次 URL/body/顺序正确、成功 note 被设置、refresh 恰一次、Promise 不 reject/没有“请求失败：load is not defined”。
3. 同一客户端测试至少保留一条失败分支（transition `{ok:false}` 或 start `{ok:false}`）：断言不执行刷新且 note 使用现有“状态迁移失败”或“执行失败”文案。这防止修复刷新时破坏错误呈现。

若不引入组件测试基础设施，最小但较脆弱的替代品是静态断言客户端源码不再含成功分支中的裸 `load();`，并断言存在回调调用；不建议以此作为唯一回归，因为它不能捕获未来的作用域错误。当前依赖中未见 React/DOM test runner，故推荐小范围抽纯 action/mock，而非新增重型浏览器框架。

## 构建、同步与 GUI 验证路径（实施后）

- 仅修改 `dsh-graph-host/lib/client.js` 时，该文件是 package `./client` 入口；`scripts/sync-core.sh`/`pnpm run build` 仅把根 `core/*.ts` 编译同步到包内 `core/*.js`，不会生成或同步该 client 文件。因此不要把 core 同步当作客户端修复已部署的证明。
- 先运行针对性 host 测试及完整 `pnpm test`（实际命令为 `node --test core/tests/*.test.ts`）；可附加 `node --check dsh-graph-host/lib/client.js` 和 `node --check dsh-graph-host/index.js`。历史 `scripts/check_g109.sh` 也只做静态 grep/语法和全套 core 测试，不能覆盖本 GUI 点击回归。
- 用 `scripts/check_plugin.sh` 可在隔离 `DSH_HOME` 内验证 host 插件真实加载和 core 测试，但脚本不做浏览器点击验证。
- DSH 客户端模块机制会读取 package `exports["./client"]` 的构建后浏览器 bundle；现有 dsh-graph client 是直接的 `lib/client.js` bundle 形态。对正在看的 `http://127.0.0.1:3080`，客户端插件无刷新 HMR 只有在 DSH checkout 中的 `pnpm run dev:web` watcher 正在重建 client bundle 时才成立；实施者应先确认该 watcher，不能仅承诺自动更新。否则应按 DSH Web 约定重建受影响 Web/client artifact 后刷新同一既有 URL，不能另起替代 server。
- 手工验收：在 ready 目标（可执行条件已满足）点击“🚀 执行”，确认请求顺序为 transition(force) 后 start-execution；出现 child 成功提示或明确 child_error 提示；不再出现 `load is not defined` / “请求失败”误报；卡片及时进入执行中并在刷新后显示最新 attempt。再断开/模拟端点失败，确认仍显示对应失败 note、按钮 loading 会复位。
