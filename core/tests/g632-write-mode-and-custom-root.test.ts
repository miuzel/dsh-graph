/**
 * g-632：负责人裁决（2026-11-17）两条边界的**守卫套件**。
 *
 * A. MCP 写工具**按需开启**（取代 g-623 判据 6 中「所有写命令未注册」的绝对口径）：
 *    ① 默认关闭，未开启时写工具**根本不注册**（负向对照：E_UNKNOWN_COMMAND + 零副作用）；
 *    ② 开启是**服务端显式动作**（`serve --allow-write` / 运行配置），**请求参数不能开启**
 *       （`allowWrite`/`writeMode`/`mode` 在认证层被当保留参数拒绝，且不产生任何写副作用）；
 *    ③ 开启后执行类写工具可达、真实修改 graph 目录，actor 固定 `mcp:local-service`（不可伪装 human）；
 *    ④ Human Gate 仍 fail-closed：`graph_resolve_accept` / `transition → delivered` /
 *       `graph_claim_supervisor` / `graph_start_attempt` 写模式下**仍不注册**，并有专门的可读原因；
 *    ⑤ 开启状态在 `serve status` 可见，开关动作写审计。
 *
 * B. 核心资料目录名**按项目自定义**：
 *    ⑥ 默认仍是 `.dsh-graph`（零迁移），自定义名贯通 CLI 定位 / 服务侧解析；
 *    ⑦ 自定义名不破坏 worktree 归属判定与路径越界防线（`..` / 绝对路径负向对照）；
 *    ⑧ 服务侧目录名**显式传入**（`--graph-dir-name` 或完整绝对 `--root`），绝不猜 cwd。
 *
 * 既有安全负向矩阵（g-623 A–I）**不改弱**：本套件只做加法。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

import { init, startAttempt, bindAttemptChild } from "../ops.ts";
import { readEvents } from "../events.ts";
import { DEFAULT_GRAPH_DIR_NAME, assertGraphDirName, relativeGraphDirName, resolveCanonicalRoot, assertGraphDirName as assertName } from "../root.ts";
import { locateGraphRoot, LocateError } from "../cli/locate.ts";
import { parseArgs } from "../cli/args.ts";
import { resolveWorkspaceForSync, SyncError } from "../cli/sync.ts";
import { startService, serviceToolNamesFor } from "../service/server.ts";
import { READ_ONLY_COMMAND_NAMES } from "../service/queries.ts";
import {
  HUMAN_GATE_PARTIAL,
  HUMAN_GATE_TOOLS,
  MCP_WRITE_ACTOR,
  WRITE_MODE_COMMAND_NAMES,
  WRITE_MODE_TRANSITION_TARGETS,
} from "../service/write-commands.ts";
import {
  listToolDescriptors,
  isRegisteredTool,
  RESERVED_PARAM_KEYS,
  unregisteredToolReason,
} from "../service/mcp.ts";
import {
  WRITE_MODE_AUDIT_FILE,
  auditWriteMode,
  initService,
  parseServeArgs,
  resolveGraphRootExplicit,
  runServeCommand,
  serviceStatus,
} from "../service/serve.ts";
import { readRuntimeConfig } from "../service/config.ts";
import { makePrivateWorkspace, seedFixtureBoard, rawRequest, snapshotTree, diffTrees } from "./fixtures/g623-service.ts";

type Svc = Awaited<ReturnType<typeof startService>>;

function withService<T>(
  opts: { allowWrite?: boolean },
  fn: (m: { svc: Svc; ws: ReturnType<typeof makePrivateWorkspace>; board: ReturnType<typeof seedFixtureBoard>; token: string; host: string; mcp: (body: unknown, headers?: Record<string, string>) => Promise<any> }) => Promise<T>,
): Promise<T> {
  const ws = makePrivateWorkspace(opts.allowWrite ? "g632-w" : "g632-r");
  const board = seedFixtureBoard(ws.graphRoot);
  return (async () => {
    const svc = await startService({
      graphRoot: ws.graphRoot,
      executionWorkspace: ws.executionWorkspace,
      stateDir: ws.stateDir,
      port: 0,
      allowWrite: opts.allowWrite === true,
    });
    const token = svc.credentials.read();
    const host = `127.0.0.1:${svc.port}`;
    try {
      return await fn({
        svc,
        ws,
        board,
        token,
        host,
        mcp: (body: unknown, headers: Record<string, string> = {}) =>
          rawRequest({
            port: svc.port,
            path: "/mcp",
            method: "POST",
            headers: { host, authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
          }),
      });
    } finally {
      await svc.close();
      ws.cleanup();
    }
  })();
}

/** g-623 H 的写工具清单（27 个）—— 用于「默认关闭」的逐项负向对照。 */
const G623_WRITE_TOOLS = [
  "graph_create_goal", "graph_set_criteria", "graph_transition", "graph_claim_supervisor", "graph_start_attempt",
  "graph_resolve_accept", "graph_archive_goal", "graph_delete_goal", "graph_add_card", "graph_store_attachment",
  "graph_write_results", "graph_refresh_results", "graph_unbind_goal_child", "graph_delete_attachment",
  "graph_memory_add", "graph_memory_replace", "graph_memory_remove", "graph_update_settings",
  "graph_rebuild", "graph_validate", "graph_handoff", "graph_rotate_token", "graph_set_directive",
  "graph_clean_worktree", "graph_append_comment", "graph_rename_goal", "graph_abandon_attempt",
];

/**
 * 写模式下**仍不可达**的 3 个整工具 Human Gate（BLOCK-1 回归钉：它们**必须**不在写白名单里）。
 * 口径与 `HUMAN_GATE_TOOLS` 的键集合同步；本清单在 A③ 里与白名单做**双向**集合比对。
 */
const HUMAN_GATE_TOOL_NAMES_EXPECTED = ["graph_resolve_accept", "graph_claim_supervisor", "graph_start_attempt"];

/**
 * g-623 名单中**已知不进写模式**的工具及原因（「未纳入」的显式账）。
 *
 * 这些名字出现在 g-623 的 H 写矩阵里，但**不是**写模式的候选：清单本身就混入了只读校验、
 * 插件侧不存在的名字与动作面远大于「改 graph 目录」的操作。把它们列在这里 = 让「未纳入」是
 * **有声明的决策**而不是「漏登记」——任何新出现的名字若既不在白名单也不在本表，A③ 必红。
 */
