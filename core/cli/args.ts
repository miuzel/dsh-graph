/**
 * dsh-cli 参数解析（g-314）：手写最小解析器，零第三方 CLI 框架、零网络。
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
  /** 命令名词（`info` / `status` / `version` / `goal` / `help`）。 */
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
}

export interface ParseResult {
  args: ParsedArgs | null;
  error: ArgError | null;
}

/** 已知顶层命令（`goal` 为多子命令容器）。 */
export const TOP_LEVEL_COMMANDS = ["info", "status", "version", "goal", "help"] as const;
/** `goal` 的已知子命令。 */
export const GOAL_SUBCOMMANDS = ["list", "show"] as const;

/** 各命令接受的位置参数个数上限（不含子命令名）。 */
const MAX_POSITIONALS: Record<string, number> = {
  info: 0,
  status: 0,
  version: 0,
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
 * 选项可出现在命令前后（`dsh-cli --root x goal list` 与 `dsh-cli goal list --root x` 等价）。
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const positionals: string[] = [];
  let root: string | null = null;
  let json = false;
  let help = false;
  let version = false;
  let all = false;
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
    if (token === "--help" || token === "-h") { help = true; continue; }
    if (token === "--version" || token === "-V") { version = true; continue; }

    if (token.startsWith("-") && token !== "-") {
      return err("unknown-option", `未知选项：${token}（可用：--root、--json、--all、--help、--version）`);
    }
    positionals.push(token);
  }

  const [commandRaw, ...rest] = positionals;

  // 仅 `--version` / `--help` 而无命令：仍合法（`dsh-cli --version`）。
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
        },
        error: null,
      };
    }
    return err("missing-command", `缺少命令（可用：${TOP_LEVEL_COMMANDS.join(" / ")}；运行 dsh-cli help 查看说明）`);
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
      // `dsh-cli goal` 无子命令但有 --help 时展示该组帮助，否则报缺参。
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
    return err("missing-argument", "命令 goal show 需要一个目标 ID（用法：dsh-cli goal show <id>）");
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
    },
    error: null,
  };
}
