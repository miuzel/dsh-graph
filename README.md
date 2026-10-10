# dsh-graph

把工作组织成**目标看板**的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件 —— 基于图的目标管理（Graph-based Goal Management）。

<p align="center">
  <img src="docs/banner.webp" alt="dsh-graph —— Agent 工作的目标化管理" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-graph"><img src="https://img.shields.io/npm/v/dsh-graph?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-graph"><img src="https://img.shields.io/npm/dm/dsh-graph?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/miuzel/dsh-graph/blob/main/dsh-graph-host/package.json"><img src="https://img.shields.io/node/v/dsh-graph?style=flat-square" alt="node engine"></a>
  <a href="https://awesome-dsh-plugin.com"><img src="https://img.shields.io/badge/awesome--dsh--plugin-listed-2f6feb?style=flat-square" alt="awesome-dsh-plugin listed"></a>
  <a href="https://github.com/miuzel/dsh-graph/blob/main/dsh-graph-host/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="license MIT"></a>
  <a href="https://github.com/miuzel/dsh-graph/blob/main/dsh-graph-host/package.json"><img src="https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.2%20%3C0.2.2--0-2f6feb?style=flat-square" alt="DSH host range"></a>
</p>

**当前版本 v0.20.1** —— npm 包名 `dsh-graph`，一个包同时提供面向 Agent 的 51 个 `graph_*` 工具（含 `/api/dsh-graph*` REST 端点）与内嵌 DSH Web 的二维泳道看板。

**最新亮点（v0.20.1）**

- **在 DSH 0.2.1 系宿主上派发不再失效**：宿主把子代理启动接口换了名字后，新宿主上任何派发都会直接失败（报 `startContinuable is not a function`）；本版把全部派发入口收口到同一处兼容层 —— 新宿主走新接口、旧宿主自动回退旧接口，两者都没有时明确报错，不再静默失败。
- **兼容性结论从此必须验「派得出去」**：新宿主上「装得上、起得来」不等于可用；宿主兼容判定固定为**安装 / 启动 / 派发可用**三个维度，缺一不得判定兼容。
- **本版这样验证**：用与用户相同的安装包在干净环境里装上后实测派发 —— 新宿主与旧宿主各成功派发一次并拿到真实子代理标识。原生 Windows 真机门禁已在本版候选包上执行，覆盖**安装 / 启动 / REST 层**（**不含「派发可用」维度**）；原生 macOS 真机门禁**本版未执行**，如实标注为「未验证」，不得读作「已通过」。
- **配置与行为零变化**：宿主兼容声明范围、设置项与看板行为均未改动；从 v0.20.0 升级无需任何手工动作。

