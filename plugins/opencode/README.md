# dsh-graph for OpenCode

> ## ✅ 验证状态
>
> **关键链路已在真机实测通过**（OpenCode CLI v2.0.24，可用 `scripts/g633-opencode-mcp-probe.mjs` 复跑）：
> `mcp add` 产出的配置与本目录 `opencode.json` 逐字段一致；OpenCode **确实发出**
> `Authorization: Bearer <token>`（`{env:…}` 已插值；未导出变量时退化为 `Bearer`，`${VAR}` 形态不插值）；
> 真实 `dsh-graph serve` 上的 MCP 协议往返（`initialize`/`tools/list` 11 个工具/未带头返回 401）实测通过。
> 日志路径由 `XDG_DATA_HOME` 派生（**不是硬编码**）—— 默认位置只读会 `EROFS` 崩溃，重定向到可写目录后正常启动。
> **仍未验证**：① `skills/` 是否被自动发现；② OpenCode **会话内**经 LLM 走到工具调用的链路。
> **`opencode debug config` 的 `***` 只是显示掩码**（对任意值一律生效，无鉴别力）；
> **`opencode mcp list` 输出随后台服务状态而变**（原因未查明），两者都**不作判据**。
> 详见 [INSTALL.md 顶部与 §8](./INSTALL.md)。

把本地 dsh-graph 目标看板接入 OpenCode。

本配置不复制产品代码：MCP 能力来自已安装的 `dsh-graph` CLI 启动的本地 `serve` 实例；技能正文为外部宿主专用版。

## 安装

```bash
opencode mcp add dsh-graph --url http://127.0.0.1:7788/mcp --header "Authorization=Bearer {env:DSH_GRAPH_MCP_TOKEN}" --global
```

服务需先 `dsh-graph serve init --root <绝对路径> --workspace <绝对路径>`，并把 token 注入 `DSH_GRAPH_MCP_TOKEN`。完整说明见 [INSTALL.md](./INSTALL.md)。

> **如实说明**：OpenCode 的 `plugin add` 只接受 npm / Git 包说明符，没有本地路径市场，
> 所以本目录用 `opencode mcp add` 写入配置（仍是单条命令），而不是 `plugin add`。

## 配置形状

`${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json`：

```json
{
  "mcp": {
    "servers": {
      "dsh-graph": {
        "type": "remote",
        "url": "http://127.0.0.1:7788/mcp",
        "headers": { "Authorization": "Bearer {env:DSH_GRAPH_MCP_TOKEN}" }
      }
    }
  }
}
```

`{env:...}` 是 OpenCode 原生插值语法，token 只写变量名。

## 能力边界

默认只读 11 个工具；`--allow-write` 后 38 个。人工裁决（accept / delivered / claim_supervisor / start_attempt）不可达，须回 DSH 看板或本地 GUI。

## 结构

```
opencode.json               MCP 连接配置片段（mcp.servers，token 只写 {env:VAR}）
skills/dsh-graph/SKILL.md   外部宿主版技能正文
INSTALL.md                  安装/验证/卸载/排障
LICENSE                     MIT
```

## License

MIT © 2026 miuzel
