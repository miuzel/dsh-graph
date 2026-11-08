/**
 * g-506 att-005：关照结论**分类契约**（真实 3120 误分类后的最小返工）。
 *
 * 现场（已由负责人授权只读两次提取结果核实）：child 只 sleep 300s、巡检前无新事件，主管以
 * 「仍 running + 预计静默」为依据回传 progress，reminders 1→0。根因假设是**接口说明不充分**：
 * 唤醒正文与 `graph_care_outcome` 描述只列 `progress|no-progress|unknown`，没解释各自边界。
 *
 * 本套件只守两件事：
 *  ① 真实生成的唤醒正文（zh/en）与**真实注册**的工具描述（zh/en）逐条包含同一份三值定义；
 *  ② 计数/锁规则**没有**被这次文案改动顺带改掉（unknown 不增不清、3 份 no-progress 升级、
 *     progress 归零但不解人类锁），且证据仍只做非空/长度格式校验。
 *
 * 明确不声称：这不能证明任何模型会遵循定义（自然语言判断无法静态强制），也不是 evidence
 * 语义真实性验证 —— 负向对照只证明「定义一旦被删/漂移，断言会真实变红」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CARE_OUTCOME_CONTRACT_EN,
  CARE_OUTCOME_CONTRACT_ZH,
  CARE_OUTCOMES,
  applyCareOutcome,
  formatCareWakeMessage as formatCareWakeMessageRaw,
  newCareGroupState,
  resolveCareDisciplineText,
} from "../../dist/core/care.js";
import { readCorePromptAsset } from "../../dist/core/ops.js";
import { SERVER_I18N, sT } from "../../dist/lib/server-i18n.js";
import { apply } from "../../dist/index.js";

/**
 * g-618：「首次全量、后续精简」上线后，**完整纪律**只出现在「开启态首发」这一场景。
 * 本套件的断言一字未改，只把场景显式限定到「开关默认开启 + 同一主管会话的第一份」：
 * `mode:"full"` + 公共层纪律资产（生产宿主走的正是这条装配路径）。精简版另由
 * `g618-care-wake-compact.test.ts` 守卫（并断言兜底纪律仍在、机读必需项齐全）。
 */
const disciplineZh = resolveCareDisciplineText({ lang: "zh", load: (l) => readCorePromptAsset("care-discipline", l) }).text;
const formatCareWakeMessage = (input: any) => formatCareWakeMessageRaw({ mode: "full", discipline: disciplineZh, ...input });

const KEY = "tool.graph_care_outcome";
const dict = SERVER_I18N as unknown as Record<"zh" | "en", Record<string, string>>;

/** 「sleep + running + 预期静默」的现场形态：已持续 300s、从未关照、零无进展。 */
const targets = [{
  goal: "goal-a",
  attempt: "att-001",
  child: "child-a",
  elapsedMs: 300_000,
  lastCareAgoMs: null,
  stagnantRounds: 0,
  maxStagnantRounds: 3,
  humanLocked: false,
}];

/** 缺哪些定义子句（空数组 = 全部存在）。 */
function missingClauses(text: string, clauses: readonly string[]): string[] {
  return clauses.filter((clause) => !text.includes(clause));
}

function registeredTool() {
  const registered: any[] = [];
  const ctx = {
    get: () => undefined,
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (def: any) => { registered.push(def); return () => {}; },
      get: () => ({}),
    },
  };
  // 只读注册表：root 用一次性空目录（mkdtemp 跟随 TMPDIR），不触碰任何真实看板数据。
  apply(ctx as any, { root: mkdtempSync(join(tmpdir(), "dsh-graph-g506-contract-")) });
  const def = registered.find((d: any) => d.name === "graph_care_outcome");
  assert.ok(def, "graph_care_outcome 必须真实注册（窄回传入口存在）");
  return def!;
}

// ───────────────────────── 1. 真实生成正文（zh/en）─────────────────────────

