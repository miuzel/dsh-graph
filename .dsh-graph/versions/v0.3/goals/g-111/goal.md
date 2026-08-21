---
{
  "id": "g-111",
  "title": "v0.3 对外发布与插件商店上架",
  "status": "review",
  "blocked_reason": null,
  "created_at": "2026-08-21T20:04:44+08:00",
  "created_by": "agent:session-b00ed183-bc6c-4f66-b07e-e5d909c1f46b",
  "version": "v0.3",
  "scope": [
    "整理 v0.3 发布物（host/client 两包 + schema/docs/scripts）",
    "确定 DSH 插件分发/商店的官方与社区渠道与上架要求",
    "产出发布手册与商店上架清单，交负责人确认后执行发布"
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
  "skill_refs": [],
  "context_cards": [
    "card-996e88de"
  ]
}
---

## 目标描述

把 dsh-graph 的 v0.3 发布到外部并上架插件商店，让其他 DSH 用户能通过官方分发渠道安装。

调研结论（收集卡 card-996e88de，子代理 0cf02d43）：官方无插件商店/registry，分发模型 = npm 包 + profile（`dsh plugin --profile <name> add <pkg>`）；所有社区商店（dsh-market / DshMarketPlace / DSH Get）同源于 awesome-dsh-plugin 一个 curated 列表，上架 = 向其提一条 PR 自动带出三家。

发布阻塞项（须先解决）：
1. dsh-graph-client/cordis.patch.yml 的 config.root 硬编码绝对路径（会打进 npm 包，不可发布）；
2. 两个包 private:true 需移除；
3. 缺 LICENSE / README / npm 元数据（description/repository/keywords 等）、无 git remote、无 dsh-plugin topic。

负责人定案路径：**先设计 root 通用化（数据目录如何解析/初始化）并实现，再打包发布**。裸名 dsh-graph-host / dsh-graph-client 在 npm 均未被占用。

推荐发布路径（定案后执行）：补缺口 → 建公开 repo + 打 dsh-plugin topic → pnpm publish 两包 → 本地 `dsh plugin add` 验收 → PR awesome-dsh-plugin 自动带出三家商店。

先要收集本地gh 工具信息

先要收集本地gh 工具信息


## 质量判据

1. root 通用化设计定案并实现：数据目录解析/初始化规则去除硬编码绝对路径（作为前置子目标 g-112，本目标依赖其完成）
2. 发布缺口补齐：两包 private:false、LICENSE/README/npm 元数据（description/repository/keywords/files 白名单）、build/prepack 脚本
3. 产出发布手册与商店上架清单（docs/ 落盘，含分步命令与 awesome-dsh-plugin PR 模板）
4. 负责人确认后执行发布：建公开 repo+打 dsh-plugin topic→pnpm publish 两包→本地 dsh plugin add 验收→PR awesome-dsh-plugin

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
