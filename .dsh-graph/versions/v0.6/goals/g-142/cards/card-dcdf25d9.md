---
{
  "id": "card-dcdf25d9",
  "goal": "g-142",
  "title": "现有 client.js 模块边界、入口契约与回归面",
  "kind": "text",
  "status": "filled",
  "filled_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "filled_at": "2026-08-23T11:22:10+08:00",
  "content_ref": null,
  "summary": "client 插件加载契约、巨型组件边界和渲染/组合验证回归面已收集。",
  "child_id": "e6f0f8e0-2249-4ec6-bd55-7a312fa9a04a",
  "parent_session_id": "session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36"
}
---

# 现有 client.js 模块边界、入口契约与回归面

> 以下为收集子代理的完整要点迁移；其调研样本路径为 `tmp/dsh-project-kanban`，用于 g-142 的 client 模块化设计参考。

## 1. 文件规模与结构现状

- 调研样本源码：`tmp/dsh-project-kanban/src/client.js`（247 行动态版源码）。
- 调研样本 bundle：`tmp/dsh-project-kanban/lib/client.js`（387 行 `__ModuleLoader__` 闭包 bundle）。

样本的 `KanbanView` 是约 200 行的单体组件，包含 14 个 `useState`、服务获取、样式注入、`emptyDraft` 等工具函数、业务动作（`act`、`move`、`shiftInColumn`、`startEdit`、`saveEdit`、`setDraft`、`submitAdd`、`submitNewCol`）、`renderCard`、`renderColumn` 与主渲染，并通过 slot 注册进入会话视图。

### 模块边界问题

1. 单一巨型组件混合了 14 个 state、业务逻辑与全部渲染；
2. CSS 以内联字符串经 `styles.insert` 注入，缺乏模块化/作用域隔离；
3. 标签与优先级选择器存在重复实现；
4. `emptyDraft`、动作函数与 UI 渲染耦合在同一闭包。

## 2. 入口契约

### 模块加载

```js
window.__ModuleLoader__.load({
  id: 'dsh-project-kanban',
  factory(require) {
    const React = require('react')
    return { apply(ctx) { /* ... */ } }
  },
})
```

- `window.__ModuleLoader__.load({ id, factory })` 注册工厂；
- `factory(require)` 接收平台 `require`，`react` 是平台种子词；
- 返回值必须是 `{ apply(ctx) }` 形式的 Cordis Plugin；
- `apply(ctx)` 经 `ctx.get('slots')` 获取插槽服务。

### 视图注册与通信

- 使用 `slots.inject('conversation.view', ...)` + `slots.register(...)` 注册 React 视图；组件可用 `React.createElement`，无需 JSX。
- 样本动态版经 `host.call('kanban.*', args)` 通信，bundle 版经 HTTP `fetch` 通信。
- 模块化不得改变当前 dsh-graph 的实际入口、slot 注册或 REST 协议；实施前必须针对 `dsh-graph-host/lib/client.js` 实测确认这些对应点。

## 3. 回归面

调研样本提供三层验证思路：

1. **渲染冒烟**：mock `__ModuleLoader__`、slots 与首帧/已有数据，覆盖模块加载、视图注入、加载态、标签、优先级、归档等 UI 分支（样本 11 项断言）；
2. **端到端验证**：临时 profile 启动后经 HTTP 验证工具 schema 与关键看板操作（样本 15 项断言）；
3. **组合脚本**：创建临时 `DSH_HOME`、安装本地包、启动 web 组合并依次运行两类测试。

## 4. 关键约束

- 改变 `__ModuleLoader__` 契约会导致整个 GUI 无法加载；
- 改变 `slots.register` 签名会导致看板 tab 消失；
- 改变 host 调用/HTTP 路径会导致操作失败；
- 改变 Board 数据结构会影响持久化兼容性；
- workspace 隔离依赖相关 workspace 参数的持续传递。

## 5. 对 g-142 的落地要求

将 dsh-graph 的客户端按入口、状态/数据、API 调用、交互组件、样式等职责拆分，同时保持现有加载、slot、接口和数据契约；为实际 dsh-graph 模块边界补充针对性的 smoke / profile 组合验证。
