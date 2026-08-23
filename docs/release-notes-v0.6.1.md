# dsh-graph v0.6.1 Release Notes

> 发布日期：2026-08-24
> 前序版本：v0.5.2
> 主题：版本泳道生命周期、数据仓库解耦、上下文卡片增强、客户端可维护性重构

---

## 拟纳入的已交付目标

| 目标 | 标题 | 关键变化 |
|------|------|----------|
| **g-142** | client.js 重构 | 将单体 `client.js` 拆分为 14 个职责模块（`kanban.js`、`goal-modal.js`、`card-drawer.js` 等），新增 `scripts/build-client.sh` 构建链路，Generated File Policy 防止直接编辑产物 |
| **g-134** | 版本泳道管理 | 支持创建、重命名、删除空版本泳道；版本详情弹窗（含重命名/删除按钮）；版本元数据与看板操作入口 |
| **g-135** | 版本泳道发布 | 发布 gate：版本下所有目标须处于 delivered 状态方可标记 released；记录 `version.released` 事件 |
| **g-149** | .dsh-graph 数据仓库解耦 | `.dsh-graph` 从主代码仓库移入独立内层 Git 仓库；`events.jsonl` 跟踪；父仓库 `.gitignore` 排除；提供迁移脚本 `migrate-dsh-graph-repo.sh`；canonical root 解析消除 `process.cwd()` 回退 |
| **g-150** | 执行 attempt handoff | `graph_start_attempt` 注入前序失败与返工约束；goal directive、comments 支持；单文件 handoff 简化 |
| **g-151** | 上下文卡片收集提示词 UX 改进 | 收集提示词编辑框高度增大；卡片抽屉 UX 优化 |
| **g-152** | 阻塞列折叠交互优化 | 阻塞列折叠/展开改为点击列标题触发，不再独占一行按钮 |
| **g-154** | 上下文卡片 Markdown 文件入口 | 上下文卡片支持 Markdown 文件类型的入口 |
| **g-148** | bugfix: ready 阶段 GUI 执行报错 | 修复 `load is not defined` 错误；新增 `onRefresh` 模块 source/bundle 契约回归测试 |
| **g-145** | 收集子代理上下文注入 | 明确绑定卡片与 `graph_fill_card` 回填指令 |
| **g-147** | 版本归属迁移保留生命周期状态 | `moveGoal` standalone↔version 迁移时保留生命周期状态 |
| **g-128** | GUI 卡片管理 | 上下文卡片新增/删除/归档 + 添加弹窗（kind 可选） |

## 明确排除的未交付目标

| 目标 | 标题 | 状态 | 排除原因 |
|------|------|------|----------|
| **g-146** | 上下文卡片中允许用户重新发起信息收集 | planning | 未交付，留待后续版本 |
| **g-153** | 暗色界面按钮文字配色与对比度统一 | planning | 未交付，留待后续版本 |
| **g-143** | 跨会话认领 planning/collecting/ready 目标 | 未纳入 | 负责人决定不纳入 v0.6 |
| **g-138** | 目标暂缓 | 暂缓 | 后续版本再安排 |
| **g-139** | 目标合并 | 暂缓 | 后续版本再安排 |
| **g-132/g-133** | 配置管理 | 暂缓 | 范围较宽，留待后续 |
| **g-136** | 项目级子代理规则 | 暂缓 | 需先消除重叠 |

## 升级/迁移说明

### 从 v0.5.x 升级

1. **`.dsh-graph` 数据仓库解耦（g-149）**

   v0.6.1 将 `.dsh-graph` 目录从父代码仓库中解耦为独立内层 Git 仓库。这是最重要的升级变化：

   - 父仓库的 `.gitignore` 已包含 `/.dsh-graph/`，父仓库不再跟踪看板数据
   - `.dsh-graph/events.jsonl` 和目标文件由内层 Git 仓库独立管理
   - **内层仓库默认无 remote**——数据仍在本地，remote/push 需显式配置
   - 提供迁移脚本：`bash scripts/migrate-dsh-graph-repo.sh`

   **升级步骤**：

   ```sh
   # 1. 更新 dsh-graph 插件
   dsh plugin update dsh-graph

   # 2. 如已有 .dsh-graph 目录且需要迁移到独立仓库结构
   bash <plugin-root>/scripts/migrate-dsh-graph-repo.sh
   ```

2. **客户端代码重构（g-142）**

   `lib/client.js` 现在由模块化源文件构建生成（`scripts/build-client.sh`）。用户侧无感知变化——产物路径和加载契约不变。但如果你 fork 或直接修改过 `client.js`，需要迁移到对应的源模块（见 `lib/client/*.js`）。

3. **无破坏性 API 变更**

   所有 `graph_*` 工具、REST 端点、看板行为保持向后兼容。新增功能（版本管理、handoff、卡片管理）为纯增量。

### 从 v0.4.x 升级

除上述 v0.5.x 变化外，还需注意 v0.5.x 系列引入的变化：
- 版本泳道管理（创建/重命名/删除）
- 目标拖拽排序
- 建目标工具、append 规范、主管提醒等

## 已知限制

1. **内层 .dsh-graph 仓库无 remote**：默认仅本地存储，负责人需自行配置 remote 实现云端同步/备份
2. **客户端单文件产物**：虽已拆分为模块化源文件，但发布包中 `client.js` 仍是合并后的单文件——浏览器加载不支持 ES module 分发
3. **worktree 隔离限制**：graph_* 工具在 linked worktree 中写 `.dsh-graph` 数据时会使用 canonical root 解析回主工作树；极少数边界场景（worktree 路径含特殊字符）可能有兼容性问题

## 回退说明

如需回退到 v0.5.2：

```sh
# 1. 降级插件版本
cd <dsh-plugin-directory>
pnpm add dsh-graph@0.5.2

# 2. .dsh-graph 数据兼容性
# v0.5.2 与 v0.6.1 的 events.jsonl 格式兼容，无需数据迁移
# 但 v0.6.1 新增的事件类型（version.released 等）在 v0.5.2 中会被忽略
```

> 注意：如果已在 v0.6.1 中使用了版本发布功能（g-135 的 `version.released` 事件），回退后这些事件仍然存在于 events.jsonl 中但不被 v0.5.2 解析——不影响数据完整性，但版本发布状态不会显示。
