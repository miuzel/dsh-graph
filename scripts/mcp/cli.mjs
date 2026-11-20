#!/usr/bin/env node
/**
 * goal-graph-mcp 命令行：为 Claude Code / Codex / OpenCode 生成 MCP 配置片段（g-631 / g-634 / g-637）。
 *
 * 用法：
 *   goal-graph-mcp <claude-code|codex|opencode|all> [--transport stdio|http] [--port N] [--token-env VAR] [--read-only] [--write <dir>] [--check]
 *
 *   --transport stdio|http  传输模式（默认 stdio：零配置拉起 goal-graph mcp；http：显式连接 goal-graph serve）
 *   --port N                HTTP 模式服务端口（默认 7788）
 *   --token-env VAR         HTTP 模式 token 所在环境变量名（默认 GOAL_GRAPH_MCP_TOKEN）
 *   --read-only             stdio 模式追加 --read-only（11 只读工具；默认 38 读写工具）
 *   --write <dir>           额外落盘为对应宿主的文件名（claude-code → .mcp.json，opencode → opencode.json，
 *                           codex → mcp-codex.toml）。**绝不**写入真实宿主配置路径（那是用户的共享文件）。
 *   --check                 自检生成结果不含 token 字面量；未显式指定 --transport 时同时覆盖 stdio 与 http 两种模式。
 *
 * 退出码：0 成功 / 2 用法错误。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PORT,
  DEFAULT_TOKEN_ENV,
  DEFAULT_TRANSPORT,
  HOSTS,
  McpConfigError,
  TRANSPORTS,
  claudeCodeCommand,
  generate,
  leaksToken,
  mcpEndpoint,
} from "./index.mjs";

const FILE_NAMES = {
  "claude-code": ".mcp.json",
  codex: "mcp-codex.toml",
  opencode: "opencode.json",
};

export function render(host, opts) {
  if (host === "codex") return generate(host, opts);
  return JSON.stringify(generate(host, opts), null, 2) + "\n";
}

export function run(argv) {
  const positional = [];
  let transport = null;
  let port = DEFAULT_PORT;
  let tokenEnv = DEFAULT_TOKEN_ENV;
  let readOnly = false;
  let writeDir = null;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--transport") {
      transport = argv[++i];
      if (!TRANSPORTS.includes(transport)) {
        throw new McpConfigError(`--transport 只接受 ${TRANSPORTS.join(" 或 ")}（收到 ${transport ?? "<空>"}）`);
      }
    } else if (a.startsWith("--transport=")) {
      transport = a.slice("--transport=".length);
      if (!TRANSPORTS.includes(transport)) {
        throw new McpConfigError(`--transport 只接受 ${TRANSPORTS.join(" 或 ")}（收到 ${transport}）`);
      }
    } else if (a === "--port") {
      port = Number(argv[++i]);
      if (!Number.isInteger(port)) throw new McpConfigError("--port 需要整数");
    } else if (a === "--token-env") {
      tokenEnv = argv[++i];
    } else if (a === "--read-only") {
      readOnly = true;
    } else if (a === "--write") {
      writeDir = resolve(argv[++i] ?? "");
    } else if (a === "--check") {
      check = true;
    } else if (a === "--help" || a === "-h") {
      return { code: 0, out: usage() };
    } else if (a.startsWith("-")) {
      throw new McpConfigError(`未知选项：${a}`);
    } else {
      positional.push(a);
    }
  }
  const target = positional[0] ?? "all";
  const hosts = target === "all" ? HOSTS : [target];
  for (const h of hosts) if (!HOSTS.includes(h)) throw new McpConfigError(`未知宿主：${h}`);

  const activeTransport = transport ?? DEFAULT_TRANSPORT;
  const opts = { transport: activeTransport, port, tokenEnv, readOnly };
  const lines = [];
  let ok = true;

  if (check) {
    // 未指定 --transport 时同时覆盖 stdio 与 http 两种模式，确保两种形态均无 token 泄漏
    const modes = transport ? [transport] : TRANSPORTS;
    for (const mode of modes) {
      for (const host of hosts) {
        const cfg = generate(host, { ...opts, transport: mode });
        const r = leaksToken(cfg, { transport: mode });
        if (!r.ok || r.literal) {
          ok = false;
          lines.push(`❌ ${host} (${mode})：配置校验未通过（ok=${r.ok} literal=${r.literal}）`);
          continue;
        }
        lines.push(
          mode === "stdio"
            ? `✅ ${host} (stdio)：零配置拉起 goal-graph mcp，无 token 字面量`
            : `✅ ${host} (http)：仅引用环境变量 ${tokenEnv}，无 token 字面量`,
        );
      }
    }
    return { code: ok ? 0 : 1, out: lines.join("\n") + "\n" };
  }

  for (const host of hosts) {
    const text = render(host, opts);
    if (writeDir) {
      mkdirSync(writeDir, { recursive: true });
      const file = join(writeDir, FILE_NAMES[host]);
      writeFileSync(file, text);
      lines.push(`--- ${host} → ${file} ---`, text);
    } else {
      lines.push(`--- ${host} ---`, text);
    }
  }
  if (activeTransport === "stdio") {
    lines.push(`# 零配置 stdio 模式：三宿主直接拉起当前工作区的 goal-graph mcp（自动分配空闲端口起本地 Web 看板）`);
    lines.push(`# 默认 38 个读写工具（Human Gate 仍 fail-closed）；需要只读请加 --read-only`);
    if (hosts.includes("claude-code")) lines.push(`# Claude Code 等价 CLI：${claudeCodeCommand(opts)}`);
  } else {
    lines.push(`# 显式 HTTP 模式（三宿主共用同一 endpoint）：${mcpEndpoint(opts)}`);
    lines.push(`# token 不落盘：请把凭据文件里的 token 注入环境变量 ${tokenEnv}`);
    if (hosts.includes("claude-code")) lines.push(`# Claude Code 等价 CLI：${claudeCodeCommand(opts)}`);
  }
  return { code: 0, out: lines.join("\n") + "\n" };
}

export function usage() {
  return [
    "goal-graph-mcp — 生成 Claude Code / Codex / OpenCode 的 MCP 配置（默认零配置 stdio，可选 --transport http）",
    "",
    "用法：goal-graph-mcp <claude-code|codex|opencode|all> [--transport stdio|http] [--port N] [--token-env VAR] [--read-only] [--write DIR] [--check]",
    "",
    `  --transport MODE  传输模式：stdio（默认，零配置拉起 goal-graph mcp）或 http（显式连接 goal-graph serve）`,
    `  --port N          HTTP 模式服务端口（默认 ${DEFAULT_PORT}）`,
    `  --token-env VAR   HTTP 模式 token 所在环境变量名（默认 ${DEFAULT_TOKEN_ENV}）`,
    "  --read-only       stdio 模式追加 --read-only（11 只读工具；默认 38 读写工具）",
    "  --write DIR       落盘为对应宿主文件名（不写真实宿主配置路径）",
    "  --check           自检：确认配置合规、不含 token 字面量（默认同时覆盖 stdio 与 http）",
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const r = run(process.argv.slice(2));
    process.stdout.write(r.out);
    process.exitCode = r.code;
  } catch (e) {
    if (e instanceof McpConfigError) {
      process.stderr.write(`goal-graph-mcp: ${e.message}\n\n${usage()}`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`goal-graph-mcp: ${e.message}\n`);
      process.exitCode = 1;
    }
  }
}
