# dsh-graph-client

dsh-graph 的 client 半边：在 [DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）Web 界面内渲染二维泳道目标看板。

- **看板**：版本 / 独立 / backlog 泳道 + 卡片（状态、依赖、被复用徽章、supervisor 状态栏）；
- **详情**：modal 弹窗查看目标描述、判据、上下文卡片、证据台账；
- **工作台**：可写操作（接受评审、编辑描述、加卡片、发起收集/执行、重新执行+模型选择），事件先行，前端不直改文件；
- **host 半边**：注册 `/api/dsh-graph`、`/api/dsh-graph/goal` 等 REST 端点。

## 安装

```sh
dsh plugin --profile web add dsh-graph-client
```

> 需要 Node ≥ 23.6（core 为 TypeScript，依赖 Node 原生 type-stripping 运行）；
> 浏览器半边依赖 DSH 内置 `@deepseek-ai/dsh-client-runtime`。

## 数据目录

与 `dsh-graph-host` 共用同一 root 解析，且 root 跟随**会话 workspace**（g-113）：
HTTP 请求本身不带会话，前端把当前会话的 workspace（`session.header.cwd` 的客户端投影）作为
`?workspace=` 查询参数随每个 `/api/dsh-graph*` 请求发送，端点据此读该项目自己的 `.dsh-graph`
（缺参时兜底 `process.cwd()`）；首次触达某 workspace 自动建骨架（幂等）。
可用用户层 `cordis.patch.yml` 按 id 覆盖 `config.root`。

## 依赖关系

- client 的 Node 半边不再跨包依赖 host（g-111 B7：`boardPayload` 已移入 core）；
- 与 host 共享同一 core（`core/`，由 `scripts/sync-core.sh` 保证与根 core 一致）。

## 开发

```sh
bash scripts/sync-core.sh   # 修改 core 后同步进包
node --test core/tests/*.test.ts
```

## License

MIT
