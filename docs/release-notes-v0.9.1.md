# dsh-graph v0.9.1 Release Notes

> 发布日期：2026-09-08
> 前序版本：v0.7.3
> 主题：上下文卡片增强、执行模式、标签筛选、记忆提炼与工程改进

## 本版本变更

### 核心功能

- **可复用上下文卡片 / 共享卡 / 附件模型（g-183）**：上下文卡片支持共享复用，新增文件附件存储与管理（`graph_store_attachment` / `graph_delete_attachment`），为执行子代理提供更丰富的上下文种子。
- **判据整行勾选交互（g-185）**：看板判据支持逐条整行勾选，评审时可直接逐项核验，提升交付审核效率。
- **转到对话按钮交互优化（g-188）**：统一「转到对话」入口的 hover / active / focus 样式与无障碍支持，弹窗内不再因拖选文本误关。
- **确认列接受交付按钮（g-186）**：确认列新增「接受交付」快捷按钮，supervisor 可一键通过验收。
- **目标卡片弹窗显示 worktree（g-189）**：目标详情弹窗展示当前 attempt 的 worktree 路径，方便快速定位工作目录。
- **主管标题栏标签（g-192）**：看板顶部主管状态栏展示当前主管会话标签，便于识别管理身份。
- **子代理执行模式（g-191）**：支持 `standard` / `minimal` 两种子代理执行模式；minimal 模式通过工具白名单实现轻量受控执行。

### 工程改进

- **交付合并后自动登记可清理 worktree（g-197）**：目标 delivered 后自动标记关联 worktree 为可清理，配合 `graph_clean_worktree` 工具安全回收。
- **目标标签与筛选（g-187）**：新增 `graph_set_goal_tags` 工具，支持为每个目标设置最多 20 个标签；看板支持按标签筛选。
- **记忆提炼与技能沉淀（g-105）**：新增 `graph_memory_add` / `graph_memory_recall` / `graph_memory_remove` / `graph_memory_replace` 四个记忆管理工具，支持按需记忆的 CRUD 操作。
- **patch / chore 微小改动类型（g-232）**：目标类型新增 `patch` 和 `chore`，区分微小修复与常规维护；`graph_set_goal_type` 同步扩展。
- **子代理 reasoning effort 配置与审计（g-231）**：支持为子代理配置 reasoning effort，`graph_start_attempt` 记录实际使用的 effort 级别，审计落盘。

### 工具总数

本版本工具总数从 28 增至 38 个（新增 `graph_set_goal_tags`、`graph_clean_worktree`、`graph_store_attachment`、`graph_delete_attachment`、`graph_memory_add`、`graph_memory_recall`、`graph_memory_remove`、`graph_memory_replace`、`graph_list_worktrees`、`graph_unbind_goal_child`）。

## 兼容性与升级

从 v0.7.3 升级无需数据迁移。既有 `.dsh-graph` 目标、卡片与事件流保持 100% 兼容。

## 发布边界

本次仅提交发布准备与版本分支合并，不执行 `npm publish`、`git tag` 或 `git push`。发布前请由负责人核验清单并手动执行发布命令。

## 排除项

- 本版本**不含**数据库迁移或外部依赖升级；
- 本版本**不含**Windows 原生适配（仍运行于 WSL2 环境）；
- 本版本**不含**分布式协作支持（仍是单用户本地模型）。
