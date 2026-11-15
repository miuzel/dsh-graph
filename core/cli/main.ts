/**
 * dsh-graph 命令分派（g-314 / g-315）：把已解析的参数映射到命令执行，并把结果写成人类可读或 JSON。
 *
 * 退出码约定（判据 4）：
 * - `0` 成功；
 * - `1` 运行期失败（非工作区 / 未初始化 / 目标不存在 / 损坏配置 / 非法路径）；
 * - `2` 用法错误（未知命令、未知选项、缺参、多余参数）。
 *
 * 零副作用（默认命令）：`info` / `status` / `goal list` / `goal show` / `version` 全部只读
 * （不 init、不记事件、不建目录）。
 *
 * 会写文件的命令只有两个：
 * - `sync`（g-315）只写 workspace 根的 `.claude/CLAUDE.md` 与 `AGENTS.md` 的受控区段，
 *   **从不**写 `.dsh-graph`（写入实现见 `sync.ts`：先全部规划、后原子落地）；
 * - `claim`（g-316）是**唯一的看板写命令**：它只经 core 的 `transition` 迁移目标状态
 *   （事件先行 + 锁 + 锁内重读），并把轻量任务单打到 stdout（实现见 `claim.ts`）。
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

const HELP_TEXT = `dsh-graph — 轻量 dsh-graph 看板命令行（默认只读；写命令只有 sync 与 claim）

用法：
  dsh-graph <命令> [选项]

命令：
  info             环境自检：Node 版本、graph root、初始化状态、关键文件可读性
  status           看板状态：目标数、事件数、最近事件、规则库版本、问题列表
  goal list        列出目标（默认不含归档；--all 含归档）
  goal show <id>   显示单个目标（含正文）
  sync             把常驻硬性事实与目标概览投影到 .claude/CLAUDE.md 与 AGENTS.md 的受控区段
  claim <goal-id>  认领目标：把状态推进到 in_progress 并输出轻量任务单（目标 + 判据 + 边界）
  version          显示 dsh-graph 版本
  help             显示本帮助

选项：
  --root <path>    显式指定 graph root（绝对路径，或相对当前目录的路径）
  --json           机器可读 JSON 输出
  --all, -a        goal list 包含归档目标
  --full           sync 不折叠目标列表（默认单次最多列 40 个）
  --active-only    sync 跳过终态目标（delivered）
  --target <path>  sync 只写其一：.claude/CLAUDE.md 或 AGENTS.md
  --help, -h       显示帮助
  --version, -V    显示版本

路径定位：
  默认从当前目录向上查找 .dsh-graph；找不到即报「非工作区」并非零退出，
  不会回落到用户全局配置（$DSH_HOME / ~/.dsh）。

退出码：
  0 成功 / 1 运行期失败（非工作区、未初始化、目标不存在、损坏配置、sync 的可判定失败） / 2 用法错误

sync（g-315）：
  把 .dsh-graph 的 standing 常驻记忆（稳定前缀）与未发布版本目标概览（动态段）投影到
  workspace 根的 .claude/CLAUDE.md 与 AGENTS.md 的受控区段（<!-- dsh-graph:sync:begin/end -->）。
  区段外字节级不动；无标记时追加到末尾；无变更不写；有变更原子写；失败不写任何文件。

claim（g-316）：
  唯一会写看板的命令。读取目标元信息与「质量判据」小节，经 core 状态机把
  planning / collecting / ready 推进到 in_progress（事件先行：先写 events.jsonl 再写目标文件），
  然后把「目标 + 判据清单 + 边界提示」的轻量任务单打到 stdout（--json 给结构化版本）。
  （解析一律经 core 的公开入口，CLI 不自行解析目标文件格式。）
  已是 in_progress ⇒ 幂等成功（不写事件）。目标不存在 / 无判据 / 判据未确认 / 状态不允许 /
  损坏 goal.md / 非工作区 / 只读目录 / 并发认领 ⇒ 非零退出且零副作用。claim 不派发子代理、不建 attempt 目录。
`;

function emit(out: string[], text: string): void {
  out.push(text);
}

function usageError(message: string): RunResult {
  return {
    exitCode: EXIT_USAGE,
    stdout: "",
    stderr: `dsh-graph: ${message}\n运行 dsh-graph help 查看用法。\n`,
  };
}

function failure(message: string): RunResult {
  return { exitCode: EXIT_FAILURE, stdout: "", stderr: `dsh-graph: ${message}\n` };
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
    return { exitCode: EXIT_OK, stdout: `dsh-graph ${ctx.version} (node ${process.version})\n`, stderr: "" };
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

  if (args.command === "sync") {
    return runSyncCommand(located, args, ctx.cwd ?? process.cwd());
  }

  if (args.command === "claim") {
    return runClaimCommand(located, args);
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

/**
 * `dsh-graph sync`（g-315）：把 `.dsh-graph` 投影写入 workspace 根的两个受控区段。
 *
 * 输出口径：
 * - 每个目标一行状态：`written`（已更新）/ `unchanged`（无变更、未写，mtime 不变）/ `error`；
 * - `--json` 给机器可读版本（含 `prefix_sha256`，用于断言前缀跨次稳定）；
 * - 任一可判定失败（损坏记忆/事件流、目标目录只读、目标不可读、标记畸形）⇒ exit 1 且**不写任何文件**；
 * - 用法问题（`--target` 值非法）⇒ exit 2。
 */
