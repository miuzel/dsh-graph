# dsh-graph-host

dsh-graph 的 host 半边：把 dsh-graph 核心层包装为 [DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）cordis 插件。

它向 agent 暴露 `graph_*` 工具，覆盖目标全生命周期：建卡、判据登记、状态迁移、上下文卡片收集、执行 attempt 派发、评审裁决、交付与沉淀。数据以文件 + 事件流形式落在工作区的 `.dsh-graph` 目录，git 友好、可审计。

## 安装

```sh
dsh plugin --profile <name> add dsh-graph-host
```

> 需要 Node ≥ 23.6（core 为 TypeScript，依赖 Node 原生 type-stripping 运行）。

## 提供的工具

| 工具 | 作用 |
|------|------|
| `graph_create_goal` | 创建目标（默认进 backlog，可排期入版本） |
| `graph_set_criteria` | 登记质量判据（判据先于执行） |
| `graph_transition` | 状态机迁移（draft→planning→collecting→ready→in_progress→review→delivered） |
| `graph_add_card` / `graph_fill_card` / `graph_review_card` | 上下文卡片收集生命周期 |
| `graph_start_attempt` | 派发执行 attempt（自动绑定可续轮子 agent） |
| `graph_move_goal` / `graph_amend_goal` | 排期移动 / 目标修订 |
| `graph_validate` / `graph_rebuild` | 全量不变式校验 / 事件流对账 |
| `graph_report_status` / `graph_report_supervisor_status` | 状态汇报（看板实时显示） |
| `graph_resolve_accept` | 评审裁决 |

## 数据目录

root 跟随**会话 workspace**（g-113）：工具按调用会话的 `session.header.cwd` 解析 `.dsh-graph`
（无会话上下文时兜底 `sandboxPolicy.workspaceRoot`，再兜底 `process.cwd()`）——在哪个项目开会话，
数据就落在哪个项目自己的 `.dsh-graph`，绝不读 dsh web 服务进程 cwd（bwrap 沙箱里固定为 profile 目录）下的空骨架。
可用 profile 用户层 `cordis.patch.yml` 按 id 覆盖 `config.root`。首次触达某 workspace 自动生成骨架
（`backlog/`、`goals/`、`versions/`、`events.jsonl`、`rules.md`），幂等、不建 demo 数据。

## 与 dsh-graph-client 的关系

- `dsh-graph-host`：工具层（agent 用），headless / web 皆可；
- `dsh-graph-client`：看板 UI 层（浏览器），依赖 host 的 `/api/dsh-graph` 端点；
- 二者共享同一 core（`core/` 目录，由 `scripts/sync-core.sh` 同步，内容一致）。

## 开发

```sh
bash scripts/sync-core.sh   # 修改 core 后同步进包
node --test core/tests/*.test.ts
```

## License

MIT
