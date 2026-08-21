/**
 * dsh-graph 核心层 CLI。
 * 用法：node core/main.ts [--root DIR] <init|create-goal|set-criteria|transition|validate|rebuild> [flags]
 */

import { GraphError } from "./machine.ts";
import {
  init,
  createGoal,
  setCriteria,
  transition,
  validate,
  rebuild,
  addCard,
  fillCard,
  reviewCard,
  startAttempt,
  reportStatus,
  moveGoal,
  amendGoal,
} from "./ops.ts";

interface Args {
  root: string;
  command?: string;
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { root: ".dsh-graph", flags: new Map() };
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === "--root") {
      args.root = argv[++i];
    } else if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const values: string[] = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        values.push(argv[++i]);
      }
      // 布尔 flag（无值）记为空数组
      args.flags.set(key, values);
    } else if (!args.command) {
      args.command = tok;
    } else {
      throw new GraphError(`无法识别的参数：${tok}`);
    }
    i++;
  }
  return args;
}

function flag(args: Args, name: string): string | undefined {
  return args.flags.get(name)?.[0];
}

function flagAll(args: Args, name: string): string[] {
  return args.flags.get(name) ?? [];
}

function need(args: Args, name: string): string {
  const v = flag(args, name);
  if (v === undefined) throw new GraphError(`缺少必填参数 --${name}`);
  return v;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const actor = flag(args, "actor") ?? "cli";
  switch (args.command) {
    case "init":
      init(args.root);
      console.log(`initialized: ${args.root}`);
      return;
    case "create-goal": {
      const id = createGoal(args.root, {
        title: need(args, "title"),
        version: flag(args, "version"),
        scope: flagAll(args, "scope"),
        actor,
      });
      console.log(id); // 只输出 id，供脚本捕获
      return;
    }
    case "set-criteria": {
      const criteria = flagAll(args, "criteria");
      setCriteria(args.root, need(args, "goal"), criteria, actor);
      console.log("criteria confirmed");
      return;
    }
    case "transition": {
      transition(args.root, need(args, "goal"), need(args, "to"), {
        reason: flag(args, "reason"),
        actor,
      });
      console.log("ok");
      return;
    }
    case "add-card": {
      const cardId = addCard(args.root, need(args, "goal"), {
        title: need(args, "title"),
        kind: need(args, "kind"),
        actor,
      });
      console.log(cardId); // 只输出卡片 id，供脚本捕获
      return;
    }
    case "fill-card": {
      fillCard(args.root, need(args, "goal"), need(args, "card"), {
        text: flag(args, "text"),
        contentRef: flag(args, "content-ref"),
        summary: flag(args, "summary"),
        by: flag(args, "by") ?? actor,
        actor,
      });
      console.log("ok");
      return;
    }
    case "review-card": {
      reviewCard(args.root, need(args, "goal"), need(args, "card"), {
        by: flag(args, "by") ?? actor,
        actor,
      });
      console.log("ok");
      return;
    }
    case "start-attempt": {
      const attId = startAttempt(args.root, need(args, "goal"), {
        executor: flag(args, "executor") ?? actor,
        actor,
      });
      console.log(attId); // 只输出 attempt id
      return;
    }
    case "report-status": {
      reportStatus(
        args.root,
        need(args, "goal"),
        need(args, "attempt"),
        need(args, "status"),
        actor,
      );
      console.log("ok");
      return;
    }
    case "amend-goal": {
      amendGoal(args.root, need(args, "goal"), {
        note: need(args, "note"),
        appendDescription: flag(args, "append"),
        actor,
      });
      console.log("ok");
      return;
    }
    case "move-goal": {
      const to = need(args, "to");
      if (to !== "backlog" && to !== "standalone" && to !== "version") {
        throw new GraphError("--to 只能是 backlog | standalone | version");
      }
      moveGoal(args.root, need(args, "goal"), {
        to,
        version: flag(args, "version"),
        actor,
      });
      console.log("ok");
      return;
    }
    case "validate": {
      const problems = validate(args.root);
      if (problems.length > 0) {
        for (const p of problems) console.error(`PROBLEM: ${p}`);
        process.exit(1);
      }
      console.log("validate: PASS");
      return;
    }
    case "rebuild": {
      const drift = rebuild(args.root);
      if (drift.length > 0) {
        for (const d of drift) console.error(`DRIFT: ${d}`);
        if (args.flags.has("check")) process.exit(1);
      } else {
        console.log("rebuild: consistent");
      }
      return;
    }
    default:
      throw new GraphError(
        "用法：node core/main.ts [--root DIR] <init|create-goal|set-criteria|transition|add-card|fill-card|review-card|start-attempt|report-status|move-goal|amend-goal|validate|rebuild> [flags]",
      );
  }
}

try {
  main();
} catch (e) {
  if (e instanceof GraphError) {
    console.error(`ERROR: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