async function runSyncCommand(
  located: { root: string; warning?: string; explicit: boolean },
  args: ParsedArgs,
  invokedWorkspace: string,
): Promise<RunResult> {
  // sync 是本 CLI 唯一会写文件的命令 ⇒ 动态加载，保持 info/version 的冷启动成本不变。
  const mod = await import("./sync.ts");
  const closedStates = args.activeOnly ? ["delivered"] : undefined;
  let plan;
  try {
    plan = mod.planSync(located.root, {
      targets: args.target,
      full: args.full,
      closedStates,
      invokedWorkspace,
    });
  } catch (e) {
    if (e instanceof mod.SyncError) {
      return usageError(e.message);
    }
    throw e;
  }
  const result = mod.applySync(plan);

  const isUsageProblem = (p: { code: string }) => p.code === "bad-option";
  if (result.problems.some(isUsageProblem)) {
    return usageError(result.problems.filter(isUsageProblem).map((p) => p.message).join("；"));
  }
  const failures = result.problems;
  const warnLine = located.warning ? `警告：${located.warning}\n` : "";

  if (args.json) {
    const body = {
      root: result.root,
      workspace: result.workspace,
      ok: failures.length === 0,
      changed: result.changedCount,
      written: result.written.map((t) => t.rel),
      unchanged: result.skipped.map((t) => t.rel),
      targets: result.targets.map((t) => ({ path: t.rel, found_block: t.rendered.found, changed: t.changed })),
      // 稳定前缀（A 段）的 sha256：两次运行相等即「前缀跨次字节稳定」的机器可读证据。
      prefix_sha256: mod.hashOf(mod.extractStablePrefix(result.block ?? "") ?? ""),
      problems: failures.map((p) => ({ code: p.code, message: p.message })),
    };
    return {
      exitCode: failures.length > 0 ? EXIT_FAILURE : EXIT_OK,
      stdout: jsonOut(body),
      stderr: warnLine,
    };
  }

  const out: string[] = [];
  for (const t of result.targets) {
    const state = failures.length > 0 ? "skipped（失败，未写）" : t.changed ? "written" : "unchanged（无变更，未写）";
    const mode = t.rendered.found ? "替换受控区段" : t.existing === null ? "新建文件" : "无标记 ⇒ 追加区段";
    emit(out, `${t.rel}\t${state}\t${mode}`);
  }
  if (failures.length > 0) {
    for (const p of failures) emit(out, `错误：${p.message}`);
    return { exitCode: EXIT_FAILURE, stdout: `${out.join("\n")}\n`, stderr: warnLine };
  }
  return { exitCode: EXIT_OK, stdout: `${out.join("\n")}\n`, stderr: warnLine };
}

/**
 * `dsh-graph claim <goal-id>`（g-316）：认领目标 + 输出轻量任务单。
 *
 * 输出口径：
 * - 成功（含 in_progress 幂等命中）⇒ exit 0；人类可读任务单写 stdout，`--json` 给结构化版本；
 * - 失败（目标不存在 / 无或空判据 / 判据未确认 / 状态不允许 / 损坏 goal.md / 非工作区 /
 *   只读目录 / 并发认领）⇒ exit 1 且**零副作用**（所有判定都早于任何写入）；
 * - 缺目标 ID ⇒ exit 2（由参数解析给出）。
 *
 * 写路径唯一：`claim.ts` 只调 core 的 `transition`（事件先行 + 锁 + 锁内重读），本层不写任何文件。
 */
async function runClaimCommand(
  located: { root: string; warning?: string; explicit: boolean },
  args: ParsedArgs,
): Promise<RunResult> {
  // claim 会连带 core 的 ops/状态机 ⇒ 动态加载，保持 info/version 冷启动成本不变。
  const mod = await import("./claim.ts");
  const id = args.positionals[0];
  const warnLine = located.warning ? `警告：${located.warning}\n` : "";
  let result: import("./claim.ts").ClaimResult;
  try {
    result = mod.claimGoal({ root: located.root, id, actor: CLAIM_ACTOR });
  } catch (e) {
    if (e instanceof mod.ClaimError) {
      // 事件先行语义：persist 阶段失败时事件已落盘 —— 必须如实说明，不能让用户以为零写入。
      const tail = e.eventsWritten ? "（注意：事件已先行落盘，重试同一命令即可收敛）" : "";
      return failure(`claim ${id} 失败：${e.message}${tail}`);
    }
    return failure(`claim ${id} 失败：${(e as Error).message}`);
  }

  if (args.json) {
    return {
      exitCode: EXIT_OK,
      stdout: jsonOut({ root: located.root, ...result }),
      stderr: warnLine,
    };
  }
  return { exitCode: EXIT_OK, stdout: mod.renderClaimSheet(result), stderr: warnLine };
}

/** claim 写入事件时的 actor 标识（与看板其它 CLI 动作一致：显式标明来源是可审计的前提）。 */
const CLAIM_ACTOR = "cli:dsh-graph claim";

/** 写入结果并返回退出码（供可执行入口复用；单测直接用 runCli 的返回值）。 */
export async function runAndPrint(argv: readonly string[], ctx: CliContext): Promise<number> {
  const result = await runCli(argv, ctx);
  const write = ctx.write ?? ((t: string) => void process.stdout.write(t));
  const writeError = ctx.writeError ?? ((t: string) => void process.stderr.write(t));
  if (result.stdout) write(result.stdout);
  if (result.stderr) writeError(result.stderr);
  return result.exitCode;
}
