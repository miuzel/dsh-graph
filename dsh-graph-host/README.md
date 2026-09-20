# dsh-graph

[中文](#中文) | [English](#english)

---

## 中文

### 概述

**dsh-graph** 是面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的目标看板插件。它将大模型智能体（Agent）的工作流组织为基于图的目标管理（Graph-based Goal Management）。

本插件采用**一体化单包分发**（npm 包名 `dsh-graph`），同时集成两大核心能力：
- **Host 端**：向 DSH Agent 提供覆盖目标全生命周期的 `graph_*` 工具集，并暴露 `/api/dsh-graph*` REST API（支持看板投影、目标详情查询与写操作）；
- **Client 端**：无缝内嵌于 DSH Web 控制台（`conversation.view` 槽位）的浏览器二维泳道看板（`lib/client.js`），提供直观的可视化交互与实时追踪。

数据以本地纯文本与事件流形式存储于工作区的 `.dsh-graph/` 目录，Git 友好、天然支持协同对账与审计追踪。

---

### 安装方式

在 DSH 环境中运行以下命令即可安装：

```sh
dsh plugin --profile <profile-name> add dsh-graph
```

> **环境要求**：Node.js ≥ 22（包内预编译 core 运行时）。
>
> **依赖说明**：宿主提供的核心包（`@deepseek-ai/cordis` ^4.0.2、`@deepseek-ai/schemastery` ^3.18.2、`@deepseek-ai/dsh-settings` ^0.1.5-rc.2）以 `peerDependencies` + `peerDependenciesMeta.optional`（DSH 生态惯例）声明，由 DSH 宿主环境提供，安装不产生 peer 告警；`yaml` 为插件自带运行依赖（声明在 `dependencies` 中），避免产生重复的核心包实例。
>
> ### 🚀 v0.12.0 新功能
>
> - **配置管理工具补齐**：新增 `graph_get_settings` 与 `graph_update_settings` 工具，支持结构化查询、更新当前 workspace 的 `project.yaml`（含模式与 automation 配置），带合法枚举/schema 提示与事件审计，告别手工翻查与编辑源码。
> - **构建流水线与 release 目录隔离**：构建产物统一输出至独立的 `dist/` 目录并自包含打包，Git 源码树彻底清除生成的重复副本（纯源码管理）。
> - **产品经理回报机制修复**：PM 润色建议强制以 `【g-XXX 润色建议】` 为标题，主管自动精准识别目标并闭环更新，避免遗漏。
> - **解耦环境事实与 HANDOFF 优化**：移除写死的项目特有环境事实，改为按需从工作区常驻记忆提取；长期记忆文件分节展示，接管时默认召回高优先级记忆，消除语义矛盾。
> - **提示词生产级清洗**：全面地毯式清除 36 处可见界面的开发过程标记，提升提示词专业度与模型理解力。
> - **帮助工具全面对齐**：`graph_help` 完整补齐全部 44 个工具的分类速查，修正 `graph_amend_goal` 的 `append` 参数签名。
>
> **DSH 版本兼容性**：本版本（v0.12.0）**支持 DeepSeek Harness `0.1.2-rc.1` ~ `0.1.5-rc.2`**（包含已完整验证的 `v0.1.5-rc.2`）；**暂不支持 `0.1.6-alpha.2`**（因宿主依赖构建审批拦截机制调整）。
>
> **平台范围**：**Linux（WSL2）、原生 Windows、macOS 均已验证。**
>
> **已知限制**：macOS 上若工作区路径**经显式传入且含符号链接**（如位于 `/tmp`、`/var` 之下），会被拒绝并报 `graph root symlink is not allowed`；由 `process.cwd()` 推导的路径不受影响。
>
> 已发布版本支持通过 npm 与 dsh-market 生态分发。

---

### 核心特性

- **四阶段生命周期状态机**：
  引擎严格约束状态迁移：`draft → planning → collecting → ready → in_progress → review → delivered`（任何阶段均可标记进入 `blocked` 阻塞状态）。
- **判据先于执行（Criteria Before Execution）**：
  在目标派发执行前必须登记明确的质量验收判据，最终评审严格依照逐条判据核验交付物，杜绝模糊交付。
- **结构化上下文卡片**：
  支持文本（Text）、文件（File）、图片（Image）、数据（Data）等多种上下文类型。经历 `empty → collecting → filled → reviewed` 闭环生命周期，为执行子代理提供精确的上下文种子。
- **二维泳道看板**：
  横向按生命周期阶段划分列，纵向按排期划分版本（Version）、暂存池（Backlog）与独立目标（Standalone）泳道；支持拖拽排期。
- **流畅跨会话交接（Handoff & Supervisor Claim）**：
  支持生成包含看板投影、长期记忆与关键环境事实的 `HANDOFF.md`，换会话后新 Supervisor 可幂等认领上下文并快速接管。
- **现代交互与双主题适配**：
  完整适配深色与浅色双套主题（自动跟随 DSH 全局主题变量）；外部数据更新时支持微光动画提醒（支持系统的 `prefers-reduced-motion` 无障碍降级）；弹窗拖拽防误关。

---

### Agent 工具速查表

dsh-graph 为 Agent 提供了完善的工具链，按功能划分为以下分类：

| 分类 | 工具名称 | 核心说明 |
|------|----------|----------|
| **目标生命周期** | `graph_create_goal` | 创建目标（默认放入 Backlog，可指定版本） |
| | `graph_rename_goal` | 重命名目标标题 |
| | `graph_set_description` | 设置/更新目标描述正文（Markdown） |
| | `graph_set_directive` | 为下一次 Attempt 注入补充指令与边界要求 |
| | `graph_set_goal_type` | 设置目标类型（feature / bug / task / improvement / patch / chore） |
| | `graph_set_goal_tags` | 设置目标标签列表（最多 20 个，乐观并发） |
| | `graph_amend_goal` | 记录对目标的修订补充，可自动同步至描述 |
| | `graph_transition` | 推进目标状态机迁移（进入 blocked 需附原因） |
| | `graph_postpone_goal` | 暂缓目标，移回 Backlog 并置为 draft |
| | `graph_archive_goal` | 归档已完成或已废弃的目标 |
| | `graph_unarchive_goal` | 从归档中恢复目标 |
| | `graph_delete_goal` | 安全删除已归档的目标 |
| | `graph_clean_worktree` | 清理已验证的 worktree（用户确认后执行） |
| | `graph_list_worktrees` | 查询 Git worktree 清理候选（只读，不自动删除） |
| **质量判据** | `graph_set_criteria` | 登记目标验收判据（严格在执行前设定） |
| **上下文卡片** | `graph_add_card` | 创建上下文卡片占位（text / file / image / data） |
| | `graph_bind_collect_card` | 绑定收集子代理，卡片状态转为 collecting |
| | `graph_fill_card` | 填充卡片内容并生成看板简要摘要 |
| | `graph_review_card` | 复核卡片内容（filled → reviewed） |
| | `graph_delete_card` | 删除未在收集中的卡片 |
| | `graph_convert_card_to_shared` | 将自有卡转换为共享卡（放入共享池） |
| | `graph_convert_card_to_owned` | 将共享卡收回为自有卡（独占） |
| **附件管理** | `graph_store_attachment` | 存储文件附件到目标 |
| | `graph_delete_attachment` | 删除目标附件 |
| **排期管理** | `graph_move_goal` | 在 Backlog、独立目标与版本之间移动排期 |
| **执行与返工** | `graph_start_attempt` | 派发执行 Attempt，启动并绑定可续轮子代理 |
| | `graph_record_attempt_handoff`| 记录前序 Attempt 的返工约束与排查基线 |
| | `graph_unbind_goal_child` | 安全解绑目标执行子代理 |
| | `graph_abandon_attempt` | 放弃陈旧或失联的 Attempt |
| **配置管理** | `graph_get_settings` | 查询当前 workspace 项目配置及合法枚举元信息 |
| | `graph_update_settings` | 结构化更新当前 workspace 项目配置（支持 patch） |
| **记忆管理** | `graph_memory_add` | 写入按需/常驻记忆条目 |
| | `graph_memory_recall` | 按关键词检索记忆 |
| | `graph_memory_remove` | 删除指定记忆条目 |
| | `graph_memory_replace` | 替换已有记忆条目内容 |
| **状态汇报** | `graph_report_status` | 汇报当前 Attempt 进度（看板卡片实时显示） |
| | `graph_report_supervisor_status` | Supervisor 汇报全局工作状态（顶部状态栏动画） |
| **评审裁决** | `graph_resolve_accept` | 裁决交付验收（verdict: accept / object） |
| **协作与交接** | `graph_add_comment` | 向目标追加可追溯的讨论与反馈历史 |
| | `graph_handoff` | 生成跨会话交接文档 `HANDOFF.md` |
| | `graph_claim_supervisor` | 新会话接管 Supervisor 并更新会话元数据 |
| | `graph_help` | 输出插件功能说明与 44 个工具速查清单 |
| **数据与校验** | `graph_validate` | 执行全量不变式检查（状态、依赖环、卡片引用） |
| | `graph_rebuild` | 从事件流完全重建目标状态并与元数据对账 |

---

### 浏览器看板说明

内嵌于 DSH Web 界面：
- **二维泳道布局**：清晰展现多个版本的推进节奏，支持灵活查看不同泳道和阶段；
- **实时流式更新**：卡片与顶部状态栏直观反映 Agent 汇报的最新执行状态；外部文件变更触发动画闪烁；
- **丰富弹窗与抽屉交互**：点击卡片可展开目标详情弹窗，查看质量判据、上下文卡片与 Attempt 历史。

---

### 数据存储说明

插件数据保存在当前工作区下的 `.dsh-graph/` 目录：
- **自动初始化**：首次在工作区运行工具时自动生成数据骨架，不包含多余 Demo 数据；
- **Git 友好**：所有数据由纯文本 YAML/Markdown 与只追加（append-only）的 `events.jsonl` 组成；
- **事件流对账**：`events.jsonl` 记录每一次状态流转与操作，是唯一事实来源，可通过 `graph_rebuild` 随时对账；
- **多 Worktree 适配**：Git Linked Worktrees 自动解析归一到主工作树的同一 `.dsh-graph/` 根目录。

---

## English

### Overview

**dsh-graph** is a goal-oriented kanban plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness), bringing Graph-based Goal Management into Agent workflows.

