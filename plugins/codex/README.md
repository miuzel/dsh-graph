# goal-graph for Codex

把本地 goal-graph 目标看板接入 Codex CLI。

本插件不复制产品代码：默认采用**零配置 stdio MCP**，由 Codex 在当前工作区自动拉起已安装的 `goal-graph mcp`（默认 38 个读写工具，并按工作区以 `127.0.0.1:0` 自动分配空闲端口起/复用本地 Web 看板，退出自动回收）；技能正文为外部宿主专用版。

## 安装

```bash
npm install -g goal-graph-cli
codex plugin marketplace add /path/to/dsh-graph/plugins/codex
codex plugin add goal-graph@goal-graph
```

无需手动运行 `goal-graph serve`、无需固定端口 `7788`、无需 `export GOAL_GRAPH_MCP_TOKEN`。完整验证、只读选项、进阶显式 HTTP 模式与排障见 [INSTALL.md](./INSTALL.md)。

## 能力边界

- **零配置 stdio 默认（`goal-graph mcp`）**：38 个读写工具（固定 actor `mcp:local-service`），可推进到 `review`。
- **只读模式（`goal-graph mcp --read-only` / 显式 `goal-graph serve`）**：11 个查询工具。
- **人工裁决保留**：`graph_resolve_accept`、`transition → delivered`、`graph_claim_supervisor`、`graph_start_attempt` 在任何模式下均不可达，须回 DSH 看板或本地 GUI 裁决。

### 文档守卫的能力边界（请勿再试图穷尽）

> 本守卫保证「登记表声明的未验证结论在**结论列**与**证据列**存在且未被否定」，
> **不保证**「文档任何位置都没有自相矛盾的肯定式表述」——后者无法用文本守卫穷尽，
> 依赖评审与 `scripts/g633-opencode-mcp-probe.mjs` 实测。

守卫（`core/tests/g633-host-plugins.test.ts`）只守 §8 表格的**行列语义**；表格**之外**段落的
肯定式小结（如「已在本地跑通」）守卫看不见，`⑧b-e1` 已把这条漏放固化为已知边界。
这是有意划定的能力上限，不是待补缺口 —— 发现这类矛盾请用探针实测取证并直接修文档。

## 结构

```
.claude-plugin/plugin.json       插件清单
.claude-plugin/marketplace.json  市场清单
.mcp.json                        零配置 stdio MCP（command: goal-graph, args: ["mcp"]，不含 token）
skills/goal-graph/SKILL.md       外部宿主版技能正文
INSTALL.md                       安装/验证/进阶 HTTP/卸载/排障/验证状态
LICENSE                          MIT
```

## License

MIT © 2026 miuzel