const G623_NOT_IN_WRITE_MODE: Readonly<Record<string, string>> = Object.freeze({
  graph_validate: "纯只读校验（core validate 只返回 problems，不写任何文件）——被 g-623 名单误列为写工具",
  graph_rotate_token: "服务凭据轮换，且插件侧没有该工具定义（host defs=0）——不是看板写操作",
  graph_clean_worktree: "动本地 Git worktree（core worktree.cleanWorktree），不是 graph 目录写；需实时 live 校验",
  graph_refresh_results: "唯一会派 LLM 子代理的路径（llm:true）——异步 + 外部依赖，不由 MCP 同步入口承担",
  graph_unbind_goal_child: "清除执行绑定与 binding token（core 自带 owner/主管授权），与 start/abandon 的执行体面同域，留待人工面",
  graph_write_results: "写 attempt 完成摘要（结果面），属主管职责，另立目标评估",
  graph_rebuild: "从事件流重建状态并回写 frontmatter（全库对账），动作面超出单目标写",
  graph_handoff: "生成跨会话交接文档，属主管职责，另立目标评估",
  graph_delete_attachment: "附件删除，另立目标评估",
  graph_memory_replace: "记忆修订（与 memory_add/remove 同域但独立），另立目标评估",
});

/** 期望在写模式下可达的集合 = g-623 名单 − 3 个 Human Gate − 显式「未纳入」账。 */
const G623_EXPECTED_WRITABLE = G623_WRITE_TOOLS.filter(
  (t) => !HUMAN_GATE_TOOL_NAMES_EXPECTED.includes(t) && !(t in G623_NOT_IN_WRITE_MODE),
);

// ── A① 默认关闭（与 g-623 逐项一致）─────────────────────────────────────────────

test("g-632 A① 写模式默认关闭：工具表恰为 11 个只读工具，27 个写工具全部未注册且零副作用", async () => {
  // 纯函数层：未给 writeMode 与显式 enabled=false 必须**逐项相等**（默认关闭的结构性保证）。
  assert.deepEqual(serviceToolNamesFor(null), READ_ONLY_COMMAND_NAMES);
  assert.deepEqual(serviceToolNamesFor({ enabled: false }), READ_ONLY_COMMAND_NAMES);
  assert.deepEqual(listToolDescriptors(null).map((t: any) => t.name), READ_ONLY_COMMAND_NAMES);
  for (const tool of G623_WRITE_TOOLS) {
    assert.equal(isRegisteredTool(tool, null), false, `${tool} 在默认（关闭）下必须不可注册`);
    assert.equal(isRegisteredTool(tool, { writeMode: { enabled: false } }), false, `${tool} 在显式关闭下必须不可注册`);
  }
  // 只读工具不受影响（正向对照）
  for (const name of READ_ONLY_COMMAND_NAMES) assert.equal(isRegisteredTool(name, null), true);

  // 服务层：未开启时 27 个写工具**逐个**返回 E_UNKNOWN_COMMAND，且 graph 树完全不变。
  await withService({}, async ({ svc, board, mcp }) => {
    assert.deepEqual(svc.writeMode, { enabled: false, actor: "" }, "未开启时服务自省必须报告关闭");
    const before = snapshotTree(board.root);
    for (const tool of G623_WRITE_TOOLS) {
      const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { goal: board.goalId } } });
      assert.equal(r.status, 200, `${tool}：请求本身合法`);
      assert.ok(r.json.error, `${tool} 必须被拒绝`);
      assert.equal(r.json.error.code, -32601);
      assert.equal(r.json.error.data?.code, "E_UNKNOWN_COMMAND");
    }
    assert.deepEqual(diffTrees(before, snapshotTree(board.root)), [], "默认关闭时写工具调用必须零副作用");
    // tools/list 与只读名单逐项一致
    const list = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.deepEqual(list.json.result.tools.map((t: any) => t.name), READ_ONLY_COMMAND_NAMES);
  });
});

test("g-632 A① 关闭态写工具的拒绝理由可读（指明如何开启），Human Gate 名字保持 g-623 原文", () => {
  assert.match(unregisteredToolReason("graph_create_goal", null), /写模式未开启/);
  assert.match(unregisteredToolReason("graph_create_goal", null), /--allow-write/, "必须指出开启方式");
  // Human Gate 名不在写白名单内 ⇒ 关闭态走 g-623 原文（逐字一致）
  assert.equal(unregisteredToolReason("graph_resolve_accept", null), "未注册的工具（MVP 只读白名单）：graph_resolve_accept");
});

// ── A② 请求参数不能开启写模式 ────────────────────────────────────────────────────

