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
> **宿主兼容声明**：`engines.dsh` 声明 DSH 兼容范围 `>=0.1.5-rc.2 <0.1.8-0`（与 `@deepseek-ai/dsh-settings` peer `^0.1.5-rc.2` 取交集后自洽；上界 `-0` 表示排除 `0.1.8` 的**一切预发布与正式版**——下代宿主须重新验证后再放宽），供 dsh-market 等宿主感知型市场在卡片展示与安装/更新预检中读取（市场读到的是 registry 上**已发布**版本的清单且有缓存 ⇒ 本声明自**包含它的版本发布后**才生效）；市场的判定是 `engines.dsh` 与各 peer 范围的**合取**，且发现阶段**不读** `peerDependenciesMeta.optional`。
>
> ### 🚀 v0.16.0 新功能
>
> - **适配 DeepSeek Harness `0.1.7` 宿主 settings 服务换代**：旧 `settings.register(namespace, schema)` API 已移除（实测告警 `sctx.settings.register is not a function`）。插件改为**能力探测分流**——服务提供 `register` 走旧 namespace 注册，否则回落 `describe` 表单投影（profile 条目 `Config`）；两条路径均在隔离实例上双宿主实机验证，且**零版本号比较**。
> - **适配 `0.1.7` 子代理目录换代（两层）**：容器由 `subagentsByParent` 改为 `projectionsBySession[sid].values.subagentCatalog`，**entry 形状同时去掉 `kind`**（新形状 `{id, createdAt, mode, label?}`，新增 `mode:'unknown'`）。目录谓词改为形状探测（有 `kind` 走旧判定、无 `kind` 按 `id`），避免点「↗ 转到对话」**静默**打开父会话。
> - （以下为此前版本的累积亮点）**适配 `0.1.6` 宿主 API 变更**：会话导航/focus 职责从 `sessions` 服务迁移到 `uiWorkspace`，统一走 `openSessionTarget`；子代理聚焦、点击「转到对话」、「交给产品经理」与用户反馈派发链路在新宿主下全部恢复可用。
> - **看板实时会话区在 `0.1.6` 下恢复显示**：按新宿主的 retain 生命周期先保留（retain）会话引用再借取 binding，不再出现「⚠️ 会话未接入（不在会话列表）」与「模型目录不可用」，真实 tokens / ctx / 模型可正常渲染；`0.1.5` 无 retain 时自动回退被动 binding，双向兼容。
> - **批量接受的主管通知在 `0.1.6` 下恢复**：通知派发改为能力探测分流，单卡接受与批量接受同形路径一并修复。
> - **并发槽位耗尽给出可操作提示**：`0.1.6` 引入子代理激活上限（默认 8 个活跃 continuable 子代理），容量耗尽或冷恢复被拒时不再只透出英文错误码。
> - **看板刷新按钮重置自动刷新倒计时**：点击刷新后倒计时立即回到完整周期，不再沿旧终点继续递减。
> - **「定义/润色」复制模板改写为自述式主管指令**：标题标明由主管处理，明确接收者角色、下一步动作与本次边界（仅处理定义/润色，不执行代码、不推进状态或版本）。
>
> **DSH 版本兼容性**：**声明的宿主兼容范围**（自 v0.16.1 起，`engines.dsh`）：`>=0.1.5-rc.2 <0.1.8-0`；**实测通过的宿主**：`0.1.6-alpha.2` ~ `0.1.7-rc.2`（`0.1.7-rc.2` 于 2026-09-25 用 v0.16.0 发布物 tarball 复验：T1–T5 全绿 **10/0/0**；逐包比对确认子代理目录层零代码变化、`llm` 服务三个方法签名逐字未变）。**本周期（g-351）实测的双宿主对照**：`0.1.7-rc.1` 上验证宿主 settings 服务换代后的**能力探测分流**——新 API 存在则走「profile 条目 Config → 设置表单」，实测 `sctx.settings.register is not a function` 降级告警消失、profile 全局默认（如 `subagentMode`）经 profile patch 真正生效（`mode_source=global`），`graph_*` 工具计数仍为 44、`/api/dsh-graph*` 端点注册齐全；`0.1.6-alpha.2` 上重跑旧路径，确认 namespace 注册（`$DSH_HOME/settings.yaml`）与 profile 全局默认照常生效，**零退化**。更早的 `0.1.2-alpha.x` ~ `0.1.4` 系列按工具与提示词契约向后兼容，但**未在本周期复跑**，且**自 v0.16.1 起不在声明范围内**（市场安装预检会保守挡住）。
>
> **平台范围**：**Linux（WSL2）、原生 Windows、macOS**（三平台使用同一安装包；**macOS 最近一次真机复验为 `v0.11.0`**，自 `v0.11.0` 以来 `core/platform.ts` 与文件锁相关代码零改动）。**本版本 `v0.16.0` 已在 Linux（WSL2）上实测**；**Windows 真机门禁（T1–T5）由负责人在本次发布前于原生 Windows 执行，结论见 `docs/release-checklist-v0.16.0.md` §3**——**本次不预先声明 PASS**；若发布时未执行该门禁，则以「**Windows 未验证**」如实标注（发布门禁红线 1）。真机门禁执行件为仓库内 `scripts/win-smoke-test.mjs`（`node win-smoke-test.mjs --tarball dsh-graph-0.16.0.tgz`）。
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

