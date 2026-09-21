/**
 * g-312（断言化证据 / Assertion-as-Evidence）专项验证套件
 *
 * 判据映射：
 *  - 判据 1 → 断言化证据规范同时存在于 supervisor-guide.zh/en（行数仍相等）、
 *             formatAttemptPrompt 的**中英两路渲染产物**、以及执行纪律真源
 *             ROLE_PROFILES.executor.disciplineLines（persona 逐行展开）；
 *  - 判据 2 → validateEvidenceSummary 是「禁止倾倒」的机器化定义：拒绝多行、代码围栏、
 *             >200 字符的 JSON 片段、DOM dump 关键词；执行侧证据采用单行
 *             `evidence: suite=… passed=… failed=… exit=… ms=… diff=… commit=…`，单条 ≤160 字符。
 *
 * 反自我满足设计（照 g-326 的做法，勿改成 grep 源码）：
 *  1. 渲染断言一律打在 formatAttemptPrompt({...}) 的**返回字符串**上，且**不传** attemptBrief /
 *     directive / targetContext —— 产物里没有调用方长文本，命中的证据规范只可能来自框架自己注入的
 *     执行纪律，而不是被回显的 brief 或粘贴的源码字符串；
 *  2. 纯函数从**构建产物** `dist/core/ops.js` 导入（而不是 ../ops.ts 源码），证明被验证的是要发布的
 *     那份代码；
 *  3. 纪律规范做**段落切片**断言（只在纪律段切片内查）——只 grep 全文无法区分「纪律段里有」与
 *     「纪律段外另有一份」；切片外另做「全篇恰好一次」的去重护栏。
 *
 * ---------------------------------------------------------------------------
 * 判据 3 度量口径（写死在此，分母与命令可复现；不主张「总输出 Token 下降比例」）
 *
 * 样本源：`.dsh-graph/events.jsonl`（看板事件流）。actor 归属分离：
 *   - 执行侧 = `goal.comment_added` 且 actor ∈ { "agent:" + `attempt.bound`.details.child_id }
 *     ——即「派发记录里登记过的执行子代理子会话」署名，不靠人肉判断；
 *   - 主管/负责人侧 = 其余全部（`human:*` / `supervisor:*` / 主管会话 `agent:session-*`）。
 *   主管的**过程性/决策性**评论不受长度限制，只统计执行侧的证据评论文本量。
 *
 * ```bash
 * # 从仓库根运行；末尾可加 `<ISO 时间>` 只看该时刻之后的窗口（跨版本对比用）
 * node -e 'const fs=require("fs");const ev=fs.readFileSync(".dsh-graph/events.jsonl","utf8").trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);const kids=new Set(ev.filter(e=>e.event==="attempt.bound"&&e.details&&e.details.child_id).map(e=>"agent:"+e.details.child_id));const q=(a,p)=>{const c=a.slice().sort((x,y)=>x-y);if(!c.length)return null;const i=(c.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return Math.round(c[lo]+(c[hi]-c[lo])*(i-lo));};const since=process.argv[1]||"";const rows=ev.filter(e=>e.event==="goal.comment_added"&&(!since||String(e.ts||"")>=since)).map(e=>({actor:e.actor||"",n:((e.details&&e.details.text)||"").length}));for(const [k,v] of [["执行侧",rows.filter(r=>kids.has(r.actor))],["主管/负责人侧",rows.filter(r=>!kids.has(r.actor))]]){const ns=v.map(r=>r.n);console.log(k+": n="+v.length+" p50="+q(ns,.5)+" p90="+q(ns,.9)+" max="+(ns.length?Math.max(...ns):0)+" 总字符="+ns.reduce((a,b)=>a+b,0));}'
 * ```
 *
 * 实测（2026-09-22，本 attempt 落地时；计划的基线快照为 n=29 / p50 663）：
 *   执行侧 n=31 / p50 **775** / p90 1960 / max 2200 / 总 27,995 字符；
 *   主管/负责人侧 n=633 / p50 306 / 总 273,088 字符。
 *   ⇒ 目标：本规范合入后**新增**的执行侧证据评论 p50 ≤150（用上面的 `--since` 窗口复测）；
 *     全历史 p50 是既成事实，不能靠新规范回改，故判据按「规范落地 + 窗口复测」口径核验。
 * ---------------------------------------------------------------------------
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_SUMMARY_MAX_CHARS,
  EVIDENCE_SUMMARY_PREFIX,
  formatEvidenceSummary,
  parseEvidenceSummary,
  validateEvidenceSummary,
} from "../../dist/core/ops.js";
import {
  ROLE_PROFILES,
  appendGoalComment,
  buildSubagentDefaultPersona,
  createGoal,
  init,
  loadGoal,
  reportStatus,
  startAttempt,
  findGoalFile,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { SERVER_I18N } from "../../dist/lib/server-i18n.js";
import { formatAttemptPrompt } from "../../dist/index.js";

const sourceRoot = join(import.meta.dirname, "../../dsh-graph-host");
const shippedRoot = join(import.meta.dirname, "../../dist");
const readAsset = (root: string, ...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

/** 与格式契约一致的规范样例（单行、8 个字段、含 commit=sha7）。 */
const CANONICAL_INPUT = {
  suite: "core.tests",
  passed: 1161,
  failed: 0,
  exit: 0,
  ms: 3601,
  diffFiles: 12,
  diffAdded: 340,
  diffRemoved: 9,
  commit: "4a2592e",
};

