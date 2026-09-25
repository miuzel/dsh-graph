# dsh-graph

把工作组织成**目标看板**的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件——基于图的目标管理（Graph-based Goal Management）。

> ### 🚀 v0.16.0 新功能
>
> - **适配 DeepSeek Harness `0.1.7` 宿主 settings 服务换代**：旧 `settings.register(namespace, schema)` API 已被移除（实测告警 `sctx.settings.register is not a function`）。插件改为**能力探测分流**——服务提供 `register` 走旧 namespace 注册，否则回落 `describe` 表单投影（profile 条目 `Config`）；两条路径均在隔离实例上双宿主实机验证，且**零版本号比较**。
> - **适配 `0.1.7` 子代理目录换代（两层）**：容器由 `subagentsByParent` 改为 `projectionsBySession[sid].values.subagentCatalog`，**entry 形状同时去掉 `kind`**（新形状 `{id, createdAt, mode, label?}`，新增 `mode:'unknown'`）。目录谓词改为形状探测（有 `kind` 走旧判定、无 `kind` 按 `id`），避免点「↗ 转到对话」**静默**打开父会话。
> - （以下为此前版本的累积亮点）**适配 `0.1.6` 宿主 API 变更**：会话导航/focus 职责从 `sessions` 服务迁移到 `uiWorkspace`，统一走 `openSessionTarget`；子代理聚焦、点击「转到对话」、「交给产品经理」与用户反馈派发链路在新宿主下全部恢复可用。
> - **看板实时会话区在 `0.1.6` 下恢复显示**：按新宿主的 retain 生命周期先保留会话引用再借取 binding，不再出现「⚠️ 会话未接入（不在会话列表）」与「模型目录不可用」，真实 tokens / ctx / 模型可正常渲染；`0.1.5` 无 retain 时自动回退被动 binding，双向兼容。
> - **批量接受的主管通知在 `0.1.6` 下恢复**：通知派发改为能力探测分流，单卡接受与批量接受同形路径一并修复。
> - **并发槽位耗尽给出可操作提示**：`0.1.6` 引入子代理激活上限（默认 8 个活跃 continuable 子代理），容量耗尽或冷恢复被拒时不再只透出英文错误码。
> - **看板刷新按钮重置自动刷新倒计时**：点击刷新后倒计时立即回到完整周期，不再沿旧终点继续递减。
> - **「定义/润色」复制模板改写为自述式主管指令**：标题标明由主管处理，明确接收者角色、下一步动作与本次边界（仅处理定义/润色，不执行代码、不推进状态或版本）。
>
> **✅ DSH 版本兼容性（重点）**：**声明的宿主兼容范围**（自 v0.16.1 起，`engines.dsh`）：`>=0.1.5-rc.2 <0.1.8-0`；**实测通过的宿主**：`0.1.6-alpha.2` ~ `0.1.7-rc.2`。**本周期（g-351）实测的双宿主对照**：`0.1.7-rc.1` 上验证宿主 settings 服务换代后的**能力探测分流**——新 API 存在则走「profile 条目 Config → 设置表单」，实测 `sctx.settings.register is not a function` 降级告警消失、profile 全局默认（如 `subagentMode`）经 profile patch 真正生效（`mode_source=global`），`graph_*` 工具计数仍为 44、`/api/dsh-graph*` 端点注册齐全；`0.1.6-alpha.2` 上重跑旧路径，确认 namespace 注册（`$DSH_HOME/settings.yaml`）与 profile 全局默认照常生效，**零退化**。更早的 `0.1.2-alpha.x` ~ `0.1.4` 系列按工具与提示词契约向后兼容，但**未在本周期复跑**，且**自 v0.16.1 起不在声明范围内**（市场安装预检会保守挡住）。
>
> **✅ 跨平台（v0.11.0 起）**：Windows 原生不可用问题已修复，并在原生 Windows（win32/x64）与 macOS（darwin/arm64）真机复验通过；**v0.16.0 周期的 Windows 真机门禁已在原生 Windows 全绿**（`win32/x64` / node v24.13.0，2026-09-25，T1–T5 通过 10 项 / 失败 0 项 / 告警 0 项，产物 `fe852e23…`；上一版本 `v0.15.0` 周期亦全绿）；**本版本 `v0.16.0` 的 Windows 真机门禁由负责人在本次发布前于原生 Windows 执行（发布红线 1），结论见 [`docs/release-checklist-v0.16.0.md`](docs/release-checklist-v0.16.0.md) §3**（本周期 Linux/WSL2 侧已实测）；**不予预先声明 PASS**——若发布时该门禁未执行，则以「**Windows 未验证**」如实标注。**macOS 门禁已于 v0.16.0 在 Mac 上执行**（`darwin/arm64`，专检 通过 2/失败 0/告警 3）：`scripts/macos-smoke-test.mjs`（M1–M4 专检 + 转发既有 T1–T5）已随 v0.16.0 落地；**v0.17.0 起 macOS 与 Linux 门禁已合并为一份跨平台执行件 [`scripts/platform-smoke-test.mjs`](scripts/platform-smoke-test.mjs)**（六项平台探针 P1–P6 + 平台无关审计 M4 + 转发 T1–T5），旧路径降为转发 shim、原实现归档在 [`scripts/archived/`](scripts/archived/)，运行手册见 [`docs/platform-gate.md`](docs/platform-gate.md)，**macOS 结论：专检 通过 2/失败 0/告警 3**（M2 实测该卷**大小写不敏感**，仅大小写不同的 slug/id 会互相别名；M1/M3 因检出未构建而未执行，脚本按设计给 WARN 而非 FAIL），转发 T1–T5 为 10/0/0 —— 详见 [`docs/release-checklist-v0.16.0.md`](docs/release-checklist-v0.16.0.md) §3.4；上一处完整 macOS 真机复验仍为 `v0.11.0`。
>
> **已知限制**：macOS 上若工作区路径**经显式传入且含符号链接**（例如位于 `/tmp`、`/var` 之下），会被拒绝并报 `graph root symlink is not allowed`；**由 `process.cwd()` 推导的路径不受影响**。