Distributed as a **single unified package** (npm package name: `dsh-graph`), it provides both halves out-of-the-box:
- **Host Side**: Exposes a full suite of `graph_*` tools to DSH Agents covering the entire goal lifecycle, along with `/api/dsh-graph*` REST endpoints for board projections, goal details, and mutations;
- **Client Side**: A browser 2D swimlane kanban board (`lib/client.js`) integrated into DSH Web (`conversation.view` slot) for intuitive visualization and real-time tracking.

All data is stored locally as human-readable files and an append-only event log under `.dsh-graph/`, making it Git-friendly, easily auditable, and collaborative.

---

### Installation

Install the plugin using the DSH CLI:

```sh
dsh plugin --profile <profile-name> add dsh-graph
```

> **Requirements**: Node.js ≥ 22 (includes precompiled core runtime).
>
> **Dependency Note**: Core packages provided by the DSH host (`@deepseek-ai/cordis` ^4.0.2, `@deepseek-ai/schemastery` ^3.18.2, `@deepseek-ai/dsh-settings` ^0.1.5-rc.2) are declared under `peerDependencies` with `peerDependenciesMeta.optional` (standard DSH ecosystem convention), provided directly by the host runtime without peer dependency warnings during installation; `yaml` is retained in `dependencies` as a plugin-specific runtime dependency, preventing duplicate core package instances.
>
> ### 🚀 What's new in v0.12.0
>
> - **Settings Management Tools**: Added `graph_get_settings` and `graph_update_settings` tools for structured querying and updating of workspace `project.yaml` (including modes and automation configurations), with valid enum hints and event logging.
> - **Build Pipeline & Release Directory Isolation**: All build artifacts are unified and isolated into the `dist/` directory; the git source tree is clean of compiled duplicates.
> - **PM Report Format & Goal Association**: PM refining suggestions now require a title with `【g-XXX 润色建议】`, allowing supervisors to automatically recognize and update target goals.
> - **Decoupled Environment Facts & Refined HANDOFF**: Hardcoded internal facts removed from HANDOFF, now driven by workspace standing memory; long-term memory files displayed under their own subheadings, with default high-priority recall.
> - **Production-Grade Prompt Cleanup**: Thoroughly cleaned 36 instances of development tags across user-visible prompts, enhancing prompt clarity.
> - **Help Assets Fully Aligned**: `graph_help` updated with the complete catalog of all 44 tools and corrected signatures (including `append` for `graph_amend_goal`).
>
> **DSH version compatibility**: This release (v0.12.0) **supports DeepSeek Harness `0.1.2-rc.1` through `0.1.5-rc.2`** (including verified `v0.1.5-rc.2`); **`0.1.6-alpha.2` is temporarily unsupported** due to changes in host build approval script mechanisms.
>
> **Platform scope**: **verified on Linux (WSL2), native Windows, and macOS.**
>
> **Known limitation**: on macOS a workspace path that is **explicitly supplied and contains a symlink** (e.g. under `/tmp` or `/var`) is rejected with `graph root symlink is not allowed`. Paths derived from `process.cwd()` are unaffected.
>
> Official releases are distributed via npm and the dsh-market ecosystem.

