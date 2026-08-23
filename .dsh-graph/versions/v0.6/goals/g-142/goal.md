---
{
  "id": "g-142",
  "title": "client js文件很大，不利于后续维护了，需要进行重构",
  "status": "delivered",
  "blocked_reason": null,
  "created_at": "2026-08-23T01:23:08+08:00",
  "created_by": "human:gui",
  "version": "v0.6",
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
    "card-dcdf25d9"
  ]
}
---

## 目标描述


将 `dsh-graph-host/lib/client.js` 按职责拆分为可维护的浏览器客户端模块，保持现有 dsh client 注入、看板交互和 REST 消费行为不变。此目标只做结构重组与测试可维护性改进，不顺带扩张 UI 功能。

执行顺序：v0.6 阶段 A，先完成本目标，再开始会改动客户端入口的 g-134 / g-135。

实施边界：入口导出与 `dsh.client` 声明保持兼容；模块按看板加载/状态与投影、拖放、目标详情与操作、版本泳道、通用 UI 等清晰职责拆分；core 源码仍以 `core/*.ts` 为唯一事实源，改 core 后必须经 `scripts/sync-core.sh` 同步。


## 质量判据

1. `dsh-graph-host/lib/client.js` 已按清晰职责拆分为多个可维护模块；主入口、`./client` export 与 `dsh.client` 注入契约保持兼容。
2. 看板加载、版本/目标投影、拖放、目标详情抽屉、目标操作、归档显示与状态汇报等现有行为无回归；不夹带新的产品功能。
3. 新增或更新覆盖模块入口与关键交互边界的自动化验证；`node --test core/tests/*.test.ts` 全量通过。
4. 修改 core 时已运行 `bash scripts/sync-core.sh`，发布包内 client/core 无失效导入；最终改动已提交。

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
