# dsh-graph (Claude Code plugin)

把本地 **dsh-graph** 目标看板接入 Claude Code：插件同时提供看板 MCP 工具与**外部宿主版**技能正文，让 Claude 能读（并可选地写）看板上的目标、判据、卡片与完成摘要。

本插件**不复制**任何产品代码或技能正文实体：MCP 能力来自你已安装的 `dsh-graph` CLI 启动的本地 `serve` 实例，技能正文是专为外部宿主裁剪过的版本（不含 DSH 插件版里 Claude 做不到的指引）。

## 安装

```bash
claude plugin marketplace add /path/to/dsh-graph/plugins/claude-code
claude plugin install dsh-graph@dsh-graph -y
```

服务需先在目标项目 `dsh-graph serve init --root <绝对路径> --workspace <绝对路径>`，并把凭据文件里的 token 注入 `DSH_GRAPH_MCP_TOKEN`。完整前置、验证、卸载与排障见 [INSTALL.md](./INSTALL.md)。

## 能力边界

- **默认只读**：11 个查询工具。
- **`--allow-write` 后**：再加 27 个写工具，可推进到 `review`。
- **人工裁决保留**：`graph_resolve_accept`、`transition → delivered`、`graph_claim_supervisor`、`graph_start_attempt` 不可达 —— 必须回 DSH 看板或本地 GUI 裁决。

## 结构

```
.claude-plugin/plugin.json      插件清单（声明 mcpServers 指向 ./.mcp.json）
.claude-plugin/marketplace.json 单插件市场（本地路径可直接 add）
.mcp.json                       MCP 连接（token 只写 ${DSH_GRAPH_MCP_TOKEN}，不含字面量）
skills/dsh-graph/SKILL.md       外部宿主版技能正文
INSTALL.md                      安装/验证/卸载/排障
LICENSE                         MIT
```

## License

MIT © 2026 miuzel
