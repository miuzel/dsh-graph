/**
 * dsh-cli 命令分派（g-314）：把已解析的参数映射到只读命令执行，并把结果写成人类可读或 JSON。
 *
 * 退出码约定（判据 4）：
 * - `0` 成功；
 * - `1` 运行期失败（非工作区 / 未初始化 / 目标不存在 / 损坏配置 / 非法路径）；
 * - `2` 用法错误（未知命令、未知选项、缺参、多余参数）。
 *
 * 零副作用：本文件**不**发起任何写操作；`info` / `status` / `goal list` / `goal show` / `version`
 * 全部只读（不 init、不记事件、不建目录）。
 */
import { parseArgs, type ParsedArgs } from "./args.ts";
import { locateGraphRoot, LocateError } from "./locate.ts";
// 冷启动纪律（判据 2）：`info` 只依赖轻量 health.ts（模块图 = node 内置 + core/root），
// `diagnostics.ts` 会连带 ops.ts + yaml（实测约 40~65ms）⇒ 对它用**动态 import**，
// 只在 status/goal 命令真正需要时才加载，避免 info/version 白付这份成本。
import { collectHealth } from "./health.ts";

/** CLI 版本：与仓库 host 包版本同源（由调用方注入，避免在 core 里硬编码第二份版本号）。 */
export interface CliContext {
  /** 版本号字符串（package.json 的 version）。 */
  version: string;
  /** 进程 cwd（默认 process.cwd()，单测可注入）。 */
  cwd?: string;
  /** stdout 写入器（单测注入以捕获输出）。 */
  write?: (text: string) => void;
  /** stderr 写入器。 */
  writeError?: (text: string) => void;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const HELP_TEXT = `dsh-cli — 轻量 dsh-graph 看板命令行（只读核心）

用法：
  dsh-cli <命令> [选项]

命令：
  info             环境自检：Node 版本、graph root、初始化状态、关键文件可读性
  status           看板状态：目标数、事件数、最近事件、规则库版本、问题列表
  goal list        列出目标（默认不含归档；--all 含归档）
  goal show <id>   显示单个目标（含正文）
  version          显示 dsh-cli 版本
  help             显示本帮助

选项：
  --root <path>    显式指定 graph root（绝对路径，或相对当前目录的路径）
  --json           机器可读 JSON 输出
  --all, -a        goal list 包含归档目标
  --help, -h       显示帮助
  --version, -V    显示版本

路径定位：
  默认从当前目录向上查找 .dsh-graph；找不到即报「非工作区」并非零退出，
  不会回落到用户全局配置（$DSH_HOME / ~/.dsh）。

退出码：
  0 成功 / 1 运行期失败（非工作区、未初始化、目标不存在、损坏配置） / 2 用法错误
`;

function emit(out: string[], text: string): void {
  out.push(text);
}

function usageError(message: string): RunResult {
  return {
    exitCode: EXIT_USAGE,
    stdout: "",
    stderr: `dsh-cli: ${message}\n运行 dsh-cli help 查看用法。\n`,
  };
}

function failure(message: string): RunResult {
  return { exitCode: EXIT_FAILURE, stdout: "", stderr: `dsh-cli: ${message}\n` };
}

function jsonOut(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 执行一次 CLI 调用：无副作用（除调用方给定的写入器）。命令需要看板汇总时才加载 diagnostics。 */
export async function runCli(argv: readonly string[], ctx: CliContext): Promise<RunResult> {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    // `--help` 出现在某命令之后但仍属用法错误时，帮助优先（避免 --help 被错误信息淹没）。
    if (argv.includes("--help") || argv.includes("-h")) {
      return { exitCode: EXIT_OK, stdout: HELP_TEXT, stderr: "" };
    }
    return usageError(parsed.error.message);
  }
  const args = parsed.args as ParsedArgs;

  if (args.help) return { exitCode: EXIT_OK, stdout: HELP_TEXT, stderr: "" };
  if (args.command === "help") return { exitCode: EXIT_OK, stdout: HELP_TEXT, stderr: "" };
  if (args.command === "version" || args.version) {
    if (args.json) {
      return { exitCode: EXIT_OK, stdout: jsonOut({ version: ctx.version, node: process.version }), stderr: "" };
    }
    return { exitCode: EXIT_OK, stdout: `dsh-cli ${ctx.version} (node ${process.version})\n`, stderr: "" };
  }

  // 其余命令都需要定位 graph root。
  let located;
  try {
    located = locateGraphRoot({ cwd: ctx.cwd, root: args.root });
  } catch (e) {
    if (e instanceof LocateError) return failure(e.message);
    return failure((e as Error).message);
  }

  const common = { root: located.root, workspace: located.workspace, mode: located.mode };
  const warnLine = located.warning ? `警告：${located.warning}\n` : "";

  if (args.command === "info") {
    const health = collectHealth(common);
    if (args.json) {
      return {
        exitCode: EXIT_OK,
        stdout: jsonOut({ ...health, explicitRoot: located.explicit, warning: located.warning ?? null }),
        stderr: warnLine,
      };
    }
    const out: string[] = [];
    emit(out, `node:            ${health.nodeVersion}`);
    emit(out, `graph root:      ${health.root}${located.explicit ? "（--root 显式指定）" : ""}`);
    emit(out, `workspace:       ${health.workspace}（mode=${health.mode}）`);
    emit(out, `initialized:     ${health.initialized ? "yes" : "no（未初始化：缺少 events.jsonl）"}`);
    emit(out, "文件：");
    for (const f of health.files) {
      const state = !f.exists ? "缺失（缺省）" : f.readable ? "可读" : `不可读：${f.error ?? "未知原因"}`;
      emit(out, `  ${f.path.padEnd(16)}${state}`);
    }
    if (located.warning) emit(out, `警告：${located.warning}`);
    return { exitCode: EXIT_OK, stdout: `${out.join("\n")}\n`, stderr: "" };
  }

  if (args.command === "status") {
    const { collectStatus } = await import("./diagnostics.ts");
    const status = collectStatus(common);
    if (args.json) {
      return {
        exitCode: EXIT_OK,
        stdout: jsonOut({ ...status, explicitRoot: located.explicit, warning: located.warning ?? null }),
        stderr: warnLine,
      };
    }
    const out: string[] = [];
    emit(out, `graph root:      ${status.root}${located.explicit ? "（--root 显式指定）" : ""}`);
    emit(out, `initialized:     ${status.initialized ? "yes" : "no（未初始化：缺少 events.jsonl）"}`);
    emit(out, `目标数:          ${status.goalCount}（含归档 ${status.goalCountWithArchived}）`);
    emit(out, `事件数:          ${status.eventCount}`);
    emit(out, `最近事件:        ${status.lastEvent ? `${status.lastEvent} @ ${status.lastEventTs}` : "（无）"}`);
    emit(out, `规则库版本:      ${status.rulesVersion ?? "（无）"}`);
    emit(out, `project.yaml:    ${status.projectConfigOk ? "可解析" : "不可解析（损坏）"}`);
    if (status.problems.length > 0) {
      emit(out, "问题：");
      for (const p of status.problems) emit(out, `  - ${p}`);
    }
    if (located.warning) emit(out, `警告：${located.warning}`);
    // 损坏配置不致命（仍能诊断），但必须以非零退出提示运维：判据 4 要求「损坏配置可读非零退出」。
    const damaged = status.problems.length > 0 || !status.initialized;
    return { exitCode: damaged ? EXIT_FAILURE : EXIT_OK, stdout: `${out.join("\n")}\n`, stderr: warnLine };
  }

  if (args.command === "goal" && args.subcommand === "list") {
    const { listGoals } = await import("./diagnostics.ts");
    const { goals, problems } = listGoals({ root: located.root, includeArchived: args.all });
    if (args.json) {
      const body = jsonOut({ root: located.root, goals, problems });
      return { exitCode: problems.length > 0 ? EXIT_FAILURE : EXIT_OK, stdout: body, stderr: warnLine };
    }
    if (goals.length === 0 && problems.length === 0) {
      return { exitCode: EXIT_OK, stdout: "（没有目标）\n", stderr: warnLine };
    }
    const out: string[] = [];
    for (const g of goals) {
      const ver = g.version ? ` @${g.version}` : "";
      emit(out, `${g.id}\t${g.status}\t${g.type}${ver}\t${g.title}`);
    }
    for (const p of problems) emit(out, `问题：${p}`);
    return {
      exitCode: problems.length > 0 ? EXIT_FAILURE : EXIT_OK,
      stdout: `${out.join("\n")}\n`,
      stderr: warnLine,
    };
  }

  if (args.command === "goal" && args.subcommand === "show") {
    const id = args.positionals[0];
    try {
      const { showGoal } = await import("./diagnostics.ts");
      const { goal } = showGoal({ root: located.root, id });
      if (args.json) {
        return { exitCode: EXIT_OK, stdout: jsonOut({ root: located.root, goal }), stderr: warnLine };
      }
      const out: string[] = [];
      emit(out, `id:       ${goal.id}`);
      emit(out, `title:    ${goal.title}`);
      emit(out, `status:   ${goal.status}`);
      emit(out, `type:     ${goal.type}`);
      emit(out, `version:  ${goal.version ?? "（无）"}`);
      emit(out, `file:     ${goal.file}`);
      emit(out, "");
      emit(out, goal.body.trimEnd());
      return { exitCode: EXIT_OK, stdout: `${out.join("\n")}\n`, stderr: warnLine };
    } catch (e) {
      // findGoalFile / loadGoal 的错误（目标不存在、frontmatter 损坏）都已是可读中文文案。
      return failure(`goal show ${id} 失败：${(e as Error).message}`);
    }
  }

  // 理论不可达（parseArgs 已穷举）；保底仍给非零用法错误，绝不静默成功。
  return usageError(`未实现的分派：${args.command ?? ""} ${args.subcommand ?? ""}`.trim());
}

/** 写入结果并返回退出码（供可执行入口复用；单测直接用 runCli 的返回值）。 */
export async function runAndPrint(argv: readonly string[], ctx: CliContext): Promise<number> {
  const result = await runCli(argv, ctx);
  const write = ctx.write ?? ((t: string) => void process.stdout.write(t));
  const writeError = ctx.writeError ?? ((t: string) => void process.stderr.write(t));
  if (result.stdout) write(result.stdout);
  if (result.stderr) writeError(result.stderr);
  return result.exitCode;
}
