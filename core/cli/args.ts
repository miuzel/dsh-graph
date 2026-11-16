/**
 * dsh-graph 参数解析（g-314）：手写最小解析器，零第三方 CLI 框架、零网络。
 *
 * 设计原则：
 * - **纯函数**：不读文件、不读环境（除了调用方显式注入的值），可在单测里穷举边界。
 * - **未知即错**：未知命令 / 未知选项 / 缺参一律返回结构化错误，由调用方转成非零退出码
 *   （判据 4：不产生副作用）。
 * - **不吞 `--`**：`--` 之后一律视为位置参数（便于未来子命令接文件路径），但当前命令集
 *   不接受多余位置参数 ⇒ 仍会报错；保留该记号使语义明确而非静默忽略。
 */

/** 解析失败：`message` 面向人类可读，`code` 供测试与调用方稳定断言。 */
export interface ArgError {
  code: "unknown-option" | "missing-value" | "unknown-command" | "missing-argument" | "unexpected-argument" | "missing-command";
  message: string;
}

export interface ParsedArgs {
  /** 命令名词（`info` / `status` / `version` / `goal` / `sync` / `claim` / `submit` / `help`）。 */
  command: string | null;
  /** 子命令（`goal` 的 `list` / `show`）。 */
  subcommand: string | null;
  /** 子命令位置参数（如 `goal show <id>` 的 id）。 */
  positionals: string[];
  /** `--root <path>` / `--root=<path>`；未给出为 null。 */
  root: string | null;
  /** `--json` 机器可读输出。 */
  json: boolean;
  /** `--help` / `-h`。 */
  help: boolean;
  /** `--version` / `-V`（与 `version` 命令等价）。 */
  version: boolean;
  /** `--all` / `-a`：`goal list` 是否包含归档目标。 */
  all: boolean;
  /** `--full`：`sync` 不折叠目标列表（g-315）。 */
  full: boolean;
  /** `--active-only`：`sync` 跳过终态目标（g-315）；布尔开关，终态集合由 CLI 固定（见 main.ts）。 */
  activeOnly: boolean;
  /** `--target <path>`：`sync` 只写其中一个输出文档（g-315）。 */
  target: string | null;
  /**
   * `--skip-tests`（g-317）：**默认关闭**。显式给出时跳过自检，工作摘要与事件里一律标注
   * 「未验证」并以非零退出（见 `submit.ts`：绝不伪装成全绿）。
   */
  skipTests: boolean;
  /** g-623 */
  serveArgv?: string[];
}

export interface ParseResult {
  args: ParsedArgs | null;
  error: ArgError | null;
}

/** 已知顶层命令（`goal` 为多子命令容器）。 */
export const TOP_LEVEL_COMMANDS = ["info", "status", "version", "goal", "sync", "claim", "submit", "serve", "help"] as const;
/** `goal` 的已知子命令。 */
export const GOAL_SUBCOMMANDS = ["list", "show"] as const;
/** `serve` 的已知动作（g-623；其余 token 一律作为服务选项原样转交）。 */
export const SERVE_ACTIONS = ["serve", "init", "status", "uninstall", "stop"] as const;

/** 各命令接受的位置参数个数上限（不含子命令名）。 */
const MAX_POSITIONALS: Record<string, number> = {
  info: 0,
  status: 0,
  version: 0,
  sync: 0,
  claim: 1,
  submit: 1,
  serve: Number.POSITIVE_INFINITY,
  help: 0,
  "goal list": 0,
  "goal show": 1,
};

function err(code: ArgError["code"], message: string): ParseResult {
  return { args: null, error: { code, message } };
}