单包发布：npm 包名 `dsh-graph`（当前版本 v0.16.0，与 `package.json` / `PLUGIN_VERSION` 一致）。一个包同时提供：

- 面向 agent 的 44 个 `graph_*` 工具（覆盖目标全生命周期）+ `/api/dsh-graph*` REST 端点；
- 浏览器二维泳道看板（`lib/client.js`），渲染进 `conversation.view` 槽。

数据以文件 + 事件流形式落在工作区 `.dsh-graph` 目录，git 友好、可审计。

## 核心概念

- **基于图的目标管理**：目标是自足实体——自然语言任务 + 动态生成的取证计划与质量判据；任务类型不预先模板化，结构化的是生命周期与求值语义。
- **四阶段生命周期**：`描述 → 收集 → 执行 → 确认`，由引擎强制的状态机：`draft → planning → collecting → ready → in_progress → review → delivered`（任意阶段可进入 `blocked`）。
- **判据先于执行**：进入执行前先登记质量判据，评审按逐条判据核验产出物。
- **上下文卡片**：目标 Runner 的种子上下文，生命周期 `empty → collecting → filled → reviewed`；形态分文本 / 文件 / 图片 / 数据。
- **排期**：Backlog（暂存池）↔ Version（批量质量管理）↔ 独立目标（standalone）；看板泳道顺序是展示态，可拖拽调整。
- **换会话交接**：`graph_handoff` 生成交接文档（board 投影 + 长期记忆 + 环境事实），`graph_claim_supervisor` 由新会话接管。

## 当前功能状态

