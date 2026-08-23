---
{
  "id": "card-8c55c88b",
  "goal": "g-148",
  "title": "GUI ready→执行后的 load 未定义调用链",
  "kind": "text",
  "status": "reviewed",
  "filled_by": "agent:11bdd44d-66e2-4212-a4d4-2c35b9a99eb7",
  "filled_at": "2026-08-23T18:31:23+08:00",
  "content_ref": null,
  "summary": "ready 点击执行成功后，AcceptFeedback 调用未在作用域的 load，导致前端报错。",
  "child_id": "11bdd44d-66e2-4212-a4d4-2c35b9a99eb7",
  "parent_session_id": "session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36"
}
---

## 结论
`ready` 阶段详情弹窗中的「🚀 执行」由 `AcceptFeedback.startExecution()` 处理。该函数在执行请求成功的分支中调用了未定义的自由标识符 `load()`；因此后端已完成状态迁移/attempt 创建及可能的子代理派发，浏览器随后抛出 `ReferenceError: load is not defined`，并被本函数的 `catch` 显示为「⚠️ 请求失败：load is not defined」。

## 前端调用链与缺失来源
- `dsh-graph-host/lib/client.js:1278` 定义 `AcceptFeedback(props)`，当前仅解构 `{ goalId, status, events, supervisorSession }`。
- `:1344-1382` 的 `startExecution`：
  1. POST `graphUrl("/api/dsh-graph/transition")`，body `{ goal: goalId, to: "in_progress", force: true }`；
  2. 成功后 POST `graphUrl("/api/dsh-graph/start-execution")`，body `{ goal: goalId }`；
  3. `data.ok` 后设置派发结果提示，随后在 `:1374` 执行 `load(); // 刷新看板`。
- `load` 并非模块级或 `AcceptFeedback` 作用域变量。唯一相关定义在父组件 `GoalModal` 的 `React.useEffect` 内（`:1573-1583`）：`const load = () => fetch(graphUrl("/api/dsh-graph/goal", { id: props.id }))...setState(...)`。该局部变量没有作为 props 下传。
- `GoalModal` 在 `:1667` 渲染 `AcceptFeedback` 时传入 `{ goalId, status, events, supervisorSession }`，未传 `load`/刷新回调。因此 `:1374` 必然引用未绑定标识符。

## 可复现条件（静态推导）
1. 打开目标详情 modal；目标具有「目标描述」小节（否则 `AcceptFeedback` 不渲染）。
2. 当前状态为 `ready`（也包括该组件允许的 `draft/planning/collecting`），且事件流中没有 `attempt.started` 且 `details.executor !== "agent:collect"` 的执行 attempt；过滤条件见 `:1405-1414`。
3. 点击「🚀 执行」。为符合题述，目标从 `ready` 出发。
4. `/transition` 返回 `{ok:true}`，并且 `/start-execution` 返回 `{ok:true}`。此时执行已被后端启动/记录；前端进入成功分支才触发 `load is not defined`。若任一请求失败，则不会走到该行。

异常在 `try` 内，故被 `:1378-1380` 捕获并显示“请求失败”，造成“执行虽可开始但界面报错”的表象；随后 `:1381` 仍会 `setLoading(false)`。

## 最小修复点（不实施）
在父子组件边界显式传递刷新回调即可：将 `GoalModal` effect 中的详情刷新函数提升到可传递的作用域/稳定回调，并在 `:1667` 以如 `onRefresh: load` 下传；`AcceptFeedback` 解构该回调，并在执行成功后调用 `onRefresh?.()`。也可直接把现有 prop 命名为 `load` 并同时下传/解构，但使用 `onRefresh` 更能表明其职责。修复应仅替换 `:1374` 的未绑定调用，不改变两次请求顺序或后端语义。

注意：`GoalModal` 的现有 `load` 位于 effect 作用域，不能仅在 `AcceptFeedback` 解构 props 而不调整其定义/传递；需要让父组件渲染处可引用该回调（例如 `useCallback` 形式），或提供等价的父级刷新回调。

## 后端端点与状态迁移
- `POST /api/dsh-graph/transition`：`dsh-graph-host/index.js:643-657`。读取 `{goal,to,reason,force}`，调用 `transition(..., { reason, force, actor: "human:gui" })`；`GraphError` 返回 HTTP 400。GUI 传 `force:true`，所以进入执行时跳过 `rules_snapshot`、非空质量判据和 `criteria.confirmed` 的常规前置校验。
- 状态机：`dsh-graph-host/core/machine.js:20` 允许 `ready → in_progress`。非 force 情形下，`:56-65` 会要求 rules snapshot、质量判据和 `criteria.confirmed`；本点击路径明确使用 force。
- `transition` 实现：`core/ops.js:518-545` 更新 goal frontmatter 的 `status` 并追加 `goal.transition` 事件（actor `human:gui`）。
- `POST /api/dsh-graph/start-execution`：`index.js:782-847`。端点先读取目标描述/判据和已填充/已复核卡片，随后 `startAttempt(... executor:"agent:executor", actor:"human:gui")`（`:803`），再 `spawnChild`（`:835`）。成功派发时绑定 attempt child（`:839`），并尝试再迁到 `in_progress`（`:840-842`）；由于前一步已在 in_progress，此次迁移会被 catch 静默忽略。
- 即使子代理派发失败，端点仍会返回 HTTP 200 `{ok:true, attempt, child_id:null, child_error}`（`:836-843`），而 attempt 已创建。只有端点整体抛错才返回 `{error}` 500。
- `startAttempt`（`core/ops.js:975-1007`）创建 `attempts/att-xxx/attempt.md` 并先追加 `attempt.started` 事件；成功 spawn 后才由 `bindAttemptChild` 追加 `attempt.bound`。

未修改代码、未做 git 操作、未 review。
