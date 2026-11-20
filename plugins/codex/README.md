# goal-graph for Codex

把本地 goal-graph 目标看板接入 Codex CLI。

本插件不复制产品代码：MCP 能力来自已安装的 `goal-graph` CLI（`goal-graph-cli`）启动的本地 `serve` 实例；技能正文为外部宿主专用版。

## 安装

```bash
codex plugin marketplace add /path/to/dsh-graph/plugins/codex
codex plugin add goal-graph@goal-graph
```

服务需先 `goal-graph serve init --root <绝对路径> --workspace <绝对路径>`，并把 token 注入 `GOAL_GRAPH_MCP_TOKEN`。完整说明见 [INSTALL.md](./INSTALL.md)。

## 与 Claude Code 版的关键差异

Claude Code 用 `headers` + `${VAR}` 插值；**Codex 的插件 MCP schema 不承载认证字段以外的那套写法**，
`headers` / `env_http_headers` 在运行时都**不发送**认证头（实测服务端收到 `undefined`）。Codex 用原生字段：

```json
"bearer_token_env_var": "GOAL_GRAPH_MCP_TOKEN"
```

它发送 `Authorization: Bearer <token>`，正是本服务接受的形式。token 只写变量名，不含字面量。

> `codex mcp get` 只回显静态配置，即使头被丢弃也照样显示"已配置" —— 判别性验证见 [INSTALL.md §5](./INSTALL.md#5-最小验证判别性必须看到实际认证结果)。

## 能力边界

默认只读 11 个工具；`--allow-write` 后 38 个。人工裁决（accept / delivered / claim_supervisor / start_attempt）不可达，须回 DSH 看板或本地 GUI。

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
.mcp.json                        MCP 连接（bearer_token_env_var，token 只写变量名）
skills/goal-graph/SKILL.md       外部宿主版技能正文
INSTALL.md                        安装/验证/卸载/排障
LICENSE                           MIT
```

## License

MIT © 2026 miuzel
