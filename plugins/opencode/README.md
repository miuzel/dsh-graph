# goal-graph for OpenCode

> ## ✅ 验证状态
>
> **关键链路已在真机实测通过**（OpenCode CLI v2.0.24，可用 `scripts/g633-opencode-mcp-probe.mjs` 复跑）：
> 零配置 stdio `opencode mcp add goal-graph --global -- goal-graph mcp` 产出与本目录 `opencode.json` 逐字段一致，OpenCode 实测**真实拉起** `goal-graph mcp` 子进程（默认 38 读写工具、`--read-only` 11 只读工具 + 自动随机端口本地 Web 看板）；
> 进阶显式 HTTP 模式下 `{env:…}` 插值与 `goal-graph serve` 往返也全部实测通过。
> 日志路径由 `XDG_DATA_HOME` 派生（**不是硬编码**）—— 默认位置只读会 `EROFS` 崩溃，重定向到可写目录后正常启动。
> **仍未验证**：① `skills/` 是否被自动发现；② OpenCode **会话内**经 LLM 走到工具调用的链路。
> **`opencode debug config` 的 `***` 只是显示掩码**（无鉴别力）；**`opencode mcp list` 输出随后台服务状态而变**（原因未查明），两者都**不作判据**。
> 详见 [INSTALL.md 顶部与 §8](./INSTALL.md)。

把本地 goal-graph 目标看板接入 OpenCode。

本配置不复制产品代码：默认采用**零配置 stdio MCP**，由 OpenCode 在当前工作区自动拉起已安装的 `goal-graph mcp`（默认 38 个读写工具，并按工作区以 `127.0.0.1:0` 自动分配空闲端口起/复用本地 Web 看板，退出自动回收）；技能正文为外部宿主专用版。

## 安装

```bash
npm install -g goal-graph-cli
opencode mcp add goal-graph --global -- goal-graph mcp
```

无需手动运行 `goal-graph serve`、无需固定端口 `7788`、无需 `export GOAL_GRAPH_MCP_TOKEN`。完整验证、只读选项、进阶显式 HTTP 模式与排障见 [INSTALL.md](./INSTALL.md)。

> **如实说明**：OpenCode 的 `plugin add` 只接受 npm / Git 包说明符，没有本地路径市场，
> 所以本目录用 `opencode mcp add` 写入配置（仍是单条命令），而不是 `plugin add`。

## 配置形状

`${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "goal-graph": {
        "type": "local",
        "command": ["goal-graph", "mcp"]
      }
    }
  }
}
```

## 能力边界

- **零配置 stdio 默认（`goal-graph mcp`）**：38 个读写工具（固定 actor `mcp:local-service`），可推进到 `review`。
- **只读模式（`goal-graph mcp --read-only` / 显式 `goal-graph serve`）**：11 个查询工具。
- **人工裁决保留**：`graph_resolve_accept`、`transition → delivered`、`graph_claim_supervisor`、`graph_start_attempt` 在任何模式下均不可达，须回 DSH 看板或本地 GUI 裁决。

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
opencode.json               零配置 stdio MCP 配置片段（mcp.servers, type: "local"）
skills/goal-graph/SKILL.md  外部宿主版技能正文
INSTALL.md                  安装/验证/进阶 HTTP/卸载/排障/实测记录
LICENSE                     MIT
```

## License

MIT © 2026 miuzel
