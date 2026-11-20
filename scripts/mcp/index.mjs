/**
 * goal-graph-mcp —— MCP 适配器与三宿主配置生成（g-631 / g-634 / g-637）。
 *
 * 两种传输形态：
 *   1. **默认零配置 `stdio`（g-637）**：三宿主直接拉起当前工作区的 `goal-graph mcp`
 *      （无需手动起 `serve`、无需固定端口 7788、无需 `export GOAL_GRAPH_MCP_TOKEN`；
 *      默认 38 个读写工具，`--read-only` 切回 11 只读工具；同时按工作区自动起/复用随机端口本地 Web 看板）。
 *   2. **显式 `http`（`--transport http [--port <p>]`）**：连接显式 `goal-graph serve` 端点，
 *      三宿主共用 `baseUrl()` 推导的单一 endpoint，**token 绝不写进配置文件**：
 *        · Claude Code（`.mcp.json` / `~/.claude.json`）：`${VAR}` 展开 ⇒ `Authorization: Bearer ${VAR}`
 *        · Codex（`~/.codex/config.toml`）：`bearer_token_env_var = "VAR"`
 *        · OpenCode（`opencode.json`）：`mcp.servers.goal-graph` + `{env:VAR}` 插值 ⇒ `Authorization: Bearer {env:VAR}`
 */

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7788;
export const DEFAULT_TOKEN_ENV = "GOAL_GRAPH_MCP_TOKEN";
export const DEFAULT_TRANSPORT = "stdio";
export const TRANSPORTS = ["stdio", "http"];
export const DEFAULT_STDIO_COMMAND = "goal-graph";
export const DEFAULT_STDIO_ARGS = ["mcp"];
export const SERVER_KEY = "goal-graph";
/** 服务端只允许数值回环绑定（见 core/service/policy.ts）；生成器也坚持这一点。 */
export const ALLOWED_HOST = "127.0.0.1";

export class McpConfigError extends Error {}

function assertTransport(transport) {
  if (!TRANSPORTS.includes(transport)) {
    throw new McpConfigError(`未知传输模式：${transport}（可选：${TRANSPORTS.join(", ")}）`);
  }
  return transport;
}

function stdioArgs({ readOnly = false } = {}) {
  return readOnly ? [...DEFAULT_STDIO_ARGS, "--read-only"] : [...DEFAULT_STDIO_ARGS];
}

/** 校验并给出 MCP endpoint 基址（HTTP 模式三宿主共用；不带 /mcp 后缀）。 */
export function baseUrl({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  if (host !== ALLOWED_HOST) {
    throw new McpConfigError(`host 只允许 ${ALLOWED_HOST}（服务端只绑定数值回环，拒绝 ${host}）`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new McpConfigError(`port 必须是 1..65535 的整数（收到 ${port}）`);
  }
  return `http://${host}:${port}`;
}

/** MCP HTTP endpoint（HTTP 模式三宿主配置里的 url 字段值，逐字相同）。 */
export function mcpEndpoint(opts = {}) {
  return `${baseUrl(opts)}/mcp`;
}

function assertTokenEnv(tokenEnv) {
  if (typeof tokenEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) {
    throw new McpConfigError(`tokenEnv 必须是合法的环境变量名（收到 ${JSON.stringify(tokenEnv)}）`);
  }
}

/**
 * Claude Code `.mcp.json` 片段。
 * 默认 `transport="stdio"`（零配置直连 `goal-graph mcp`）；`transport="http"` 生成显式 HTTP + `${VAR}`。
 */
export function claudeCodeConfig({
  transport = DEFAULT_TRANSPORT,
  readOnly = false,
  tokenEnv = DEFAULT_TOKEN_ENV,
  ...opts
} = {}) {
  assertTransport(transport);
  if (transport === "stdio") {
    return {
      mcpServers: {
        [SERVER_KEY]: {
          type: "stdio",
          command: DEFAULT_STDIO_COMMAND,
          args: stdioArgs({ readOnly }),
        },
      },
    };
  }
  assertTokenEnv(tokenEnv);
  return {
    mcpServers: {
      [SERVER_KEY]: {
        type: "http",
        url: mcpEndpoint(opts),
        headers: { Authorization: `Bearer \${${tokenEnv}}` },
      },
    },
  };
}

/** Claude Code 的 CLI 等价命令（用户可复制执行）。 */
export function claudeCodeCommand({
  transport = DEFAULT_TRANSPORT,
  readOnly = false,
  tokenEnv = DEFAULT_TOKEN_ENV,
  ...opts
} = {}) {
  assertTransport(transport);
  if (transport === "stdio") {
    const argv = [DEFAULT_STDIO_COMMAND, ...stdioArgs({ readOnly })].join(" ");
    return `claude mcp add --transport stdio ${SERVER_KEY} -- ${argv}`;
  }
  assertTokenEnv(tokenEnv);
  return `claude mcp add --transport http ${SERVER_KEY} ${mcpEndpoint(opts)} --header "Authorization: Bearer $${tokenEnv}"`;
}

/**
 * Codex `~/.codex/config.toml` 片段。
 * 只输出 `[mcp_servers.goal-graph]` 这一张表 —— 用户在**共享**的 config.toml 里手动合并，
 * 生成器绝不整文件覆盖。
 */
export function codexConfig({
  transport = DEFAULT_TRANSPORT,
  readOnly = false,
  tokenEnv = DEFAULT_TOKEN_ENV,
  ...opts
} = {}) {
  assertTransport(transport);
  if (transport === "stdio") {
    const argsToml = stdioArgs({ readOnly }).map((a) => JSON.stringify(a)).join(", ");
    return [
      `[mcp_servers.${SERVER_KEY}]`,
      `command = ${JSON.stringify(DEFAULT_STDIO_COMMAND)}`,
      `args = [${argsToml}]`,
      "",
    ].join("\n");
  }
  assertTokenEnv(tokenEnv);
  return [
    `[mcp_servers.${SERVER_KEY}]`,
    `url = "${mcpEndpoint(opts)}"`,
    // Codex 原生键：从该环境变量取 bearer token，token 本体永不落盘配置文件。
    `bearer_token_env_var = "${tokenEnv}"`,
    "",
  ].join("\n");
}

/** OpenCode `opencode.json` 片段（默认 `type="local"` stdio；HTTP 模式为 `type="remote"` + `{env:VAR}`）。 */
export function openCodeConfig({
  transport = DEFAULT_TRANSPORT,
  readOnly = false,
  tokenEnv = DEFAULT_TOKEN_ENV,
  ...opts
} = {}) {
  assertTransport(transport);
  if (transport === "stdio") {
    return {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        servers: {
          [SERVER_KEY]: {
            type: "local",
            command: [DEFAULT_STDIO_COMMAND, ...stdioArgs({ readOnly })],
          },
        },
      },
    };
  }
  assertTokenEnv(tokenEnv);
  return {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      servers: {
        [SERVER_KEY]: {
          type: "remote",
          url: mcpEndpoint(opts),
          headers: { Authorization: `Bearer {env:${tokenEnv}}` },
        },
      },
    },
  };
}

