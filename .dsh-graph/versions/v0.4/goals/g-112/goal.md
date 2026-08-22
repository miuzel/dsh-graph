---
{
  "id": "g-112",
  "title": "root 通用化：数据目录解析与初始化（去除 client 硬编码绝对路径）",
  "status": "delivered",
  "blocked_reason": null,
  "created_at": "2026-08-21T20:59:04+08:00",
  "created_by": "agent:session-b00ed183-bc6c-4f66-b07e-e5d909c1f46b",
  "version": "v0.4",
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
  "skill_refs": [],
  "context_cards": [
    "card-81fe900b"
  ]
}
---

## 目标描述

让 dsh-graph 数据目录（root）的解析与初始化通用化，使发布到 npm 后任意用户安装即可用，而非依赖本机硬编码路径。当前阻塞：dsh-graph-client/cordis.patch.yml 的 config.root 硬编码 `/home/miuzel/workspace/personal/dsh-graph/.dsh-graph`，会打进 npm 包、在他人机器上失效。

**设计定案（基于收集卡 card-81fe900b，权威：dsh-home-paths + 官方 README + 参考插件 dsh-project-kanban）**：
1. **root 解析基准 = workspace 根**（`process.cwd()`，DSH 官方「运行目录=默认 workspace 根」约定），默认相对 `.dsh-graph`——符合 git 友好、多项目各用各数据；第三方插件数据约定在工作区内，非 $DSH_HOME。
2. **两半统一**：host 与 client 都改为 `resolve(workspaceRoot, config?.root ?? ".dsh-graph")`；删除 client bundle patch 的硬编码绝对路径。
3. **覆盖链保留**：config.root 仍可覆盖；本地开发继续靠 `~/.dsh/profiles/web/cordis.patch.yml` 用户层覆盖指向现有 `.dsh-graph`（hot-reload，不破坏本地开发）。
4. **初始化**：host apply 幂等调用 core `init()`——发布后新用户装上自动建骨架（backlog/goals/versions/memory + events.jsonl/index.json/rules.md，不建 project.yaml、不带 demo 数据）。

产出：上述统一 root 解析函数 + 两个 cordis.patch.yml 改相对/可配置 + host apply 调 init() + 测试。

## 质量判据

1. root 解析统一为 workspace 根（process.cwd()）基准，默认相对 .dsh-graph；host/client 两半同一 resolve(workspaceRoot, config.root ?? ".dsh-graph")
2. 删除 dsh-graph-client/cordis.patch.yml 的硬编码绝对路径，改为相对/可配置；host 的 cordis.patch.yml 保持相对
3. host apply 幂等调 core init()：root 不存在时自动建骨架（backlog/goals/versions/memory + events.jsonl/index.json/rules.md），重复 apply 不重复建
4. 本地开发不破坏：~/.dsh/profiles/web/cordis.patch.yml 用户层覆盖仍指向现有 .dsh-graph，测试全绿不回归

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
