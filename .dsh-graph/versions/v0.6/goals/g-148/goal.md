---
{
  "id": "g-148",
  "title": "Bugfix： 目标卡片在ready阶段GUI点击执行，虽然可以正常开始，但是界面报错 load is not defined",
  "status": "delivered",
  "blocked_reason": null,
  "created_at": "2026-08-23T18:26:23+08:00",
  "created_by": "human:gui",
  "version": "v0.6",
  "depends_on": [],
  "review": {
    "reviewer": "human",
    "prompt": null
  },
  "pk": {
    "lanes": 1,
    "sandbox": "directory"
  },
  "rules_snapshot": "r-2026-08-3",
  "skill_refs": [],
  "context_cards": [
    "card-8c55c88b",
    "card-daadd1e7",
    "card-6fdd51d9",
    "card-b8763af4",
    "card-70a0d725"
  ]
}
---

## 目标描述


复现路径：目标处于 `ready` 时，在看板 GUI 点击“执行”；后端执行 attempt 可以正常启动，但前端随即报 `load is not defined`。

修复范围限定为执行操作完成后的客户端 JS 调用链与错误呈现：消除未定义标识符，确保成功启动后 UI 能正常刷新/显示执行状态；不得破坏 ready→in_progress、attempt 创建、子代理启动或既有错误提示。需要定位实际抛错文件、调用栈与测试入口后再实施。

收集结论固化：根因位于 `AcceptFeedback.startExecution()` 成功分支的裸 `load()` 调用；该函数不在 `GoalModal` effect 内，父组件也未传刷新回调。实施应显式传递语义化刷新回调（如 `onRefresh`），或抽取可 mock 的纯执行 action；不得通过吞异常或伪造全局 `load` 修复。

测试至少固定：GUI 所依赖的 force `ready → in_progress` 后 `start-execution` 成功链、刷新恰一次且不进入“请求失败”分支，以及一条 transition/start-execution 失败时不刷新且保持原错误 note 的回归。客户端文件修改后需按实际 DSH Web 构建/HMR 条件验证，不得仅以 core 同步宣称 GUI 已部署。

基于 g-142 模块化的返工约束：`dsh-graph-host/lib/client.js` 为 generated 文件，禁止直接编辑。g-148 的 `AcceptFeedback` 成功刷新逻辑只能改/验于 `dsh-graph-host/lib/client/goal-actions.js` 与 `goal-modal.js`，随后运行 `bash scripts/build-client.sh` 并提交重建 bundle。必须验证模块源与生成 bundle 都不存在裸 `load()` 调用，`onRefresh` 从 GoalModal 正确下传且成功路径仅刷新一次；保留失败路径错误提示。实际 GUI 验收须按运行中的 DSH Web watcher/重建条件操作，不得把 core sync 误称为客户端部署。


## 质量判据

1. 在 ready 目标的 GUI 点击“执行”后，不再出现 `load is not defined` 或其他未定义标识符前端异常。
2. 成功路径仍创建正确的执行 attempt/child，并将目标置入 `in_progress`；客户端随后可刷新并展示当前执行状态。
3. 失败路径继续显示后端错误，不被新的客户端异常遮蔽；不引入重复执行、重复 attempt 或重复状态迁移。
4. 定位并修复实际的客户端调用点，不以吞掉异常、全局定义空函数或关闭刷新作为规避；只编辑 g-142 拆分后的模块源，不直接编辑生成 `client.js`。
5. 新增或更新回归测试，覆盖 GUI ready→执行成功后的刷新行为与错误处理，以及模块源/生成 bundle 的 onRefresh 注入契约；`node --test core/tests/*.test.ts` 全量通过。
6. 运行 `bash scripts/build-client.sh` 后生成 bundle 零 diff，且与模块源一起提交；实际 GUI 验收遵循 DSH Web watcher/重建条件，不以 core 同步替代。

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