/**
 * 解析 argv（不含 `node` 与脚本路径）。
 *
 * 选项语法：`--flag`、`--opt value`、`--opt=value`；短选项 `-h` / `-V` / `-a`。
 * 选项可出现在命令前后（`dsh-graph --root x goal list` 与 `dsh-graph goal list --root x` 等价）。
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const rawArgv = [...argv];
  const positionals: string[] = [];
  let root: string | null = null;
  let json = false;
  let help = false;
  let version = false;
  let all = false;
  let full = false;
  let activeOnly = false;
  let target: string | null = null;
  let skipTests = false;
  let afterDoubleDash = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (afterDoubleDash) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    // `--target=<path>` 形态（g-315 sync）
    if (token.startsWith("--target=")) {
      const value = token.slice("--target=".length);
      if (value === "") return err("missing-value", "选项 --target 需要一个路径值（--target=<path>）");
      if (target !== null) return err("unexpected-argument", "选项 --target 只能给出一次");
      target = value;
      continue;
    }
    if (token === "--target") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return err("missing-value", "选项 --target 需要一个路径值（用法：--target <path>）");
      }
      if (target !== null) return err("unexpected-argument", "选项 --target 只能给出一次");
      target = value;
      i++;
      continue;
    }
    // `--opt=value` 形态
    if (token.startsWith("--root=")) {
      const value = token.slice("--root=".length);
      if (value === "") return err("missing-value", "选项 --root 需要一个路径值（--root=<path>）");
      if (root !== null) return err("unexpected-argument", "选项 --root 只能给出一次");
      root = value;
      continue;
    }
    if (token === "--root") {
      const value = argv[i + 1];
      // 下一个 token 若形如选项，视为缺值（不把 `--json` 误当成路径）。
      if (value === undefined || value.startsWith("-")) {
        return err("missing-value", "选项 --root 需要一个路径值（用法：--root <path>）");
      }
      if (root !== null) return err("unexpected-argument", "选项 --root 只能给出一次");
      root = value;
      i++;
      continue;
    }
    if (token === "--json") { json = true; continue; }
    if (token === "--all" || token === "-a") { all = true; continue; }
    if (token === "--full") { full = true; continue; }
    if (token === "--active-only") { activeOnly = true; continue; }
    if (token === "--skip-tests") { skipTests = true; continue; }
    if (token === "--help" || token === "-h") { help = true; continue; }
    if (token === "--version" || token === "-V") { version = true; continue; }

    if (token.startsWith("-") && token !== "-") {
      return err(
        "unknown-option",
        `未知选项：${token}（可用：--root、--json、--all、--full、--active-only、--target、--skip-tests、--help、--version）`,
      );
    }
    positionals.push(token);
  }

  const [commandRaw, ...rest] = positionals;
  // `serve` 专属选项由服务自己解析 ⇒ 原样保留 `--opt value` 的成对顺序（不随位置参数剥离）。
  const serveRawArgv = rawArgv.slice(rawArgv.indexOf("serve") + 1).filter((t) => t !== "--");

  // g-623：`serve` 的选项属于**服务**（--graph-root/--workspace/--state-dir/--port/--host/
  // --rotate-token/--revoke-token …），CLI 参数解析器不解释它们，只原样转交（单一真源在
  // core/service/serve.ts）。因此 `serve` 走**独立**的解析路径：跳过未知选项检查。
  if (commandRaw === "serve") {
    if (help) {
      return {
        args: {
          command: "help",
          subcommand: "serve",
          positionals: [],
          root: null,
          json: false,
          help: true,
          version: false,
          all: false,
          full: false,
          activeOnly: false,
          target: null,
          skipTests: false,
        },
        error: null,
      };
    }
    const sub = positionals.slice(1);
    const action = sub.find((t) => (SERVE_ACTIONS as readonly string[]).includes(t)) ?? "serve";
    // 原样转交的 argv：按**原始**顺序，去掉动作词本身（动作由服务自己再解析一次）。
    const serveArgv = serveRawArgv.filter((t) => t !== action);
    return {
      args: {
        command: "serve",
        subcommand: action === "serve" ? null : action,
        positionals: sub.filter((t) => t !== action),
        root: null,
        json: false,
        help: false,
        version: false,
        all: false,
        full: false,
        activeOnly: false,
        target: null,
        skipTests: false,
        serveArgv,
      },
      error: null,
    };
  }

  // 仅 `--version` / `--help` 而无命令：仍合法（`dsh-graph --version`）。
  if (commandRaw === undefined) {
    if (version || help) {
      return {
        args: {
          command: version ? "version" : "help",
          subcommand: null,
          positionals: [],
          root,
          json,
          help,
          version,
          all,
          full,
          activeOnly,
          target,
          skipTests,
        },
        error: null,
      };
    }
    return err("missing-command", `缺少命令（可用：${TOP_LEVEL_COMMANDS.join(" / ")}；运行 dsh-graph help 查看说明）`);
  }

  if (!(TOP_LEVEL_COMMANDS as readonly string[]).includes(commandRaw)) {
    return err("unknown-command", `未知命令：${commandRaw}（可用：${TOP_LEVEL_COMMANDS.join(" / ")}）`);
  }

  const command: string = commandRaw;
  let subcommand: string | null = null;
  let tail = rest;
  if (command === "goal") {
    const sub = rest[0];
    if (sub === undefined) {
      // `dsh-graph goal` 无子命令但有 --help 时展示该组帮助，否则报缺参。
      if (help) {
        subcommand = null;
        tail = [];
      } else {
        return err("missing-argument", `缺少子命令：goal <${GOAL_SUBCOMMANDS.join("|")}>`);
      }
    } else {
      if (!(GOAL_SUBCOMMANDS as readonly string[]).includes(sub)) {
        return err("unknown-command", `未知子命令：goal ${sub}（可用：${GOAL_SUBCOMMANDS.join(" / ")}）`);
      }
      subcommand = sub;
      tail = rest.slice(1);
    }
  }

  // 选项与命令的适配（g-317）：`--skip-tests` 只适用于 submit，出现在其它命令上属于用法错误。
  if (command !== "submit" && skipTests) {
    return err("unexpected-argument", "选项 --skip-tests 只适用于 submit 命令");
  }

  // 选项与命令的适配（g-315）：sync 专属选项出现在其它命令上属于用法错误，不得被静默忽略。
  if (command !== "sync" && (full || activeOnly || target !== null)) {
    const used = [full ? "--full" : null, activeOnly ? "--active-only" : null, target !== null ? "--target" : null]
      .filter(Boolean)
      .join("、");
    return err("unexpected-argument", `选项 ${used} 只适用于 sync 命令`);
  }

  const key = subcommand ? `${command} ${subcommand}` : command;
  const max = MAX_POSITIONALS[key];
  if (max !== undefined && tail.length > max) {
    const extra = tail.slice(max).join(" ");
    return err(
      "unexpected-argument",
      `命令 ${key} 不接受多余参数：${extra}`,
    );
  }
  if (command === "goal" && subcommand === "show" && tail.length === 0) {
    return err("missing-argument", "命令 goal show 需要一个目标 ID（用法：dsh-graph goal show <id>）");
  }
  // claim（g-316）：唯一写命令之一，必须显式给出目标 ID（不做任何「自动挑目标」的猜测）。
  if (command === "claim" && tail.length === 0) {
    return err("missing-argument", "命令 claim 需要一个目标 ID（用法：dsh-graph claim <goal-id>）");
  }
  // submit（g-317）：**允许省略** goal-id —— 省略时从「唯一在途目标」推断（多个/没有 ⇒ 在
  // submit.ts 里报错并列候选，不猜）。这里只拒绝「给多了」。
  if (command === "submit" && tail.length > 0 && tail[0].trim() === "") {
    return err("missing-argument", "命令 submit 的目标 ID 不能为空串（用法：dsh-graph submit [goal-id]）");
  }

  return {
    args: {
      command,
      subcommand,
      positionals: tail,
      root,
      json,
      help,
      version,
      all,
      full,
      activeOnly,
      target,
      skipTests,
    },
    error: null,
  };
}