test("g506 契约①：真实唤醒正文 zh/en 逐条包含三值定义（sleep+running+预期静默 ⇒ unknown 而非 progress）", () => {
  const zh = formatCareWakeMessage({ inspectionId: "insp-1", targets, maxStagnantRounds: 3 });
  const en = formatCareWakeMessage({ inspectionId: "insp-1", targets, maxStagnantRounds: 3, lang: "en" });

  assert.deepEqual(missingClauses(zh, CARE_OUTCOME_CONTRACT_ZH), [], "zh 唤醒正文必须逐条包含三值定义");
  assert.deepEqual(missingClauses(en, CARE_OUTCOME_CONTRACT_EN), [], "en 唤醒正文必须逐条包含三值定义");

  // 定义块必须出现在「必须用 graph_care_outcome 回传」之前（先定义、再要求回传）
  const zhDefAt = zh.indexOf("结论分类");
  const zhReportAt = zh.indexOf("graph_care_outcome");
  assert.ok(zhDefAt > 0 && zhReportAt > zhDefAt, "zh 定义块必须早于回传要求");
  const enDefAt = en.indexOf("Outcome definitions");
  const enReportAt = en.indexOf("graph_care_outcome");
  assert.ok(enDefAt > 0 && enReportAt > enDefAt, "en 定义块必须早于回传要求");

  // 现场反例必须被写明：正常等待/仅 running/时间经过都不是 progress，证据不足用 unknown
  assert.match(zh, /sleep/, "zh 必须点明 sleep 这类正常等待是 unknown 场景，不是 progress");
  assert.match(zh, /不是\*\*.*progress/, "zh 必须写明“仅 running/仅时间经过”不是 progress");
  assert.match(zh, /选 unknown/, "zh 必须给出“无法判断 ⇒ unknown”的明确出口");
  assert.match(en, /NOT progress/, "en 必须写明“仅 running/仅时间经过”不是 progress");
  assert.match(en, /choose unknown/, "en 必须给出“无法判断 ⇒ unknown”的明确出口");

  // 正文仍有界（新增定义不得把唤醒撑爆；单目标 < 4000 沿用既有约束）
  assert.ok(zh.length < 4000, `zh 唤醒正文必须有界（实际 ${zh.length}）`);
  assert.ok(en.length < 4000, `en 唤醒正文必须有界（实际 ${en.length}）`);
});

test("g506 契约②：真实注册的工具描述 zh/en 与正文同一定义，参数面与三值枚举不变", () => {
  const def = registeredTool();

  // 描述真源 = server-i18n（运行时 sT 覆盖 def.description）；注册面必须逐条含同一契约
  assert.ok([dict.zh[KEY], dict.en[KEY]].includes(def.description), "注册描述必须取自 server-i18n");
  assert.deepEqual(missingClauses(def.description, CARE_OUTCOME_CONTRACT_ZH), [], "注册 zh 描述缺定义子句");
  assert.deepEqual(missingClauses(sT(KEY, "en"), CARE_OUTCOME_CONTRACT_EN), [], "en 描述缺定义子句");
  assert.doesNotMatch(sT(KEY, "en"), /[\u3400-\u9fff]/, "en 描述不得含 CJK");

  // 定义必须与 core 真源逐字一致（防两处漂移：任一侧改了另一侧没改即红）
  assert.deepEqual(missingClauses(sT(KEY, "zh"), CARE_OUTCOME_CONTRACT_ZH), [], "zh 描述与 core 契约漂移");
  assert.deepEqual(missingClauses(sT(KEY, "en"), CARE_OUTCOME_CONTRACT_EN), [], "en 描述与 core 契约漂移");

  // 不新增分类值、不改必填面、evidence 仍只是非空/长度格式约束（不是语义校验）
  const props = def.parameters.properties;
  assert.deepEqual(props.outcome.enum, [...CARE_OUTCOMES], "outcome 枚举必须恰为既有三值（不得新增分类）");
  assert.deepEqual(def.parameters.required, ["inspection", "goal", "attempt", "child", "outcome", "evidence"]);
  assert.equal(props.evidence.minLength, 1, "evidence 只要求非空（服务端不做语义验证）");
  assert.equal(def.parameters.additionalProperties, false, "参数白名单不得放宽");
  assert.match(sT(KEY, "zh"), /不做语义真实性验证/, "描述必须如实说明服务端不验证证据语义");
  assert.match(sT(KEY, "en"), /never for semantic truth/, "en 描述必须如实说明服务端不验证证据语义");
  assert.ok(sT(KEY, "zh").length < 2000, "工具描述必须有界（避免撑爆工具清单）");
});

// ───────────────────── 2. 计数/锁规则未被文案改动顺带改变 ─────────────────────

