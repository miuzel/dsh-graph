# dsh-graph-cli 安装指南

dsh-graph 命令行：`info` / `status` / `goal list|show` / `version` / `sync` / `claim` / `submit` / `serve`。

**自包含**：本包把所需的全部 core 运行时与提示词资产都打进了 tarball，**不依赖** `dsh-graph` 插件本体
或其他包。只装它就能直接操作看板。

## 1. 前置要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | ≥ 22 | `node -v` 自查 |
| 一个 dsh-graph 看板工作区 | `.dsh-graph/` 目录 | 命令默认从 cwd 向上查找；也可用 `--root` 指定 |
| DeepSeek Harness | **不需要** | 本包独立运行，不依赖 DSH |

## 2. 安装

### 全局安装

```bash
npm install -g dsh-graph-cli
dsh-graph version
```

### 项目本地安装

```bash
npm install --save-dev --save-exact dsh-graph-cli
npx dsh-graph version          # 或 ./node_modules/.bin/dsh-graph version
```

## 3. 最小验证步骤

在**含 `.dsh-graph/` 的项目根**执行：

```bash
# ① 版本（期望：dsh-graph 1.0.0 (node v…)
dsh-graph version

# ② 环境自检（期望：initialized: yes 与若干「可读」行）
dsh-graph info

# ③ 看板只读状态（期望：JSON，含目标数/事件数）
dsh-graph status --json
```

实测输出（v1.0.0，节选）：

```
dsh-graph 1.0.0 (node v26.7.0)
node:            v26.7.0
graph root:      /path/to/project/.dsh-graph
workspace:       /path/to/project（mode=main-tree）
initialized:     yes
```

> 默认命令（`info` / `status` / `goal list` / `goal show` / `version`）**全部只读**：
> 不创建 `.dsh-graph`、不写事件、不建目录。会写文件的只有 `sync` / `claim` / `submit`。

## 4. 卸载

```bash
npm uninstall -g dsh-graph-cli     # 全局
npm uninstall dsh-graph-cli        # 项目本地
```

CLI 本身**不在看板里留任何状态**；卸载不会删除 `.dsh-graph/`。

## 5. 常见故障排查

### 5.1 版本不匹配

本包只要求 Node ≥ 22，**不要求 DSH**。若 `dsh-graph version` 报语法错误或
`ERR_UNKNOWN_FILE_EXTENSION`，通常是 Node 过旧：

```bash
node -v                            # 必须 ≥ v22
node -p "require('dsh-graph-cli/package.json').engines"
```

若你同时装了插件本体，两者版本号应一致（均为 `1.0.0`），以便命令语义与看板格式对齐。

### 5.2 端口占用

只有 `dsh-graph serve` 子命令会监听端口（底层即 `dsh-graph-service` 的能力）。
启动报「端口不可用（EADDRINUSE）」时：

```bash
ss -ltnp | grep <端口号>            # Linux
lsof -i :<端口号>                   # macOS
```

CLI **不会**抢占已占用端口、也不会静默回退到别的端口——必须显式换 `--port`。

### 5.3 token 缺失

`info` / `status` / `goal` / `sync` / `claim` / `submit` **都不需要 token**。
仅 `serve`（MCP endpoint）需要：token 由 `dsh-graph serve init` 生成到 0600 凭据文件。
详见 `dsh-graph-service` 的安装指南。

### 5.4 权限问题

- 全局安装 EACCES：改用用户级前缀
  ```bash
  npm config set prefix ~/.npm-global
  export PATH="$HOME/.npm-global/bin:$PATH"
  npm install -g dsh-graph-cli
  ```
- `serve init` 报「私有状态目录权限过宽（755），要求 0700」：
  ```bash
  chmod 700 <state-dir>
  ```
  这是刻意的安全校验（凭据文件必须 0600、其目录必须 0700），不是可以绕过的噪音。

### 5.5 「非 dsh-graph 工作区」

```
dsh-graph: 当前目录 /tmp 及其所有祖先目录都没有 .dsh-graph（非 dsh-graph 工作区）
```

在项目根运行，或显式指定：`dsh-graph info --root /path/to/.dsh-graph`。
CLI **不会**回落到用户全局配置去猜看板位置。