test("g-632 A② 请求参数不能开启写模式：allowWrite/writeMode/mode 等一律按保留参数拒绝且零副作用", async () => {
  // 结构性：保留参数表必须覆盖写模式开关族
  for (const key of ["allowWrite", "allow_write", "writeMode", "write_mode", "writable", "mode", "readOnly", "write"]) {
    assert.ok(RESERVED_PARAM_KEYS.includes(key), `保留参数必须包含 ${key}（否则请求参数可被当作可信上下文）`);
  }

  await withService({}, async ({ board, mcp }) => {
    const before = snapshotTree(board.root);
    const probes: Array<[string, any]> = [
      ["顶层 params", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_query_goal", arguments: { goal: board.goalId }, allowWrite: true } }],
      ["initialize 参数", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", allowWrite: true } }],
      ["工具 arguments", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_query_goal", arguments: { goal: board.goalId, writeMode: true } } }],
      ["mode 别名", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_query_goal", arguments: { goal: board.goalId }, mode: "write" } }],
    ];
    for (const [label, body] of probes) {
      const r = await mcp(body);
      assert.equal(r.status, 200, `${label}：HTTP 层正常处理`);
      assert.ok(r.json.error, `${label}：必须被拒绝`);
      assert.equal(r.json.error.code, -32602, `${label}：必须是 INVALID_PARAMS（保留参数）`);
      assert.match(String(r.json.error.message), /保留/, `${label}：必须说明是保留可信上下文字段`);
    }
    assert.deepEqual(diffTrees(before, snapshotTree(board.root)), [], "尝试用请求参数开启写模式必须零副作用");
  });
});

test("g-632 A② 开启入口只认服务端 CLI：--allow-write 是布尔开关，不接受取值", () => {
  const base = ["init", "--root", "/ws/.dsh-graph", "--workspace", "/ws-exec", "--state-dir", "/state"];
  assert.equal(parseServeArgs([...base, "--allow-write"]).allowWrite, true, "显式开关必须被解析为 true");
  assert.equal(parseServeArgs(base).allowWrite, undefined, "未给出时必须保持 undefined（沿用运行配置）");
  assert.equal(parseServeArgs([...base, "--no-allow-write"]).allowWrite, false, "显式关闭必须被解析为 false");
  assert.throws(() => parseServeArgs([...base, "--allow-write=false"]), /不接受取值/, "带取值的写法必须拒绝（不解析字符串真值）");
  assert.throws(() => parseServeArgs([...base, "--allow-write=true"]), /不接受取值/);
});

test("g-632 A② 运行配置：allowWrite 缺省/畸形一律按关闭读取（只认布尔 true）", () => {
  const ws = makePrivateWorkspace("g632-cfg");
  try {
    const args = parseServeArgs(["init", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace, "--state-dir", ws.stateDir]);
    initService(args, { HOME: ws.home });
    assert.equal(readRuntimeConfig(ws.stateDir).allowWrite, false, "未给 --allow-write 时必须落盘 false");
    // 畸形值：字符串 "true" 不得被当成开启（避免配置事故把服务升格为可写）
    const file = join(ws.stateDir, "server.json");
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...cfg, allowWrite: "true" }), "utf8");
    assert.equal(readRuntimeConfig(ws.stateDir).allowWrite, false, "字符串 \"true\" 必须按关闭读取");
    writeFileSync(file, JSON.stringify({ ...cfg, allowWrite: true }), "utf8");
    assert.equal(readRuntimeConfig(ws.stateDir).allowWrite, true, "布尔 true 才生效（正向对照）");
  } finally {
    ws.cleanup();
  }
});

// ── A③ 开启后写工具可达 + actor 可追溯 ───────────────────────────────────────────

test("g-632 A③ 开启写模式后执行类写工具可达并真实修改 graph 目录，actor 固定 mcp:local-service", async () => {
  // ⓪ BLOCK-1 回归钉（结构性，无服务即可判红）：g-623 名单 27 个名字的**每一个**都必须有明确归属 ——
  //    ① 写白名单（可达）、② 3 个整工具 Human Gate、③ 显式声明的「未纳入」账（G623_NOT_IN_WRITE_MODE）。
  //    此前 `graph_append_comment` / `graph_abandon_attempt` 三类都不在 ⇒ 开启态只有 25 个工具可达且
  //    无任何断言。现在做**双向**集合比对：漏登记（既不可达也无声明）与越权开放（Human Gate 混入）都变红。
  assert.equal(G623_WRITE_TOOLS.length, 27, "g-623 写工具名单必须仍是 27 个（口径基线，不得为了对齐而删名单）");
  assert.equal(new Set(G623_WRITE_TOOLS).size, 27, "g-623 名单不得有重复项");
  assert.equal(HUMAN_GATE_TOOL_NAMES_EXPECTED.length, 3, "整工具 Human Gate 恰为 3 个");
  const unaccounted = G623_WRITE_TOOLS.filter(
    (t) => !WRITE_MODE_COMMAND_NAMES.includes(t) && !HUMAN_GATE_TOOL_NAMES_EXPECTED.includes(t) && !(t in G623_NOT_IN_WRITE_MODE),
  );
  assert.deepEqual(unaccounted, [], "g-623 名单里每个名字都必须有归属：写白名单 / Human Gate / 显式「未纳入」账（此处即漏登记）");
  // 「未纳入」账里不得有**其实已在白名单**的名字（声明与代码事实必须一致）
  for (const name of Object.keys(G623_NOT_IN_WRITE_MODE)) {
    assert.ok(!WRITE_MODE_COMMAND_NAMES.includes(name), `${name} 已签到「未纳入」却出现在写白名单里（账实不符）`);
    assert.ok(!HUMAN_GATE_TOOL_NAMES_EXPECTED.includes(name), `${name} 是 Human Gate，不该记在「未纳入」账里`);
  }
  // 正向：g-623 名单里该开放的那批**必须**全在（brief 点名的两个漏项就在其中）
  assert.deepEqual(
    [...G623_EXPECTED_WRITABLE].sort(),
    G623_WRITE_TOOLS.filter((t) => WRITE_MODE_COMMAND_NAMES.includes(t)).sort(),
    "g-623 名单中已开放的集合必须与白名单交集精确一致",
  );
  for (const must of ["graph_append_comment", "graph_abandon_attempt"]) {
    assert.ok(WRITE_MODE_COMMAND_NAMES.includes(must), `${must} 此前被漏登记，必须已在写白名单内`);
  }
  assert.deepEqual(
    [...HUMAN_GATE_TOOL_NAMES_EXPECTED].sort(),
    Object.keys(HUMAN_GATE_TOOLS).sort(),
    "测试内的 Human Gate 清单必须与 `HUMAN_GATE_TOOLS` 真源逐项一致",
  );
  for (const gate of HUMAN_GATE_TOOL_NAMES_EXPECTED) {
    assert.ok(!WRITE_MODE_COMMAND_NAMES.includes(gate), `${gate} 绝不得进入写白名单（Human Gate）`);
  }

  await withService({ allowWrite: true }, async ({ svc, board, mcp }) => {
    assert.deepEqual(svc.writeMode, { enabled: true, actor: MCP_WRITE_ACTOR });

    // tools/list 必须同时列出只读与写工具，且写工具**不得**声明 readOnlyHint
    const list = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools: any[] = list.json.result.tools;
    const names = tools.map((t) => t.name);
    for (const n of READ_ONLY_COMMAND_NAMES) assert.ok(names.includes(n), `只读工具不得消失：${n}`);
    for (const n of WRITE_MODE_COMMAND_NAMES) assert.ok(names.includes(n), `写模式下写工具必须可发现：${n}`);
    // 确保「27 个写工具全部在表中」不是靠名单自证：逐项核对**真实响应**里的名字，
    // 并钉住 3 个 Human Gate 工具**不在**其中（BLOCK-1/P2 回归保护的运行时侧）。
    for (const n of G623_EXPECTED_WRITABLE) {
      assert.ok(names.includes(n), `开启态 tools/list 必须包含 ${n}（g-623 的 24 个可写工具之一）`);
    }
    for (const n of HUMAN_GATE_TOOL_NAMES_EXPECTED) {
      assert.ok(!names.includes(n), `开启态 tools/list 不得包含 ${n}（Human Gate 仍 fail-closed）`);
    }
    assert.equal(
      names.filter((n) => G623_WRITE_TOOLS.includes(n)).length,
      G623_EXPECTED_WRITABLE.length,
      "开启态 tools/list 中出现在 g-623 名单里的工具数必须恰为 24（27 − 3 Human Gate）",
    );
    for (const t of tools) {
      if (WRITE_MODE_COMMAND_NAMES.includes(t.name)) {
        assert.equal(t.annotations.readOnlyHint, false, `${t.name} 不得声明 readOnlyHint`);
        assert.equal(t.annotations.destructiveHint, true, `${t.name} 必须如实声明 destructiveHint`);
      }
    }

    // 真实写入 ①：创建目标（返回新 id，落在 backlog）
    const created = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_create_goal", arguments: { title: "MCP 写入目标", type: "task" } } });
    assert.equal(created.json.result.isError, false, `创建目标必须成功：${JSON.stringify(created.json.result)}`);
    const newGoal = String(created.json.result.structuredContent?.goal ?? "");
    assert.match(newGoal, /^g-\d+$/, "必须返回真实目标 id");
    assert.ok(snapshotTree(board.root).has(`backlog/goals/${newGoal}/goal.md`) || [...snapshotTree(board.root).keys()].some((k) => k.includes(newGoal)), "目标必须真实落盘");

    // 真实写入 ②：追加评论（事件流可追溯 actor）
    const comment = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_add_comment", arguments: { goal: board.goalId, text: "MCP 写入的评论" } } });
    assert.equal(comment.json.result.isError, false, `追加评论必须成功：${JSON.stringify(comment.json.result)}`);

    // 真实写入 ②b：`graph_append_comment`（插件侧别名入口，此前被漏登记）——必须同样可达并真实落盘
    const appendComment = await mcp({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "graph_append_comment", arguments: { goal: board.goalId, text: "MCP 经 append_comment 写入的评论" } },
    });
    assert.equal(appendComment.json.result.isError, false, `graph_append_comment 必须成功：${JSON.stringify(appendComment.json.result)}`);
    assert.match(goalTextOf(board), /MCP 经 append_comment 写入的评论/, "评论必须真实落到 goal.md 的「评论」小节");

    // actor 追溯：新事件里的 actor 必须是 mcp:local-service，绝不出现 human:*
    const events = readEvents(board.root);
    const forged = events.filter((e) => /human:|user$|^owner$/.test(String(e.actor ?? "")));
    assert.ok(evTextOf(board.root).includes(MCP_WRITE_ACTOR), "写入必须在事件流留下 mcp:local-service 痕迹");
    for (const e of events) {
      if (e.actor === MCP_WRITE_ACTOR) continue;
      assert.ok(!/^mcp:/.test(String(e.actor ?? "")), "除固定 actor 外不得出现其他 mcp: 形态 actor");
    }
    void forged;

    // actor 不可伪装：同一个请求里带 actor/owner/human 必须被拒绝
    for (const key of ["actor", "owner", "human", "approval"]) {
      const spoof = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_add_comment", arguments: { goal: board.goalId, text: "x", [key]: "human:owner" } } });
      assert.equal(spoof.json.result.isError, true, `参数 ${key} 在写模式下必须仍被拒绝`);
      assert.match(JSON.stringify(spoof.json.result.content), /E_FORBIDDEN/, `参数 ${key} 必须返回 E_FORBIDDEN`);
    }
    // 顶层可信字段同样拒绝
    const topLevel = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_add_comment", arguments: { goal: board.goalId, text: "x" }, actor: "human" } });
    assert.equal(topLevel.json.error?.code, -32602, "根级 params 的可信字段必须直接拒绝");
  });
});