### 侧边栏用法

右侧栏的「**看板**」与会话页的「**看板**」页签是**同一份实现**——同一个看板组件、同一套头部与窄档逻辑，**两侧完全一致**（零 host 门控），任选其一即可。

- **入口**：在会话里打开右侧栏 → 点「看板」磁贴；打开的看板面板会成为右侧栏顶部的一个页签常驻，随时切回。
- **`⋯ 工具`**：刷新 / 标签筛选 / 记忆 / 项目知识库（共享条目）/ 看板设置 / 已归档。工具条按**头部实测宽度装不下**自动折叠为这一项（不是写死的窗口断点）。
- **`[🏷️]` 版本管理**：角落的方形图标按钮（可访问名称为「🏷️ 版本管理」），点开版本管理抽屉；紧邻其右是**同一行等高**的 `创建版本`。
- **版本选择器**：位于泳道行 `[+]`（新建目标）**左侧**，切换当前显示的泳道（具体版本 / Backlog / 独立目标）。
- **窄档行为**（分档依据是**看板根容器实测宽度**——即看板组件自身元素的 `clientWidth`，**不是窗口宽度、也不是浏览器视口宽度**）：
  - **`≥ 480px`（宽档）**：多泳道横向并排，各版本 / Backlog / 独立目标可同时查看；
  - **`< 480px`（单泳道档）**：阶段列由横向并排改为**纵向堆叠**，泳道内容由版本选择器决定（**具体版本 / Backlog / 独立目标三选一**；**工作区一个版本都没有时，默认落点就是「独立目标」**，选择器当前项显示「独立目标」）；该档**没有版本折叠开关**（收起来等于空板），并同时**把工具条强制折叠为「⋯ 工具」**、**隐藏 DEBUG 行**。
  - **怎么把看板放进 `< 480px`**：宿主页签的宽度由**页签布局模式**决定，不是拖出来的——实测（1600px 视口）单页签 **719px**、页签上的 `分栏` 之后每页签 **359px**（该档随窗口宽度变化）、`全屏` **799px**。所以**默认单页签宽度（719px）落在宽档**，此时不会出现单泳道；需要单泳道档时用页签上的 **`分栏`**，或把窗口收窄到看板面板实测宽度 <480px。
  - **宽档残留（实测）**：宽档网格的最小宽度实测约 **956px**，所以看板面板实测宽度在这之下时（例如默认单页签 **719px**），宽档网格**仍会横向滚动**、把「确认 / 批量接受」列推到可视区外；真正消除横向滚动的是单泳道档（<480px）。
  - **版本选择器只在单泳道档渲染**：宽档下整个看板**没有**版本选择器（该元素不渲染）。因此宽档里能看到的「全部版本」只可能来自**打开的下拉选项列表**，而不是当前选中项。

