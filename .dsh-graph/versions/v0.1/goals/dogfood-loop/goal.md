---
{
  "id": "g-002",
  "title": "Dogfood：用本系统管理 g-001 走通全生命周期",
  "status": "planning",
  "blocked_reason": null,
  "created_at": "2026-08-20 17:29:00+08:00",
  "created_by": "supervisor",
  "version": "v0.1",
  "scope": [
    ".dsh-graph/"
  ],
  "depends_on": [
    {
      "goal": "g-001",
      "consumes": [
        "core/ 交付物与 delivered 状态"
      ]
    }
  ],
  "review": {
    "reviewer": "human",
    "prompt": null
  },
  "pk": {
    "lanes": 1,
    "sandbox": "directory"
  },
  "rules_snapshot": "r-2026-08",
  "skill_refs": []
}
---

## 目标描述
不使用引擎辅助（本期引擎尚不存在，纯人工按 schema 操作文件），用 `.dsh-graph`
管理 g-001 的开发，从 draft 到 delivered 走通完整生命周期，并记录过程中发现的
schema 与流程缺陷。本目标与 g-001 并行推进：g-001 在开发，本目标在管理它的开发。

## 收集计划
- [x] `schema/SCHEMA.md` 操作规范
- [x] 版本范围与 g-001 判据（负责人确认中）

## 质量判据
1. g-001 的每次状态迁移在 events.jsonl 中有对应事件，序列符合状态机，无跳变无漏记
2. 过程中发现的每个缺陷都有记录（memory 条目或 SCHEMA.md / DESIGN.md 修订），无静默修复
3. g-001 review 时判据逐条核验结果写入其 attempt 的 Review 记录小节

## 证据台账
| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|
| ev-01 | 发现#1（planning 细化）：冻结验收脚本时 CLI 需要 `set-criteria` 命令，goal 描述中未列出——已补入 g-001 描述 | 编写 scripts/check_core.sh | 2026-08-20T17:29 | fresh |
| ev-02 | 发现#2（schema 缺陷）：事件类型全集缺少通用 `goal.transition`（如 planning→collecting 无对应事件），已补入 SCHEMA.md | 迁移 g-001 状态时 | 2026-08-20T17:35 | fresh |
| ev-03 | 发现#3（驱动方式缺陷）：**人工 gate 流程不能用 DSH goal 自动续轮模式驱动**——round driver 不停等人工输入，会把 scope/判据/review 等人工决策点全部冲过。正确方式：普通会话逐轮推进，在人工 gate 处自然停轮。DSH goal 工具仅适合无人值守的长任务 | 负责人指出（第 2 轮自动续轮后） | 2026-08-20T17:40 | fresh |
| ev-04 | 正面验证：收集 subagent 模式首次实战成功——插件机制调研的粗读在主上下文外消化，精炼报告回流，主上下文保持干净（符合 §2.1 修订后的 collecting 语义） | DSH 插件机制调研 subagent | 2026-08-20T18:05 | fresh |
| ev-05 | 发现#4（流程缺陷）：补记场景下状态迁移会漏记事件（g-001 的 ready→in_progress、g-002 的 draft→planning），引擎 rebuild --check 当场抓出两处 drift。处置：补记事件 + replay 语义扩展（goal.planned 视作 draft→planning 隐式迁移），已写入 SCHEMA.md | 引擎 validate/rebuild 实报 | 2026-08-20T18:35 | fresh |
| ev-06 | 发现#5（实现反馈）：rules_snapshot 不应手工填——setCriteria 时引擎自动从 rules.md 快照（验收脚本首跑失败暴露）；init 默认生成 r-init 骨架规则文件 | scripts/check_core.sh 首跑失败 | 2026-08-20T18:30 | fresh |
| ev-07 | 发现#6（事件语义缺陷）：排期移动（backlog→版本）被误记为 `goal.transition`（to 填了路径而非状态），污染 replay 被 rebuild 当场抓出。处置：新增 `goal.moved` 事件类型（不影响状态），replay 忽略非法状态值 | 我自身操作失误被引擎抓出 | 2026-08-20T18:57 | fresh |

## 处置分支
（使用项目默认）

## 依赖我的下游
（暂无）
