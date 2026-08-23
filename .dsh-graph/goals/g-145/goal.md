---
{
  "id": "g-145",
  "title": "收集子代理上下文注入：明确绑定卡片与 graph_fill_card 回填指令",
  "status": "review",
  "blocked_reason": null,
  "created_at": "2026-08-23T11:21:46+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": null,
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


## 质量判据

1. 通过工具/后端派发的收集子代理，其实际 spawn 提示明确包含仓库根、当前 goal id/标题、当前 card id/标题/kind、收集范围与精确 `graph_fill_card` 回填模板；子代理无需猜测任何 `.dsh-graph` 路径。
2. 从 GUI 点击“开始收集”触发的收集子代理，生成的实际提示词也必须包含同一组目标/卡片上下文与唯一回填模板；不得走缺字段、与工具路径不一致的 prompt 分支。
3. 两条提示路径均明确要求只回填绑定的当前卡片、不得写其他 goal/card、不得自行 review；完成后由 supervisor 执行 `graph_review_card`。
4. 实现可验证的绑定保护：收集 child 对未绑定卡片的回填被拒绝或在服务端可识别为违规；正常 supervisor/人工回填和既有收集流程保持可用。
5. 新增覆盖工具派发与 GUI“开始收集”两条路径的提示上下文完整性、正确回填、错 goal/card 回填拒绝（或可识别失败）的回归测试；`node --test core/tests/*.test.ts` 全量通过。
6. 针对本次事故复测：一个收集 child 仅能将结果落入其绑定的 g-145 测试卡，不能修改历史目标卡片；最终改动已提交。

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
