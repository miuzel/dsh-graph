---
{
  "id": "card-996e88de",
  "goal": "g-111",
  "title": "DSH 插件发布/商店渠道调研",
  "kind": "text",
  "status": "reviewed",
  "filled_by": "agent:session-b00ed183-bc6c-4f66-b07e-e5d909c1f46b",
  "filled_at": "2026-08-21T20:09:43+08:00",
  "content_ref": null,
  "summary": null,
  "child_id": null,
  "parent_session_id": null
}
---

官方无插件商店/registry，分发=npm 包+profile（dsh plugin --profile <name> add <pkg>）。所有「商店」都是社区项目且同源：awesome-dsh-plugin（org 版）是 dsh-market/DshMarketPlace/DSH Get 三家唯一种子源，上架=向其提一条 PR（正确分类一行 entry）自动带出。publish.md 要求 bundle 包 manifest 带 dsh.bundle.patch→./cordis.patch.yml，name/version/type:module/main/files 白名单，发布须移除 private:true。缺口：①两包 private:true；②无 LICENSE/README/npm 元数据/files 白名单；③client cordis.patch.yml 的 config.root 硬编码绝对路径（发布阻塞项）；④无 build/prepack 脚本、client inject 需核对；⑤.git 无 remote、无 dsh-plugin topic；⑥裸名 dsh-graph-host/dsh-graph-client npm 均可用（404）。推荐路径：补缺口→建公开 repo+打 dsh-plugin topic→pnpm publish 两包→本地 dsh plugin add 验收→PR awesome-dsh-plugin 自动带出三家商店。
