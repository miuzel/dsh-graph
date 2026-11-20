# goal-graph-service

goal-graph 本地服务（默认**只读**）：同一进程提供 Web App（`/`）、Web API（`/api/…`）与
localhost MCP endpoint（`POST /mcp`）。只绑定 `127.0.0.1`，每个请求校验 peer / Host / Origin，
MCP 每请求先验 `Authorization: Bearer` 再解析业务。

自包含，不依赖其他包。命令行入口由 `goal-graph-cli` 的 `goal-graph serve` 提供，
或 `import { runServeCommand } from "goal-graph-service"`。

完整安装、验证与排障见 **INSTALL.md**。
