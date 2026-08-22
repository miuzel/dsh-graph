---
{
  "id": "g-135",
  "title": "看板版本泳道发布：提交版本泳道到 released（须无交付阶段以外的目标）",
  "status": "collecting",
  "blocked_reason": null,
  "created_at": "2026-08-22T22:26:14+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.6",
  "scope": [
    "dsh-graph-host",
    "core/ops.ts",
    "版本泳道 released"
  ],
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
    "card-2a50cb9a"
  ]
}
---

## 目标描述


实现版本泳道的正式发布 guard：由负责人明确确认后，才可把版本标为 `released`。发布前必须检查该版本全部非归档目标均为 `delivered`；若不满足，返回完整阻塞目标清单且不写任何状态。

执行顺序：v0.6 阶段 C，建立在 g-134 的版本管理/元数据能力之上。

实现约束：成功路径先记 `version.released` 事件，再更新版本状态与发布记录；UI 必须展示发布前置条件、阻塞原因与二次确认；不能由执行子代理绕过负责人直接发布；历史已发布版本与现有 `version.released` 事件投影必须继续可读。


## 质量判据

1. 仅在负责人明确确认的操作路径中允许发布；执行子代理或普通状态迁移不能绕过该 gate 标记版本 released。
2. 发布前逐一校验版本全部非归档目标均为 `delivered`；存在 planning/collecting/ready/in_progress/review/blocked/draft 目标时拒绝发布、返回完整阻塞清单且不改写状态。
3. 成功发布先写 `version.released` 事件，再更新版本状态与发布记录；历史 `version.released` 事件与已发布版本投影继续正确读取。
4. 看板 UI 清楚展示发布条件、阻塞原因与二次确认；新增成功/拒绝/事件顺序测试，且 `node --test core/tests/*.test.ts` 全量通过。

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