function evTextOf(root: string): string {
  return readFileSync(join(root, "events.jsonl"), "utf8");
}

// ── A③b graph_abandon_attempt：可开放（不是 Human Gate），但角色授权仍由 core 把关 ────────

test("g-632 A③b 写模式下 graph_abandon_attempt 可达并真实落盘；非 owner 目标仍被 core 授权拒绝", async () => {
  await withService({ allowWrite: true }, async ({ board, mcp }) => {
    // ① MCP 自建的目标 ⇒ `mcp:local-service` 就是 owner ⇒ 放弃成功（证明工具真正可达、而非只在表里）
    const created = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_create_goal", arguments: { title: "待放弃目标", version: board.versionSlug, type: "task" } } });
    assert.equal(created.json.result.isError, false, `创建目标必须成功：${JSON.stringify(created.json.result)}`);
    const ownedGoal = String(created.json.result.structuredContent?.goal ?? "");

    // 用只读查询拿不到 attempt 创建入口（start_attempt 是 Human Gate），故用 core 直接在夹具里预置 attempt。
    const attId = startAttempt(board.root, ownedGoal, { executor: "test", actor: "agent:test" } as any);

    const abandoned = await mcp({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "graph_abandon_attempt", arguments: { goal: ownedGoal, attempt: attId, reason: "MCP 放弃陈旧 attempt" } },
    });
    assert.equal(abandoned.json.result.isError, false, `graph_abandon_attempt 必须可达并成功：${JSON.stringify(abandoned.json.result)}`);
    assert.equal(abandoned.json.result.structuredContent?.abandoned, true, "必须真实标记为已放弃");
    assert.equal(abandoned.json.result.structuredContent?.attempt, attId);
    // 落盘 + 事件可追溯：attempt.abandoned 的 actor 必须是 mcp:local-service
    const attemptText = readFileSync(join(board.root, `versions/${board.versionSlug}/goals/${ownedGoal}/attempts/${attId}/attempt.md`), "utf8");
    assert.match(attemptText, /cancelled/, "attempt.md 必须落 result=cancelled");
    assert.match(evTextOf(board.root), /"attempt\.abandoned"/, "必须写 attempt.abandoned 事件");
    const abandonEvent = readEvents(board.root).filter((e) => e.event === "attempt.abandoned").at(-1);
    assert.equal(abandonEvent?.actor, MCP_WRITE_ACTOR, "放弃事件的 actor 必须固定为 mcp:local-service");

    // ② 幂等：重复放弃 ⇒ already=true，不报错也不重复写（core 既有语义）
    const again = await mcp({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "graph_abandon_attempt", arguments: { goal: ownedGoal, attempt: attId, reason: "再次放弃" } },
    });
    assert.equal(again.json.result.isError, false, `重复放弃必须幂等成功：${JSON.stringify(again.json.result)}`);
    assert.equal(again.json.result.structuredContent?.already, true);

    // ③ 负向对照：夹具目标由 `human:test` 创建 ⇒ MCP 固定 actor 不是 owner ⇒ core 授权拒绝（零提权）
    const before = snapshotTree(board.root);
    const forbidden = await mcp({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "graph_abandon_attempt", arguments: { goal: board.goalId, attempt: board.attemptId, reason: "越权尝试" } },
    });
    assert.equal(forbidden.json.result.isError, true, "非 owner 目标必须被拒绝（不得因开启写模式而提权）");
    assert.match(JSON.stringify(forbidden.json.result.content), /无权解绑/, "必须给出 core 的授权拒绝原因");
    assert.deepEqual(diffTrees(before, snapshotTree(board.root)), [], "授权拒绝必须零副作用");

    // ④ 参数缺失：reason 是 core 的必填项 ⇒ 可读错误而非静默成功
    const noReason = await mcp({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "graph_abandon_attempt", arguments: { goal: ownedGoal, attempt: attId } },
    });
    assert.equal(noReason.json.result.isError, true, "缺 reason 必须被拒绝");
  });
});