- **全链路 i18n（v0.9.2）**：看板 UI、工具描述与全部 LLM 提示词中英双语；整篇提示词文档按语言后缀文件区分（`supervisor-guide.zh.md` / `.en.md`），跟随 DSH 界面语言（`locale.preference`）或可在看板设置中显式指定。
- **结构化执行状态（v0.9.2）**：`graph_report_status` 支持 `state` 枚举（working/blocked/done/error），看板活跃判断以结构化状态优先、关键词匹配仅作遗留回退。
- **目标描述就地编辑（v0.9.2）**：目标弹窗中描述可直接进入 Markdown 编辑态保存（`graph_set_description`）。
- **更新强调**：目标被外部编辑后，看板卡片播放更新强调动画；弹窗打开期间的变化在关闭弹窗时补播；系统开启 reduced-motion 时降级为静态高光。
- **浅色主题**：看板、弹窗与抽屉完整适配浅色 / 深色两套主题（跟随 DSH 主题变量）。
- **信息收集**：目标详情弹窗的上下文卡片区显示「🔎 信息收集」。
- **卡片标题**：直接显示目标标题，无 🎯 前缀。
- **弹窗交互**：从弹窗内容开始框选文本并拖到弹窗外松开，不会误关闭弹窗。

## 安装

```sh
dsh plugin --profile <name> add dsh-graph
```

