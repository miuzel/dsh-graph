---
{
  "id": "g-130",
  "title": "goal.md 修改后格式检查：文件变更检测 + 校验告警（编辑器自由编辑配套）",
  "status": "draft",
  "blocked_reason": null,
  "created_at": "2026-08-22T16:36:30+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.5",
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


## 目标描述

v0.5（负责人 2026-08-22 提出）：goal.md 被外部编辑器修改后需要格式检查——与 g-129（goal.md 文件链接、编辑器自由编辑）配套，用户改完能立即发现格式问题。

背景：现有 `graph_validate` 是全量校验（含 frontmatter 解析失败报告），但**无文件监听 hook**——编辑器改完 goal.md 不会自动触发检查。

实现方向（方案待定）：
1. 文件变更检测：监听 `.dsh-graph` 目录文件变化（fs.watch / 轮询），或 GUI 刷新时检测 goal.md 的 mtime/内容变化；
2. 校验触发：检测到修改后运行格式校验（复用 loadGoal/validate 逻辑），对 frontmatter 解析失败/结构异常/事件流漂移告警；
3. 告警呈现：看板 UI 提示（目标卡片角标/横幅），或写入事件流；
4. 调研 DSH 是否有现成文件监听服务可复用（dsh-fs-local 仅乐观并发控制，无监听——待确认）。

与 g-129 衔接：g-129 提供打开链接（编辑器改），本目标提供改后检查（格式告警）。



## 质量判据

1. 调研：DSH 有无现成文件监听/变更检测机制（fs.watch / dsh-fs 服务 / GUI 轮询），确认可复用方案
2. 实现 goal.md 修改后格式检查：检测 .dsh-graph 目标文件变更（mtime/内容对比），触发校验
3. 校验复用 loadGoal/validate：frontmatter 解析失败/结构异常/事件流漂移等格式问题告警
4. 告警呈现：看板 UI（目标卡片/详情提示）或事件流记录，用户改完可见
5. 全量测试与冻结脚本 PASS，graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