test("g506 契约③：unknown 不增不清、progress 清计数但不解人类锁、3 份 no-progress 才升级", () => {
  const started = { child: "child-a", attempt: "att-001", goal: "goal-a", bindingVersion: 1, startedAt: 1_000_000, lastProgressAt: null, lastProgressFingerprint: null, stagnantRounds: 2, humanLocked: false, lastCareAt: null, frozenRemainingMs: null };

  // unknown：stagnant/reminders 原样（未回复预算也不归零）
  const u = applyCareOutcome(newCareGroupState(), [{ ...started, remindersSent: 1, awaitingReply: true } as any], { child: "child-a", attempt: "att-001" }, { kind: "unknown", now: 1_000_100, maxStagnantRounds: 3 });
  assert.equal(u.tasks[0].stagnantRounds, 2, "unknown 不得递增/归零无进展计数");
  assert.equal((u.tasks[0] as any).remindersSent, 1, "unknown 不得归零未回复预算");
  assert.equal(u.tasks[0].humanLocked, false);

  // progress：归零计数，但既有人员锁 sticky
  const p = applyCareOutcome(newCareGroupState(), [{ ...started, humanLocked: true, humanReason: "no_progress_limit" } as any], { child: "child-a", attempt: "att-001" }, { kind: "progress", now: 1_000_200, maxStagnantRounds: 3 });
  assert.equal(p.tasks[0].stagnantRounds, 0, "progress 必须归零计数");
  assert.equal(p.tasks[0].humanLocked, true, "progress 绝不解除已有人工锁（sticky）");

  // 3 份新鲜 no-progress 才升级（第 3 次才锁；第 1/2 次不锁）
  let g = newCareGroupState();
  let tasks: any[] = [{ ...started, stagnantRounds: 0 }];
  const rounds: boolean[] = [];
  for (let i = 1; i <= 3; i += 1) {
    const r = applyCareOutcome(g, tasks, { child: "child-a", attempt: "att-001" }, { kind: "no-progress", now: 1_000_000 + i * 100, maxStagnantRounds: 3 });
    g = r.group; tasks = r.tasks; rounds.push(r.tasks[0].humanLocked === true);
  }
  assert.deepEqual(rounds, [false, false, true], "只有第 3 份新鲜 no-progress 才升级人工");

  // 文案与算法一致（定义里写明的计数口径必须与上面实测行为一致）
  const zh = formatCareWakeMessage({ inspectionId: "insp-3", targets, maxStagnantRounds: 3 });
  assert.match(zh, /unknown 不递增也不归零/, "正文必须写明 unknown 的计数口径");
  assert.match(zh, /连续 3 份新鲜 no-progress 才升级/, "正文必须写明 3 份升级口径");
  // 上限是**可配置**的（projection.max_stagnant_rounds），契约措辞不得把它写死成 3
  assert.match(zh, /默认 3/, "契约必须说明 3 只是默认值（上限可配置）");
  assert.match(sT(KEY, "en"), /default 3/, "en 契约必须说明 3 只是默认值");
});

// ───────────────────── 3. 负向对照（删掉定义 ⇒ 断言真实变红）─────────────────────

test("g506 契约④：负向 mutant —— 从真实正文/描述里删掉任一子句，契约判据必须变红", () => {
  const zh = formatCareWakeMessage({ inspectionId: "insp-mut", targets, maxStagnantRounds: 3 });
  const en = formatCareWakeMessage({ inspectionId: "insp-mut", targets, maxStagnantRounds: 3, lang: "en" });

  // 基线：未变异的正文不缺任何子句
  assert.deepEqual(missingClauses(zh, CARE_OUTCOME_CONTRACT_ZH), []);

  for (const [i, clause] of CARE_OUTCOME_CONTRACT_ZH.entries()) {
    const mutated = zh.replace(`  · ${clause}`, "  · （被删除的定义）");
    assert.deepEqual(
      missingClauses(mutated, CARE_OUTCOME_CONTRACT_ZH),
      [clause],
      `删掉 zh 第 ${i + 1} 条定义后契约判据必须变红（若能通过说明守卫无效）`,
    );
  }
  for (const [i, clause] of CARE_OUTCOME_CONTRACT_EN.entries()) {
    const mutated = en.replace(`  · ${clause}`, "  · (definition removed)");
    assert.deepEqual(missingClauses(mutated, CARE_OUTCOME_CONTRACT_EN), [clause], `删掉 en 第 ${i + 1} 条定义必须变红`);
  }

  // 工具描述同样有牙：删掉 progress 定义（真实误区所在）后必须缺该条
  const mutDesc = sT(KEY, "zh").replace(CARE_OUTCOME_CONTRACT_ZH[0], "progress：只要还在运行就算进展。");
  assert.deepEqual(missingClauses(mutDesc, CARE_OUTCOME_CONTRACT_ZH), [CARE_OUTCOME_CONTRACT_ZH[0]], "描述被改坏时判据必须变红");
});