> 需要 Node ≥ 22（包内 core 为编译后 `.js`）。已发布版本经 npm 与 dsh-market 生态（[dsh-market](https://github.com/dsh-market/dsh-market) / DshMarketPlace / DSH Get，见 `docs/release-handbook.md`）分发。
>
> **依赖说明**：宿主提供的核心包（`@deepseek-ai/cordis` ^4.0.2、`@deepseek-ai/schemastery` ^3.18.2、`@deepseek-ai/dsh-settings` ^0.1.5-rc.2）以 `peerDependencies` + `peerDependenciesMeta.optional`（DSH 生态惯例）声明，由 DSH 宿主环境提供，安装不产生 peer 告警；`yaml` 为插件自带运行依赖（声明在 `dependencies` 中），避免产生重复的核心包实例。
>
> **宿主兼容声明**：`engines.dsh` 声明 DSH 兼容范围 `>=0.1.5-rc.2 <0.1.8-0`（与 `@deepseek-ai/dsh-settings` peer `^0.1.5-rc.2` 取交集后自洽；上界 `-0` 表示排除 `0.1.8` 的**一切预发布与正式版**——下代宿主须重新验证后再放宽），供 dsh-market 等宿主感知型市场在卡片展示与安装/更新预检中读取；市场的判定是 `engines.dsh` 与各 peer 范围的**合取**，且发现阶段**不读** `peerDependenciesMeta.optional`。
>
> **✅ DSH 版本兼容性（重点）**：**声明的宿主兼容范围**（自 v0.16.1 起，`engines.dsh`）：`>=0.1.5-rc.2 <0.1.8-0`（最新的 `0.1.7-rc.2` 已适配并实测通过 —— 2026-09-25 用 v0.16.0 发布物 tarball 在 Linux/WSL2 上跑 T1–T5 全绿 **10/0/0**，并逐包比对 `0.1.7-rc.1`→`rc.2`：子代理目录层（`dsh-session-projection`）零代码变化、`listProviders`/`listModels`/`resolveModelInfo` 签名逐字未变、客户端只用到的 `MarkdownText` 仍在；`0.1.7-rc.1` 为 g-351 双宿主对照实测；`0.1.6-alpha.2` 在本周期同批复跑确认零退化）。宿主 settings 服务在 `0.1.7` 线换成「profile 条目 Config → 设置表单」形态（旧 `settings.register` 已移除），插件改为**能力探测分流**：新 API 存在走新路径，否则回落旧 namespace 注册；两条路径均在隔离实例上实机验证。更早的 `0.1.2-alpha.x` ~ `0.1.4` 系列按工具与提示词契约向后兼容，但**未在本周期复跑**，且**自 v0.16.1 起不在声明范围内**（市场安装预检会保守挡住）。
>
> **平台范围**：**Linux（WSL2）、原生 Windows、macOS**（三平台使用同一安装包；macOS 最近一次真机复验为 `v0.11.0`，自 `v0.11.0` 以来 `core/platform.ts` 与文件锁相关代码零改动）。**本版本 `v0.16.0` 已在 Linux（WSL2）实测**；**macOS 门禁已于 v0.16.0 在 Mac 上执行**（`darwin/arm64`，专检 通过 2/失败 0/告警 3） —— **v0.17.0 起 macOS 与 Linux 门禁已合并为一份跨平台执行件 [`scripts/platform-smoke-test.mjs`](scripts/platform-smoke-test.mjs)**（单文件 Node 实现，六项平台探针 P1–P6：大小写敏感性 / 软链 root 边界 / 挂载类型识别 / 并发 CAS 与原子写 / 跨 FS rename(EXDEV) / locale 编码逐字节往返，另有平台无关的 Linux-only 假设审计 M4）并转发既有 `win-smoke-test.mjs` 的 T1–T5；旧路径 [`scripts/macos-smoke-test.mjs`](scripts/macos-smoke-test.mjs) 已降为转发 shim（原实现归档在 [`scripts/archived/`](scripts/archived/)），**macOS/Linux 的命令序列、逐项判读与结论回填表见 [`docs/platform-gate.md`](docs/platform-gate.md)**（[`docs/macos-gate.md`](docs/macos-gate.md) 为 v0.16.0 历史记录），**本版本不预先声明 macOS 已验证**；**Windows 真机门禁（T1–T5）由负责人在本次发布前于原生 Windows 执行 `node win-smoke-test.mjs --tarball dsh-graph-0.16.0.tgz`，结论见 [`docs/release-checklist-v0.16.0.md`](docs/release-checklist-v0.16.0.md) §3**——**本次不预先声明 PASS（红线 1）**；若发布时未执行该门禁，则以「**Windows 未验证**」如实标注。此前 Windows 不可用的两类问题——① `core/ops.ts` 使用 POSIX 专用文件锁常量（目录当 fd 打开、`O_DIRECTORY`、`O_NOFOLLOW`）；② 宿主提供的核心包被同时写进 `dependencies` 与 `peerDependencies`——已在 **v0.11.0** 修复，并在原生 Windows 与 macOS 真机复验通过。**已知限制**：macOS 上**经显式传入且含符号链接**的工作区路径（如位于 `/tmp`、`/var` 之下）会被拒绝并报 `graph root symlink is not allowed`；由 `process.cwd()` 推导的路径不受影响（Node 返回物理路径），但建议一律使用真实路径（后续版本继续跟进）。

## 提供的工具

44 个 `graph_*` 工具，按功能分组：

| 分组 | 工具 |
|------|------|
| 目标生命周期 | `graph_create_goal` · `graph_rename_goal` · `graph_set_description` · `graph_set_goal_type` · `graph_set_goal_tags` · `graph_amend_goal` · `graph_transition` · `graph_postpone_goal` · `graph_archive_goal` · `graph_unarchive_goal` · `graph_delete_goal` · `graph_clean_worktree` · `graph_list_worktrees` |
| 质量判据 | `graph_set_criteria` |
| 上下文卡片 | `graph_add_card` · `graph_fill_card` · `graph_review_card` · `graph_bind_collect_card` · `graph_delete_card` · `graph_convert_card_to_shared` · `graph_convert_card_to_owned` |
| 附件 | `graph_store_attachment` · `graph_delete_attachment` |
| 排期 | `graph_move_goal` |
| 执行派发 | `graph_start_attempt` · `graph_set_directive` · `graph_record_attempt_handoff` · `graph_unbind_goal_child` · `graph_abandon_attempt` |
| 记忆 | `graph_memory_add` · `graph_memory_recall` · `graph_memory_remove` · `graph_memory_replace` |
| 配置管理 | `graph_get_settings` · `graph_update_settings` |
| 校验 / 对账 | `graph_validate` · `graph_rebuild` |
| 状态汇报 | `graph_report_status` · `graph_report_supervisor_status` |
| 评审裁决 | `graph_resolve_accept` |
| 历史讨论 | `graph_add_comment` |
| 换会话 | `graph_handoff` · `graph_claim_supervisor` |
| 帮助 | `graph_help` |

各工具具体含义见 `dsh-graph-host/README.md` 或 `graph_help`。

## 看板（浏览器客户端）

浏览器二维泳道看板：横向为生命周期阶段列（描述 / 收集 / 执行 / 确认 / 交付 / 阻塞），每个版本一条泳道，另有 Backlog 与独立目标区；支持拖拽排期、判据 / 上下文卡片抽屉、`graph_report_status` 与 `graph_report_supervisor_status` 的实时状态显示、阻塞折叠等。以下为虚构演示数据（nebula-notes）截图：

![看板总览](screenshot/screenshot-1.png)

![目标详情弹窗](screenshot/screenshot-2.png)

## 侧边栏用法

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
  - **版本选择器只在单泳道档渲染**：宽档下整个看板**没有**版本选择器（该元素不渲染）。因此宽档里能看到的「全部版本」只可能来自**打开的下拉选项列表**，而不是当前选中项；单泳道档未显式选过任何视图时，当前项是「独立目标」而**不是**「全部版本」。

下图为右侧栏「看板」面板（虚构演示数据 nebula-notes，宽度落在 `< 480px` 单泳道档：阶段列纵向堆叠、工具条折叠为「⋯ 工具」、DEBUG 行按规则隐藏；「确认」列头右侧即 `✅ 批量接受` 入口）：

![侧边栏看板](screenshot/sidebar-kanban.png)

## 数据目录

`<workspace>/.dsh-graph`：跟随调用会话的 workspace（`session.header.cwd`），数据落在每个项目自己的 `.dsh-graph`，git 友好。包含 `backlog/`、`goals/`、`versions/`、`events.jsonl`（事件流，唯一事实源）等。首次触达某 workspace 自动生成骨架，幂等、不建 demo 数据；`.dsh-graph` 也可配置为独立 Git 仓库（见 `docs/` 与 `scripts/archived/migrate-dsh-graph-repo.sh`）。

## 仓库结构（monorepo）

- `core/`——核心层源码（唯一事实源），经 `scripts/sync-core.sh` 编译成 `dsh-graph-host/core/*.js` 进发布包。可基于core开发各类UI / CLI / REST / agent 工具，核心层不依赖 DSH。
- `dsh-graph-host/`——单包发布物：`index.js`（工具 + REST 端点）、`lib/client.js`（看板）、`cordis.patch.yml`（`dsh.bundle`）、`supervisor-guide.zh.md`、`supervisor-guide.en.md`、`README.md`、`LICENSE`。
- `schema/`、`docs/`、`scripts/`——数据 / 设计文档 / 构建脚本。

## 开发

```sh
bash scripts/sync-core.sh          # 修改 core 后同步进包
node --test core/tests/*.test.ts   # 全量测试

# 复现 README 截图（虚构演示数据，写仓库外 /tmp，不提交 mock .dsh-graph）：
node scripts/dsh-graph-mock-seed.mjs --validate               # 生成 nebula-notes mock 数据
CWD=/tmp/dsh-graph-mock-demo bash scripts/archived/dev-dsh-instance.sh run --port 3082  # 测试实例（开「看板」tab）
# 截图：同一次 seed、同一实例、固定视口——看板全景 → screenshot/screenshot-1.png；
# 点击看板上的目标卡片打开详情弹窗 → screenshot/screenshot-2.png
# 侧边栏看板 → screenshot/sidebar-kanban.png：同一实例里打开右侧栏 → 点「看板」磁贴，
# 再把看板面板弄到实测宽度 <480px（用页签上的 `分栏`，或收窄窗口；单泳道档：工具条折叠、
# DEBUG 行自动隐藏）后截「看板」面板
```

## License

MIT（Copyright © 2026 miuzel）
