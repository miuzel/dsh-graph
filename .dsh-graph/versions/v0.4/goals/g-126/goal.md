---
{
  "id": "g-126",
  "title": "看板版本泳道与包版本对齐（合并单包后已是 0.4.x，泳道仍叫 v0.3）",
  "status": "in_progress",
  "blocked_reason": null,
  "created_at": "2026-08-22T12:19:57+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.4",
  "scope": [
    "core",
    "dsh-graph-host"
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
  "skill_refs": []
}
---

## 目标描述

负责人 2026-08-22 指出：自从两个插件合并为单包 dsh-graph 后，包版本已是 0.4.x（npm 0.4.0/0.4.1，本地 dsh-graph-host/package.json version=0.4.1），但看板的版本泳道还停在 **v0.3（看板可视化）**——版本语义与包版本不对齐，需要适当调整。

待办（等 g-125 等当前任务完成后处理，负责人指示）：
1. 梳理版本泳道与包版本的对应关系（v0.3 泳道承载了 g-111~g-125，其中大量是 0.4.x 时代的合并后功能）；
2. 调整方案待定：可能新建 v0.4 泳道承接 0.4.x 目标、v0.3 标记 released、或按包版本重命名泳道；
3. 涉及 core（版本管理/boardProjection）、host（看板渲染版本泳道）。

当前进行中任务：g-125（in_progress），完成后再处理本目标。



## 质量判据

1. 调研现状：梳理 v0.1/v0.2/v0.3 泳道与包版本（npm 0.3.x/0.4.x）的对应关系，定位语义错位点（哪些 0.4.x 时代目标落在 v0.3 泳道）
2. 给出调整方案并获负责人确认：新建 v0.4 泳道承接 0.4.x 目标 / v0.3 标记 released / 按包版本重命名泳道（至少二选一对比）
3. 实现：看板版本泳道与包版本对齐（core boardProjection + 目标归属迁移 + 看板渲染，涉及文件移动走 graph_move_goal 事件先行）
4. 全量测试与冻结脚本 PASS，graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|
| ev-01 | npm 发布史实测：两包 dsh-graph-host/client 0.3.0/0.3.1/0.3.2（2026-08-21T18:12Z~20:43Z，即北京 8/22 02:12~04:43）；单包 dsh-graph 0.4.0（2026-08-22T02:24:49Z，北京 10:24）；0.4.1 本地已 0.4.1 待发 | registry.npmjs.org（curl 实测） | 2026-08-22 | fresh |
| ev-02 | 语义错位点：v0.3 泳道 19 目标中，g-116~g-126 共 11 个为 0.4.x 单包时代创建（8/22 04:53 后），另 g-111~g-113 发布产物实为 0.4.0/0.4.1；v0.3 泳道 status=active 但 0.3.x 两包时代已终结（0.3.2 计划撤回） | boardProjection + events.jsonl + goal.md created_at | 2026-08-22 | fresh |
| ev-03 | 负责人确认方案 A：v0.3 标记 released（保留 5 个 0.3.x 时代已交付目标）+ 新建 v0.4 泳道承接 14 个 0.4.x 时代目标（对比过仅 released/目录改名两方案） | GUI 问答（方案 A 确认） | 2026-08-22 | fresh |
| ev-04 | 迁移完成：14 目标（g-111~g-113、g-116~g-126）graph_move_goal → v0.4，goal.moved 事件先行；v0.3 version.md status→released、v0.4 version.md 新建（v-004 active）；version.created/version.released 事件入流 | events.jsonl（goal.moved ×14 + version.created + version.released） | 2026-08-22 | fresh |
| ev-05 | 验证全绿：85/85 单测 + 10 冻结脚本（check_cards/core/g107/g108/g109/g124/g125/ga92e1406/kanban/plugin）全 PASS；graph_validate 无问题；graph_rebuild 无 drift；boardPayload 投影 v0.1~v0.3 released + v0.4 active(14) | 本机运行（node --test + scripts/check_*.sh + graph_* 校验） | 2026-08-22 | fresh |

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