效果截图见仓库 [`screenshot/sidebar-kanban.png`](https://github.com/miuzel/dsh-graph/blob/main/screenshot/sidebar-kanban.png)（虚构演示数据 nebula-notes，右侧栏宽度落在 `< 480px` 单泳道档）；本 npm 包不包含仓库的 `screenshot/` 目录，故此处只给出仓库路径。

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
> **Host compatibility declaration**: `engines.dsh` declares the DSH range `>=0.1.5-rc.2 <0.1.8-0` (self-consistent with the `@deepseek-ai/dsh-settings` peer `^0.1.5-rc.2`; the `-0` upper bound excludes **every** `0.1.8` prerelease and final release — the next host generation must be re-verified before the range is re-opened). Host-aware markets such as dsh-market read it for card display and install/update pre-flight (**markets read the manifest of the *published* version, with caching — so this declaration takes effect once the version carrying it is published**); the market's verdict is a **conjunction** of `engines.dsh` and each peer range, and discovery does **not** honor `peerDependenciesMeta.optional`.
>
> ### 🚀 What's new in v0.16.0
>
> - **Adapted to the DeepSeek Harness `0.1.7` settings-service generation change**: the old `settings.register(namespace, schema)` API is gone (observed warning: `sctx.settings.register is not a function`). The plugin now **probes capabilities**: if the service exposes `register` it uses the legacy namespace registration, otherwise it falls back to the `describe` form projection (profile entry `Config`); both paths were verified on a live, isolated instance against both hosts, with **zero version-literal comparison**.
> - **Adapted to the `0.1.7` subagent-catalog generation change (both layers)**: the container moved from `subagentsByParent` to `projectionsBySession[sid].values.subagentCatalog`, and the **entry shape lost `kind`** (now `{id, createdAt, mode, label?}`, with a new `mode:'unknown'`). Catalog predicates now probe the shape (entries that carry `kind` use the old rule, entries without it match by `id`), so "↗ go to conversation" can no longer **silently** open the parent session.
> - (Cumulative highlights from earlier releases) **Adapted to DeepSeek Harness `0.1.6` host API changes**: session navigation/focus moved from the `sessions` service to `uiWorkspace`, now unified through `openSessionTarget`; subagent focus, "go to conversation", and the "hand off to PM" / user-feedback delivery paths are all functional again on the new host.
> - **Live session strip restored under `0.1.6`**: session references are now retained through the new host's retain lifecycle before borrowing a binding, so "⚠️ session not attached (not in session list)" and "model catalog unavailable" no longer appear and real tokens / ctx / model render correctly; on `0.1.5`, which has no retain, it automatically falls back to passive binding — compatibility is bidirectional.
> - **Supervisor notification on batch accept restored under `0.1.6`**: notification dispatch is routed by capability detection, fixing the single-card and batch-accept paths that shared the same shape.
> - **Actionable hints when concurrency slots are exhausted**: `0.1.6` introduced a subagent activation cap (8 active continuable subagents by default); when capacity is exhausted or cold resume is refused, a bare English error code is no longer the only feedback.
> - **Board refresh button resets the auto-refresh countdown**: clicking refresh immediately restarts the full interval instead of continuing toward the old deadline.
> - **"Define/Polish" clipboard template rewritten as a self-describing supervisor instruction**: the title states it is for the supervisor and makes the recipient role, next action, and scope explicit (handles definition/polish only — no code execution, no status or version change).
>
> **DSH version compatibility**: **Declared host range** (from v0.16.1, `engines.dsh`): `>=0.1.5-rc.2 <0.1.8-0`; hosts verified in this cycle: `0.1.6-alpha.2` through `0.1.7-rc.2` (`0.1.7-rc.2` re-verified on 2026-09-25 with the v0.16.0 release tarball: T1–T5 all green, **10/0/0**; a per-package diff confirmed the subagent-catalog layer has zero code changes and the `llm` service's `listProviders`/`listModels`/`resolveModelInfo` signatures are byte-identical). **Bidirectional host comparison measured in this cycle (g-351)**: on `0.1.7-rc.1` the plugin now routes by **capability detection** across the host's reworked settings service — when the new API is present it uses the profile-entry `Config` → settings-form projection; the `sctx.settings.register is not a function` degradation warning is gone, profile-level defaults (e.g. `subagentMode`) set through the profile patch take effect (`mode_source=global`), the `graph_*` tool count stays at 44, and all `/api/dsh-graph*` routes register. On `0.1.6-alpha.2` the legacy path was re-run: namespace registration (`$DSH_HOME/settings.yaml`) and profile-level defaults still work, with **no regression**. The earlier `0.1.2-alpha.x` ~ `0.1.4` series remains backward compatible by tool and prompt contract, but was **not re-run in this cycle** and is **no longer inside the declared range from v0.16.1 on** (market install pre-flight blocks it conservatively).
>
> **Platform scope**: **Linux (WSL2), native Windows, and macOS** (all three using the same package; **macOS was last verified on-device at `v0.11.0`**, and `core/platform.ts` plus the file-locking code are unchanged since `v0.11.0`). **This release, `v0.16.0`, has been verified on Linux (WSL2)**; **its Windows on-device gate (T1–T5) is executed by the owner on native Windows before this release, with the verdict recorded in `docs/release-checklist-v0.16.0.md` §3** — **no PASS is claimed in advance**; if that gate is not run before release, the release must be labeled "**Windows not verified**" (release gate red line 1). The on-device gate executor is `scripts/win-smoke-test.mjs` in the repository (`node win-smoke-test.mjs --tarball dsh-graph-0.16.0.tgz`).
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

### Sidebar Usage

The sidebar's "**Kanban**" tile and the conversation page's "**Kanban**" tab are **the same implementation** — the same board component and the same header / narrow-width logic, **fully identical on both sides** (zero host gating). Either entry point works.

- **Entry**: open the right sidebar in a session → click the "Kanban" tile; the opened board then stays as a persistent tab at the top of the sidebar, one click away.
- **`⋯ Tools`**: Refresh / Tag filter / Memory / Project Knowledge Base (shared entries) / Board settings / Archived. The toolbar collapses into this single item automatically when it **does not fit the measured header width** (not a hard-coded viewport breakpoint).
- **`[🏷️]` Version Management**: the square icon button in the corner (accessible name "🏷️ Version Management") opens the version-management drawer; immediately to its right sits `Create Version`, **same row and equal height**.
- **Version selector**: sits **to the left of** the lane-row `[+]` (new goal) and switches the lane currently shown (a specific version / Backlog / Standalone).
- **Narrow-width behaviour** (tiered by the **measured width of the board's root container** — the board element's own `clientWidth`, **not the window width and not the browser viewport width**):
  - **`≥ 480px` (wide tier)**: multiple swimlanes side by side, so versions / Backlog / Standalone are all visible at once;
  - **`< 480px` (single-lane tier)**: stage columns switch from side-by-side to **vertically stacked**, and the lane shown is chosen by the version selector (**exactly one of a specific version / Backlog / Standalone**; **when the workspace has no versions at all, the default landing lane is "Standalone"**, and the selector's current item reads "Standalone"); this tier has **no per-lane collapse toggle** (collapsing would leave an empty board), and it also **forces the toolbar into `⋯ Tools`** and **hides the DEBUG line**.
  - **How to get the board into `< 480px`**: the host tab's width comes from the **tab layout mode**, not from dragging — measured at a 1600px viewport: single tab **719px**, **359px** per tab after the tab's `Split` mode (this mode scales with the window width), **799px** in `Fullscreen`. So the **default single-tab width (719px) lands in the wide tier** and no single lane appears; use the tab's **`Split`** mode, or narrow the window until the board panel measures <480px. Once there, it is obvious: the six stage blocks are **stacked vertically** and the version selector appears next to the lane title.
  - **Residual in the wide tier (measured)**: the wide-tier grid's minimum width is about **956px**, so whenever the board panel measures less than that (e.g. the default single tab at **719px**) the wide grid **still scrolls horizontally** and pushes the confirm / bulk-accept column out of view; the tier that actually removes horizontal scrolling is the single-lane one (<480px).
  - **The version selector is rendered only in the single-lane tier**: in the wide tier the board has **no** version selector at all. So an "All versions" string seen in the wide tier can only come from an **opened dropdown option list**, never from the current selection; and in the single-lane tier, before any explicit view choice, the current item is "Standalone" — **not** "All versions".

See [`screenshot/sidebar-kanban.png`](https://github.com/miuzel/dsh-graph/blob/main/screenshot/sidebar-kanban.png) in the repository for a screenshot (fictional demo data nebula-notes, sidebar width in the `< 480px` single-lane tier); this npm package does not ship the repository's `screenshot/` directory, so only the repository path is given here.

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