test("g-632 A③b MCP 侧不提供 liveCheck ⇒ 只能清「已结算」的 attempt，走不到「活跃中」的（如实钉住这个局限）", async () => {
  await withService({ allowWrite: true }, async ({ board, mcp }) => {
    const created = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_create_goal", arguments: { title: "已绑定目标", version: board.versionSlug, type: "task" } } });
    const goalId = String(created.json.result.structuredContent?.goal ?? "");
    const attId = startAttempt(board.root, goalId, { executor: "test", actor: "agent:test" } as any);
    // 绑定一个真实 child_id（模拟正在执行/刚结束的 attempt）
    bindAttemptChild(board.root, goalId, attId, "child-g632", "agent:test", "sess-g632");

    // ① 已绑定且 result 仍为 pending（= 可能仍在跑）⇒ MCP 无 liveCheck ⇒ **必须 fail-closed 拒绝**
    const live = await mcp({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "graph_abandon_attempt", arguments: { goal: goalId, attempt: attId, reason: "想清活跃 attempt" } },
    });
    assert.equal(live.json.result.isError, true, "活跃（pending）attempt 必须拒绝放弃——MCP 无法确认子代理状态");
    assert.match(JSON.stringify(live.json.result.content), /无法确认子代理状态/, "必须给出 core 的 live check 缺失原因");

    // ② 同一个 attempt 已结算（result=failed）⇒ 放弃成功（证明局限只针对活跃态，不是全拒）
    const attFile = join(board.root, `versions/${board.versionSlug}/goals/${goalId}/attempts/${attId}/attempt.md`);
    writeFileSync(attFile, readFileSync(attFile, "utf8").replace(/"result": "pending"/, '"result": "failed"'), "utf8");
    const settled = await mcp({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "graph_abandon_attempt", arguments: { goal: goalId, attempt: attId, reason: "清已结算 attempt" } },
    });
    assert.equal(settled.json.result.isError, false, `已结算 attempt 必须可放弃：${JSON.stringify(settled.json.result)}`);
    assert.equal(settled.json.result.structuredContent?.abandoned, true);

    // ③ 结构性：MCP 写命令一律不提供 liveCheck（否则等于把「是否仍在跑」的判断权交给客户端）
    const src = readFileSync(join(import.meta.dirname, "../service/write-commands.ts"), "utf8");
    assert.ok(!/liveCheck/.test(src), "core/service/write-commands.ts 不得向 abandonAttempt 传 liveCheck");
  });
});

/** 读夹具目标的 goal.md 全文（版本排期形态；找不到就按 backlog 形态回落）。 */
function goalTextOf(board: { root: string; goalId: string; versionSlug: string }): string {
  for (const rel of [`versions/${board.versionSlug}/goals/${board.goalId}/goal.md`, `backlog/goals/${board.goalId}/goal.md`]) {
    const p = join(board.root, rel);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`找不到目标文件：${board.goalId}（root=${board.root}）`);
}

// ── A④ Human Gate 保留 ─────────────────────────────────────────────────────────

test("g-632 A④ 写模式下 Human Gate 仍 fail-closed：accept / delivered / claim_supervisor / start_attempt 不可达", async () => {
  // 结构性：人工裁决与主管/派发类工具**不得**出现在写白名单里
  for (const tool of Object.keys(HUMAN_GATE_TOOLS)) {
    assert.ok(!WRITE_MODE_COMMAND_NAMES.includes(tool), `${tool} 不得进入写模式白名单（整工具 Human Gate）`);
  }
  // transition：工具可达，但 delivered 是**部分限制**（由状态白名单拒绝，而不是整工具不可达）
  assert.ok(HUMAN_GATE_PARTIAL.graph_transition, "transition 的 delivered 限制必须登记");
  assert.ok(WRITE_MODE_COMMAND_NAMES.includes("graph_transition"), "transition 必须可达（只屏蔽 delivered 这个目标状态）");
  assert.ok(!(WRITE_MODE_TRANSITION_TARGETS as readonly string[]).includes("delivered"), "delivered 必须不在可达状态集合内");
  assert.ok((WRITE_MODE_TRANSITION_TARGETS as readonly string[]).includes("ready"), "非 delivered 状态必须可达");
  // 写模式下的 tools/list 也不得暴露这些名字

  const names = listToolDescriptors({ writeMode: { enabled: true } }).map((t: any) => t.name);
  assert.ok(!names.includes("graph_resolve_accept"), "tools/list 不得暴露 graph_resolve_accept");
  assert.ok(!names.includes("graph_claim_supervisor"), "tools/list 不得暴露 graph_claim_supervisor");
  assert.ok(!names.includes("graph_start_attempt"), "tools/list 不得暴露 graph_start_attempt");

  await withService({ allowWrite: true }, async ({ board, mcp }) => {
    const before = snapshotTree(board.root);
    // ① 人工裁决工具：未注册（METHOD_NOT_FOUND + E_UNKNOWN_COMMAND），理由指向本地 GUI
    for (const tool of ["graph_resolve_accept", "graph_claim_supervisor", "graph_start_attempt"]) {
      const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { goal: board.goalId, verdict: "accept", human: true, force: true } } });
      assert.ok(r.json.error, `${tool} 写模式下仍必须不可达`);
      assert.equal(r.json.error.code, -32601);
      assert.equal(r.json.error.data?.code, "E_UNKNOWN_COMMAND");
      assert.match(String(r.json.error.message), /人工|主管|执行派发/, `${tool} 必须给出可读原因（不是裸的未注册）`);
    }
    // ② delivered：transition 工具可达，但**拒绝** delivered（E_FORBIDDEN），状态不变
    const delivered = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_transition", arguments: { goal: board.goalId, to: "delivered" } } });
    assert.equal(delivered.json.result.isError, true, "transition → delivered 必须 fail-closed");
    assert.match(JSON.stringify(delivered.json.result.content), /E_FORBIDDEN/);
    assert.match(JSON.stringify(delivered.json.result.content), /人工|GUI/, "必须给出可读原因（人在本地看板裁决）");
    assert.deepEqual(diffTrees(before, snapshotTree(board.root)), [], "Human Gate 拒绝必须零副作用（目标状态未被写入）");

    // ③ 正向对照：同一工具迁移到**非 delivered** 状态必须成功（证明限制是精准的状态过滤，不是全拒）
    const planning = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_transition", arguments: { goal: board.goalId, to: "ready" } } });
    assert.equal(planning.json.result.isError, false, `transition → ready 必须可达：${JSON.stringify(planning.json.result)}`);
  });
});

