// g-469 真宿主派发探测插件（**惰性资产，不参与闸门**：文件名不匹配 core/tests/*.test.ts，
// 只有被显式 --patch 引用时才会被 DSH 加载）。
//
// 用途：在**真实 DSH 运行时**里探测 subagent 服务的派发 API 面，并在真实 live Agent
// 出现时，用被测插件（dsh-graph）的收口 helper `startSubagentCompat` 走一次**真实派发**，
// 把「是否拿到真实 childId」写进 out 指定的 JSON 文件。
//
// 不写任何凭据、不调模型（派发在「子代理 inbox 接收首条消息」即 resolve；后续轮次需要
// 模型凭据与本探测无关）——因此可在无凭据环境复跑。
//
// 复跑步骤（DSH_HOME 必须在项目 tmp/ 内；每个宿主版本一份独立 home）：
//   1) 先在隔离树里构建本插件：`bash scripts/build.sh`
//   2) 写补丁（把探测件与 out 路径注入 headless profile）：
//        - insert:
//            - id: g469-host-probe
//              name: <repo>/core/tests/fixtures/g469-host-dispatch-probe.mjs
//              config: { out: <repo>/tmp/g469/probe.json, pluginEntry: <repo>/dist/index.js, hostVersion: <版本> }
//   3) 用目标版本的运行时（tmp/dsh-test/<版本>）跑：
//        DSH_HOME=<repo>/tmp/g469/home-<版本> \
//          <repo>/tmp/dsh-test/<版本>/node_modules/.bin/dsh --profile headless \
//          --patch <上面的补丁> "say hi"
//      （进程最后会因无模型凭据以 MISSING_CREDENTIAL、退出码 1 结束 —— 与派发探测无关，
//        证据以 out 指向的 JSON 为准。）
//   4) 读 out JSON：`dispatch.ok === true` 且 `dispatch.childId` 非空、`child_id_is_real === true`
//      即「真实派发拿到真实 childId」；`service.has_startActivation/has_startContinuable`
//      是**真实服务面**（不是 mock）；`pre_fix_repro` 只在旧名缺失的宿主上出现（零副作用）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const name = "g469-host-probe";
export const inject = ["subagents"];

export function apply(ctx, config) {
  const out = config.out;
  const pluginEntry = config.pluginEntry;
  const hostVersion = config.hostVersion ?? null;
  const record = {
    host_version: hostVersion,
    node: process.version,
    service: null,
    dispatch: null,
    note: "g-469 临时探测件",
  };
  const write = () => {
    try {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
    } catch (e) {
      console.error("[g469-probe] write failed:", e);
    }
  };

  const s = ctx.get("subagents");
  record.service = {
    has_startActivation: typeof s?.startActivation === "function",
    has_startContinuable: typeof s?.startContinuable === "function",
    has_interruptByParent: typeof s?.interruptByParent === "function",
    has_getProvider: typeof s?.getProvider === "function",
    registered: (() => { try { return s.list(); } catch (e) { return `list() 抛错: ${e?.message ?? e}`; } })(),
    prepareContinuable_capable: (() => {
      try {
        return s.list().filter((n) => typeof s.getProvider(n)?.prepareContinuable === "function");
      } catch (e) { return [`getProvider 抛错: ${e?.message ?? e}`]; }
    })(),
  };
  write();

  ctx.on("agent/created", async ({ agent, source, signal }) => {
    if (record.dispatch) return;
    const subagents = ctx.get("subagents");
    // 派发时刻重新读一次 provider 面（apply 时刻可能早于 provider 插件注册）。
    const capable = (() => {
      try { return subagents.list().filter((n) => typeof subagents.getProvider(n)?.prepareContinuable === "function"); }
      catch (e) { return [`getProvider 抛错: ${e?.message ?? e}`]; }
    })();
    const provider = capable[0];
    const spec = {
      provider,
      label: "g469:host-probe",
      request: {
        parent: agent,
        prompt: [{ type: "text", text: "g-469 派发契约探测：无需回复，仅验证子代理能否被真实创建。" }],
      },
      signal: signal ?? new AbortController().signal,
    };
    record.dispatch = {
      attempted: true, source, provider,
      registered_at_dispatch: (() => { try { return subagents.list(); } catch (e) { return String(e?.message ?? e); } })(),
      prepareContinuable_capable_at_dispatch: capable,
      parent_id: agent?.id ?? null,
      spec_fields: Object.keys(spec).sort(),
      request_fields: Object.keys(spec.request).sort(),
    };
    write();
    try {
      const { startSubagentCompat } = await import(pluginEntry);
      const started = await startSubagentCompat(subagents, spec);
      record.dispatch.ok = true;
      record.dispatch.childId = started?.childId ?? null;
      record.dispatch.parentSessionId = started?.parentSessionId ?? null;
      record.dispatch.receipt_keys = Object.keys(started ?? {}).sort();
      record.dispatch.child_id_is_real = typeof started?.childId === "string" && started.childId.length > 0
        && started.childId !== agent?.id;
    } catch (e) {
      record.dispatch.ok = false;
      record.dispatch.error = String(e?.message ?? e);
      record.dispatch.error_code = e?.code ?? null;
    }
    if (!record.service.has_startContinuable) {
      // 阴性对照：直接按**修复前**的写法调用宿主旧名，复现上报的失败形态
      // （仅在旧名确实不存在时执行 ⇒ 零副作用，不会真的多建一个子代理）。
      try {
        await subagents.startContinuable(spec);
        record.pre_fix_repro = { threw: false };
      } catch (e) {
        record.pre_fix_repro = {
          call: "subagents.startContinuable(spec)",
          threw: true,
          error_name: e?.constructor?.name ?? null,
          error: String(e?.message ?? e),
        };
      }
    }
    write();
  });
}