---

### Key Features

- **Four-Phase Lifecycle State Machine**:
  Enforced by the core engine: `draft → planning → collecting → ready → in_progress → review → delivered` (with a `blocked` escape hatch available at any stage).
- **Criteria Before Execution**:
  Acceptance criteria must be explicitly defined prior to execution. Deliverables in the review phase are verified strictly against individual criteria, preventing ambiguous delivery.
- **Context Cards**:
  Supports Text, File, Image, and Data cards. Follows a structured lifecycle (`empty → collecting → filled → reviewed`) to seed precise task context for execution subagents.
- **2D Swimlane Board**:
  Columns represent lifecycle stages, while horizontal swimlanes organize goals by Version, Backlog, and Standalone categories, complete with drag-and-drop scheduling.
- **Seamless Session Handoff**:
  Generate `HANDOFF.md` summarizing board projections, long-term memory, and environment facts. A new session can claim the Supervisor role idempotently via `graph_claim_supervisor`.
- **Modern UI & Dual-Theme Support**:
  Full Dark and Light theme adaptation following DSH variables. Subtle pulse animations highlight external updates (with `prefers-reduced-motion` accessibility support); drag-safe modal text selection.

---

### Agent Tools Reference

dsh-graph equips Agents with a comprehensive set of `graph_*` tools:

| Category | Tool | Description |
|----------|------|-------------|
| **Goal Lifecycle** | `graph_create_goal` | Create a goal (defaults to Backlog, optional Version) |
| | `graph_rename_goal` | Rename goal title |
| | `graph_set_description` | Set/update goal description body (Markdown) |
| | `graph_set_directive` | Inject instructions and boundaries for the upcoming attempt |
| | `graph_set_goal_type` | Set goal type (feature / bug / task / improvement / patch / chore) |
| | `graph_set_goal_tags` | Set goal tags (max 20, optimistic concurrency) |
| | `graph_amend_goal` | Record amendments, optionally appending to description |
| | `graph_transition` | Advance goal through lifecycle states (reason required for blocked) |
| | `graph_postpone_goal` | Postpone goal back to Backlog as draft |
| | `graph_archive_goal` | Archive completed or obsolete goals |
| | `graph_unarchive_goal` | Restore goals from archive |
| | `graph_delete_goal` | Safely delete an archived goal |
| | `graph_clean_worktree` | Clean up a verified worktree (requires user confirmation) |
| | `graph_list_worktrees` | Query Git worktree cleanup candidates (read-only, no auto-delete) |
| **Quality Criteria** | `graph_set_criteria` | Define quality criteria (required prior to execution) |
| **Context Cards** | `graph_add_card` | Create a context card placeholder (text / file / image / data) |
| | `graph_bind_collect_card` | Bind collection subagent; marks card status as collecting |
| | `graph_fill_card` | Populate card content with a concise board summary |
| | `graph_review_card` | Review card content (filled → reviewed) |
| | `graph_delete_card` | Delete cards not currently collecting |
| | `graph_convert_card_to_shared` | Convert owned card to shared card |
| | `graph_convert_card_to_owned` | Convert shared card back to owned card |
| **Attachments** | `graph_store_attachment` | Store file attachments to a goal |
| | `graph_delete_attachment` | Delete a goal attachment |
| **Scheduling** | `graph_move_goal` | Move goals between Backlog, Standalone, and Versions |
| **Execution & Rework** | `graph_start_attempt` | Dispatch an execution attempt and spawn a continuable subagent |
| | `graph_record_attempt_handoff`| Record rework constraints, failure notes, and baseline |
| | `graph_unbind_goal_child` | Safely detach an execution subagent from a goal |
| | `graph_abandon_attempt` | Abandon a stale or lost attempt |
| **Configuration** | `graph_get_settings` | Query workspace project configuration and enum metadata |
| | `graph_update_settings` | Update workspace project configuration (supports partial patch) |
| **Memory** | `graph_memory_add` | Write on-demand / standing memory entries |
| | `graph_memory_recall` | Recall memory entries by keyword search |
| | `graph_memory_remove` | Remove a specific memory entry |
| | `graph_memory_replace` | Replace an existing memory entry's content |
| **Status Reporting** | `graph_report_status` | Report progress of current attempt (live card display) |
| | `graph_report_supervisor_status` | Report supervisor status (top status bar animation) |
| **Review & Verdict** | `graph_resolve_accept` | Accept or object to delivered attempts |
| **Collaboration** | `graph_add_comment` | Append historical discussion or human feedback |
| | `graph_handoff` | Export cross-session handover document (`HANDOFF.md`) |
| | `graph_claim_supervisor` | Claim supervisor role in new session & update metadata |
| | `graph_help` | Display usage instructions and 44-tool checklist |
| **Validation** | `graph_validate` | Validate full invariants (states, cycles, card refs) |
| | `graph_rebuild` | Rebuild goal state from `events.jsonl` and reconcile |
| | `graph_handoff` | Export cross-session handover document (`HANDOFF.md`) |
| | `graph_claim_supervisor` | Claim supervisor role in new session & update metadata |
| | `graph_help` | Display usage instructions and claim guide |
| **Validation** | `graph_validate` | Validate full invariants (states, cycles, card refs) |
| | `graph_rebuild` | Rebuild goal state from `events.jsonl` and reconcile |

---

### Browser Kanban UI

Embedded directly within the DSH Web console:
- **2D Swimlane Layout**: View the progress of multiple versions and categories simultaneously;
- **Live Streaming Updates**: Cards and the top status bar stream real-time execution updates; external file edits trigger visual highlights;
- **Interactive Modals & Drawers**: Click cards to inspect quality criteria, context cards, attempt histories, and detailed instructions.

---

### Data Storage

All data resides in `.dsh-graph/` within your workspace:
- **Zero-Config Auto-Init**: Generates directory structure automatically upon first tool call without dummy demo data;
- **Git Friendly**: Managed as plain YAML/Markdown files and an append-only `events.jsonl` event log;
- **Auditability**: `events.jsonl` serves as the authoritative single source of truth, reconcilable at any time via `graph_rebuild`;
- **Multi-Worktree Support**: Git Linked Worktrees automatically resolve to the canonical graph root in the primary worktree.

---

## License

[MIT](LICENSE)
