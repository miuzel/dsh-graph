# dsh-graph

把工作组织成**目标看板**的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件——基于图的目标管理（Graph-based Goal Management）。

> **✅ 支持 DeepSeek Harness `v0.1.5-rc.2`（Linux/WSL2 已验证）**：本版本（v0.10.0）在该宿主版本上完整验证（隔离 Web 实例、看板交互、全部 `graph_*` 工具与 REST 端点、中英双语界面）——**验证环境为 Linux（WSL2）**，并以此为推荐配套版本；兼容 `0.1.5` 系列与 `0.1.2-alpha.x` 及以上。
>
> **⚠️ Windows 原生环境尚未验证**：已知两类问题会导致 Windows 下不可用——① 平台代码使用 POSIX 专用的文件锁常量（把目录当 fd 打开 / `O_DIRECTORY` / `O_NOFOLLOW`，见 `core/ops.ts`）；② 插件把宿主提供的核心包（`@deepseek-ai/schemastery` 等）同时声明在 `dependencies` 与 `peerDependencies`，触发 DSH profile 核心包隔离检查。两者相互独立，修复计划见看板目标 g-284（平台兼容）与 g-285（依赖隔离）；修复后欢迎 Windows 用户重新验证并反馈。

单包发布：npm 包名 `dsh-graph`（当前版本 v0.10.0）。一个包同时提供：

- 面向 agent 的 39 个 `graph_*` 工具（覆盖目标全生命周期）+ `/api/dsh-graph*` REST 端点；
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
> **✅ DSH 版本兼容性（重点）**：v0.10.0 **已在 Linux（WSL2）上完整验证并支持 DeepSeek Harness [`v0.1.5-rc.2`](https://www.npmjs.com/package/@deepseek-ai/dsh)**——开发期的隔离测试实例（Web GUI + 二维泳道看板 + `graph_*` 工具 + REST 端点）与中英双语功能演示视频（见 [dsh-graph-videos](https://github.com/miuzel/dsh-graph-videos)）全部在 `v0.1.5-rc.2` 上实测通过，**推荐与该版本配套使用**。同时兼容 `0.1.5` 系列及 `0.1.2-alpha.x` 及以上版本（工具与提示词契约向后兼容）。
>
> **⚠️ 平台范围（重要）**：上述验证**不包含 Windows 原生环境**。Windows 下已知两类独立问题：① `core/ops.ts` 使用 POSIX 专用文件锁常量（把目录当 fd 打开、`O_DIRECTORY`、`O_NOFOLLOW`），在 Windows 上无法获取锁；② 宿主提供的核心包被同时写进 `dependencies` 与 `peerDependencies`，触发 DSH profile 核心包隔离检查。修复跟踪：看板目标 **g-284**（Windows 平台兼容）与 **g-285**（依赖隔离）。在两者修复并通过 Windows 真机复验前，**请勿在 Windows 原生环境部署**（WSL2 内使用不受影响）。

## 提供的工具

39 个 `graph_*` 工具，按功能分组：

| 分组 | 工具 |
|------|------|
| 目标生命周期 | `graph_create_goal` · `graph_rename_goal` · `graph_set_description` · `graph_set_goal_type` · `graph_set_goal_tags` · `graph_amend_goal` · `graph_transition` · `graph_postpone_goal` · `graph_archive_goal` · `graph_unarchive_goal` · `graph_delete_goal` · `graph_clean_worktree` · `graph_list_worktrees` |
| 质量判据 | `graph_set_criteria` |
| 上下文卡片 | `graph_add_card` · `graph_fill_card` · `graph_review_card` · `graph_bind_collect_card` · `graph_delete_card` |
| 附件 | `graph_store_attachment` · `graph_delete_attachment` |
| 排期 | `graph_move_goal` |
| 执行派发 | `graph_start_attempt` · `graph_set_directive` · `graph_record_attempt_handoff` · `graph_unbind_goal_child` |
| 记忆 | `graph_memory_add` · `graph_memory_recall` · `graph_memory_remove` · `graph_memory_replace` |
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

## 数据目录

`<workspace>/.dsh-graph`：跟随调用会话的 workspace（`session.header.cwd`），数据落在每个项目自己的 `.dsh-graph`，git 友好。包含 `backlog/`、`goals/`、`versions/`、`events.jsonl`（事件流，唯一事实源）等。首次触达某 workspace 自动生成骨架，幂等、不建 demo 数据；`.dsh-graph` 也可配置为独立 Git 仓库（见 `docs/` 与 `scripts/migrate-dsh-graph-repo.sh`）。

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
CWD=/tmp/dsh-graph-mock-demo bash scripts/dev-dsh-instance.sh run --port 3082  # 测试实例（开「看板」tab）
# 截图：同一次 seed、同一实例、固定视口——看板全景 → screenshot/screenshot-1.png；
# 点击 g-006 卡片打开目标详情弹窗 → screenshot/screenshot-2.png
```

## License

MIT（Copyright © 2026 miuzel）
