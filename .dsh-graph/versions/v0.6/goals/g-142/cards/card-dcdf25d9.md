---
{
  "id": "card-dcdf25d9",
  "goal": "g-142",
  "title": "现有 client.js 模块边界、入口契约与回归面",
  "kind": "text",
  "status": "filled",
  "filled_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "filled_at": "2026-08-23T11:05:11+08:00",
  "content_ref": null,
  "summary": "已收集 client 插件加载契约与回归策略；当前仓库模块边界仍需专项核验。",
  "child_id": "e6f0f8e0-2249-4ec6-bd55-7a312fa9a04a",
  "parent_session_id": "session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36"
}
---

## 收集结论：client 插件加载/模块化参考基线

### 可复用的入口契约与风险点

- Web client 入口必须保持 `window.__ModuleLoader__.load({ id, factory })` → `factory(require)` → `{ apply(ctx) }` 的加载契约；React 由平台 `require('react')` 提供。
- 视图以 `slots.inject('conversation.view', ...)` 注册；改动入口、`slots.register` 签名或 host 通信协议会使整个看板不可加载。
- 模块化时应把状态/业务动作、渲染组件、样式与 API 调用分开，避免巨型组件和内联样式/业务逻辑耦合。
- 回归策略应至少覆盖：模块加载与渲染冒烟、看板数据首帧/已有数据分支、关键 API 操作、临时 profile 下的组合启动验证。

### 重要适用边界

子代理报告中列出的 `tmp/dsh-project-kanban/src/client.js` 文件行数、`/api/kanban` 路径及 11/15 项断言属于其调研样本，**不是当前 dsh-graph 仓库的事实断言**。本卡将这些信息作为 client 插件入口与回归面设计的参考；实施前仍须对 `dsh-graph-host/lib/client.js` 的真实模块边界、现有 REST 路由和测试入口做专项核验。
