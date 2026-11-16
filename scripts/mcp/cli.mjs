#!/usr/bin/env node
/**
 * dsh-graph-mcp 命令行：为 Claude Code / Codex / OpenCode 生成 MCP 配置片段（g-631）。
 *
 * 用法：
 *   dsh-graph-mcp <claude-code|codex|opencode|all> [--port N] [--token-env VAR] [--write <dir>] [--check]
 *
 *   --write <dir>  额外落盘为对应宿主的文件名（claude-code → .mcp.json，opencode → opencode.json，
 *                  codex → mcp-codex.toml）。**绝不**写入真实宿主配置路径（那是用户的共享文件）。
 *   --check        自检生成结果不含 token 字面量，且引用的环境变量名一致。
 *
 * 退出码：0 成功 / 2 用法错误。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PORT,
  DEFAULT_TOKEN_ENV,
  HOSTS,
  McpConfigError,
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
  let port = DEFAULT_PORT;
  let tokenEnv = DEFAULT_TOKEN_ENV;
  let writeDir = null;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      port = Number(argv[++i]);
      if (!Number.isInteger(port)) throw new McpConfigError("--port 需要整数");
    } else if (a === "--token-env") {
      tokenEnv = argv[++i];
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

  const opts = { port, tokenEnv };
  const lines = [];
  let ok = true;
  for (const host of hosts) {
    if (check) {
      const r = leaksToken(generate(host, opts));
      if (!r.ok || r.literal) {
        ok = false;
        lines.push(`❌ ${host}：配置未按环境变量引用 token（ok=${r.ok} literal=${r.literal}）`);
        continue;
      }
      lines.push(`✅ ${host}：仅引用环境变量 ${tokenEnv}，无 token 字面量`);
      continue;
    }
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
  if (!check) {
    lines.push(`# 三宿主共用同一 endpoint：${mcpEndpoint(opts)}`);
    lines.push(`# token 不落盘：请把凭据文件里的 token 注入环境变量 ${tokenEnv}`);
    if (hosts.includes("claude-code")) lines.push(`# Claude Code 等价 CLI：${claudeCodeCommand(opts)}`);
  }
  return { code: ok ? 0 : 1, out: lines.join("\n") + "\n" };
}

export function usage() {
  return [
    "dsh-graph-mcp — 生成 Claude Code / Codex / OpenCode 的 MCP 配置（token 只引用环境变量）",
    "",
    "用法：dsh-graph-mcp <claude-code|codex|opencode|all> [--port N] [--token-env VAR] [--write DIR] [--check]",
    "",
    `  --port N        服务端口（默认 ${DEFAULT_PORT}）`,
    `  --token-env VAR token 所在环境变量名（默认 ${DEFAULT_TOKEN_ENV}）`,
    "  --write DIR     落盘为对应宿主文件名（不写真实宿主配置路径）",
    "  --check         自检：确认配置只引用环境变量、不含 token 字面量",
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
      process.stderr.write(`dsh-graph-mcp: ${e.message}\n\n${usage()}`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`dsh-graph-mcp: ${e.message}\n`);
      process.exitCode = 1;
    }
  }
}
