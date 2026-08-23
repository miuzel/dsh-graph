---
{
  "id": "g-145",
  "title": "收集子代理上下文注入：明确绑定卡片与 graph_fill_card 回填指令",
  "status": "delivered",
  "blocked_reason": null,
  "created_at": "2026-08-23T11:21:46+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.5",
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
    "card-40c21970"
  ]
}
---

## 目标描述


修复收集子代理派发上下文不完整导致的误写卡片问题。当前收集 child 会自行猜测历史卡片或文件路径，可能把结果回填到不属于当前目标的卡片。

修复范围：在收集子代理的 spawn/续轮提示中显式注入当前仓库根、`goal` id 与标题、`card` id/标题/kind、收集范围、以及唯一允许的回填动作。提示必须给出精确调用模板：`graph_fill_card(goal=<当前 goal>, card=<当前 card>, text=..., summary=...)`；要求子代理仅在仓库根运行 graph 工具、不得猜测 `.dsh-graph` 文件路径、不得写其他 goal/card、不得自行调用 `graph_review_card`。完成后由 supervisor 复核卡片。

还需让绑定/服务端校验尽可能把“当前 collecting child 只能回填其绑定卡片”的约束落到可验证的路径，避免仅依赖自然语言提示。现有正常收集、人工填卡和 supervisor 填卡不得回归。

根目录要求修正：执行/收集子代理应以**自身被分配的 worktree（当前工作目录）**为代码与 graph 工具工作目录。提示词不得把 graph 数据根 `<workspace>/.dsh-graph` 标为“仓库根”，也不得要求 child 返回主工作树；应明确“在当前分配的 worktree/当前工作目录运行，不要猜测 `.dsh-graph` 文件路径”，并继续用精确 goal/card id 回填。


## 质量判据

1. 通过工具/后端派发的收集子代理，其实际 spawn 提示明确要求在**当前分配的 worktree/当前工作目录**运行；不得把 `<workspace>/.dsh-graph` 数据根标为仓库根，也不得要求 child 回到主工作树。提示同时包含当前 goal id/标题、card id/标题/kind、收集范围与精确 `graph_fill_card` 回填模板，子代理无需猜测任何 `.dsh-graph` 路径。
2. 从 GUI 点击“开始收集”触发的收集子代理，生成的实际提示词也必须包含同一组目标/卡片上下文和 worktree/当前工作目录约束；不得走缺字段、与工具路径不一致或将数据根误标为仓库根的 prompt 分支。
3. 两条提示路径均明确要求只回填绑定的当前卡片、不得写其他 goal/card、不得自行 review；完成后由 supervisor 执行 `graph_review_card`。
4. 实现可验证的绑定保护：收集 child 对未绑定卡片的回填被拒绝或在服务端可识别为违规；正常 supervisor/人工回填和既有收集流程保持可用。
5. 新增覆盖工具派发与 GUI“开始收集”两条路径的提示上下文完整性、worktree/当前工作目录约束、正确回填、错 goal/card 回填拒绝（或可识别失败）的回归测试；`node --test core/tests/*.test.ts` 全量通过。
6. 针对本次事故复测：一个收集 child 仅能将结果落入其绑定的 g-145 测试卡，不能修改历史目标卡片；最终改动已提交。

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|
| ev-001 | formatCollectPrompt 函数实现，生成完整收集提示词 | core/ops.ts | 2026-08-23 | 当前版本 |
| ev-002 | fill_mismatch 绑定保护机制实现 | core/ops.ts | 2026-08-23 | 当前版本 |
| ev-003 | collect-prompt.test.ts 测试覆盖 | core/tests/collect-prompt.test.ts | 2026-08-23 | 当前版本 |
| ev-004 | client.test.ts 测试覆盖 REST 路径 | core/tests/client.test.ts | 2026-08-23 | 当前版本 |
| ev-005 | 所有测试通过（146/146） | node --test core/tests/*.test.ts | 2026-08-23 | 当前版本 |
| ev-006 | 绑定保护机制验证：非绑定 actor 填充 collecting 卡片记录 mismatch 事件 | 手动测试 | 2026-08-23 | 当前版本 |
| ev-007 | 更新提示词：明确要求在当前 worktree/当前工作目录运行，不把 .dsh-graph 数据根标为仓库根 | core/ops.ts, dsh-graph-host/lib/client.js | 2026-08-23 | 当前版本 |
| ev-008 | 更新测试：验证提示词包含工作目录说明和运行要求 | core/tests/collect-prompt.test.ts | 2026-08-23 | 当前版本 |

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
