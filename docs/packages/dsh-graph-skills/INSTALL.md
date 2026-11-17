# dsh-graph-skills 安装指南

dsh-graph 的 Agent 技能包，含两个技能：

| 技能 | 内容 | 面向 |
|---|---|---|
| `dsh-graph` | 看板用法（`graph_*` 工具、目标/判据/卡片/执行） | 执行者 / 使用者 |
| `dsh-graph-supervisor` | 主管工作指南（目标生命周期、判据门禁、人工 gate、派发与复核） | 主管 Agent |

技能只在**按需加载**时占用上下文，不常驻。

## 1. 前置要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | ≥ 22 | 安装脚本用 Node 内置模块，零依赖 |
| DeepSeek Harness | **不需要** | 技能包本身不含插件代码 |

## 2. 安装

### 全局安装（技能落到用户级技能目录）

```bash
npm install -g dsh-graph-skills
dsh-graph-skills                      # 默认装到 ${DSH_HOME:-~/.dsh}/skills
```

### 项目本地安装

```bash
npm install --save-dev --save-exact dsh-graph-skills
node ./node_modules/dsh-graph-skills/install.mjs --target ./.claude/skills
```

`--target <dir>` 指定落点；`--force` 覆盖已存在的同名技能（默认**跳过**，不覆盖你的本地修改）。

## 3. 最小验证步骤

```bash
# ① 技能文件齐全（期望：列出 2 个目录、各含 SKILL.md）
ls -1 ~/.dsh/skills | grep dsh-graph
cat ~/.dsh/skills/dsh-graph/SKILL.md | head -3

# ② 安装脚本自检（装到临时目录，不污染真实技能目录）
node ./node_modules/dsh-graph-skills/install.mjs --target /tmp/skills-check
ls /tmp/skills-check
```

实测输出（v1.0.0）：

```
dsh-graph
dsh-graph-supervisor

---
name: dsh-graph
description: dsh-graph 是把工作组织成「目标看板」的插件。你有 graph_* 工具可用：
```

`/tmp/skills-check` 下应出现 `dsh-graph/` 与 `dsh-graph-supervisor/`，各含
`SKILL.md`（中文，带 frontmatter）、`SKILL.en.md`（英文）及参考文件。

## 4. 卸载

```bash
node ./node_modules/dsh-graph-skills/install.mjs --uninstall
npm uninstall -g dsh-graph-skills     # 全局
npm uninstall dsh-graph-skills        # 项目本地
```

`--uninstall` 只删这两个技能目录，不动技能目录里的其他技能。

## 5. 常见故障排查

### 5.1 版本不匹配

本包**不依赖 DSH 与插件本体**，故无宿主版本下限；只要求 Node ≥ 22。
若技能正文与插件行为不一致（例如工具名对不上），请把本包版本与 `dsh-graph` 插件对齐到同一版本：

```bash
node -p "require('dsh-graph-skills/package.json').version"   # 期望 1.0.0
```

### 5.2 端口占用

技能包**不监听任何端口**，不涉及此问题。

### 5.3 token 缺失

技能包**不需要 token**。

### 5.4 权限问题

```bash
# 全局安装 EACCES
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"

# 安装脚本写不进技能目录
ls -ld "${DSH_HOME:-$HOME/.dsh}/skills"
```

若 `DSH_HOME` 指向只读位置，用 `--target` 指定可写目录。

### 5.5 技能没加载

技能只在**被调用时**加载（不常驻）。确认：
1. 目录名即技能名（`dsh-graph`），且目录内有 `SKILL.md`；
2. 落点确实是 DSH 读取的技能目录（`${DSH_HOME:-~/.dsh}/skills`）；
3. 会话重试后仍未出现，检查 DSH 日志中该目录是否被扫描。
