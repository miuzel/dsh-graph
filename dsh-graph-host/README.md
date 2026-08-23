# dsh-graph

dsh-graph 单包（g-116：host 与 client 合并；npm 包名 = dsh-graph，内部 host 插件 id 保留 dsh-graph-host）：把 dsh-graph 核心层包装为 [DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）cordis 插件，**一个包同时提供两个半边**：

- **host 半边**：向 agent 暴露 `graph_*` 工具，覆盖目标全生命周期：建卡、判据登记、状态迁移、上下文卡片收集、执行 attempt 派发、评审裁决、交付与沉淀；同时注册 `/api/dsh-graph*` REST 端点（看板投影 / 详情 / 写操作）。
- **client 半边**：浏览器二维泳道看板（`lib/client.js`，经 `dsh.client` 声明 + `exports["./client"]` 编入 `__DSH_BOOT__`，渲染进 `conversation.view` 槽）。

数据以文件 + 事件流形式落在工作区的 `.dsh-graph` 目录，git 友好、可审计。

## 安装

```sh
dsh plugin --profile <name> add dsh-graph
```

> 需要 Node ≥ 22（包内 core 为编译后 .js）。

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
| `graph_handoff` | 换会话交接：生成/更新 `.dsh-graph/HANDOFF.md`（board 投影 + 长期记忆 + 环境事实） |
| `graph_claim_supervisor` | 新会话接手：更新 `supervisor.session` 为当前会话 id + 记事件 + 返回 HANDOFF 全文（幂等） |
| `graph_bind_collect_card` | 把已派发的收集子代理绑定到上下文卡片（写 child_id/parent_session_id、置 collecting、记事件；重复绑定同 child 幂等） |
| `graph_help` | 输出 dsh-graph 使用说明 + supervisor 接管（claim）指引（g-118） |

## 引导提示词自动注入（g-118）

dsh-graph-host 经 `ctx.systemPrompt.section()` 在**所有会话**注入一条**简短引导提示词**（非完整守则）：
告知如何用 `graph_claim_supervisor` 接管 supervisor、存在 `graph_help` 命令查看使用说明。
内容轻量无害（告知「如何」接管，不授予主管角色）——

- **完整 supervisor 工作守则不自动注入**：仍走显式 `skill dsh-graph-supervisor` 调用，
  避免临时会话被注入主管角色而争抢 supervisor；
- 隔离：主管守则**绝不**出现在任何会话的自动注入里（含执行子代理）。

详见 `docs/guide-auto-injection.md`。

## 数据目录

root 跟随**会话 workspace**（g-113）：工具按调用会话的 `session.header.cwd` 解析 `.dsh-graph`
（无会话上下文时兜底 `sandboxPolicy.workspaceRoot`，再兜底 `process.cwd()`）——在哪个项目开会话，
数据就落在哪个项目自己的 `.dsh-graph`，绝不读 dsh web 服务进程 cwd（bwrap 沙箱里固定为 profile 目录）下的空骨架。
可用 profile 用户层 `cordis.patch.yml` 按 id 覆盖 `config.root`。首次触达某 workspace 自动生成骨架
（`backlog/`、`goals/`、`versions/`、`events.jsonl`、`rules.md`），幂等、不建 demo 数据。

**g-149 canonical root**：Git linked worktree 自动归一到主工作树的 graph root（`resolveCanonicalRoot`），不会在 code worktree 下 init 第二份。`apply()` 不再以 `process.cwd()` 自动创建骨架——有明确 session/request workspace 或 `sandboxPolicy` 时才 init。详见根 README「独立数据仓库模式」。

**数据 repo 边界**：`.dsh-graph` 可由独立 Git 仓库管理（内层仓库跟踪 `events.jsonl`）。父仓库 `.gitignore` 以 `**/.dsh-graph/` 通配规则防止子目录意外引入。supervisor 和子 Agent 不得用 `git add -f` 把 `.dsh-graph` 数据重新纳入父代码仓库 Git。

## 与 dsh-graph-client 的关系（g-116 合并后）

- 原 `dsh-graph-client` 包已并入本包（0.3.2 两包作废，0.4.0 起单包发布）；
- 看板 UI 层（浏览器）即本包 `lib/client.js`，消费本包 `/api/dsh-graph` 端点；
- core（`core/` 目录，由 `scripts/sync-core.sh` 同步）为唯一事实来源。

## 开发

```sh
bash scripts/sync-core.sh   # 修改 core 后同步进包
node --test core/tests/*.test.ts
```

## License

MIT
