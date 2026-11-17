# dsh-graph-service

dsh-graph 本地**只读**服务：同一进程提供 Web App（`/`）、Web API（`/api/…`）与
localhost MCP endpoint（`POST /mcp`）。只绑定 `127.0.0.1`，每个请求校验 peer / Host / Origin，
MCP 每请求先验 `Authorization: Bearer` 再解析业务。

自包含，不依赖其他 dsh-graph 包。命令行入口由 `dsh-graph-cli` 的 `dsh-graph serve` 提供，
或 `import { runServeCommand } from "dsh-graph-service"`。

完整安装、验证与排障见 **INSTALL.md**。
