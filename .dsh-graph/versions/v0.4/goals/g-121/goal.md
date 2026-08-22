---
{
  "id": "g-121",
  "title": "HANDOFF 旧版归档：生成新 HANDOFF 前打包旧文件，归档目录不入 git",
  "status": "delivered",
  "blocked_reason": null,
  "created_at": "2026-08-22T11:44:02+08:00",
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

负责人 2026-08-22 反馈：新 supervisor 完成 handoff 后，**原来的 HANDOFF.md 没有归档**——每次 graph_handoff(write) 直接覆盖 `<root>/HANDOFF.md`，旧版本丢失、且若手工留档会产生大量遗留文件，影响整体表现。要求：

1. 生成新 HANDOFF 前，若旧 HANDOFF.md 存在且内容不同，**先打包归档**（如 `<root>/handoffs/HANDOFF-<时间戳>.md` 或打包压缩）；
2. **归档目录不进 git**（.gitignore 排除）——遗留文件不入库；
3. graph_handoff 工具与 graph_claim_supervisor（返回 HANDOFF 时同时落盘）统一走归档逻辑。

与 g-117（HANDOFF 自动生成）衔接：g-117 管「生成」，本目标管「旧版归档、不留库」。



## 质量判据

1. generateHandoff(write:true) 写新 HANDOFF 前：若 <root>/HANDOFF.md 已存在且内容不同，先把它归档（如 <root>/handoffs/ 目录，文件名带时间戳，如 HANDOFF-<ts>.md 或 .tar.gz），再写新文件
2. 归档目录（handoffs/）加入 .gitignore / 不在 git 跟踪范围——旧 HANDOFF 不提交入库（负责人 2026-08-22 指示：遗留文件影响整体表现）
3. claimSupervisor / graph_handoff 工具行为同步（写盘路径统一走归档逻辑）
4. 单测覆盖：首写无归档；二次写旧文件归档（内容/时间戳/目录）；归档不进 git（.gitignore 断言）；全量测试与冻结脚本 PASS
5. graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|
| ev-001 | 单测 85/85 全绿（g-121 新增 4 用例：首写无归档 / 二次写归档内容+时间戳+目录 / writeHandoff 内容相同不归档 / claimSupervisor 落盘+归档；另 .gitignore 断言合并进首用例） | `node --test core/tests/*.test.ts` | 2026-08-22 | fresh |
| ev-002 | 8 冻结脚本全 PASS（check_core / check_cards / check_g107 / check_g108 / check_g109 / check_ga92e1406 / check_kanban / check_plugin——含真实 headless 插件加载） | scripts/check_*.sh | 2026-08-22 | fresh |
| ev-003 | tsc 编译产物与包内 dsh-graph-host/core/*.js 完全一致（sync-core.sh 一致性校验，无 .ts 泄漏） | scripts/sync-core.sh | 2026-08-22 | fresh |
| ev-004 | 实机探针：graph_handoff 首写无归档 → 二次写归档 HANDOFF-<ts>.md（内容=旧版全文）→ claimSupervisor 返回时同时落盘并触发归档（累计 2 份）；仓库根 .gitignore 含 handoffs/ | tmp/handoff-archive-probe.mjs | 2026-08-22 | fresh |
| ev-005 | 归档目录确认不入 git：`git check-ignore -v .dsh-graph/handoffs/HANDOFF-*.md` 命中 `.gitignore:9:handoffs/` | git check-ignore | 2026-08-22 | fresh |
| ev-006 | graph_validate PASS（全量不变式校验无问题） | `node core/main.ts --root .dsh-graph validate` | 2026-08-22 | fresh |

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
