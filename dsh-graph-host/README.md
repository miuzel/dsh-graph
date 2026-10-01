# dsh-graph

[中文](#中文) | [English](#english)

<p align="center">
  <img src="https://raw.githubusercontent.com/miuzel/dsh-graph/main/docs/banner.webp" alt="dsh-graph —— Agent 工作的目标化管理" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-graph"><img src="https://img.shields.io/npm/v/dsh-graph?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-graph"><img src="https://img.shields.io/npm/dm/dsh-graph?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="https://raw.githubusercontent.com/miuzel/dsh-graph/main/dsh-graph-host/package.json"><img src="https://img.shields.io/node/v/dsh-graph?style=flat-square" alt="node engine"></a>
  <a href="https://awesome-dsh-plugin.com"><img src="https://img.shields.io/badge/awesome--dsh--plugin-listed-2f6feb?style=flat-square" alt="awesome-dsh-plugin listed"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="license MIT"></a>
  <a href="https://raw.githubusercontent.com/miuzel/dsh-graph/main/dsh-graph-host/package.json"><img src="https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.2%20%3C0.2.1--0-2f6feb?style=flat-square" alt="DSH host range"></a>
</p>

---

## 中文

### 概述

**dsh-graph** 是面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的目标看板插件。它将大模型智能体（Agent）的工作流组织为基于图的目标管理（Graph-based Goal Management）。

本插件采用**一体化单包分发**（npm 包名 `dsh-graph`），同时集成两大核心能力：

- **Host 端**：向 DSH Agent 提供覆盖目标全生命周期的 50 个 `graph_*` 工具，并暴露 `/api/dsh-graph*` REST API（支持看板投影、目标详情查询与写操作）；
- **Client 端**：无缝内嵌于 DSH Web 控制台（`conversation.view` 槽位）的浏览器二维泳道看板，提供直观的可视化交互与实时追踪。

数据以本地纯文本与事件流形式存储于工作区的 `.dsh-graph/` 目录，Git 友好、天然支持协同对账与审计追踪。

---

### 安装方式

在 DSH 环境中运行以下命令即可安装：

```sh
dsh plugin --profile <profile-name> add dsh-graph
```

**当前版本**：v0.18.0（本次发布准备产物；`0.18.0-alpha` 为开发线版本串）。**环境要求**：Node.js ≥ 22（包内预编译 core 运行时）。宿主提供的核心包（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings`）以 `peerDependencies` + `peerDependenciesMeta.optional`（DSH 生态惯例）声明，由 DSH 宿主环境提供，安装不产生 peer 告警；`yaml` 为插件自带运行依赖（声明在 `dependencies` 中），避免产生重复的核心包实例。

**宿主兼容范围**：`engines.dsh` 声明 `>=0.1.5-rc.2 <0.2.1-0`（上界 `-0` 排除 `0.2.1` 的一切预发布与正式版），供 dsh-market 等宿主感知型市场在卡片展示与安装/更新预检中读取。**实测通过的宿主**：`0.1.6-alpha.2` ~ `0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`（负责人 2026-09-30 真机复验）。该区间顺带覆盖的 `0.1.8` 系**在 npm 上从未发布**（`0.1.7-rc.2` 之后直接跳版到 `0.2.0-rc.1`），故为空集，不构成未实测声明。

**平台状态**：

| 平台 | 本版状态 |
|------|----------|
| Linux / WSL2 | ✅ 已实测通过（本版全量测试 fail 0） |
| 原生 Windows | ⚠️ **本次未执行真机门禁**（不得读出「已通过」）；本版验证结果见发布核对表（运行中，待回填）。最近一次真机结论见 [v0.17.0 清单](https://github.com/miuzel/dsh-graph/blob/main/docs/release-checklist-v0.17.0.md) §3.1 |
| macOS | ⚠️ **本次未执行真机门禁**（不得读出「已通过」）；本版验证结果见发布核对表（运行中，待回填）。最近一次真机结论见 [v0.16.0 清单](https://github.com/miuzel/dsh-graph/blob/main/docs/release-checklist-v0.16.0.md) |

三平台使用同一安装包。**已知限制**：macOS 上若工作区路径**经显式传入且含符号链接**（如位于 `/tmp`、`/var` 之下），会被拒绝并报 `graph root symlink is not allowed`；由 `process.cwd()` 推导的路径不受影响。

**最新亮点（v0.18.0）**

- **目标间关系标记**：新增「取代 / 调整 / 补充 / 相关」四类关系，关系只记在目标文件（frontmatter）这一处真源；依赖声明与关系严格分离，不再混写在同一个字段里。
- **新增 `graph_set_relation` 工具**：标记 / 解除目标间关系，重复标记同一关系不产生第二条，并拒绝形成互相取代的环。
- **看板与弹窗都能看到关系**：卡片显示关系徽标；目标弹窗在「**目标描述**」正下方直接列出只读关系清单（本目标发出 / 指向本目标，标注跨版本与已归档）。
- **标记对端改为搜索式选择**：输入编号或标题关键字即可定位对端目标，候选复用看板搜索的同一套匹配实现；候选过多时提示继续输入以缩小范围。
- **派发前先写目标描述**：主管派发前收到提醒；目标描述为空（或仅占位符 / 注释）时 `graph_start_attempt` 拒绝派发并提示用 `graph_set_description` 补写后重试，零副作用。

完整变更史见 [CHANGELOG](https://github.com/miuzel/dsh-graph/blob/main/CHANGELOG.md)；逐版本门禁结论见 [v0.18.0 清单](https://github.com/miuzel/dsh-graph/blob/main/docs/release-checklist-v0.18.0.md)，平台门禁运行手册见 [platform-gate.md](https://github.com/miuzel/dsh-graph/blob/main/docs/platform-gate.md)。已发布版本支持通过 npm 与 dsh-market 生态分发。

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
- **目标间关系标记**：
  目标之间可标记「取代 / 调整 / 补充 / 相关」四类关系（也可解除），关系只记在目标文件（frontmatter）这一处真源；看板卡片显示关系徽标，目标弹窗在「目标描述」下方直接列出关系清单（含跨版本与已归档标注）。
- **流畅跨会话交接（Handoff & Supervisor Claim）**：
  支持生成包含看板投影、长期记忆与关键环境事实的 `HANDOFF.md`，换会话后新 Supervisor 可幂等认领上下文并快速接管。
- **现代交互与双主题适配**：
  完整适配深色与浅色双套主题（自动跟随 DSH 全局主题变量）；外部数据更新时支持微光动画提醒（支持系统的 `prefers-reduced-motion` 无障碍降级）；弹窗拖拽防误关。

---

### Agent 工具速查表

dsh-graph 为 Agent 提供了完善的工具链（共 50 个 `graph_*` 工具），按功能划分为以下分类：

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
| **目标关系** | `graph_set_relation` | 标记/解除目标间关系（取代/调整/补充/相关，可增可删；幂等，拒绝替代环） |
| **质量判据** | `graph_set_criteria` | 登记目标验收判据（严格在执行前设定） |
| **上下文卡片** | `graph_add_card` | 创建上下文卡片占位（text / file / image / data） |
| | `graph_bind_collect_card` | 绑定收集子代理，卡片状态转为 collecting |
| | `graph_fill_card` | 填充卡片内容并生成看板简要摘要 |
| | `graph_review_card` | 复核卡片内容（filled → reviewed） |
| | `graph_delete_card` | 删除未在收集中的卡片 |
| | `graph_convert_card_to_shared` | 将自有卡转换为共享卡（放入共享池） |
| | `graph_convert_card_to_owned` | 将共享卡收回为自有卡（独占） |
| | `graph_attach_shared_card` | 把共享池既有共享卡挂载到目标（复用已收集上下文，仅 owner/主管） |
| | `graph_detach_shared_card` | 解除目标对共享卡的引用（卡仍留池；collecting 拒绝） |
| | `graph_list_shared_cards` | 只读列出共享池共享卡（id/title/status/refs） |
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
| | `graph_write_results` | 人工写入 attempt 完成摘要（source=manual + 写入者标注；无子代理的轻量改动兜底） |
| | `graph_refresh_results` | 重写 `results.md`：零 LLM 兜底拼装，或采用专用摘要子代理/人工产出的 `content`（旧版自动归档；支持批量 goals[]） |
| | `graph_handoff` | 生成跨会话交接文档 `HANDOFF.md` |
| | `graph_claim_supervisor` | 新会话接管 Supervisor 并更新会话元数据 |
| | `graph_help` | 输出插件功能说明与 50 个工具速查清单 |
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
  - **怎么把看板放进 `< 480px`**：宿主页签的宽度由**页签布局模式**决定，不是拖出来的——实测（1600px 视口）单页签 **719px**、页签上的 `分栏` 之后每页签 **359px**（该档随窗口宽度变化）、`全屏` **799px**。所以**默认单页签宽度（719px）落在宽档**，此时不会出现单泳道；需要单泳道档时用页签上的 **`分栏`**，或把窗口收窄到看板面板实测宽度 <480px。进入后一眼可验：六个阶段块**纵向堆叠**，且泳道标题右侧出现版本选择器（当前项为具体版本 / Backlog / 独立目标）。
  - **宽档残留（实测）**：宽档网格的最小宽度实测约 **956px**，所以看板面板实测宽度在这之下时（例如默认单页签 **719px**），宽档网格**仍会横向滚动**、把「确认 / 批量接受」列推到可视区外；真正消除横向滚动的是单泳道档（<480px）。
  - **版本选择器只在单泳道档渲染**：宽档下整个看板**没有**版本选择器（该元素不渲染）。因此宽档里能看到的「全部版本」只可能来自**打开的下拉选项列表**，而不是当前选中项；单泳道档未显式选择任何视图时，当前项是「独立目标」而**不是**「全部版本」。

效果截图见仓库 [screenshot/sidebar-kanban.png](https://github.com/miuzel/dsh-graph/blob/main/screenshot/sidebar-kanban.png)（虚构演示数据 nebula-notes，右侧栏宽度落在 `< 480px` 单泳道档）；本 npm 包不包含仓库的 `screenshot/` 目录，故此处只给出仓库路径。

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

- **Host Side**: Exposes 50 `graph_*` tools to DSH Agents covering the entire goal lifecycle, along with `/api/dsh-graph*` REST endpoints for board projections, goal details, and mutations;
- **Client Side**: A browser 2D swimlane kanban board integrated into DSH Web (the `conversation.view` slot) for intuitive visualization and real-time tracking.

All data is stored locally as human-readable files and an append-only event log under `.dsh-graph/`, making it Git-friendly, easily auditable, and collaborative.

---

### Installation

Install the plugin using the DSH CLI:

```sh
dsh plugin --profile <profile-name> add dsh-graph
```

**Current version**: v0.18.0 (this release-preparation artifact; `0.18.0-alpha` was the development version string — not yet published to npm). **Requirements**: Node.js ≥ 22 (includes the precompiled core runtime). Core packages provided by the DSH host (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-settings`) are declared under `peerDependencies` with `peerDependenciesMeta.optional` (standard DSH ecosystem convention) and provided by the host runtime without peer warnings; `yaml` is retained in `dependencies` as a plugin-specific runtime dependency, preventing duplicate core package instances.