const RENDER_ARGS = { goal: "g-312", attempt: "att-001", goalRel: ".dsh-graph/versions/v0.16.0/goals/g-312/goal.md" };

/** 纪律段切片：只在这一段里查证据规范（切片外另有一份表述会被去重护栏抓住）。 */
function disciplineSlice(output: string, start: string, end: string): string {
  const startAt = output.indexOf(start);
  const endAt = output.indexOf(end);
  assert.ok(startAt >= 0 && endAt > startAt, `纪律段切片边界必须存在且有序：${start} / ${end}`);
  return output.slice(startAt, endAt);
}

function countOccurrences(text: string, token: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(token, from);
    if (at < 0) return count;
    count += 1;
    from = at + token.length;
  }
}

// ===== 判据 2：纯函数层 =====

test("g-312 判据 2：formatEvidenceSummary 产出单行规范概要，parse 往返无损且在 160 字符预算内", () => {
  const line = formatEvidenceSummary(CANONICAL_INPUT);

  // 单行 + 规范前缀 + 8 个字段。
  assert.equal(line.includes("\n"), false, "概要必须是单行");
  assert.ok(line.startsWith(`${EVIDENCE_SUMMARY_PREFIX} `), `概要必须以「${EVIDENCE_SUMMARY_PREFIX} 」开头`);
  assert.ok(line.length <= EVIDENCE_SUMMARY_MAX_CHARS, `概要必须 ≤${EVIDENCE_SUMMARY_MAX_CHARS} 字符，实际 ${line.length}`);
  for (const field of ["suite=", "passed=", "failed=", "exit=", "ms=", "diff=", "commit="]) {
    assert.ok(line.includes(field), `概要必须含字段 ${field}`);
  }
  assert.match(line, /diff=\d+f\/\+\d+\/-\d+/, "diff 必须是 <files>f/+<a>/-<d> 复合形态");

  // 解析往返：parse(format(x)) 必须回到原值。
  assert.deepEqual(parseEvidenceSummary(line), { ...CANONICAL_INPUT, commit: "4a2592e" });
  assert.deepEqual(parseEvidenceSummary(`  ${line}  `), { ...CANONICAL_INPUT, commit: "4a2592e" }, "首尾空白不应破坏解析");

  // 一套件一行：多套件渲染成多行，每行各自在预算内。
  const suites = ["core.tests", "core.tests.prompt-i18n", "core.tests.dist-freshness"];
  const lines = suites.map((suite) => formatEvidenceSummary({ ...CANONICAL_INPUT, suite }));
  assert.equal(lines.length, 3);
  for (const [index, each] of lines.entries()) assert.ok(each.length <= EVIDENCE_SUMMARY_MAX_CHARS, `第 ${index + 1} 行超预算`);
  assert.deepEqual(lines.map((each) => parseEvidenceSummary(each)?.suite), suites);

  // 越界输入：宁可抛错，也不允许产出违反契约的行。
  assert.throws(() => formatEvidenceSummary({ ...CANONICAL_INPUT, suite: "x".repeat(200) }), /超长/, "超预算必须抛错");
  assert.throws(() => formatEvidenceSummary({ ...CANONICAL_INPUT, commit: "not-a-sha" }), /commit/, "非 sha 必须抛错");
  assert.throws(() => formatEvidenceSummary({ ...CANONICAL_INPUT, passed: 1.5 as number }), /非负整数/, "非整数计数必须抛错");
  assert.throws(() => formatEvidenceSummary({ ...CANONICAL_INPUT, suite: "" }), /suite/, "空 suite 必须抛错");
});

