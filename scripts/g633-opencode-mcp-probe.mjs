#!/usr/bin/env node
/**
 * g-633 · OpenCode MCP 接入探针（**可复跑**，评审要求落盘的证据脚本）
 *
 * 为什么存在：att-003 把「与真实 dsh-graph serve 的 MCP 往返成功」「认证头确实发出」写成结论，
 * 但探针用完就删 ⇒ 评审无法复核，错误归因因此得以存活。本脚本把这些结论变成
 * **任何人都能重跑的一条命令**，并把每一步的判别力写清楚（哪一步有鉴别力、哪一步没有）。
 *
 * 用法：
 *   TMPDIR=/tmp node scripts/g633-opencode-mcp-probe.mjs
 *   node scripts/g633-opencode-mcp-probe.mjs --json     # 机器可读输出
 *
 * 退出码：0 = 全部实测项通过；1 = 有实测项失败；2 = 环境不满足（缺 opencode / 缺构建产物）。
 *
 * 实测项（每项都标注鉴别力）：
 *   P1  XDG_* 重定向后可启动                     [有鉴别力：不重定向则 EROFS 崩溃]
 *   P2  `opencode mcp add ... -- goal-graph mcp` 写出的零配置 stdio 形状 [有鉴别力：与 plugins/opencode/opencode.json 逐字段比对]
 *   P2c OpenCode 真实拉起 stdio 进程（`type: "local"`） [有鉴别力：shim 实测捕获真实 spawn + cwd/args]
 *   P2d 真实 `goal-graph mcp` stdio 协议往返（默认 38 工具 / `--read-only` 11 工具 / 自动 Web 端口）[有鉴别力]
 *   P3  `opencode debug config` 能读到配置（HTTP 模式掩码 `***`） [**无鉴别力**：header 对任意值一律掩码 `***`]
 *   P4  HTTP 模式 `{env:}` 真的插值成 token（正向） [有鉴别力，配合 P5 才是决定性证据]
 *   P5  未导出该变量时退化为 len=6（负向对照）     [**决定性**：等长字面量无法伪满足]
 *   P6  `${VAR}` 形态不插值（负向对照）            [**决定性**：区分 OpenCode 与 Claude Code 语法]
 *   P7  真实显式 HTTP `serve` 上的 MCP 往返        [有鉴别力：需服务端真实响应 + 无头 401]
 *   P8  `opencode mcp list` 输出依赖后台服务状态   [无鉴别力，原因未查明 ⇒ 不作判据]
 *
 * 不落盘的东西：本脚本只在 `TMPDIR` 下建临时目录，退出时清理；token 只生成在内存与临时文件里，
 * 不写入任何仓库文件、不打印完整值（只打印长度）。
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const WANT_JSON = process.argv.includes("--json");
const results = [];

function record(id, title, ok, evidence, discriminative) {
  results.push({ id, title, ok, discriminative, evidence });
  if (!WANT_JSON) {
    const mark = ok === null ? "SKIP" : ok ? "PASS" : "FAIL";
    const tag = discriminative ? "[有鉴别力]" : "[无鉴别力]";
    console.log(`${mark} ${id} ${tag} ${title}\n       ${evidence}`);
  }
}

function have(cmd) {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() !== "";
}

const TOKEN = "probe-" + "a".repeat(19) + "-" + "0123456789abcdef"; // 实测 42 字符（6+19+1+16），形态像真 token
const TOKEN_LEN = TOKEN.length;

// ── 临时环境 ────────────────────────────────────────────────────────────────
/** `$TMPDIR` 运行前的条目快照：用于收尾时只删除**本次**新增的 `opencode/`、`.bun-*.so`。 */
const tmpBefore = new Set((() => {
  try {
    return readdirSync(tmpdir());
  } catch {
    return [];
  }
})());
const tmpRoot = mkdtempSync(join(tmpdir(), "g633-probe-"));
const tmpRootName = tmpRoot.slice(tmpRoot.lastIndexOf("/") + 1);
const xdg = {
  XDG_DATA_HOME: join(tmpRoot, "data"),
  XDG_CONFIG_HOME: join(tmpRoot, "config"),
  XDG_STATE_HOME: join(tmpRoot, "state"),
  XDG_CACHE_HOME: join(tmpRoot, "cache"),
};
for (const p of Object.values(xdg)) mkdirSync(p, { recursive: true });
const ocConfigPath = join(xdg.XDG_CONFIG_HOME, "opencode", "opencode.json");