// ── A⑤ 状态可见 + 审计 ─────────────────────────────────────────────────────────

test("g-632 A⑤ serve status 可见写模式，开启/关闭写审计（不含秘密）", async () => {
  const ws = makePrivateWorkspace("g632-status");
  try {
    seedFixtureBoard(ws.graphRoot);
    const off = parseServeArgs(["init", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace, "--state-dir", ws.stateDir]);
    const offInit = initService(off, { HOME: ws.home });
    assert.equal(offInit.allowWrite, false);
    const s1 = serviceStatus(off, { HOME: ws.home });
    assert.equal(s1.allowWrite, false, "status 必须报告写模式关闭");
    assert.match(s1.writeMode, /read-only/);

    // init 审计留痕
    const auditPath = join(ws.stateDir, WRITE_MODE_AUDIT_FILE);
    assert.ok(existsSync(auditPath), "开关动作必须写审计");
    const auditLines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(auditLines.at(-1).action, "init");
    assert.equal(auditLines.at(-1).allowWrite, false);

    // `serve --allow-write` 的**写模式落盘**语义（不启动前台进程：runServe 会阻塞到信号）。
    // 等价路径：运行配置写 true ⇒ serviceStatus 必须报告开启；再写回 false ⇒ 报告关闭。
    const serveArgv = ["serve", "--allow-write", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace, "--state-dir", ws.stateDir];
    assert.equal(parseServeArgs(serveArgv).allowWrite, true, "CLI 必须解析出 --allow-write");
    const cfgFile = join(ws.stateDir, "server.json");
    const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
    writeFileSync(cfgFile, JSON.stringify({ ...cfg, allowWrite: true }), { mode: 0o600 });
    const sOn = serviceStatus(off, { HOME: ws.home });
    assert.equal(sOn.allowWrite, true, "status 必须报告写模式开启");
    assert.match(sOn.writeMode, /allow-write/, "status 必须给出写模式一句话说明");
    // 启动 banner 文案由 handler 生成（同一 status 说明），此处断言其可读内容而非起前台进程
    assert.match(sOn.writeMode, /fail-closed|只读|写/, "写模式说明必须可读");

    // 审计追加 serve 行（直接调用同一入口，不启动前台服务）
    auditWriteMode(ws.stateDir, true, "serve");
    const lines2 = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines2.at(-1).action, "serve");
    assert.equal(lines2.at(-1).allowWrite, true);
    // 审计不含 token 原文（只登记开关动作）
    const token = readFileSync(join(ws.stateDir, "token"), "utf8").trim();
    assert.ok(!readFileSync(auditPath, "utf8").includes(token), "审计不得含 token 原文");
    // 关闭：`serve --no-allow-write` 解析为 false，运行配置回到只读 ⇒ status 回到关闭
    const offArgv = ["serve", "--no-allow-write", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace, "--state-dir", ws.stateDir];
    assert.equal(parseServeArgs(offArgv).allowWrite, false, "CLI 必须解析出显式关闭");
    writeFileSync(cfgFile, JSON.stringify({ ...cfg, allowWrite: false }), { mode: 0o600 });
    assert.equal(readRuntimeConfig(ws.stateDir).allowWrite, false, "关闭动作必须落回运行配置");
    assert.equal(serviceStatus(off, { HOME: ws.home }).allowWrite, false);
  } finally {
    ws.cleanup();
  }
});

// ── B⑥ 默认名 + 自定义名贯通 ──────────────────────────────────────────────────

