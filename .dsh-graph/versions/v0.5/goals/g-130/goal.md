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


## 方案转向（负责人 2026-08-22）

负责人提出更优方案：**不搞文件监听 hook，直接在 graph_amend_goal 工具脚本里实现格式约束**——工具写盘是统一入口，写入时自动规范化/校验，比监听可靠简单。

落地：
1. **amendGoal 剥离 Markdown 标题**（appendDescription 若以 `## ` 开头则剥离或告警）——根治 g-119/120/124/125/128/129 连环「重复小节」坑；
2. **append 格式约束**：appendDescription 只允许正文内容（一句话要点/段落），写盘后 body 仍满足「单小节、无占位」结构；
3. 用户用编辑器直接改 goal.md 的格式问题仍靠 graph_validate 兜底（不做文件监听）；g-129 文件链接配套说明「建议用工具改，手改后跑 validate」。

g-130 范围收窄为：amendGoal 工具内格式约束（剥离标题 + append 规范化）+ 测试。



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

1. amendGoal 剥离 appendDescription 中的 Markdown 标题（/^##?\s/ 开头则剥离，保留正文）——根治重复小节坑（g-119/120/124/125/128/129）
2. append 规范化：写入后 body 仍满足单「## 目标描述」小节、无占位残留；appendDescription 为空或仅标题时行为明确（告警或忽略）
3. 用户手改 goal.md 的格式问题仍由 graph_validate 兜底（g-129 文件链接配套说明）
4. 单测覆盖：append 带头标题被剥离、正常正文不受影响、重复小节不产生；全量测试与冻结脚本 PASS
5. graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