test("g-312 判据 2：validateEvidenceSummary 拒绝多行 / 围栏 / >200 字符 JSON 片段 / DOM dump 关键词", () => {
  // 正例：规范单行通过，且判定携带具体结论。
  const ok = validateEvidenceSummary(formatEvidenceSummary(CANONICAL_INPUT));
  assert.equal(ok.ok, true, `规范单行必须通过：${ok.detail}`);
  assert.equal(ok.issue, null);

  // 反例 1：多行（把日志/报告直接粘进来）。
  const multiline = validateEvidenceSummary(`${formatEvidenceSummary(CANONICAL_INPUT)}\n第二行补充说明`);
  assert.equal(multiline.ok, false);
  assert.equal(multiline.issue, "multiline", `多行必须被拒，实际 ${multiline.issue}`);

  // 反例 2：代码围栏（多行日志/JSON 的典型包装）。
  for (const fence of ["```", "~~~"]) {
    const fenced = validateEvidenceSummary(`${fence}json\n{"a":1}\n${fence}`);
    assert.equal(fenced.ok, false, `${fence} 围栏必须被拒`);
    assert.equal(fenced.issue, "code_fence");
  }

  // 反例 3：>200 字符的 JSON 片段（单行也要拒，且必须先于长度判定命中，保证可独立观测）。
  const bigJson = `evidence: suite=all ${JSON.stringify({ payload: "x".repeat(260) })}`;
  assert.ok(bigJson.length > EVIDENCE_SUMMARY_MAX_CHARS, "该反例本身也超长，故 json_dump 判定必须排在长度判定之前");
  const jsonDump = validateEvidenceSummary(bigJson);
  assert.equal(jsonDump.ok, false);
  assert.equal(jsonDump.issue, "json_dump", `>200 字符 JSON 片段必须被拒，实际 ${jsonDump.issue}`);

  // 边界：JSON 片段 ≤200 字符不再按 json_dump 拒（它仍会因不合规范格式被拒，错误码不同）。
  const smallJson = validateEvidenceSummary(`evidence: suite=all ${JSON.stringify({ payload: "x".repeat(40) })}`);
  assert.equal(smallJson.ok, false);
  assert.equal(smallJson.issue, "format", `≤200 字符的 JSON 属于「非规范形态」，应报 format，实际 ${smallJson.issue}`);

  // 反例 4：DOM dump 关键词。
  const domDumps = [
    "evidence: suite=all passed=1 failed=0 exit=0 ms=1 diff=1f/+1/-0 commit=4a2592e <div class=\"a\">x</div>",
    "outerHTML: <span>1</span>",
    "document.querySelector('.dg-card') 返回 3 个节点",
    "getBoundingClientRect() = {top: 1}",
  ];
  for (const dump of domDumps) {
    const dom = validateEvidenceSummary(dump);
    assert.equal(dom.ok, false, `DOM dump 必须被拒：${dump}`);
    assert.equal(dom.issue, "dom_dump", `应报 dom_dump，实际 ${dom.issue}：${dump}`);
  }

  // 反例 5/6：超长散文与非规范形态（禁止倾倒的另外两种常见形态）。
  const tooLong = validateEvidenceSummary(`evidence: suite=all ${"细节".repeat(90)}`);
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.issue, "too_long");

  const prose = validateEvidenceSummary("我跑了测试，全绿，具体输出如下：一切正常。");
  assert.equal(prose.ok, false);
  assert.equal(prose.issue, "format", "散文结论不是结构化概要");

  const empty = validateEvidenceSummary("   ");
  assert.equal(empty.ok, false);
  assert.equal(empty.issue, "empty");

  // parse 对倾倒文本必须返回 null（而不是抛出）——软观测路径不能被异常打断。
  assert.equal(parseEvidenceSummary(bigJson), null);
  assert.equal(parseEvidenceSummary(`${formatEvidenceSummary(CANONICAL_INPUT)}\n第二行`), null);
  assert.equal(parseEvidenceSummary(undefined), null);
});

