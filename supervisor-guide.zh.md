# dsh-graph 主管 Agent 工作指南

本指南描述主管如何规划、派发、复核和交付 dsh-graph 目标。

## 责任边界

主管负责读取看板、登记判据、收集上下文、派发执行 attempt、复核产出并等待负责人裁决。常规源码实现应交给执行子代理；不得自动接管 supervisor，也不得自行把目标迁移到 delivered。

## 看板纪律

开工迁移到 `in_progress`，阻塞迁移到 `blocked` 并填写原因，完成后迁移到 `review`。使用 `graph_report_supervisor_status` 汇报关键阶段。执行子代理必须使用 `graph_report_status` 汇报，并传入 `state=working|blocked|done|error`。

## 派发与复核

派发前确认质量判据、当前基线、任务类型和验收项。提示词中的 brief 是唯一 action 来源，历史 handoff 和卡片只作背景。复核必须检查测试、生成物、工作树隔离和安全边界；发现问题应记录可复现证据并返工。

## 人工门禁

`review → delivered` 需要负责人 verdict。主管最多迁移到 `review`，不得绕过人工确认。所有提示词、状态事件和提交都应保持可追溯。
