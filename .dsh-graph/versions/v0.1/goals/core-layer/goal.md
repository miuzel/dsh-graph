---
{
  "id": "g-001",
  "title": "核心层 TypeScript 参考实现",
  "status": "delivered",
  "blocked_reason": null,
  "created_at": "2026-08-20 17:29:00+08:00",
  "created_by": "supervisor",
  "version": "v0.1",
  "scope": [
    "core/"
  ],
  "depends_on": [],
  "review": {
    "reviewer": "human",
    "prompt": "重点检查：不变式是否由引擎强制而非靠测试自觉；事件流是否唯一真相源；非受管区域是否原文保留"
  },
  "pk": {
    "lanes": 1,
    "sandbox": "directory"
  },
  "rules_snapshot": "r-2026-08-2",
  "skill_refs": []
}
---

## 目标描述
按 `schema/SCHEMA.md` 实现核心层参考实现（TypeScript，运行于 Node ≥ 23.6 原生 TS，
零 npm 依赖、零构建步骤，代码位于 `core/`；与 DSH 同为 JS 技术栈）：

- 图根目录初始化（init）
- 目标实体的创建、frontmatter 解析与写回（非受管区域保留原文；frontmatter 采用
  JSON——YAML 的子集，Node 标准库直接可解析）
- 状态机迁移接口：合法迁移执行并追加 events.jsonl 事件；非法迁移拒绝
- 不变式校验（validate）与依赖建边环检测
- 从事件流重建全部目标状态并与 frontmatter 比对（rebuild --check）

CLI 形态：`node core/main.ts [--root DIR] <init|create-goal|set-criteria|transition|validate|rebuild>`

## 收集计划
- [x] `DESIGN.md` 与 `schema/SCHEMA.md`（已就绪，作为规格）
- [x] DSH goal 工具的准确行为（仅了解，本期不对接）→ ev-01

## 质量判据
1. create-goal 生成符合 schema 的 goal.md；引擎写回 frontmatter 后，描述等非受管小节保持原文
2. 合法迁移执行并追加事件；非法迁移（跳阶段、无 reason 进 blocked、无判据进 in_progress）
   被拒绝且 CLI 退出码非零
3. validate 能报告违反不变式的存量目标（如手改 frontmatter 造成的非法状态）
4. rebuild --check 从 events.jsonl 重建状态并与 frontmatter 一致；人为篡改 frontmatter 后能报出 drift
5. [script] scripts/check_core.sh

## 证据台账
| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|
| ev-01 | DSH goal 工具为会话级单一活动目标（`dsh-goal`/`dsh-tool-goal`/`dsh-goal-round-driver` 包）：权威检查要求 edit/pause/resume 必须来自直接人类输入，complete/blocked 仅允许在 goal round 内。结论：**不可复用为多项目目标的状态机**，dsh-graph 状态自持于文件；DSH goal 工具只镜像 supervisor 的会话级目标 | 阅读 DSH 安装包源码 | 2026-08-20T17:35 | fresh |

## 处置分支
（使用项目默认）

## 依赖我的下游
- g-002（消费：本目标 delivered 状态与 `core/` 交付物）