// ===== C-lite：软观测（只记事件，不拒绝） =====

test("g-312 C-lite：超长 status/评论只追加 report.oversize 软观测事件，绝不拒绝合法调用", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g312-"));
  init(root);
  const goal = createGoal(root, { title: "证据软观测", version: "v-t", actor: "human:test" });
  const attempt = startAttempt(root, goal, { executor: "agent:test", actor: "human:test" });

  // 短 status：不产生软观测事件（阈值内不打扰）。
  reportStatus(root, goal, attempt, "正在跑断言", "agent:test", "working");
  assert.equal(
    readEvents(root).filter((event) => event.event === "report.oversize").length,
    0,
    "阈值内的 status 不应产生软观测事件",
  );

  // 超长 status：正常写入（不拒绝），另记一条软观测。
  const longStatus = `正在核验 ${"很长的运行态描述".repeat(20)}`;
  assert.ok(longStatus.length > 40);
  reportStatus(root, goal, attempt, longStatus, "agent:test", "working");
  const attemptFile = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${attempt}/attempt.md`);
  assert.equal(loadGoal(attemptFile).meta.status_line, longStatus, "超长 status 仍必须如实写入——软观测绝不等于拒绝");

  // 超长评论：同样只观测不拒绝。
  appendGoalComment(root, goal, "短评论", "agent:test");
  appendGoalComment(root, goal, "长".repeat(900), "agent:test");

  const oversize = readEvents(root).filter((event) => event.event === "report.oversize");
  assert.equal(oversize.length, 2, "恰好两条软观测：一条 status、一条 comment");
  const byKind = new Map(oversize.map((event) => [(event.details as any).kind, event]));
  assert.deepEqual([...byKind.keys()].sort(), ["comment", "status"]);
  assert.equal((byKind.get("status")!.details as any).limit, 40);
  assert.equal((byKind.get("comment")!.details as any).limit, 800);
  assert.equal((byKind.get("comment")!.details as any).chars, 900);
  for (const event of oversize) {
    assert.equal(event.actor, "agent:test", "软观测事件必须带 actor——判据 3 的度量按 actor 归属分离执行侧与主管侧");
    assert.equal(event.goal, goal);
  }
  // 评论确实落盘（未拒绝）。
  const goalText = readFileSync(findGoalFile(root, goal), "utf8");
  assert.ok(goalText.includes("长".repeat(50)), "超长评论必须仍被写入");
});

// ===== 判据 1：渲染产物级（中英两路） =====

test("g-312 判据 1（核心）：formatAttemptPrompt 中英两路渲染产物的纪律段内都真的含证据规范", () => {
  // 刻意不传 brief/directive/targetContext：命中的文本只可能来自框架注入的执行纪律。
  const zhOutput = formatAttemptPrompt({ ...RENDER_ARGS });
  const enOutput = formatAttemptPrompt({ ...RENDER_ARGS, promptLanguage: "en" });

  // 前提检查：确实走了各自渲染路径，且没有调用方文本可被回显。
  assert.ok(zhOutput.includes("（未提供）"), "本次渲染未提供 brief/directive，产物应显式标注未提供");
  assert.doesNotMatch(enOutput, /[\u3400-\u9fff]/, "英文渲染路径不得含 CJK（含即说明回落到中文纪律块）");

  const zhDiscipline = disciplineSlice(zhOutput, "## 通用执行纪律", "若本 prompt 同时含");
  const enDiscipline = disciplineSlice(enOutput, "## Execution discipline", "If a prompt contains a historical handoff");

  // 中文纪律段切片内：格式样例 + 禁止倾倒 + 断言化 + UI 例外。
  for (const fragment of [
    "evidence: suite=<id> passed=<n> failed=<n> exit=<code> ms=<n> diff=<files>f/+<a>/-<d> commit=<sha7>",
    "单条 ≤160 字符",
    "禁止倾倒多行 JSON、DOM dump、切片数据、原始日志与围栏代码块",
    "运行态不变式一律沉淀为自动化断言",
    "仅 UI 视觉层保留轻量截图核验",
  ]) {
    assert.ok(zhDiscipline.includes(fragment), `中文纪律段切片缺少证据规范片段：「${fragment}」`);
  }

  // 英文纪律段切片内：同一套要求（不是「英文侧漏写」）。
  for (const fragment of [
    "evidence: suite=<id> passed=<n> failed=<n> exit=<code> ms=<n> diff=<files>f/+<a>/-<d> commit=<sha7>",
    "at most 160 characters each",
    "never dump multi-line JSON, DOM dumps, sliced data, raw logs, or fenced code blocks",
    "turn runtime invariants into automated assertions",
    "lightweight screenshot verification only for the non-codifiable UI/visual layer",
  ]) {
    assert.ok(enDiscipline.includes(fragment), `英文纪律段切片缺少证据规范片段：「${fragment}」`);
  }

  // 规范必须位于初始 prompt 内（而不是被挤出收尾语之后）。
  assert.ok(
    zhOutput.indexOf("evidence: suite=") < zhOutput.indexOf("若本 prompt 同时含历史 handoff"),
    "中文证据规范必须位于初始 prompt 收尾语之前",
  );
  assert.ok(
    enOutput.indexOf("evidence: suite=") < enOutput.indexOf("If a prompt contains a historical handoff"),
    "英文证据规范必须位于初始 prompt 收尾语之前",
  );

  // 去重护栏：整篇 prompt 里证据格式只出现一次（防止纪律段外再长出一份竞争表述）。
  assert.equal(countOccurrences(zhOutput, "evidence: suite="), 1, "中文渲染产物里证据格式必须恰好出现一次");
  assert.equal(countOccurrences(enOutput, "evidence: suite="), 1, "英文渲染产物里证据格式必须恰好出现一次");
});

test("g-312 判据 1：执行纪律真源 disciplineLines 与 persona 同口径（g-326 分级规则一并补齐）", () => {
  const lines = ROLE_PROFILES.executor.disciplineLines;

  // 只允许在数组末尾追加：前 5 条逐字锚定项仍在原位（role-contract-g253 亦逐行锚定 [0]）。
  assert.ok(lines.length >= 7, `executor 纪律应至少 7 条（含 g-326/g-312 追加），实际 ${lines.length}`);
  for (const [index, prefix] of ["1.", "2.", "3.", "4.", "5."].entries()) {
    assert.ok(lines[index].startsWith(prefix), `第 ${index + 1} 条必须仍是 ${prefix} 开头的原条目（只许末尾追加）`);
  }
  assert.match(lines[0], /有限关键节点/);
  assert.match(lines[0], /长任务适度节流心跳/);

  // g-326：分级规则此前误判为「未被渲染的死文本」而漏写——真源必须补上。
  const tierLine = lines.find((line) => line.includes("测试力度按改动性质分级"));
  assert.ok(tierLine, "executor 纪律真源必须含 g-326 的测试力度三档分级");
  for (const fragment of ["一档｜零行为逻辑改动", "二档｜小幅逻辑改动", "三档｜新增功能/契约变更", "改坏就会红"]) {
    assert.ok(tierLine!.includes(fragment), `分级条目缺少档位片段：「${fragment}」`);
  }

  // g-312：证据形式条目必须在真源里。
  const evidenceLine = lines.find((line) => line.includes("证据形式"));
  assert.ok(evidenceLine, "executor 纪律真源必须含断言化证据条目");
  for (const fragment of [
    "单行结构化概要",
    "evidence: suite=<id> passed=<n> failed=<n> exit=<code> ms=<n> diff=<files>f/+<a>/-<d> commit=<sha7>",
    "单条 ≤160 字符",
    "禁止向证据台账、评论区或回复倾倒多行 JSON、DOM dump、切片数据、原始日志与围栏代码块",
    "运行态不变式一律沉淀为自动化断言",
  ]) {
    assert.ok(evidenceLine!.includes(fragment), `证据条目缺少片段：「${fragment}」`);
  }

  // persona 逐行展开该数组 → 子代理 system prompt 与 attempt prompt 必须同一套口径。
  const persona = buildSubagentDefaultPersona("g-312", "att-001");
  assert.ok(persona.includes(tierLine!), "persona 必须展开 g-326 分级条目（此前正是漏在这里）");
  assert.ok(persona.includes(evidenceLine!), "persona 必须展开 g-312 证据条目");
});

test("g-312 判据 1：supervisor-guide 与 prompts 资产（源码 + dist 投递副本）双侧同含证据规范", () => {
  const zhGuideTokens = [
    "证据形式（断言化，禁长文倾倒）",
    "自动化断言",
    "evidence: suite=… passed=… failed=… exit=… ms=… diff=… commit=…",
    "多行 JSON、DOM dump、切片数据、原始日志与围栏代码块",
    "一套件一行",
    "轻量截图核验",
  ];
  const enGuideTokens = [
    "Evidence form (assertion-based; no long-form dumping)",
    "automated assertions",
    "evidence: suite=… passed=… failed=… exit=… ms=… diff=… commit=…",
    "multi-line JSON, DOM dumps, sliced data, raw logs, or fenced code blocks",
    "one suite per line",
    "lightweight screenshot verification",
  ];
  for (const [label, root] of [["源码", sourceRoot], ["投递副本 dist", shippedRoot]] as const) {
    const zh = readAsset(root, "supervisor-guide.zh.md");
    const en = readAsset(root, "supervisor-guide.en.md");
    for (const token of zhGuideTokens) assert.ok(zh.includes(token), `${label} supervisor-guide.zh.md 缺少「${token}」`);
    for (const token of enGuideTokens) assert.ok(en.includes(token), `${label} supervisor-guide.en.md 缺少「${token}」`);
    // 行数相等是整文件不变量（zh/en 必须成对改）。
    assert.equal(
      zh.split("\n").length,
      en.split("\n").length,
      `${label} supervisor-guide 行数必须仍相等（zh/en 成对改）`,
    );
    // 每轮注入的主管纪律提醒也含同一证据条目。
    const zhDiscipline = readAsset(root, "prompts", "discipline.zh.md");
    const enDiscipline = readAsset(root, "prompts", "discipline.en.md");
    assert.ok(zhDiscipline.includes("证据形式（断言化，禁长文倾倒）"), `${label} prompts/discipline.zh.md 缺少证据条目`);
    assert.ok(zhDiscipline.includes("evidence: suite=<id>"), `${label} prompts/discipline.zh.md 缺少格式样例`);
    assert.ok(enDiscipline.includes("Evidence form (assertion-based; no long-form dumping)"), `${label} prompts/discipline.en.md 缺少证据条目`);
    assert.ok(enDiscipline.includes("evidence: suite=<id>"), `${label} prompts/discipline.en.md 缺少格式样例`);
    assert.equal(
      zhDiscipline.split("\n").length,
      enDiscipline.split("\n").length,
      `${label} prompts/discipline 行数必须仍相等`,
    );
  }
});

test("g-312 判据 1：graph_report_status / graph_add_comment / graph_fill_card 的工具描述同步改口径（zh/en 对称）", () => {
  // 运行时真源：host 用 sT(...) 从 SERVER_I18N 取工具描述 → 对**投递副本** dist 求值后断言取值。
  const zh = SERVER_I18N.zh as Record<string, string>;
  const en = SERVER_I18N.en as Record<string, string>;
  const sourceText = readAsset(sourceRoot, "lib", "server-i18n.js");
  const keys = ["reportStatus", "tool.graph_report_status", "tool.graph_add_comment", "tool.graph_fill_card"];

  for (const key of keys) {
    assert.ok(zh[key], `SERVER_I18N.zh 缺少键 ${key}`);
    assert.ok(en[key], `SERVER_I18N.en 缺少键 ${key}`);
    // 源码副本与投递副本必须同文本（dist/lib/server-i18n.js 是逐字复制，另由 dist-freshness 用例守住）。
    assert.ok(sourceText.includes(zh[key]), `源码与投递副本不一致（zh.${key}）——请重新 build`);
    assert.ok(sourceText.includes(en[key]), `源码与投递副本不一致（en.${key}）——请重新 build`);
  }

  for (const key of ["reportStatus", "tool.graph_report_status"]) {
    assert.ok(zh[key].includes("evidence: suite="), `${key} 的中文描述应给结构化概要样例`);
    assert.ok(en[key].includes("evidence: suite="), `${key} 的英文描述应给结构化概要样例`);
    assert.match(zh[key], /≤40 字符/, `${key} 应明确 status 维持一句人话`);
    assert.match(en[key], /at most 40 characters/, `${key} 应明确 status 维持一句人话`);
  }
  for (const key of ["tool.graph_add_comment", "tool.graph_fill_card"]) {
    assert.match(zh[key], /≤150 字符/, `${key} 应给出单条长度建议`);
    assert.match(zh[key], /禁止倾倒/, `${key} 应明确禁止倾倒`);
    assert.match(en[key], /at most 150 characters/, `${key} 应给出单条长度建议`);
    assert.match(en[key], /never dump/, `${key} 应明确禁止倾倒`);
  }
  assert.doesNotMatch(Object.values(en).join("\n"), /[\u3400-\u9fff]/, "SERVER_I18N.en 必须零 CJK");
});

test("g-312 判据 1：docs/guide-auto-injection.md 的纪律副本与真源逐条一致（防再次漂移）", () => {
  // 该副本此前已漂移（缺记忆管理纪律与测试力度分级）；本断言把它钉在真源上。
  const source = readAsset(sourceRoot, "prompts", "discipline.zh.md").split("\n").filter((line) => line.length > 0);
  const docs = readFileSync(join(import.meta.dirname, "../../docs/guide-auto-injection.md"), "utf8");
  const block = /const SUPERVISOR_DISCIPLINE = \[([\s\S]*?)\]\.join\("\\n"\)/.exec(docs);
  assert.ok(block, "docs/guide-auto-injection.md 应含 SUPERVISOR_DISCIPLINE 数组");
  const mirrored = block![1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .map((line) => line.replace(/^"/, "").replace(/",?$/, ""));
  assert.deepEqual(
    mirrored,
    source,
    "docs 副本必须与 prompts/discipline.zh.md 真源逐条一致；改了真源请同步副本（勿只补最后一条）",
  );
  assert.ok(mirrored.some((line) => line.includes("证据形式（断言化，禁长文倾倒）")), "docs 副本应含 g-312 证据条目");
});

test("g-312 判据 1 防删除反向断言：旧「详尽长文」口径不得回归，新规范任何一处删掉即红", () => {
  // 反向断言 1：结构性诱因已被改写掉——指南不得再要求「详尽的测试核验记录与证据」。
  for (const [label, root] of [["源码", sourceRoot], ["投递副本 dist", shippedRoot]] as const) {
    const zh = readAsset(root, "supervisor-guide.zh.md");
    const en = readAsset(root, "supervisor-guide.en.md");
    assert.doesNotMatch(zh, /追加详尽的测试核验记录与证据/, `${label} 指南仍残留「详尽测试核验记录」诱因`);
    assert.doesNotMatch(en, /adds a detailed test-verification record and evidence/, `${label} en 指南仍残留 detailed record 诱因`);
    // 反向断言 2：新规范不得被写成「可以倾倒」。
    assert.doesNotMatch(zh, /允许倾倒|可以倾倒/, `${label} 指南不得出现允许倾倒的口径`);
    assert.doesNotMatch(en, /allowed to dump|dumping is allowed/, `${label} en 指南不得出现允许倾倒的口径`);
  }

  // 反向断言 3：渲染产物里证据规范被删/被换即红（逐片段存在性 + 恰好一次，见上面的渲染用例）。
  const zhOutput = formatAttemptPrompt({ ...RENDER_ARGS });
  const enOutput = formatAttemptPrompt({ ...RENDER_ARGS, promptLanguage: "en" });
  assert.ok(zhOutput.includes("evidence: suite=<id>"), "删掉中文纪律里的格式样例必须变红");
  assert.ok(enOutput.includes("evidence: suite=<id>"), "删掉英文纪律里的格式样例必须变红");
  assert.doesNotMatch(zhOutput, /evidence: suite=<id>[^\n]*\n[^\n]*evidence: suite=/, "产物内不得出现第二份竞争表述");

  // 反向断言 4：真源被删即红（persona 与真源是同一条数组）。
  assert.ok(
    ROLE_PROFILES.executor.disciplineLines.some((line) => line.includes("evidence: suite=<id>")),
    "删掉真源里的证据条目必须变红",
  );

  // 反向断言 5：纯函数被删/被弱化即红（validate 不再拒绝倾倒文本时必须失败）。
  assert.equal(validateEvidenceSummary("随便一段散文结论").ok, false, "validate 被弱化为「什么都通过」即红");
  assert.equal(validateEvidenceSummary(`${formatEvidenceSummary(CANONICAL_INPUT)}\nx`).ok, false, "validate 不再拒绝多行即红");
});