**Host compatibility range**: `engines.dsh` declares `>=0.1.5-rc.2 <0.2.1-0` (the `-0` upper bound excludes every `0.2.1` prerelease and final release); host-aware markets such as dsh-market read it for card display and install/update pre-flight. **Hosts verified**: `0.1.6-alpha.2` through `0.1.7-rc.2`, and `0.2.0-rc.1`; `0.2.0-rc.2` (verified by the maintainer on 2026-09-30). The `0.1.8` line incidentally covered by that range was **never published on npm** (versions jump straight from `0.1.7-rc.2` to `0.2.0-rc.1`), so it is an empty set and adds no unverified claim.

**Platform status**:

| Platform | Status for this release |
|----------|-------------------------|
| Linux / WSL2 | ✅ Verified on-device (this release's full test suite: 0 failures) |
| Native Windows | ⚠️ **No on-device gate was run for this release** (must not be read as "verified"); this release's results are recorded in the release checklist (in progress, to be back-filled). Most recent on-device verdict: [v0.17.0 checklist](https://github.com/miuzel/dsh-graph/blob/main/docs/release-checklist-v0.17.0.md) §3.1 |
| macOS | ⚠️ **No on-device gate was run for this release** (must not be read as "verified"); this release's results are recorded in the release checklist (in progress, to be back-filled). Most recent on-device verdict: [v0.16.0 checklist](https://github.com/miuzel/dsh-graph/blob/main/docs/release-checklist-v0.16.0.md) |

All three platforms share the same package. **Known limitation**: on macOS a workspace path that is **explicitly supplied and contains a symlink** (e.g. under `/tmp` or `/var`) is rejected with `graph root symlink is not allowed`; paths derived from `process.cwd()` are unaffected.

**What's new (v0.18.0)**

- **Relations between goals**: four relation kinds — supersedes / amends / extends / related — recorded in exactly one source of truth (the goal's frontmatter); dependency declarations and relations are kept strictly apart instead of sharing one field.
- **New `graph_set_relation` tool**: mark or unmark a relation between goals; marking the same relation twice never creates a second entry, and mutually superseding cycles are rejected.
- **Relations are visible on the board and in the dialog**: cards show relation badges, and the goal dialog lists a read-only relation inventory directly **under "Goal description"** (outgoing / incoming, with cross-version and archived peers flagged).
- **Peer selection now searches**: pick the peer goal by typing its id or a title keyword; candidates reuse the board's one and only search-matching implementation, and an oversized candidate set prompts you to keep typing.
- **Write the goal description before dispatching**: supervisors get a reminder, and `graph_start_attempt` refuses to dispatch while the description is empty, placeholder-only, or comment-only — telling you to fill it in via `graph_set_description` and retry, with zero side effects.

See the [CHANGELOG](https://github.com/miuzel/dsh-graph/blob/main/CHANGELOG.md) for the full history; per-release gate verdicts live in the [v0.18.0 checklist](https://github.com/miuzel/dsh-graph/blob/main/docs/release-checklist-v0.18.0.md) and the platform gate runbook in [platform-gate.md](https://github.com/miuzel/dsh-graph/blob/main/docs/platform-gate.md). Official releases are distributed via npm and the dsh-market ecosystem.

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
- **Relations Between Goals**:
  Goals can be linked with four relation kinds — supersedes / amends / extends / related — and unlinked again; relations live in exactly one source of truth (the goal's frontmatter). Cards show relation badges, and the goal dialog lists the full inventory under "Goal description" (cross-version and archived peers flagged).
- **Seamless Session Handoff**:
  Generate `HANDOFF.md` summarizing board projections, long-term memory, and environment facts. A new session can claim the Supervisor role idempotently via `graph_claim_supervisor`.
- **Modern UI & Dual-Theme Support**:
  Full Dark and Light theme adaptation following DSH variables. Subtle pulse animations highlight external updates (with `prefers-reduced-motion` accessibility support); drag-safe modal text selection.

---

### Agent Tools Reference

dsh-graph equips Agents with a comprehensive set of `graph_*` tools (50 in total):

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
| **Goal Relations** | `graph_set_relation` | Mark or unmark a relation between goals (supersedes / amends / extends / related; idempotent, rejects supersede cycles) |
| **Quality Criteria** | `graph_set_criteria` | Define quality criteria (required prior to execution) |
| **Context Cards** | `graph_add_card` | Create a context card placeholder (text / file / image / data) |
| | `graph_bind_collect_card` | Bind collection subagent; marks card status as collecting |
| | `graph_fill_card` | Populate card content with a concise board summary |
| | `graph_review_card` | Review card content (filled → reviewed) |
| | `graph_delete_card` | Delete cards not currently collecting |
| | `graph_convert_card_to_shared` | Convert owned card to shared card |
| | `graph_convert_card_to_owned` | Convert shared card back to owned card |
| | `graph_attach_shared_card` | Attach an existing shared card to a goal (reuse collected context; owner/supervisor only) |
| | `graph_detach_shared_card` | Remove a goal's reference to a shared card (card stays in the pool; rejected while collecting) |
| | `graph_list_shared_cards` | List shared pool cards read-only (id/title/status/refs) |
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
| | `graph_write_results` | Manually write an attempt completion summary (source=manual + writer annotation; fallback for subagent-less changes) |
| | `graph_refresh_results` | Regenerate `results.md`: zero-LLM fallback assembly, or a caller-supplied `content` body from the dedicated summarizer subagent / a human (previous version archived; supports a goals[] batch) |
| | `graph_handoff` | Export cross-session handover document (`HANDOFF.md`) |
| | `graph_claim_supervisor` | Claim supervisor role in new session & update metadata |
| | `graph_help` | Display usage instructions and the 50-tool checklist |
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
  - **How to get the board into `< 480px`**: the host tab's width comes from the **tab layout mode**, not from dragging — measured at a 1600px viewport: single tab **719px**, **359px** per tab after the tab's `Split` mode (this mode scales with the window width), **799px** in `Fullscreen`. So the **default single-tab width (719px) lands in the wide tier** and no single lane appears; use the tab's **`Split`** mode, or narrow the window until the board panel measures <480px. Once there, it is obvious: the six stage blocks are **stacked vertically** and the version selector appears next to the lane title (current item: a specific version / Backlog / Standalone).
  - **Residual in the wide tier (measured)**: the wide-tier grid's minimum width is about **956px**, so whenever the board panel measures less than that (e.g. the default single tab at **719px**) the wide grid **still scrolls horizontally** and pushes the confirm / bulk-accept column out of view; the tier that actually removes horizontal scrolling is the single-lane one (<480px).
  - **The version selector is rendered only in the single-lane tier**: in the wide tier the board has **no** version selector at all. So an "All versions" string seen in the wide tier can only come from an **opened dropdown option list**, never from the current selection; and in the single-lane tier, before any explicit view choice, the current item is "Standalone" — **not** "All versions".

See [screenshot/sidebar-kanban.png](https://github.com/miuzel/dsh-graph/blob/main/screenshot/sidebar-kanban.png) in the repository for a screenshot (fictional demo data nebula-notes, sidebar width in the `< 480px` single-lane tier); this npm package does not ship the repository's `screenshot/` directory, so only the repository path is given here.

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
