# goal-graph for OpenCode

> ## ✅ 验证状态
>
> **关键链路已在真机实测通过**（OpenCode CLI v2.0.24，可用 `scripts/g633-opencode-mcp-probe.mjs` 复跑）：
> `mcp add` 产出的配置与本目录 `opencode.json` 逐字段一致；OpenCode **确实发出**
> `Authorization: Bearer <token>`（`{env:…}` 已插值；未导出变量时退化为 `Bearer`，`${VAR}` 形态不插值）；
> 真实 `goal-graph serve` 上的 MCP 协议往返（`initialize`/`tools/list` 11 个工具/未带头返回 401）实测通过。
> 日志路径由 `XDG_DATA_HOME` 派生（**不是硬编码**）—— 默认位置只读会 `EROFS` 崩溃，重定向到可写目录后正常启动。
> **仍未验证**：① `skills/` 是否被自动发现；② OpenCode **会话内**经 LLM 走到工具调用的链路。
> **`opencode debug config` 的 `***` 只是显示掩码**（对任意值一律生效，无鉴别力）；
> **`opencode mcp list` 输出随后台服务状态而变**（原因未查明），两者都**不作判据**。
> 详见 [INSTALL.md 顶部与 §8](./INSTALL.md)。

把本地 goal-graph 目标看板接入 OpenCode。

本配置不复制产品代码：MCP 能力来自已安装的 `goal-graph` CLI（`goal-graph-cli`）启动的本地 `serve` 实例；技能正文为外部宿主专用版。

## 安装

```bash
opencode mcp add goal-graph --url http://127.0.0.1:7788/mcp --header "Authorization=Bearer {env:GOAL_GRAPH_MCP_TOKEN}" --global
```

服务需先 `goal-graph serve init --root <绝对路径> --workspace <绝对路径>`，并把 token 注入 `GOAL_GRAPH_MCP_TOKEN`。完整说明见 [INSTALL.md](./INSTALL.md)。

> **如实说明**：OpenCode 的 `plugin add` 只接受 npm / Git 包说明符，没有本地路径市场，
> 所以本目录用 `opencode mcp add` 写入配置（仍是单条命令），而不是 `plugin add`。

## 配置形状

`${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json`：

```json
{
  "mcp": {
    "servers": {
      "goal-graph": {
        "type": "remote",
        "url": "http://127.0.0.1:7788/mcp",
        "headers": { "Authorization": "Bearer {env:GOAL_GRAPH_MCP_TOKEN}" }
      }
    }
  }
}
```

`{env:...}` 是 OpenCode 原生插值语法，token 只写变量名。

## 能力边界

默认只读 11 个工具；`--allow-write` 后 38 个。人工裁决（accept / delivered / claim_supervisor / start_attempt）不可达，须回 DSH 看板或本地 GUI。

### 文档守卫的能力边界（请勿再试图穷尽）

> 本守卫保证「登记表声明的未验证结论在**结论列**与**证据列**存在且未被否定」，
> **不保证**「文档任何位置都没有自相矛盾的肯定式表述」——后者无法用文本守卫穷尽，
> 依赖评审与 `scripts/g633-opencode-mcp-probe.mjs` 实测。

也就是说：§8 表格**行列语义**（结论讲什么、证据是否仍在说「未证实」、每行恰好 3 列）由
`core/tests/g633-host-plugins.test.ts` 的 ⑧b 守住；但表格**之外**的段落若写「已在本地跑通」这类
肯定式小结，守卫**看不见**（`⑧b-e1` 把这条漏放固化下来）。这是有意的边界，不是待补的缺口 ——
补词表只是把地鼠洞挪到下一条措辞。**发现这类矛盾时，请用上面的探针实测取证并直接修文档。**

## 结构

```
opencode.json               MCP 连接配置片段（mcp.servers，token 只写 {env:VAR}）
skills/goal-graph/SKILL.md  外部宿主版技能正文
INSTALL.md                  安装/验证/卸载/排障
LICENSE                     MIT
```

## License

MIT © 2026 miuzel
