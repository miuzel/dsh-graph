/**
 * goal-graph-mcp —— MCP 适配器与三宿主配置生成（g-631 / g-634）。
 *
 * 判据 4：Claude Code / Codex / OpenCode 的配置**能被各自宿主识别**，且**都指向同一 endpoint**，
 * 并且 **token 绝不写进配置文件**。
 *
 * 「不让 token 进配置文件」的三宿主落地方式（各自支持的原生 env 引用语法，不是我们发明的）：
 *   · Claude Code（`.mcp.json` / `~/.claude.json`）：`${VAR}` 展开 ⇒ `Authorization: Bearer ${VAR}`
 *   · Codex（`~/.codex/config.toml`）：`bearer_token_env_var = "VAR"`（专门为此存在的键）
 *   · OpenCode（`opencode.json`）：`{env:VAR}` 插值 ⇒ `Authorization: Bearer {env:VAR}`
 * 三者都只写**变量名**；真实 token 由用户从 goal-graph 服务的凭据文件（0600）注入环境。
 *
 * endpoint 单一真源：由 `{host, port}` 推导，三宿主共用 `baseUrl()` 结果 —— 不可能出现
 * 「三个配置指向三个不同端口」的漂移。
 */

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7788;
export const DEFAULT_TOKEN_ENV = "GOAL_GRAPH_MCP_TOKEN";
export const SERVER_KEY = "goal-graph";
/** 服务端只允许数值回环绑定（见 core/service/policy.ts）；生成器也坚持这一点。 */
export const ALLOWED_HOST = "127.0.0.1";

export class McpConfigError extends Error {}

/** 校验并给出 MCP endpoint 基址（三宿主共用；不带 /mcp 后缀）。 */
export function baseUrl({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  if (host !== ALLOWED_HOST) {
    throw new McpConfigError(`host 只允许 ${ALLOWED_HOST}（服务端只绑定数值回环，拒绝 ${host}）`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new McpConfigError(`port 必须是 1..65535 的整数（收到 ${port}）`);
  }
  return `http://${host}:${port}`;
}

/** MCP endpoint（三宿主配置里的 url 字段值，逐字相同）。 */
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
 * `scope="project"` ⇒ `.mcp.json` 可直接入库（token 仍是 ${VAR}，不泄漏）；
 * `scope="user"` ⇒ 写进 `~/.claude.json` 的 `mcpServers`（同一结构）。
 */
export function claudeCodeConfig({ tokenEnv = DEFAULT_TOKEN_ENV, ...opts } = {}) {
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

/** Claude Code 的 CLI 等价命令（用户可复制执行，token 仍是 shell 变量引用）。 */
export function claudeCodeCommand({ tokenEnv = DEFAULT_TOKEN_ENV, ...opts } = {}) {
  assertTokenEnv(tokenEnv);
  return `claude mcp add --transport http ${SERVER_KEY} ${mcpEndpoint(opts)} --header "Authorization: Bearer $${tokenEnv}"`;
}

/**
 * Codex `~/.codex/config.toml` 片段。
 * 只输出 `[mcp_servers.goal-graph]` 这一张表 —— 用户在**共享**的 config.toml 里手动合并，
 * 生成器绝不整文件覆盖。
 */
export function codexConfig({ tokenEnv = DEFAULT_TOKEN_ENV, ...opts } = {}) {
  assertTokenEnv(tokenEnv);
  return [
    `[mcp_servers.${SERVER_KEY}]`,
    `url = "${mcpEndpoint(opts)}"`,
    // Codex 原生键：从该环境变量取 bearer token，token 本体永不落盘配置文件。
    `bearer_token_env_var = "${tokenEnv}"`,
    "",
  ].join("\n");
}

/** OpenCode `opencode.json` 片段（`mcp` 键，type=remote + {env:VAR} 插值）。 */
export function openCodeConfig({ tokenEnv = DEFAULT_TOKEN_ENV, ...opts } = {}) {
  assertTokenEnv(tokenEnv);
  return {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      [SERVER_KEY]: {
        type: "remote",
        url: mcpEndpoint(opts),
        enabled: true,
        headers: { Authorization: `Bearer {env:${tokenEnv}}` },
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
 * 自检：断言一份已生成文本/对象**不含任何看起来像真实 token 的东西**，
 * 且确实只引用了环境变量名。供守卫测试与 --verify 使用。
 */
export function leaksToken(rendered) {
  const text = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
  // 允许的三种引用形态（只含变量名，不含值）
  const placeholder = /\$\{GOAL_GRAPH_MCP_TOKEN\}|\{env:GOAL_GRAPH_MCP_TOKEN\}|bearer_token_env_var = "GOAL_GRAPH_MCP_TOKEN"/;
  const ok = placeholder.test(text);
  // 危险信号：Bearer 后面直接跟了 32+ 位的非空白字面量（真实 token 的典型形态）
  const literal = /Bearer\s+(?!\$\{|{env:)[A-Za-z0-9._~+/=-]{24,}/.test(text);
  return { ok, literal };
}
