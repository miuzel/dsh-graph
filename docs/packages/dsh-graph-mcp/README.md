# dsh-graph-mcp

把 dsh-graph 的只读看板 MCP endpoint 接入外部 Agent，并生成三宿主配置：

```bash
npx dsh-graph-mcp all --port 7801        # Claude Code / Codex / OpenCode 三段配置
npx dsh-graph-mcp all --check            # 自检：只引用环境变量，无 token 字面量
```

三宿主配置均指向**同一** `http://127.0.0.1:<port>/mcp`；token **绝不写进配置文件**，
只写环境变量名（`${VAR}` / `bearer_token_env_var` / `{env:VAR}` 三种宿主原生语法）。

完整说明见 **INSTALL.md**。
