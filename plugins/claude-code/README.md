# goal-graph (Claude Code plugin)

把本地 **goal-graph** 目标看板接入 Claude Code：插件同时提供看板 MCP 工具与**外部宿主版**技能正文，让 Claude 能读（并可选地写）看板上的目标、判据、卡片与完成摘要。

本插件**不复制**任何产品代码或技能正文实体：MCP 能力来自你已安装的 `goal-graph` CLI（`goal-graph-cli`）启动的本地 `serve` 实例，技能正文是专为外部宿主裁剪过的版本（不含 DSH 插件版里 Claude 做不到的指引）。

## 安装

```bash
claude plugin marketplace add /path/to/dsh-graph/plugins/claude-code
claude plugin install goal-graph@goal-graph -y
```

服务需先在目标项目 `goal-graph serve init --root <绝对路径> --workspace <绝对路径>`，并把凭据文件里的 token 注入 `GOAL_GRAPH_MCP_TOKEN`。完整前置、验证、卸载与排障见 [INSTALL.md](./INSTALL.md)。

## 能力边界

- **默认只读**：11 个查询工具。
- **`--allow-write` 后**：再加 27 个写工具，可推进到 `review`。
- **人工裁决保留**：`graph_resolve_accept`、`transition → delivered`、`graph_claim_supervisor`、`graph_start_attempt` 不可达 —— 必须回 DSH 看板或本地 GUI 裁决。

### 文档守卫的能力边界（请勿再试图穷尽）

> 本守卫保证「登记表声明的未验证结论在**结论列**与**证据列**存在且未被否定」，
> **不保证**「文档任何位置都没有自相矛盾的肯定式表述」——后者无法用文本守卫穷尽，
> 依赖评审与 `scripts/g633-opencode-mcp-probe.mjs` 实测。

守卫（`core/tests/g633-host-plugins.test.ts`）只守 §8 表格的**行列语义**；表格**之外**段落的
肯定式小结（如「已在本地跑通」）守卫看不见，`⑧b-e1` 已把这条漏放固化为已知边界。
这是有意划定的能力上限，不是待补缺口 —— 发现这类矛盾请用探针实测取证并直接修文档。

## 结构

```
.claude-plugin/plugin.json      插件清单（声明 mcpServers 指向 ./.mcp.json）
.claude-plugin/marketplace.json 单插件市场（本地路径可直接 add）
.mcp.json                       MCP 连接（token 只写 ${GOAL_GRAPH_MCP_TOKEN}，不含字面量）
skills/goal-graph/SKILL.md      外部宿主版技能正文
INSTALL.md                      安装/验证/卸载/排障
LICENSE                         MIT
```

## License

MIT © 2026 miuzel
