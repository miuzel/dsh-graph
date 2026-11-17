---
name: dsh-graph
description: 通过 MCP 连接本地 dsh-graph 服务读写目标看板（默认只读 11 个工具；服务端 --allow-write 后 38 个）。人工裁决（accept/delivered/派发）在外部宿主不可达，需回 DSH 看板或本地 GUI。
---

# dsh-graph（外部宿主版）

本技能供 **Claude Code / Codex / OpenCode** 这类外部宿主使用。它与 DSH 插件内置的技能正文**不是同一份**：
DSH 插件版能调用完整工具集，外部宿主只能看见 MCP 服务实际注册的工具。请以本文为准，不要套用 DSH 版做法。

## 1. 先确认服务能力状态

调用 `graph_board` 或 `graph_list_goals` 试探：

- 成功返回数据 ⇒ 服务在跑、token 有效。
- 返回 `E_UNKNOWN_COMMAND` ⇒ 该工具**未注册**（可能是写模式没开，或碰了人工裁决保留项）。
- 返回 `E_NOT_INITIALIZED` ⇒ 看板还没初始化，先到看板所在项目执行 `dsh-graph serve init`。
- HTTP 401 ⇒ token 缺失或错误，见 INSTALL.md 排障。

**服务有两种模式**，工具表不同（模式只能由服务端启动参数决定，客户端无法自行开启）：

| 模式 | 启动方式 | 可见工具数 |
|---|---|---|
| 只读（默认） | `dsh-graph serve` | 11 |
| 写模式 | `dsh-graph serve --allow-write` | 38 |

## 2. 只读模式（默认）可用的 11 个工具

| 工具 | 必填参数 | 用途 |
|---|---|---|
| `graph_board` | — | 看板派生投影（版本/独立/backlog + 主管状态 + 共享卡摘要） |
| `graph_list_goals` | — | 列出目标（`includeArchived` 含归档） |
| `graph_list_versions` | — | 列出版本 |
| `graph_query_goal` | `goal` | 单个目标的描述/判据/状态/卡片/结果摘要 |
| `graph_query_criteria` | `goal` | 目标判据条目与是否已验 |
| `graph_list_cards` | `goal` | 目标的上下文卡片 |
| `graph_query_results` | `goal` | 目标完成摘要投影 |
| `graph_settings` | — | 脱敏项目设置 |
| `graph_list_attachments` | — | 附件安全引用名（不含绝对路径） |
| `graph_read_attachment` | `name` | 按引用名读附件（base64） |
| `graph_events` | `goal` | 只读事件信封（可加 `limit`） |

只读模式下**不要尝试**任何写操作——`graph_create_goal` 等名字此时根本不存在，调用只会得到 `E_UNKNOWN_COMMAND`。

## 3. 写模式（`--allow-write`）额外可用的 27 个工具

开启后额外可用：

**目标生命周期**：`graph_create_goal`（`title`）、`graph_rename_goal`、`graph_set_description`、
`graph_set_criteria`、`graph_update_criteria`、`graph_set_directive`、`graph_set_goal_tags`、
`graph_set_goal_type`、`graph_set_goal_budget`、`graph_move_goal`、`graph_archive_goal`、`graph_delete_goal`。

**阶段迁移**：`graph_transition`（`goal` + `to`）—— 只接受 `draft / planning / collecting / ready /
in_progress / review / blocked`。**`delivered` 会被拒（`E_FORBIDDEN`）**，那需要人在 DSH 看板裁决。

**协作记录**：`graph_add_comment` / `graph_append_comment`、`graph_add_card`、`graph_fill_card`、
`graph_delete_card`、`graph_add_relation`、`graph_remove_relation`、`graph_store_attachment`、
`graph_report_supervisor_status`。

**记忆与配置**：`graph_memory_add`、`graph_memory_remove`、`graph_update_settings`、
`graph_set_memory_tools_enabled`。

**attempt 清理**：`graph_abandon_attempt`（标记陈旧 attempt 为已放弃，**不启动**执行体；仍受 core 角色校验）。

所有写操作的 actor 固定为 `mcp:local-service`，事件流里能区分出「这是外部宿主经 MCP 写的」。

### 写模式开启方式（客户端做不到）

写模式**只能由服务端启动时决定**。请求里传 `allowWrite` / `writeMode` / `mode` 不会生效，还会被当保留参数
拒绝。要开启请让服务以 `dsh-graph serve --allow-write` 重启。若你没有服务端的操作权限，就按只读模式工作。

## 4. 外部宿主**做不到**的事（人工裁决保留项）

以下操作在任何模式下都不可达，**不要尝试，也不要向用户承诺**：

| 不可用操作 | 原因 | 替代做法 |
|---|---|---|
| `graph_resolve_accept` | 接受/异议必须人在本地 GUI 裁决 | 请用户在 DSH 看板或本地 GUI 点击裁决 |
| `graph_transition` 到 `delivered` | 同上（工具可用，但该目标状态被拒） | 迁到 `review` 后交给人 |
| `graph_claim_supervisor` | 主管身份只能本地人工/宿主会话接管 | 请用户在 DSH 会话中接管 |
| `graph_start_attempt` | 派发会启动真实执行体 | 请用户在 DSH 看板派发；外部宿主只能读产物 |

**口径**：你能把工作推进到 `review`，但**不能自己判定交付完成**。到 `review` 就停下并告诉用户去裁决。

## 5. 推荐工作流（外部宿主）

1. 用 `graph_board` / `graph_list_goals` 了解现状，用 `graph_query_goal` 读目标描述与判据。
2. 需要上下文时用 `graph_list_cards` + `graph_query_results`，附件用 `graph_list_attachments` + `graph_read_attachment`。
3. 有写模式时：先 `graph_set_criteria` 登记判据（判据先于执行），再动手改代码。
4. 过程中用 `graph_add_comment` 留可追溯记录（不要倾倒长日志，只写结论 + 文件路径 + 关键行）。
5. 完成后把目标迁到 `review`（`graph_transition`），写完成摘要，然后**请用户裁决**。

## 6. 错误码速查

服务错误码共 7 个（`core/service/queries.ts` 的 `ServiceErrorCode`），全部是可预期拒绝，响应体只带 code + message：

| 错误码 | 含义 | 处理 |
|---|---|---|
| `E_UNKNOWN_COMMAND` | 工具未注册（模式不对 / 人工裁决保留项） | 确认服务模式；人工裁决走 GUI |
| `E_FORBIDDEN` | 已注册但该参数/目标被拒（如 `to=delivered`） | 改到允许范围 |
| `E_INPUT` | 参数不合法 | 按提示修正参数 |
| `E_NOT_FOUND` | 目标/卡片/附件不存在 | 先列表确认 id |
| `E_NOT_INITIALIZED` | 看板未初始化 | 在项目里 `dsh-graph serve init` |
| `E_NOT_READ_ONLY` | 只读模式下请求了写路由 | 按只读模式工作，或让服务端开 `--allow-write` |
| `E_STORAGE` | 存储层失败（磁盘/权限/损坏） | 查 `serve status` 与服务日志 |

并发写冲突表现为 `E_INPUT` 提示基线不一致：先重读最新条目，再用 `force` 或新基线重试。