test("g-632 B⑥ 目录名默认仍是 .dsh-graph（零迁移），自定义名经 core/CLI 一致生效", () => {
  assert.equal(DEFAULT_GRAPH_DIR_NAME, ".dsh-graph");
  assert.equal(relativeGraphDirName(null), ".dsh-graph", "未配置必须回落默认名");
  assert.equal(relativeGraphDirName({}), ".dsh-graph");
  assert.equal(relativeGraphDirName({ root: ".dsh-graph" }), ".dsh-graph");
  assert.equal(relativeGraphDirName({ root: "board-a" }), "board-a", "自定义名原样保留");
  assert.equal(relativeGraphDirName({ root: "boards/main" }), "boards/main", "允许子目录形态");

  // resolveRoot / resolveCanonicalRoot 都按自定义名解析（同一 workspace 下不再硬编码默认名）
  const ws = makePrivateWorkspace("g632-name");
  try {
    const custom = resolveCanonicalRoot({ root: "board-a" }, ws.base);
    assert.equal(custom.root, join(ws.base, "board-a"));
    assert.equal(resolveCanonicalRoot(null, ws.base).root, join(ws.base, ".dsh-graph"), "默认路径逐字不变");

    // CLI 定位：自定义名（不含默认名）必须定位成功；默认名在同样目录下必须报「非工作区」。
    const boardDir = join(ws.base, "proj", "board-a");
    mkdirSync(boardDir, { recursive: true });
    init(boardDir);
    const viaName = locateGraphRoot({ cwd: join(ws.base, "proj"), dirName: "board-a" });
    assert.equal(viaName.root, boardDir, "CLI 必须按自定义名定位到看板");
    // 反向（隔离容器）：只含自定义名目录、无默认名目录时，默认名查找**绝不**返回该自定义目录，
    // 自定义名查找必须精确命中。注意 `tmp/` 位于本仓库内，祖先里本就有真实 `.dsh-graph`——
    // 故这里不断言「报非工作区」（那会被祖先看板命中），只断言**解析目标**：
    // 默认名路径下不存在事件流，而自定义名必须指向真实看板。
    const iso = join(ws.base, "iso");
    const isoBoard = join(iso, "board-a");
    mkdirSync(isoBoard, { recursive: true });
    init(isoBoard);
    const byDefault = locateGraphRoot({ cwd: iso });
    assert.notEqual(byDefault.root, isoBoard, "默认名查找不得命中自定义名目录（默认语义不变）");
    assert.ok(byDefault.root.endsWith(`${sep}.dsh-graph`) || byDefault.root.includes(".dsh-graph"), "默认名仍解析为 .dsh-graph（零迁移）");
    assert.equal(locateGraphRoot({ cwd: iso, dirName: "board-a" }).root, isoBoard, "自定义名必须精确命中看板");
    // --root 指向 workspace + 自定义名 ⇒ 补齐为 <ws>/board-a（不静默读空目录）
    const viaRoot = locateGraphRoot({ cwd: ws.base, root: join(ws.base, "proj"), dirName: "board-a" });
    assert.equal(viaRoot.root, boardDir);
    // --root 直接指向看板目录本身也接受（自定义名形态）
    const direct = locateGraphRoot({ cwd: ws.base, root: boardDir, dirName: "board-a" });
    assert.equal(direct.root, boardDir);
  } finally {
    ws.cleanup();
  }
});

// ── B⑦ 越界防线 + worktree 归属 ────────────────────────────────────────────────

test("g-632 B⑦ 自定义名不得越过工作区：.. / 绝对路径 / 空段一律拒绝（负向对照）", () => {
  for (const bad of ["../escape", "a/../../b", "/etc/passwd", "..", ".", "a//b", "a/./b", "C:/x"]) {
    assert.throws(() => assertGraphDirName(bad), /不能为空|不得|越界|相对路径/, `必须拒绝非法目录名：${JSON.stringify(bad)}`);
    // 穿越类必须点名「越界/不得」，绝对路径必须点名「相对路径」——两种拒绝语义都不含糊。
    if (bad === "/etc/passwd" || bad === "C:/x") {
      assert.throws(() => assertGraphDirName(bad), /相对路径/, `绝对形态必须按「非相对名」拒绝：${bad}`);
      assert.throws(() => relativeGraphDirName({ root: bad }), /相对路径/, `resolveRoot 侧同样按相对名拒绝：${bad}`);
    } else {
      assert.throws(() => relativeGraphDirName({ root: bad }), /不能为空|不得|越界/, `resolveRoot 路径必须同样拒绝：${JSON.stringify(bad)}`);
    }
  }
  // 空 / 纯空白：`assertGraphDirName` 明确拒绝；`relativeGraphDirName` 把空串当「未配置」回落默认名
  // （与 config.root 的既有「空即未给」语义一致），但**空白**同样被拒绝。
  assert.throws(() => assertGraphDirName(""), /不能为空/);
  assert.throws(() => relativeGraphDirName({ root: "/abs" }), /绝对路径|不得/, "绝对 config.root 不得走相对名通道");
  assert.throws(() => relativeGraphDirName({ root: "   " }), /不能为空/);
  assert.equal(relativeGraphDirName({ root: "" }), ".dsh-graph", "空串视为未配置（零迁移）");
  // 正向对照
  assert.equal(assertGraphDirName("board-a"), "board-a");
  assert.equal(assertGraphDirName("boards/main"), "boards/main");
  // 尾斜杠归一化（`board-a/` == `board-a`）；但 `./board-a` 含 `.` 段 ⇒ **fail-closed 拒绝**
  // （越界防线上只接受规整相对名，不做「猜用户意图」的静默归一化）。
  assert.equal(assertGraphDirName("board-a/"), "board-a", "尾斜杠归一化");
  assert.throws(() => assertGraphDirName("./board-a"), /越界防线/, "含 `.` 段必须拒绝（不做静默归一化）");
  assert.equal(assertName, assertGraphDirName);

  // CLI 参数层同样是 fail-closed（用法错误，不进解析）
  const parsed = parseArgs(["info", "--graph-dir-name", "../escape"]);
  assert.ok(parsed.error, "非法目录名必须是用法错误");
  assert.equal(parsed.error?.code, "invalid-value");
  // 与 --root 互斥
  const both = parseArgs(["info", "--root", "/x", "--graph-dir-name", "board-a"]);
  assert.ok(both.error, "--root 与 --graph-dir-name 必须互斥");
  // 正向对照：合法目录名被接受
  const ok = parseArgs(["info", "--graph-dir-name", "board-a"]);
  assert.equal(ok.error, null);
  assert.equal(ok.args?.graphDirName, "board-a");
});

test("g-632 B⑦ worktree 归属判定不因自定义名退化：跨树仍拒绝，同树仍接受", () => {
  const ws = makePrivateWorkspace("g632-sync");
  try {
    const mk = (name: string, dirName: string) => {
      const workspace = join(ws.base, name);
      const root = join(workspace, dirName);
      mkdirSync(workspace, { recursive: true });
      init(root);
      return { workspace, root };
    };
    const a = mk("a", "board-a");
    const b = mk("b", "board-b");
    // 同树 + 自定义名：接受
    assert.equal(resolveWorkspaceForSync(a.workspace, a.root, "board-a"), a.workspace);
    // 跨树：拒绝（自定义名下不得误判为「本树的看板」→ 否则 sync 会写错树）
    assert.throws(
      () => resolveWorkspaceForSync(b.workspace, a.root, "board-a"),
      (e: unknown) => e instanceof SyncError && e.code === "bad-option",
      "跨树必须拒绝",
    );
    // 目录名不一致（声称 board-b 但看板是 board-a）：同样拒绝，不得静默按错名归属
    assert.throws(
      () => resolveWorkspaceForSync(a.workspace, a.root, "board-b"),
      (e: unknown) => e instanceof SyncError,
      "目录名与实际根不一致必须拒绝",
    );
    // 默认名回归：既有落点行为逐字不变
    const d = mk("d", ".dsh-graph");
    assert.equal(resolveWorkspaceForSync(d.workspace, d.root), d.workspace, "未给目录名时默认路径行为不变");
  } finally {
    ws.cleanup();
  }
});

