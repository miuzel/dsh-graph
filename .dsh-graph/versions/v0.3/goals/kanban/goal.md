---
{
  "id": "g-102",
  "title": "Kanban 二维泳道看板（client-plugin）",
  "status": "in_progress",
  "blocked_reason": null,
  "created_at": "2026-08-20 17:29:00+08:00",
  "created_by": "supervisor",
  "version": "v0.3",
  "scope": [],
  "depends_on": [],
  "review": {
    "reviewer": "human",
    "prompt": null
  },
  "pk": {
    "lanes": 1,
    "sandbox": "directory"
  },
  "rules_snapshot": "r-2026-08",
  "skill_refs": [],
  "context_cards": [
    "card-fb306499",
    "card-94c86099"
  ]
}
---

## 目标描述
DSH client-plugin 形态的看板：横轴生命周期阶段、纵轴版本泳道 + backlog 区；
卡片查看详情/判据核对/履历；干预操作（声明完成、CRUD、给 supervisor 输入）。
依赖 g-101 提供的接口。

最终修订版交互形态：二维泳道只读看板；目标卡=蓝边🎯+关键信息扼要；信息收集卡=绿色缩进子卡+摘要行+抽屉（摘要/全文/子代理链接）；详情 modal 分区扼要；弹层打开时源卡片保持高亮；已发布版本收起置底可展开；依赖卡琥珀边标识；hover/active 反馈贯穿所有可点元素。


## 收集计划

（已并入上下文卡片：两项收集即为本目标的两张卡片，见「上下文卡片」）

## 质量判据

1. [script] scripts/check_kanban.sh
