---
{
  "id": "g-124",
  "title": "状态行改进：tooltip 显示状态延续时间 + supervisor/子代理结束工作前更新 status",
  "status": "review",
  "blocked_reason": null,
  "created_at": "2026-08-22T12:09:28+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.3",
  "scope": [
    "dsh-graph-host",
    "supervisor-guide"
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

负责人 2026-08-22 反馈两个状态行问题：

1. **「🔄 等待最新状态…」显示不好**：现在 staleStatus（新一轮 running 翻转后 status 时间戳旧于翻转时刻）时显示「🔄 等待最新状态…」，负责人觉得这个等待态不好——改为在状态行 tooltip 中显示**当前状态延续的时间**（statusAt 距今多久），不再用「🔄 等待最新状态…」占位；
2. **结束工作前更新 status**：supervisor 与子代理在**结束工作前**都更新一下 status（如「本轮完成/空闲待命」），避免实际空闲但 status 仍显示「正在做 X」的错位——看板如实反映空闲/完成状态。

改动面：
- client.js：staleStatus 分支改为显示延续时间（tooltip 或行内），去「🔄 等待最新状态…」；
- supervisor-guide.md：加「结束工作前更新 status（空闲/完成态）」规范；
- host/index.js spawn 提示词：子代理结束/空闲前更新 status 的指令。



## 质量判据

1. client.js staleStatus 分支改为显示当前状态延续时间（tooltip 或行内，statusAt 距今时长），不再显示「🔄 等待最新状态…」
2. supervisor-guide.md 加规范：supervisor 结束工作前（每轮收尾）更新 status 为「空闲/待命/等待输入」等完成态，避免空闲时仍显示「正在…」
3. host/index.js 两处 spawn 提示词（graph_start_attempt 工具 + start-execution 端点）加指令：子代理结束/空闲前更新 status 为完成态
4. 单测/冻结脚本覆盖（若涉及可测点）；graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|
| ev-001 | client.js staleStatus 分支去「🔄 等待最新状态…」占位，改显状态延续时长（statusAt 距今，行内 ⏳ 状态延续 X + tooltip，30s 时钟刷新）；新增 fmtElapsed 格式化函数 | scripts/check_g124.sh + git diff（branch g124/wt-att-001 @3263bb1） | 2026-08-22 | fresh |
| ev-002 | supervisor-guide.md 新增「每轮收尾更新为完成态（空闲待命/本轮完成/等待输入）」规范，并同步更新过期清空机制描述（旧状态过期→显示状态延续时长） | git diff | 2026-08-22 | fresh |
| ev-003 | host/index.js 两处 spawn 提示词（graph_start_attempt 工具 + start-execution 端点）均加「结束工作前更新 status」指令（grep 计数=2，awk 锚点各自命中） | scripts/check_g124.sh | 2026-08-22 | fresh |
| ev-004 | check_g124.sh 全 PASS；g-108/g-a92e1406 共享回归 PASS；core 单测 PASS（node --test） | scripts/check_g124.sh / check_g108.sh / check_ga92e1406.sh | 2026-08-22 | fresh |
| ev-005 | graph_validate 全量不变式校验无问题（problems: []） | graph_validate 工具 | 2026-08-22 | fresh |

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
