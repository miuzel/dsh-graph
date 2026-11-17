# dsh-graph 安装指南

DSH 插件本体：提供 `graph_*` 工具（目标 / 判据 / 卡片 / 执行）与二维泳道看板。

**只装这一个包就能用完整的看板能力**，不需要先装 CLI / 服务 / 技能 / MCP。

## 1. 前置要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | ≥ 22 | `node -v` 自查 |
| DeepSeek Harness | `>=0.2.2-rc.3 <0.2.3-0` | 插件宿主；版本不匹配时插件不加载 |
| 操作系统 | Linux / macOS / Windows | Windows 未在本轮验证（见「故障排查」） |

> DSH 版本下限由本包 `package.json` 的 `engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh-settings"]`
> **逐字相等**地声明，两者任一不满足都会被宿主的插件解析拒绝。

## 2. 安装

### 全局安装（推荐：所有项目共用）

```bash
npm install -g dsh-graph
```

然后在 DSH 配置里启用插件（DSH 的 profile / 插件清单按宿主的常规插件条目写法
`dsh-graph` 即可，宿主会读取包内 `cordis.patch.yml` 与 `dsh` 字段）。

### 项目本地安装（推荐：版本随项目走）

```bash
npm install --save-exact dsh-graph
```

安装后包本体位于 `node_modules/dsh-graph/`；项目内 CLI（若另装了 `dsh-graph-cli`）可直接调用。

## 3. 最小验证步骤

装完**必须**确认它真的能工作，三步都要过：

```bash
# ① 包结构与版本（期望输出各含 1.0.0）
node -p "require('dsh-graph/package.json').version"

# ② 插件入口可加载（期望输出 "OK 68"）
node -e "import('dsh-graph').then(m=>console.log('OK', Object.keys(m).length))"

# ③ 插件资产齐全（期望输出 prompts=56 diagrams=6）
node -e "const fs=require('fs'),p=require.resolve('dsh-graph/package.json'),d=p.replace(/package\.json$/,'');console.log('prompts='+fs.readdirSync(d+'prompts').length,'diagrams='+fs.readdirSync(d+'diagrams').length)"
```

实测输出（v1.0.0）：

```
1.0.0
OK 68
prompts=56 diagrams=6
```

然后在运行中的 DSH 会话里执行任一 `graph_*` 工具（如 `graph_list_goals`）——能返回目标列表
（空看板返回空数组）即证明插件已加载并连通。

## 4. 卸载

```bash
npm uninstall -g dsh-graph          # 全局安装
npm uninstall dsh-graph             # 项目本地安装
```

看板数据在项目内的 `.dsh-graph/`，**卸载包不会删除数据**；如需一并清理请手工删除该目录。

## 5. 常见故障排查

### 5.1 版本不匹配

**症状**：宿主报插件加载失败，或 `npm ls` 提示 peer 冲突。

```bash
node -p "require('dsh-graph/package.json').engines"
npm ls @deepseek-ai/dsh-settings
```

要求 DSH 满足 `>=0.2.2-rc.3 <0.2.3-0`。低于下限请升级 DSH；**高于上限（0.2.3-0 及以上）
本包未经适配，宿主应拒绝加载**——这是刻意的窄范围声明，不是 bug。

### 5.2 端口占用

本包本体**不监听任何端口**。若同时装了 `dsh-graph-service` 并启动报端口占用：

```bash
ss -ltnp | grep <端口号>       # Linux
lsof -i :<端口号>              # macOS
```

换端口（`--port 7801`）或先停掉占用进程。服务**不会**抢占已占用端口，也不会静默回退。

### 5.3 token 缺失

本包本体**不需要 token**。token 只属于 `dsh-graph-service` / `dsh-graph-mcp`
（MCP endpoint 的 `Authorization: Bearer`）。若在外部 Agent 里遇到 401，请见对应包的安装指南。

### 5.4 权限问题

```bash
# 全局安装报 EACCES：不要用 sudo，改为用户级前缀
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
npm install -g dsh-graph
```

### 5.5 `prompts=0` 或报 `prompt asset missing or unreadable`

说明包内资产缺失（通常是打包不完整）。重新安装本包；若仍失败，请附
`node -p "require.resolve('dsh-graph')"` 的输出报 issue。插件正文在**每次调用时现读**
`prompts/*.md`，缺资产会明确报错，不会静默降级为空正文。
