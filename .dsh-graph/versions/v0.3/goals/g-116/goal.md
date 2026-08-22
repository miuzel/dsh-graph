---
{
  "id": "g-116",
  "title": "合并单包：dsh-graph-client 并入 dsh-graph-host",
  "status": "delivered",
  "blocked_reason": null,
  "created_at": "2026-08-22T04:53:03+08:00",
  "created_by": "agent:session-b00ed183-bc6c-4f66-b07e-e5d909c1f46b",
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
  "rules_snapshot": "r-2026-08-3",
  "skill_refs": []
}
---

## 目标描述

把 dsh-graph-client 并入 dsh-graph-host，合并成**单包**——解决「装一个只有半拉功能」（graph_* 工具/skill 在 host、看板在 client，用户只装 client 时无工具无 skill）的发布痛点。负责人指示「client 合并到 host 里比较方便，早做早好」。

合并后的单包 `dsh-graph-host`（保留 host 名）需同时具备：
1. **host 半边**：graph_* 工具注册 + dsh-graph/dsh-graph-supervisor skill 注册 + webServer 端点（/api/dsh-graph* 全部路由，原 client index.js 的端点并入 host index.js）
2. **client 半边**：浏览器看板（原 client lib/client.js 的 KanbanView 等，经 conversation.view slot 渲染）

具体：
- 原 dsh-graph-client/index.js（webServer 端点 + spawnChild 等）→ 并入 dsh-graph-host/index.js（或同包第二个入口文件，最终单包导出）
- 原 dsh-graph-client/lib/client.js（看板 UI）→ 移入单包 lib/
- cordis.patch.yml 合并：一条 bundle patch 同时 insert host（tools/skills/webServer）与 client（conversation.view 看板）两个插件
- package.json 合并：`dsh.bundle.patch` + `dsh.client`（platform web + inject）同在一包；files 白名单含 index.js + lib/ + core/ + cordis.patch.yml + README + LICENSE + supervisor-guide.md
- 删除 dsh-graph-client 包（目录 + 引用）
- 本地开发两半加载路径、root 跟随 workspace、DEBUG 行等既有行为不回归

发布：0.3.2 两包作废，单包重新发（版本号待定，建议 0.4.0 表示结构变更）。

## 质量判据

1. 单包 dsh-graph-host 同时具备 host 半边（graph_* 工具 + skill + /api/dsh-graph* 端点）与 client 半边（conversation.view 看板）
2. 一条 cordis.patch.yml insert 两个插件；package.json 含 dsh.bundle.patch + dsh.client；files 白名单齐全
3. dsh-graph-client 包删除，无残留引用；本地开发两半加载不回归（marker 14 工具 + 看板正常）
4. 测试不回归（53/53+）+ 冻结脚本全绿 + 他机验证：装单包后工具/skill/看板三者齐备

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|
| ev-001 | 单测 53/53 全绿（合并前基线同 53/53，未回归） | `node --test core/tests/*.test.ts` | 2026-08-22 | fresh |
| ev-002 | 8 冻结脚本全 PASS（check_core/cards/plugin/g107/g108/g109/ga92e1406/kanban） | scripts/ | 2026-08-22 | fresh |
| ev-003 | headless 真实加载 marker：14 工具注册 + validate PASS | check_plugin.sh | 2026-08-22 | fresh |
| ev-004 | 隔离 web 实装：首页含 plugins/dsh-graph/client.js、client.js 200、/api/dsh-graph 返回正确 JSON | check_kanban.sh（多次重跑稳定；包名更名后 URL 断言值需规划方修订为 /plugins/dsh-graph/） | 2026-08-22 | fresh |
| ev-005 | __DSH_BOOT__ entry dsh-graph + inject @deepseek-ai/dsh-client-runtime；lib/client.js 浏览器契约 smoke（bundle id/name=dsh-graph，conversation.view 看板槽注册）；skills dsh-graph/dsh-graph-supervisor + 14 工具 | probe（tmp/skill-check.mjs + client-smoke） | 2026-08-22 | fresh |
| ev-006 | 单包 files 白名单齐全（index.js/core/lib/cordis.patch.yml/supervisor-guide.md/README/LICENSE）、无 .ts 泄漏、dsh-graph-client 无残留功能引用 | 结构核查 + git grep | 2026-08-22 | fresh |
| ev-007 | 命名更正（负责人定案）：npm 包名 dsh-graph；实测 link 键名、__DSH_BOOT__ entry、/plugins/dsh-graph/client.js 均跟随包名；npm pack 0.4.0 tgz 解包验证 host 导出 + client bundle（id/name=dsh-graph） | 隔离 web 实例 + npm pack | 2026-08-22 | fresh |

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