function ocEnv(extra = {}) {
  // PATH 必须保留（否则找不到 opencode）；其余保持最小面
  const base = { ...process.env, ...xdg };
  // 长版本探针不要继承外部 token，避免污染负向对照
  delete base.GOAL_GRAPH_MCP_TOKEN;
  return { ...base, ...extra };
}

function oc(args, extra = {}) {
  const r = spawnSync("opencode", args, { env: ocEnv(extra), encoding: "utf8", timeout: 60000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function main() {
  if (!have("opencode")) {
    record("env", "opencode CLI 可用", null, "PATH 中没有 opencode ⇒ 本探针无法执行", true);
    return 2;
  }
  const distServe = join(REPO, "dist", "bin", "goal-graph.mjs");
  if (!existsSync(distServe)) {
    record("env", "构建产物存在", null, `缺 ${distServe} ⇒ 先 bash scripts/build.sh`, true);
    return 2;
  }

  // ── P1 XDG 重定向后可启动 ────────────────────────────────────────────────
  const ver = oc(["--version"]);
  record(
    "P1",
    "XDG_* 重定向到可写目录后 opencode 可启动",
    ver.code === 0 && /v?\d+\.\d+\.\d+/.test(ver.out),
    `${ver.out.trim().split("\n").slice(-1)[0]} (exit ${ver.code})`,
    true,
  );

  // ── P2 零配置 stdio：`opencode mcp add ... -- goal-graph mcp` 产出配置形状 ──
  const addedStdio = oc(["mcp", "add", "goal-graph", "--global", "--", "goal-graph", "mcp"]);
  let writtenStdioOk = false;
  let writtenStdioShape = "";
  if (existsSync(ocConfigPath)) {
    const j = JSON.parse(readFileSync(ocConfigPath, "utf8"));
    const s = j?.mcp?.servers?.["goal-graph"];
    writtenStdioOk = s?.type === "local" && Array.isArray(s?.command) && s.command[0] === "goal-graph" && s.command[1] === "mcp";
    writtenStdioShape = JSON.stringify(s);
  }
  record(
    "P2",
    "opencode mcp add 写出零配置 stdio（mcp.servers.goal-graph: type=local, command=[goal-graph, mcp]）",
    writtenStdioOk,
    writtenStdioShape || addedStdio.out.trim().slice(0, 200),
    true,
  );

  // 与仓库内 plugins/opencode/opencode.json 逐字段比对
  const repoCfg = JSON.parse(readFileSync(join(REPO, "plugins/opencode/opencode.json"), "utf8"));
  const repoServer = repoCfg?.mcp?.servers?.["goal-graph"];
  const sameStdio = JSON.stringify(repoServer) === writtenStdioShape;
  record("P2b", "插件目录 opencode.json 与实测 stdio 产出逐字段一致", sameStdio, sameStdio ? "逐字段一致" : `仓库=${JSON.stringify(repoServer)}`, true);

  // ── P2c OpenCode 真实拉起 stdio 进程（`type: "local"`）──────────────────
  {
    const stdioHome = mkdtempSync(join(tmpdir(), "g633-stdio-"));
    for (const sub of ["data", "config/opencode", "state", "cache", "bin", "ws"]) mkdirSync(join(stdioHome, sub), { recursive: true });
    const spawnMarker = join(stdioHome, "spawned.log");
    const shimPath = join(stdioHome, "bin", "goal-graph");
    writeFileSync(
      shimPath,
      `#!/usr/bin/env bash\necho "SPAWNED args=$*" >> ${JSON.stringify(spawnMarker)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(distServe)} "$@"\n`,
    );
    chmodSync(shimPath, 0o755);
    writeFileSync(
      join(stdioHome, "config", "opencode", "opencode.json"),
      JSON.stringify({ mcp: { servers: { "goal-graph": { type: "local", command: ["goal-graph", "mcp", "--no-web"] } } } }, null, 2) + "\n",
    );
    const stdioEnv = {
      ...process.env,
      PATH: `${join(stdioHome, "bin")}:${process.env.PATH ?? ""}`,
      XDG_DATA_HOME: join(stdioHome, "data"),
      XDG_CONFIG_HOME: join(stdioHome, "config"),
      XDG_STATE_HOME: join(stdioHome, "state"),
      XDG_CACHE_HOME: join(stdioHome, "cache"),
    };
    delete stdioEnv.GOAL_GRAPH_MCP_TOKEN;
    spawnSync("opencode", ["run", "--standalone", "hi"], { cwd: join(stdioHome, "ws"), env: stdioEnv, encoding: "utf8", timeout: 60000 });
    const markerText = existsSync(spawnMarker) ? readFileSync(spawnMarker, "utf8").trim() : "";
    rmSync(stdioHome, { recursive: true, force: true });
    record(
      "P2c",
      "OpenCode 按 type=local 配置真实拉起 goal-graph mcp 子进程",
      markerText.includes("SPAWNED args=mcp"),
      markerText ? `shim 实测捕获：${markerText.split("\n")[0]}` : "未捕获到 goal-graph mcp 启动记录",
      true,
    );
  }

  // ── P2d 真实 `goal-graph mcp` stdio 协议往返（默认 38 / --read-only 11）──
  {
    const wsDir = join(tmpRoot, "stdio-ws");
    const stateDir = join(tmpRoot, "stdio-state");
    mkdirSync(wsDir, { recursive: true });
    const runStdio = (extraArgs) =>
      spawnSync(process.execPath, [distServe, "mcp", "--state-dir", stateDir, ...extraArgs], {
        cwd: wsDir,
        input: [
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        ].join("\n") + "\n",
        encoding: "utf8",
        timeout: 15000,
      });
    const rw = runStdio([]);
    const ro = runStdio(["--read-only", "--no-web"]);
    const rwMsgs = rw.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const roMsgs = ro.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const rwCount = rwMsgs[1]?.result?.tools?.length ?? -1;
    const roCount = roMsgs[1]?.result?.tools?.length ?? -1;
    const ok =
      rw.status === 0 &&
      ro.status === 0 &&
      rwMsgs.length === 2 &&
      rwMsgs[0]?.result?.serverInfo?.name === "goal-graph-local" &&
      rwCount === 38 &&
      roCount === 11 &&
      /web=http:\/\/127\.0\.0\.1:\d+\//.test(rw.stderr);
    record(
      "P2d",
      "真实 goal-graph mcp stdio 往返（默认 38 工具 + 自动随机端口 Web / --read-only 11 工具）",
      ok,
      `default tools=${rwCount} (exit=${rw.status}); --read-only tools=${roCount} (exit=${ro.status}); stderr=${rw.stderr.trim().slice(0, 120)}`,
      true,
    );
  }

  // ── 进阶显式 HTTP 形态：`opencode mcp add --url` + `{env:}` 插值对照 ─────
  const url = "http://127.0.0.1:7788/mcp";
  oc([
    "mcp",
    "add",
    "goal-graph",
    "--url",
    url,
    "--header",
    "Authorization=Bearer {env:GOAL_GRAPH_MCP_TOKEN}",
    "--global",
  ]);

  // ── P3 debug config 显示 ***（无鉴别力）─────────────────────────────────
  const dbg = oc(["debug", "config"]);
  const dbgHasEntry = dbg.out.includes("goal-graph") && dbg.out.includes("***");
  record(
    "P3",
    "opencode debug config 显示 *** 掩码",
    dbgHasEntry,
    dbgHasEntry
      ? "输出含 goal-graph 条目且 header 显示为 *** —— 但该掩码对**任意值**一律生效，见 P3b，故无鉴别力"
      : dbg.out.trim().split("\n").slice(-3).join(" / ").slice(0, 240),
    false,
  );

  // P3b：字面量 vs 变量引用 → 同样 *** ⇒ 证明该命令无鉴别力
  {
    const literalCfg = {
      mcp: { servers: { "goal-graph": { type: "remote", url, headers: { Authorization: "Bearer PLAINLITERAL_NOT_VAR" } } } },
    };
    writeFileSync(ocConfigPath, JSON.stringify(literalCfg, null, 2) + "\n");
    const lit = oc(["debug", "config"]);
    const litMasked = lit.out.includes("***");
    // 还原为 mcp add 写出的配置，供后续步骤使用
    writeFileSync(ocConfigPath, JSON.stringify({ mcp: { servers: { "goal-graph": { type: "remote", url, headers: { Authorization: "Bearer {env:GOAL_GRAPH_MCP_TOKEN}" } } } } }, null, 2) + "\n");
    record(
      "P3b",
      "纯字面量 header 与变量引用同样显示 ***",
      litMasked,
      litMasked
        ? "字面量 \"Bearer PLAINLITERAL_NOT_VAR\" 也显示 *** ⇒ debug config 对任意值一律掩码，**无鉴别力**，不得据此推断「引用被识别」"
        : "字面量未被掩码（出乎预期）",
      true,
    );
  }

  // ── P4/P5/P6 认证头实际发出（带日志监听器）──────────────────────────────
  /** 起一个记录 Authorization 头的假 MCP 监听器，跑一次 opencode 会话，返回收到的头列表。 */
  async function captureHeaders(envExtra, headerValue, urlOverride) {
    // ⚠️ 每次都必须用**全新的** XDG 数据目录：实测同一目录连跑两次 `opencode run`，
    // 第二次不再发起 MCP 连接（run1 收到 3 个请求，run2 收到 0 个）—— 复用会话/缓存所致。
    const caseHome = mkdtempSync(join(tmpdir(), "g633-case-"));
    for (const sub of ["data", "config/opencode", "state", "cache"]) mkdirSync(join(caseHome, sub), { recursive: true });
    const caseXdg = {
      XDG_DATA_HOME: join(caseHome, "data"),
      XDG_CONFIG_HOME: join(caseHome, "config"),
      XDG_STATE_HOME: join(caseHome, "state"),
      XDG_CACHE_HOME: join(caseHome, "cache"),
    };
    const caseCfg = join(caseHome, "config", "opencode", "opencode.json");
    const seen = [];
    const server = createServer((req, res) => {
      if (req.method === "POST") seen.push(String(req.headers.authorization ?? "<none>"));
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let payload = { jsonrpc: "2.0", id: 1, result: {} };
        try {
          const parsed = JSON.parse(body || "{}");
          if (parsed.method === "initialize") {
            payload = {
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                protocolVersion: parsed.params?.protocolVersion ?? "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "probe", version: "0.0.0" },
              },
            };
          } else if (parsed.method === "tools/list") {
            payload = { jsonrpc: "2.0", id: parsed.id, result: { tools: [] } };
          } else if (parsed.id !== undefined) {
            payload = { jsonrpc: "2.0", id: parsed.id, result: { content: [], isError: false } };
          }
        } catch {
          /* 非 JSON：保持空 result */
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const url = urlOverride ?? `http://127.0.0.1:${port}/mcp`;
    writeFileSync(
      caseCfg,
      JSON.stringify({ mcp: { servers: { "goal-graph": { type: "remote", url, headers: { Authorization: headerValue } } } } }, null, 2) + "\n",
    );
    // 关键：必须让 opencode 走到「已初始化 MCP、开始连服务器」这一步。
    //   · `opencode run --model <不存在>` ⇒ 在 MCP 初始化**之前**就以 rc=1 退出（实测零请求）
    //   · `opencode run hi`（默认模型）⇒ MCP 正常连上；随后 LLM 上游失败与我们无关
    // 因此用默认模型，并把“进程退出”而不是“LLM 成功”当作采集终点。
    const base = { ...process.env, ...caseXdg, ...envExtra };
    delete base.GOAL_GRAPH_MCP_TOKEN;
    Object.assign(base, envExtra);
    // `--standalone`：用私有服务而非后台托管服务。必须加 —— 不加时多次调用会争用同一个
    // 托管服务端口（实测 `Managed service port 49374 ... already in use`），第 2 次起就不再连 MCP。
    const child = spawn("opencode", ["run", "--standalone", "hi"], { env: base, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((r) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        r();
      }, 60000);
      child.on("exit", () => {
        clearTimeout(timer);
        r();
      });
    });
    await new Promise((r) => server.close(r));
    rmSync(caseHome, { recursive: true, force: true });
    return seen;
  }

  /** 采集稳定化：MCP 连接可能与 LLM 上游失败竞争，最多重试 3 轮直到拿到认证头或稳定为空。 */
  async function captureStable(envExtra, headerValue) {
    let last = [];
    for (let i = 0; i < 3; i += 1) {
      last = await captureHeaders(envExtra, headerValue);
      if (last.length > 0) return last;
    }
    return last;
  }

  // 正向：导出 token ⇒ 实收 "Bearer <token>"
  const withVar = await captureStable({ GOAL_GRAPH_MCP_TOKEN: TOKEN }, "Bearer {env:GOAL_GRAPH_MCP_TOKEN}");
  const authWithVar = withVar.find((h) => h.startsWith("Bearer")) ?? "";
  record(
    "P4",
    "认证头确实发出且 {env:} 被替换成真实 token（正向）",
    authWithVar === `Bearer ${TOKEN}`,
    `服务端实收 Authorization 长度=${authWithVar.length}（= "Bearer " 7 + token ${TOKEN_LEN} = ${7 + TOKEN_LEN}）；POST 次数=${withVar.length}`,
    true,
  );

  // 负向对照 A：不导出变量 ⇒ 退化为 "Bearer"（长度 6，插值为空）。
  //   这才是**决定性**证据：等长字面量同样能满足正向的长度算术，但不可能在未导出时退化成 "Bearer"。
  const withoutVar = await captureStable({}, "Bearer {env:GOAL_GRAPH_MCP_TOKEN}");
  const authWithout = withoutVar.find((h) => h.startsWith("Bearer")) ?? "";
  record(
    "P5",
    "负向对照 A：未导出 GOAL_GRAPH_MCP_TOKEN 时退化为 \"Bearer\"（len=6）",
    authWithout === "Bearer",
    withoutVar.length === 0
      ? "本轮未采集到请求（MCP 连接与 LLM 上游失败竞争，未在时限内建立连接）⇒ 该对照本轮**未取得结论**"
      : `服务端实收 Authorization = "${authWithout}"（长度 ${authWithout.length}）⇒ 替换确实取自环境变量；` +
        `正向的长度算术（"Bearer " 7 + token ${TOKEN_LEN} = ${7 + TOKEN_LEN}）本身可被**等长字面量**伪满足，鉴别力来自本行与 P6`,
    true,
  );

  // 负向对照 B：${VAR} 形态不插值 ⇒ 实收的是字面量本身。
  const dollarVar = await captureStable({ GOAL_GRAPH_MCP_TOKEN: TOKEN }, "Bearer ${GOAL_GRAPH_MCP_TOKEN}");
  const authDollar = dollarVar.find((h) => h.startsWith("Bearer")) ?? "";
  record(
    "P6",
    "负向对照 B：${VAR} 形态不插值（实收字面量）",
    authDollar === "Bearer ${GOAL_GRAPH_MCP_TOKEN}",
    dollarVar.length === 0
      ? "本轮未采集到请求 ⇒ 该对照本轮**未取得结论**"
      : `服务端实收长度=${authDollar.length}（字面量 "${"Bearer ${GOAL_GRAPH_MCP_TOKEN}"}" 长度 ${"Bearer ${GOAL_GRAPH_MCP_TOKEN}".length}）` +
        `⇒ OpenCode 只认 {env:}，与 Claude Code 的 \${VAR} 语法可区分`,
    true,
  );

  // ── P7 真实 serve 的 MCP 往返 ────────────────────────────────────────────
  {
    // 还原成插件目录里的配置形状，指向真实 serve
    const servePort = 17788;
    const serveUrl = `http://127.0.0.1:${servePort}/mcp`;
    // serve 的三个前置事实（实测踩到，均写进安装指南排障）：
    //   ① 必须先 `serve init`（未 init 时 serve 报「运行配置不存在」）
    //   ② --root 与 --workspace **不得相同**（同值直接报错 exit 2）
    //   ③ 服务状态目录由 XDG_STATE_HOME 派生，必须可写
    const boardDir = join(tmpRoot, "board");
    const wsDir = join(tmpRoot, "ws");
    const serveTokenPath = join(xdg.XDG_STATE_HOME, "goal-graph-service", "token");
    mkdirSync(boardDir, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
    const initRes = spawnSync(process.execPath, [distServe, "serve", "init", "--root", boardDir, "--workspace", wsDir], {
      env: ocEnv({ GOAL_GRAPH_MCP_TOKEN: TOKEN }),
      encoding: "utf8",
      timeout: 60000,
    });
    // serve 使用的 token 是 init 写进私有状态目录的那一个（不是我们自己编的）
    let serveToken = "";
    try {
      serveToken = readFileSync(serveTokenPath, "utf8").trim();
    } catch {
      /* 读不到则留空，下面断言会红 */
    }
    if (initRes.status !== 0) {
      record("P7", "真实 goal-graph serve 上的 MCP 往返", false, `serve init 失败 rc=${initRes.status}：${(`${initRes.stdout ?? ""}${initRes.stderr ?? ""}`).trim().slice(0, 200)}`, true);
      return finish();
    }
    writeFileSync(ocConfigPath, JSON.stringify({ mcp: { servers: { "goal-graph": { type: "remote", url: serveUrl, headers: { Authorization: "Bearer {env:GOAL_GRAPH_MCP_TOKEN}" } } } } }, null, 2) + "\n");

    const serve = spawn(process.execPath, [distServe, "serve", "--root", boardDir, "--workspace", wsDir, "--port", String(servePort)], {
      env: { ...ocEnv({ GOAL_GRAPH_MCP_TOKEN: TOKEN }) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let serveOut = "";
    serve.stdout.on("data", (c) => (serveOut += c));
    serve.stderr.on("data", (c) => (serveOut += c));
    // 等端口起来（最多 15s）
    let up = false;
    for (let i = 0; i < 75 && !up; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      const probe = spawnSync(process.execPath, ["-e", `fetch(${JSON.stringify(serveUrl)},{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.T} ,body:JSON.stringify({jsonrpc:"2.0",id:0,method:"ping"})}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))`], {
        env: { ...process.env, T: serveToken },
        timeout: 5000,
      });
      up = probe.status === 0;
    }

    if (!up) {
      record("P7", "真实 goal-graph serve 上的 MCP 往返", false, `serve 未在 15s 内起来：${serveOut.slice(-200)}`, true);
    } else {
      // 直接用 fetch 模拟客户端协议往返（不依赖 opencode 能否跑通完整会话）
      const post = async (body, auth = `Bearer ${serveToken}`) => {
        const r = await fetch(serveUrl, {
          method: "POST",
          headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
          body: JSON.stringify(body),
        });
        return { status: r.status, json: await r.json().catch(() => null) };
      };
      const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
      const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const tools = list.json?.result?.tools ?? [];
      const listNames = tools.map((t) => t.name);
      const call = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "graph_list_goals", arguments: {} } });
      const callText = JSON.stringify(call.json ?? {});
      const unauthorized = await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, null);
      const ok =
        serveToken.length > 0 &&
        init.json?.result?.serverInfo?.name !== undefined &&
        listNames.length === 11 &&
        call.json?.result !== undefined &&
        unauthorized.status !== 200;
      record(
        "P7",
        "真实 goal-graph serve 的 MCP 往返（initialize / tools/list / tools/call）",
        ok,
        `initialize=${init.status} serverInfo=${init.json?.result?.serverInfo?.name ?? "?"}；` +
          `tools/list=${listNames.length} 个工具；tools/call graph_list_goals → ${call.json?.result?.isError ? "isError 结果" : "正常结果"}；` +
          `未带认证头 → HTTP ${unauthorized.status}（证明认证层确实生效）。` +
          `注意：tools/call 返回 ${/E_NOT_INITIALIZED/.test(callText) ? "E_NOT_INITIALIZED 应用层错误" : "正常数据"}，` +
          `本探针**不**据此推断「token 已通过认证层」—— 认证是否生效由「未带头的对照返回非 200」单独证明`,
        true,
      );
    }
    serve.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (serve.exitCode === null) serve.kill("SIGKILL");
  }

  return finish();
}

// ── P8 mcp list 的行为（不是「恒返回空」）────────────────────────────────
async function finish() {
  {
    // 冷启动：从未跑过 run ⇒ 返回 No MCP servers configured
    const coldHome = mkdtempSync(join(tmpdir(), "g633-p8a-"));
    for (const d of ["data", "config/opencode", "state", "cache"]) mkdirSync(join(coldHome, d), { recursive: true });
    writeFileSync(
      join(coldHome, "config", "opencode", "opencode.json"),
      JSON.stringify({ mcp: { servers: { "goal-graph": { type: "remote", url: "http://127.0.0.1:7788/mcp", headers: { Authorization: "Bearer {env:GOAL_GRAPH_MCP_TOKEN}" } } } } }, null, 2) + "\n",
    );
    const coldEnv = { ...process.env, XDG_DATA_HOME: join(coldHome, "data"), XDG_CONFIG_HOME: join(coldHome, "config"), XDG_STATE_HOME: join(coldHome, "state"), XDG_CACHE_HOME: join(coldHome, "cache") };
    delete coldEnv.GOAL_GRAPH_MCP_TOKEN;
    const cold = spawnSync("opencode", ["mcp", "list"], { env: coldEnv, encoding: "utf8", timeout: 60000 });
    const coldOut = `${cold.stdout ?? ""}${cold.stderr ?? ""}`.trim();
    rmSync(coldHome, { recursive: true, force: true });

    // 热状态：同一 XDG 目录跑过一次 run 之后 ⇒ 能列出该 server
    const warmHome = mkdtempSync(join(tmpdir(), "g633-p8b-"));
    for (const d of ["data", "config/opencode", "state", "cache"]) mkdirSync(join(warmHome, d), { recursive: true });
    writeFileSync(
      join(warmHome, "config", "opencode", "opencode.json"),
      JSON.stringify({ mcp: { servers: { "goal-graph": { type: "remote", url: "http://127.0.0.1:44093/mcp", headers: { Authorization: "Bearer {env:GOAL_GRAPH_MCP_TOKEN}" } } } } }, null, 2) + "\n",
    );
    const warmEnv = { ...process.env, XDG_DATA_HOME: join(warmHome, "data"), XDG_CONFIG_HOME: join(warmHome, "config"), XDG_STATE_HOME: join(warmHome, "state"), XDG_CACHE_HOME: join(warmHome, "cache"), GOAL_GRAPH_MCP_TOKEN: TOKEN };
    spawnSync("opencode", ["run", "--standalone", "hi"], { env: warmEnv, encoding: "utf8", timeout: 60000 });
    const warm = spawnSync("opencode", ["mcp", "list"], { env: warmEnv, encoding: "utf8", timeout: 60000 });
    const warmOut = `${warm.stdout ?? ""}${warm.stderr ?? ""}`.trim();
    rmSync(warmHome, { recursive: true, force: true });

    // 注意：本项只用 ok=null（观察项）而非 true/false —— `opencode mcp list` 依赖后台托管服务，
    // 而它的输出会随环境变化（本次两组都因托管服务端口争用报错；评审 3 次复跑则均正常返回
    // `No MCP servers configured`、`ss` 上无该端口监听）。⇒ **端口争用不是该子命令的固有行为**，
    // 只是某一轮环境的残留服务造成的；因此这里**只如实记录当次观察**，不据此判红/判绿、也不对机制作断言。
    record(
      "P8",
      "opencode mcp list 输出依赖后台服务状态（观察项，不作判据）",
      null,
      `本次观察（仅当轮，不代表固有行为）：冷启动="${coldOut.replace(/\n/g, " ").slice(0, 120)}"；` +
        `跑过 run 后="${warmOut.replace(/\n/g, " ").slice(0, 120)}"。` +
        `两次配置**完全相同**而输出不同（也可能直接报托管服务端口错）⇒ ` +
        `该子命令不作判据；判据用 P4–P6（认证头实收）与 P7（tools/list 往返）`,
      false,
    );
  }

  return results.every((r) => r.ok === true || r.ok === null) ? 0 : 1;
}

/**
 * **`opencode` 本体在 `$TMPDIR` 下可能留下的产物名**（**不是**本脚本建的）。
 *
 * att-006 评审实测：只匹配 `\.so$` 会漏掉 `\.bun-1000-*.node`（514960 B）—— 探针跑完 `/tmp` 里仍有残留。
 * 故改为按 **`.bun-` 前缀整体匹配**（覆盖面最大：`.so` / `.node` / 将来别的前缀产物都算），
 * 并额外接受 `opencode` 目录本身。前缀口径见 `isOpenCodeTmpArtifact`。
 */
function isOpenCodeTmpArtifact(name) {
  return name === "opencode" || name === ".bun" || name.startsWith(".bun-");
}

/**
 * 清理 `opencode` 本体在 `TMPDIR` 下留下的临时产物。
 *
 * 只删**本次运行前不存在**的项（避免误删用户既有的同名目录），且只删本目录一层。
 * 返回**未能删除**的名单（供收尾自检判红）。
 */
function cleanupOpenCodeTmpArtifacts(before) {
  const dir = tmpdir();
  const failed = [];
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return failed;
  }
  for (const name of entries) {
    if (before.has(name)) continue; // 运行前就有 ⇒ 不是本探针造成的，绝不删
    if (!isOpenCodeTmpArtifact(name)) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

/**
 * **零残留自检**：运行前后 `$TMPDIR` 的条目集合**必须相同**。
 *
 * 判据是「新增集合为空」而不是「删成功了几项」：
 * 任何本次新增、且不是本脚本自己的 `tmpRoot` 的条目都算残留（含 `opencode/`、`.bun-*`、其他未知产物）。
 * 这同时防住「清理正则又漏了一种后缀」这一类回归 —— 漏了就必然算作残留 ⇒ 判红。
 */
function tmpResidue(before) {
  const dir = tmpdir();
  let after = [];
  try {
    after = readdirSync(dir);
  } catch {
    return [];
  }
  return after.filter((name) => !before.has(name) && name !== tmpRootName);
}

let code = 1;
try {
  code = await main();
} catch (e) {
  record("exception", "探针异常", false, String(e?.stack ?? e).slice(0, 400), true);
  code = 1;
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
  const undeleted = cleanupOpenCodeTmpArtifacts(tmpBefore);
  // **零残留自检**：清理之后再快照一次，新增集合必须为空 ⇒ 否则判红（并把 code 置 1）
  const residue = tmpResidue(tmpBefore);
  record(
    "S1",
    "TMPDIR 零残留自检（运行前后条目集合相同）",
    residue.length === 0 && undeleted.length === 0,
    residue.length === 0 && undeleted.length === 0
      ? `运行前后 ${tmpdir()} 新增条目 0 项（已清理 \u0060opencode/\u0060 / \u0060.bun-*\u0060 等产物）`
      : `仍残留 ${residue.length} 项：${residue.join(", ") || "(无)"}；未能删除：${undeleted.join(", ") || "(无)"}`,
    true,
  );
  if (residue.length > 0 || undeleted.length > 0) code = 1;
  if (WANT_JSON) {
    console.log(JSON.stringify({ ok: code === 0, results }, null, 2));
  } else {
    const pass = results.filter((r) => r.ok === true).length;
    const fail = results.filter((r) => r.ok === false).length;
    const skip = results.filter((r) => r.ok === null).length;
    console.log(`\n汇总：pass=${pass} fail=${fail} skip=${skip} exit=${code}`);
  }
}
process.exitCode = code;