// ── B⑧ 服务侧显式目录名 + 端到端自定义根 ──────────────────────────────────────

test("g-632 B⑧ 服务侧目录名显式传入（不猜 cwd）：--graph-dir-name 解析 + 穿越负向对照", () => {
  const wsAbs = "/abs/ws";
  const explicit = resolveGraphRootExplicit(parseServeArgs(["init", "--root", wsAbs, "--graph-dir-name", "board-a", "--workspace", "/abs/exec"]));
  assert.equal(explicit, join(wsAbs, "board-a"), "显式目录名必须在显式 workspace 下解析（不读 cwd）");
  // 未给目录名：--root 就是看板目录本身（g-623 语义逐字不变）
  assert.equal(resolveGraphRootExplicit(parseServeArgs(["init", "--root", `${wsAbs}/.dsh-graph`, "--workspace", "/abs/exec"])), `${wsAbs}/.dsh-graph`);
  // 穿越/绝对路径：必须拒绝
  for (const bad of ["../etc", "/etc", "a/../../b"]) {
    assert.throws(
      () => resolveGraphRootExplicit(parseServeArgs(["init", "--root", wsAbs, "--graph-dir-name", bad, "--workspace", "/abs/exec"])),
      /绝对路径|空段|越界|不得/,
      `服务侧必须拒绝穿越目录名：${bad}`,
    );
  }
  // 相对 --root 依旧拒绝（不得按 cwd 猜）
  assert.throws(
    () => parseServeArgs(["init", "--root", "ws", "--workspace", "/abs/exec"]).root === "ws" &&
      initService(parseServeArgs(["init", "--root", "ws", "--workspace", "/abs/exec", "--state-dir", "/nonexistent-state"])),
    /绝对路径/,
    "相对 --root 必须被拒绝（不猜 cwd）",
  );
  // 走完整 initService 的自定义根：配置文件里落的是完整绝对路径
  const ws = makePrivateWorkspace("g632-svcname");
  try {
    const wsRoot = join(ws.base, "proj");
    const boardDir = join(wsRoot, "board-a");
    mkdirSync(boardDir, { recursive: true });
    init(boardDir);
    const args = parseServeArgs(["init", "--root", wsRoot, "--graph-dir-name", "board-a", "--workspace", ws.executionWorkspace, "--state-dir", ws.stateDir]);
    const r = initService(args, { HOME: ws.home });
    assert.equal(r.config.graphRoot, boardDir);
    assert.equal(r.graphInitialized, true, "自定义根必须被识别为已初始化看板");
    assert.equal(readRuntimeConfig(ws.stateDir).graphRoot, boardDir, "运行配置必须保存完整绝对路径（无第二真源猜测）");
  } finally {
    ws.cleanup();
  }
});

test("g-632 B⑧ 端到端：自定义根下服务只读查询生效、附件落自定义根、穿越仍被拒", async () => {
  const ws = makePrivateWorkspace("g632-e2e");
  const customRoot = join(ws.base, "graph", "board-a");
  mkdirSync(customRoot, { recursive: true });
  mkdirSync(join(ws.base, "graph", ".dsh-graph"), { recursive: true });
  const board = seedFixtureBoard(customRoot);
  // 干扰项：默认根下放一块**不同的**看板 —— 若服务回落到默认名就会读到它（静默误读负向对照）。
  writeFileSync(join(ws.base, "graph", ".dsh-graph", "events.jsonl"), "", "utf8");
  writeFileSync(join(ws.base, "graph", ".dsh-graph", "DECOY"), "decoy-board\n", "utf8");

  const svc = await startService({ graphRoot: customRoot, executionWorkspace: ws.executionWorkspace, stateDir: ws.stateDir, port: 0, allowWrite: true });
  try {
    const token = svc.credentials.read();
    const host = `127.0.0.1:${svc.port}`;
    const mcp = (body: unknown) =>
      rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

    // 只读：必须读到自定义根的目标（不是默认根的空看板）
    const goals = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_list_goals", arguments: {} } });
    assert.equal(goals.json.result.isError, false, `自定义根查询必须成功：${JSON.stringify(goals.json.result)}`);
    const text = JSON.stringify(goals.json.result.structuredContent);
    assert.ok(text.includes(board.goalId), "必须读到自定义根里的目标（不得回落到默认根）");
    assert.ok(!text.includes("decoy-board"), "不得读到默认根下的干扰看板");

    // 写入：附件必须落在自定义根下（自定义根的附件隔离）
    const stored = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_store_attachment", arguments: { name: "mcp/note.txt", content: "custom-root-attachment\n" } } });
    assert.equal(stored.json.result.isError, false, `附件写入必须成功：${JSON.stringify(stored.json.result)}`);
    assert.ok(existsSync(join(customRoot, "attachments", "mcp", "note.txt")), "附件必须落在自定义根的 attachments/ 下");
    assert.ok(!existsSync(join(ws.base, "graph", ".dsh-graph", "attachments")), "绝不得写入默认根（跨看板隔离）");

    // 穿越负向对照：读附件 `../` 一律 E_NOT_FOUND（不泄露根外存在性）
    for (const bad of ["../.dsh-graph/DECOY", "/etc/passwd", "..\\..\\x"]) {
      const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_read_attachment", arguments: { name: bad } } });
      assert.equal(r.json.result.isError, true, `穿越名必须被拒：${bad}`);
      assert.match(JSON.stringify(r.json.result.content), /E_NOT_FOUND/, `穿越名必须返回 E_NOT_FOUND：${bad}`);
    }
    // 写方向穿越：附件名带 `../` 必须被拒（不写进默认根/根外）
    const escape = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_store_attachment", arguments: { name: "../../escape.txt", content: "x" } } });
    assert.equal(escape.json.result.isError, true, "写入方向的穿越必须被拒");
    assert.ok(!existsSync(join(ws.base, "escape.txt")) && !existsSync(join(ws.base, "graph", "escape.txt")), "穿越写入不得产生根外文件");

    // 默认根干扰看板保持原样（未被服务读写污染）
    assert.deepEqual(readdirSync(join(ws.base, "graph", ".dsh-graph")).sort(), ["DECOY", "events.jsonl"]);
  } finally {
    await svc.close();
    ws.cleanup();
  }
});
