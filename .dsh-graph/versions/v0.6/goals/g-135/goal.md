---
{
  "id": "g-135",
  "title": "看板版本泳道发布：提交版本泳道到 released（须无交付阶段以外的目标）",
  "status": "ready",
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

新增 GUI 需求：点击看板中的版本标题打开版本详情弹窗。弹窗必须展示版本名称、版本摘要、主要功能/范围；并提供“标记为 released”与“标记为 working”操作。

状态语义：GUI 的 **working** 对应版本元数据的 `active` 状态，用于把版本置为进行中；**released** 对应 `released`，必须复用本目标的发布 guard、阻塞目标清单与负责人二次确认，不能只是直接改 frontmatter。版本摘要和主要功能应从版本元数据/版本文档的受管内容读取，缺省时给出清楚的空态。


## 质量判据

1. 点击看板版本标题可打开版本详情弹窗；弹窗显示版本名称、版本摘要、主要功能/范围，并对缺少摘要或范围提供明确空态。
2. 详情弹窗提供“标记为 working”操作，语义映射到版本 `active`；用户显式点击并确认后才允许变更，事件先行记录状态改变，版本投影和重载后的状态一致。
3. 详情弹窗提供“标记为 released”操作；仅在负责人明确确认的路径中允许发布，执行子代理或普通状态迁移不能绕过该 gate。
4. 发布前逐一校验版本全部非归档目标均为 `delivered`；存在 planning/collecting/ready/in_progress/review/blocked/draft 目标时拒绝发布、展示完整阻塞清单且不改写状态。
5. 成功 released 先写 `version.released` 事件，再更新版本状态与发布记录；working/released 的历史事件与版本投影均正确读取，既有 `version.released` 事件继续兼容。
6. 新增 GUI 弹窗、working/released 成功与拒绝、事件先行/顺序、摘要范围展示和空态的回归测试；`node --test core/tests/*.test.ts` 全量通过。

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