变更史见 [CHANGELOG.md](https://github.com/miuzel/dsh-graph/blob/main/CHANGELOG.md)。

## 平台状态

| 平台 | 本版状态 |
|------|----------|
| Linux / WSL2 | ✅ 已实测通过（本版全量测试 fail 0） |
| 原生 Windows | ✅ **已实测通过**（`v0.20.1` 候选包真机门禁：原生 Windows `win32/x64` + Node `v24.21.0` + 宿主 DSH `0.2.0-rc.2`，端口 3088；T1–T5 **通过 15 / 失败 0 / 告警 1**、T3 看板文件系统生命周期 **32/32 步**（含步骤清单自证 / 失败路径 / 跨进程 CAS）；唯一告警 = 发布包内无 `core/*.ts` ⇒ 台账层未对账，属设计内；逐字报告见[平台门禁](docs/platform-gate.md) §7.9）。⚠️ 该行结论**只覆盖安装 / 启动 / REST 层**，**不覆盖「派发可用」维度** —— 派发可用维度本版在 Linux/WSL2 隔离实例上验证（新宿主与旧宿主各成功派发一次），**Windows 未经真机验证**。 |
| macOS | ⏳ **本版未验证**：`v0.20.1` **未**在原生 macOS 上执行真机门禁 ⇒ **不得读出「已通过」**。历史记录见[平台门禁](docs/platform-gate.md) §7.4 / §7.7，只覆盖 v0.19.8 及更早的产品代码。 |

三平台共用同一安装包。已知限制：① macOS 默认文件系统 APFS 大小写不敏感——仅大小写不同的目标编号 / 版本泳道会落到**同一实体**，请勿只用大小写区分；② macOS 上**经显式传入且含符号链接**的工作区路径（如位于 `/tmp`、`/var` 之下）会被拒绝并报 `graph root symlink is not allowed`，由 `process.cwd()` 推导的路径不受影响。

## 安装

```sh
dsh plugin --profile <name> add dsh-graph
```

需要 Node ≥ 22。依赖说明、宿主兼容范围（`engines.dsh` 声明与实测宿主）、侧边栏用法、数据目录等完整内容，见 **[dsh-graph-host/README.md](dsh-graph-host/README.md)**（即 npm 包内 README）。升级宿主后若 Web 看板半边不激活（`web boot: … did not activate`），见该 README 的「[升级残留自检与清理](dsh-graph-host/README.md#升级残留自检与清理)」。

## 核心概念

- **基于图的目标管理**：目标是自足实体 —— 自然语言任务 + 动态生成的取证计划与质量判据；任务类型不预先模板化，结构化的是生命周期与求值语义。
- **四阶段生命周期**：`描述 → 收集 → 执行 → 确认`，由引擎强制的状态机：`draft → planning → collecting → ready → in_progress → review → delivered`（任意阶段可进入 `blocked`）。
- **判据先于执行**：进入执行前先登记质量判据，评审按逐条判据核验产出物。
- **上下文卡片**：目标 Runner 的种子上下文，生命周期 `empty → collecting → filled → reviewed`；形态分文本 / 文件 / 图片 / 数据。
- **排期**：Backlog（暂存池）↔ Version（批量质量管理）↔ 独立目标（standalone）；看板泳道顺序是展示态，可拖拽调整。
- **分级评审与策略配置**：支持配置项目专属模块区域 `review.regions`、冻结契约 `review.contract_paths` 与排除前缀 `review.non_product_prefixes`，未登记区域自动安全升级 strict，空契约默认 M1 不触发。
- **换会话交接**：`graph_handoff` 生成交接文档（board 投影 + 长期记忆 + 环境事实），`graph_claim_supervisor` 由新会话幂等接管。
- **目标间关系**：目标之间可标记「取代 / 调整 / 补充 / 相关」四类关系（`graph_set_relation`，可增可删）；关系只记在目标 frontmatter 这一处真源，看板卡片与目标弹窗直接可见。
- **Profile 全局设置**：子代理默认 provider / model、推理档位、执行模式、提示词语言与补充提示词，可在「设置 → 看板设置」「右侧栏 → 插件 → dsh-graph」两处任一打开，两处读写同一份 profile 配置（workspace `project.yaml` 明确配置优先）。

## 提供的工具

51 个 `graph_*` 工具，按功能分组（逐个说明见 [dsh-graph-host/README.md](dsh-graph-host/README.md) 或 `graph_help`）：

| 分组 | 工具 |
|------|------|
| 目标生命周期 | `graph_create_goal` · `graph_rename_goal` · `graph_set_description` · `graph_set_goal_type` · `graph_set_goal_tags` · `graph_amend_goal` · `graph_transition` · `graph_postpone_goal` · `graph_archive_goal` · `graph_unarchive_goal` · `graph_delete_goal` · `graph_clean_worktree` · `graph_list_worktrees` |
| 目标关系 | `graph_set_relation` |
| 质量判据 | `graph_set_criteria` |
| 上下文卡片 | `graph_add_card` · `graph_fill_card` · `graph_review_card` · `graph_bind_collect_card` · `graph_delete_card` · `graph_convert_card_to_shared` · `graph_convert_card_to_owned` · `graph_attach_shared_card` · `graph_detach_shared_card` · `graph_list_shared_cards` |
| 附件 | `graph_store_attachment` · `graph_delete_attachment` |
| 排期 | `graph_move_goal` |
| 执行派发 | `graph_start_attempt` · `graph_start_review` · `graph_set_directive` · `graph_record_attempt_handoff` · `graph_unbind_goal_child` · `graph_abandon_attempt` |
| 记忆 | `graph_memory_add` · `graph_memory_recall` · `graph_memory_remove` · `graph_memory_replace` |
| 配置管理 | `graph_get_settings` · `graph_update_settings` |
| 校验 / 对账 | `graph_validate` · `graph_rebuild` |
| 状态汇报 | `graph_report_status` · `graph_report_supervisor_status` |
| 评审裁决 | `graph_resolve_accept` |
| 历史讨论 | `graph_add_comment` |
| 完成摘要 | `graph_write_results` · `graph_refresh_results` |
| 换会话 | `graph_handoff` · `graph_claim_supervisor` |
| 帮助 | `graph_help` |

## 看板（浏览器客户端）

浏览器二维泳道看板：横向为生命周期阶段列（描述 / 收集 / 执行 / 确认 / 交付 / 阻塞），每个版本一条泳道，另有 Backlog 与独立目标区；支持拖拽排期、判据 / 上下文卡片抽屉、实时状态显示、阻塞折叠等。以下为虚构演示数据（nebula-notes）截图：

![看板总览](screenshot/screenshot-1.png)
![目标详情弹窗](screenshot/screenshot-2.png)
![侧边栏看板（窄档：阶段列纵向堆叠、工具条折叠为 `⋯ 工具`）](screenshot/sidebar-kanban.png)

## 侧边栏与数据目录

侧边栏入口、窄档（<480px）分档行为与「怎么把看板放进窄档」的实测说明，以及数据目录 `<workspace>/.dsh-graph`（纯文本 + 只追加 `events.jsonl`，git 友好、可 `graph_rebuild` 对账）的完整说明，均见 [dsh-graph-host/README.md](dsh-graph-host/README.md)。

## 仓库结构（monorepo）

- `core/` —— 核心层源码（唯一事实源），经 `scripts/sync-core.sh` 编译成 `dist/core/*.js` 进发布包；核心层不依赖 DSH。
- `dsh-graph-host/` —— 单包发布物源码：`index.js`（工具 + REST 端点）、`lib/client/*.js`（看板源模块，构建产物为 `dist/lib/client.js`）、`cordis.patch.yml`、`supervisor-guide.{zh,en}.md`、`README.md`、`LICENSE`。
- `schema/`、`docs/`、`scripts/` —— 数据 / 设计文档 / 构建脚本；一切构建产物落在 `dist/`（gitignored）。

## 开发

```sh
bash scripts/build.sh                 # 同步 core + 客户端产物 + 复制发布资产到 dist/
node --test core/tests/*.test.ts      # 全量测试
./node_modules/.bin/tsc --noEmit -p tsconfig.json
# 隔离测试实例（不碰主 GUI）：DSH_HOME 与 workspace 均在 ./tmp/dsh-test/ 下
bash scripts/dsh-test-web.sh <DSH版本> [--port PORT]
```

构建与实验一律在隔离 worktree（`.worktrees/<goal>-att-<NN>`）内进行；约定见 [AGENTS.md](AGENTS.md)，隔离实例参数与开发回路见 [docs/dev-instance-guide.md](docs/dev-instance-guide.md)。README 截图用 `scripts/dsh-graph-mock-seed.mjs` 生成虚构演示数据后复现。

## License

MIT（Copyright © 2026 miuzel）—— 见 [dsh-graph-host/LICENSE](dsh-graph-host/LICENSE)。
