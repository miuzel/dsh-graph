# HANDOFF（换会话交接）

> 给新 supervisor 会话的第一份阅读材料。工作目录 /home/miuzel/workspace/personal/dsh-graph。
> 你的职责指南：dsh-graph-host/supervisor-guide.md（注册为 skill `dsh-graph-supervisor`）。

## 当前状态（2026-08-22 换会话时）

### v0.3 目标看板
- **已交付**：g-107（会话内嵌）、g-108（主管栏）、g-a92e1406（状态摘要动画）、g-109（看板可写工作台）、g-112（root 通用化）、g-113（root 跟随会话 workspace）、g-116（client 并入 host 合并单包）
- **g-111（发布）**：npm 0.3.1 已发（两包），待 awesome-dsh-plugin PR 收尾（仓库需 ≥1 天 + ≥10 commits）
- **g-116（合并单包）**：本地验收通过（单包 `dsh-graph@0.4.0` 14 工具 + 看板 + 2 skill 齐备），**待发布 0.4.0**

### 进行中（下一步就干）
1. 发布单包 `dsh-graph@0.4.0`：`cd dsh-graph-host && pnpm publish --registry=https://registry.npmjs.org --no-git-checks --otp=<码>`
2. 发布后撤旧包：`npm unpublish dsh-graph-host@0.3.2` / `npm unpublish dsh-graph-client@0.3.2`（均需 OTP）
3. awesome-dsh-plugin 上架：`data/plugins/miuzel__dsh-graph.yml`，详见 docs/release-handbook.md §7

### 关键环境事实（务必记住）
- **executor provider = `deepseek-official`/deepseek-v4-flash**（「deepseek」是错名；DSH adapter 注册名是 `deepseek-official`，源码 dsh-llm-deepseek `const PROVIDER = "deepseek-official"`）
- **本地 dev 的 root 覆盖必须用相对值 `.dsh-graph`**（绝对路径会被 `path.resolve` 顶掉、破坏 workspace 跟随；host/client 两半都踩过）
- pnpm 11 supply-chain 策略在 **`pnpm-workspace.yaml`** 设 `minimumReleaseAge`（不是 .npmrc）
- 冻结脚本 R-03：执行方不得改；规划方（supervisor）可改但必须加 revision 注记
- 子代理 spawn 两个 provider 概念别混：subagent provider（spawn/fork）≠ LLM provider（agentOptions）

### 记忆
- mem-005/006/007 在 `.dsh-graph/memory/long-term/`
- mnemon 已下线；dsh-graph 自带 memory 管理在 backlog **g-105**（方案已起草，放回 backlog）

### 调试遗留
- 看板头部 DEBUG 行（`sessionId=… ws=…`）**保留**作诊断（负责人指示）
- g-114/g-115 是调试期测试目标，可删
- `.dsh-graph/memory/long-term/` 里 mem 文件是事件流外的长期记忆，supervisor 交付时继续在此沉淀

## supervisor 会话 id 变更
- 旧：session-b00ed183-bc6c-4f66-b07e-e5d909c1f46b（本会话，因 compact/token-meter 问题弃用）
- 新：见 project.yaml 的 `supervisor.session`（换会话后由负责人更新）