export const HOSTS = ["claude-code", "codex", "opencode"];

/** 统一入口：按宿主名生成配置（字符串或对象）。 */
export function generate(host, opts = {}) {
  switch (host) {
    case "claude-code":
      return claudeCodeConfig(opts);
    case "codex":
      return codexConfig(opts);
    case "opencode":
      return openCodeConfig(opts);
    default:
      throw new McpConfigError(`未知宿主：${host}（可选：${HOSTS.join(", ")}）`);
  }
}

/**
 * 自检：断言一份已生成文本/对象**不含任何看起来像真实 token 的东西**。
 * - HTTP 配置：必须只引用 `GOAL_GRAPH_MCP_TOKEN` 环境变量名（不认旧 `DSH_GRAPH_MCP_TOKEN`）、无字面量；
 * - stdio 配置：必须以 `goal-graph` + `mcp` 启动、不含任何 token 字面量或旧环境变量名。
 */
export function leaksToken(rendered, { transport } = {}) {
  const text = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
  // 危险信号：Bearer 后面直接跟 24+ 位非占位字面量，或任意 32+ 位疑似 hex/base64 凭据字面量（排除 URL）
  const bearerLiteral = /Bearer\s+(?!\$\{|\{env:)[A-Za-z0-9._~+/=-]{24,}/.test(text);
  const longSecretMatch = /["'\s=:]([A-Za-z0-9._~+/=-]{32,})["'\s]/.exec(text);
  const longSecretLiteral = Boolean(longSecretMatch && !/^https?:|^\/|^\.\.?\//.test(longSecretMatch[1]));
  const literal = bearerLiteral || longSecretLiteral;
  const hasStaleEnv = /\bDSH_GRAPH_MCP_TOKEN\b/.test(text);

  const inferredHttp =
    transport === "http" ||
    (transport === undefined &&
      (/http:\/\/127\.0\.0\.1:\d+\/mcp/.test(text) || /Authorization|bearer_token_env_var/.test(text)));

  if (inferredHttp) {
    // HTTP 模式必须按三种原生变量引用语法之一引用 GOAL_GRAPH_MCP_TOKEN
    const placeholder = /\$\{GOAL_GRAPH_MCP_TOKEN\}|\{env:GOAL_GRAPH_MCP_TOKEN\}|bearer_token_env_var\s*=\s*"GOAL_GRAPH_MCP_TOKEN"/;
    const ok = placeholder.test(text) && !hasStaleEnv && !literal;
    return { ok, literal };
  }

  // stdio 模式：不携带 token 字段，且必须指向 goal-graph mcp
  const hasStdioCmd = /"goal-graph"/.test(text) && /"mcp"/.test(text);
  const ok = hasStdioCmd && !hasStaleEnv && !literal;
  return { ok, literal };
}
