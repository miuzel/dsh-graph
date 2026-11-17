# dsh-graph for Codex

把本地 dsh-graph 目标看板接入 Codex CLI。

本插件不复制产品代码：MCP 能力来自已安装的 `dsh-graph` CLI 启动的本地 `serve` 实例；技能正文为外部宿主专用版。

## 安装

```bash
codex plugin marketplace add /path/to/dsh-graph/plugins/codex
codex plugin add dsh-graph@dsh-graph
```

服务需先 `dsh-graph serve init --root <绝对路径> --workspace <绝对路径>`，并把 token 注入 `DSH_GRAPH_MCP_TOKEN`。完整说明见 [INSTALL.md](./INSTALL.md)。

## 与 Claude Code 版的关键差异

Claude Code 用 `headers` + `${VAR}` 插值；**Codex 的插件 MCP schema 不承载认证字段以外的那套写法**，
`headers` / `env_http_headers` 在运行时都**不发送**认证头（实测服务端收到 `undefined`）。Codex 用原生字段：

```json
"bearer_token_env_var": "DSH_GRAPH_MCP_TOKEN"
```

它发送 `Authorization: Bearer <token>`，正是本服务接受的形式。token 只写变量名，不含字面量。

> `codex mcp get` 只回显静态配置，即使头被丢弃也照样显示"已配置" —— 判别性验证见 [INSTALL.md §5](./INSTALL.md#5-最小验证判别性必须看到实际认证结果)。

## 能力边界

默认只读 11 个工具；`--allow-write` 后 38 个。人工裁决（accept / delivered / claim_supervisor / start_attempt）不可达，须回 DSH 看板或本地 GUI。

## 结构

```
.claude-plugin/plugin.json       插件清单
.claude-plugin/marketplace.json  市场清单
.mcp.json                        MCP 连接（bearer_token_env_var，token 只写变量名）
skills/dsh-graph/SKILL.md        外部宿主版技能正文
INSTALL.md                        安装/验证/卸载/排障
LICENSE                           MIT
```

## License

MIT © 2026 miuzel
