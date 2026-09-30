/** g-380：目标详情「目标描述」标题右侧关系标记入口的客户端契约守卫（「改坏即红」）。
 *
 * 分工（与仓库既有客户端测试口径一致）：
 *  - 本套件 = **源码级契约 + i18n 对称 + bundle 新鲜度**的机器断言（含负向对照：改坏必红）；
 *  - 真实交互（点开入口、添加后徽标/关系行、删除后消失）由隔离实例（`scripts/dsh-test-web.sh`）
 *    的实机 UI 验收截图核验，见本目标证据台账。
 *
 * 断言面：
 *  A. 位置：标记入口按钮**紧贴**「目标描述」标题右侧（位于标题之后、编辑按钮之前）；
 *  B. 写入通道：复用 `POST /api/dsh-graph/relations`（action add|remove + base_relations 乐观并发）；
 *  C. 并发冲突(409)：可操作提示（i18n）+「重试」路径（重试前重取 base_relations）；
 *  D. 删除入口：每条标记（出向/入向）都渲染一个删除按钮；
 *  E. 无轮询：成功回包后**重取一次**（无 setInterval/setTimeout/watcher/EventSource）；
 *  F. i18n：面板用到的键 zh/en 齐全、全量键集对称、en 零 CJK；
 *  G. bundle 新鲜度：dist/lib/client.js 必须已含本入口（未 rebuild 即红）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const hostRoot = join(import.meta.dirname, "../../dsh-graph-host");
const MODAL_SRC = readFileSync(join(hostRoot, "lib/client/goal-modal.js"), "utf8");
const I18N_SRC = readFileSync(join(hostRoot, "lib/client/i18n.js"), "utf8");
const BUNDLE_SRC = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");

/** 面板源码切片：`RelationMarker` 组件本体（到 DescriptionBox 注释为止）。 */
function panelSlice(src: string): string {
  const start = src.indexOf("function RelationMarker(");
  const end = src.indexOf("// g-260：目标描述组件", start);
  return start < 0 || end <= start ? "" : src.slice(start, end);
}

/** 客户端 i18n 字典（与 g281 同一装载口径）。 */
function loadClientI18n() {
  const sandbox: any = { React: {} };
  vm.runInNewContext(I18N_SRC + "; this.zh = zh; this.en = en;", sandbox);
  return { zh: sandbox.zh as Record<string, string>, en: sandbox.en as Record<string, string> };
}

/** 纯判定：真实文件与内存副本共用同一套断言（负向对照复用）。 */
function uiProblems(src: string, zh: Record<string, string>, en: Record<string, string>): string[] {
  const problems: string[] = [];
  const panel = panelSlice(src);
  if (!panel) return ["goal-modal.js 缺少 RelationMarker 组件（标记入口被删除？）"];

  // A. 位置：标题 → 标记按钮 → 编辑按钮
  const iTitle = src.indexOf('h("div", { style: S.modalH }, dgT("section.description"))');
  const iMark = src.indexOf('dg-relation-mark-btn');
  const iEdit = src.indexOf('title: dgT("description.editInPlace")');
  if (iTitle < 0) problems.push("缺少「目标描述」标题行（section.description）");
  if (iMark < 0) problems.push("缺少标记入口按钮（dg-relation-mark-btn）");
  if (iTitle >= 0 && iMark >= 0) {
    if (!(iTitle < iMark)) problems.push("标记入口不在「目标描述」标题之后");
    else if (iMark - iTitle > 400) problems.push("标记入口离「目标描述」标题过远（未紧贴标题右侧）");
  }
  if (iEdit >= 0 && iMark >= 0 && !(iMark < iEdit)) problems.push("标记入口不在编辑按钮之前（非标题右侧紧邻位）");

  // B. 写入通道：复用既有 REST
  if (!/fetch\(graphUrl\("\/api\/dsh-graph\/relations", \{ goal: goalId \}\)\)/.test(panel)) {
    problems.push("面板未通过 GET /api/dsh-graph/relations 读取关系");
  }
  if (!/graphUrl\("\/api\/dsh-graph\/relations"\), \{\s*method: "POST"/.test(panel)) {
    problems.push("面板未复用 POST /api/dsh-graph/relations 写入");
  }
  if (!/JSON\.stringify\(\{ goal: source, target, type: markType, action, base_relations: base \}\)/.test(panel)) {
    problems.push("POST body 缺少 action/type/target/base_relations（乐观并发基准）");
  }
  if (!/const base = await tokensFor\(source\);/.test(panel)) {
    problems.push("写入前未取 base_relations（并发冲突检测失效）");
  }
  if (!/out\.map\(\(v\) => `\$\{v\.type\}:\$\{v\.goal\}`\)\.sort\(\)/.test(panel)) {
    problems.push("base_relations token 形态与 core relationsToken（type:goal 排序）不一致");
  }

  // C. 409 可操作提示 + 重试路径
  if (!/if \(r\.status === 409\) \{/.test(panel)) problems.push("缺少 409（并发冲突）分支");
  if (!/text: dgT\("relation\.conflict"\), retry: true/.test(panel)) problems.push("409 未给可操作提示/重试标记");
  if (!/pendingRef\.current = \{ action, source, type: markType, target \}/.test(panel)) {
    problems.push("409 未记录待重试操作（重试路径不可达）");
  }
  if (!/const retry = \(\) => \{\s*const p = pendingRef\.current;\s*if \(p\) submit\(p\.action, p\.source, p\.type, p\.target\);/.test(panel)) {
    problems.push("缺少「重试」处理（重试前会重新取 base_relations）");
  }
  if (!/dgT\("relation\.retry"\)/.test(panel)) problems.push("重试按钮未走 i18n");

  // D. 删除入口：出向/入向每条标记一个删除入口
  if (!/submit\("remove", goalId, r\.type, r\.goal\)/.test(panel)) problems.push("出向标记缺少删除（remove）调用");
  if (!/submit\("remove", r\.goal, r\.type, goalId\)/.test(panel)) problems.push("入向标记缺少删除（remove）调用");
  if (!/dgT\("relation\.removeBtn"\)/.test(panel)) problems.push("删除按钮未走 i18n");

  // E. 无轮询 / watcher；成功一次回包后重取
  if (/\bsetInterval\b|\bsetTimeout\b|fs\.watch|EventSource|new WebSocket|requestAnimationFrame/.test(panel)) {
    problems.push("面板引入了轮询/定时器/watcher（判据 3 明令禁止）");
  }
  if (!/await load\(\); \/\/ 一次成功回包后重取（非轮询）/.test(panel)) {
    problems.push("成功回包后未重取关系数据（徽标/关系行无法即时反映）");
  }

  // F. 失败的可见错误（不白屏）
  for (const key of ["relation.requestFail", "relation.saveFail", "relation.loadFail"]) {
    if (!panel.includes(`dgT("${key}")`)) problems.push(`面板缺少可见错误提示 ${key}（失败会白屏/静默）`);
  }
  if (!/\.catch\(\(e\) => \{/.test(panel)) problems.push("面板缺少 fetch 失败兜底（try/catch 或 .catch）");

  // G. i18n 键存在 + en 零 CJK
  const used = [...panel.matchAll(/dgT\("([^"]+)"/g)].map((m) => m[1]);
  for (const key of new Set(used)) {
    if (key.startsWith("card.relType.")) continue; // g-379 既有键，由 g379 套件守卫
    if (zh[key] === undefined) problems.push(`zh 字典缺少面板用到的键 ${key}`);
    if (en[key] === undefined) problems.push(`en 字典缺少面板用到的键 ${key}`);
    else if (/[\u3400-\u9fff]/.test(en[key])) problems.push(`en.${key} 含 CJK：${en[key]}`);
  }
  return problems;
}

const { zh, en } = loadClientI18n();

test("g-380 判据3：标记入口契约（位置/写入通道/409 重试/删除入口/无轮询/i18n）在真实源码上零问题", () => {
  const problems = uiProblems(MODAL_SRC, zh, en);
  assert.deepEqual(problems, [], `客户端契约漂移：\n${problems.join("\n")}`);
});

test("g-380 判据3：负向对照——删入口 / 去 base_relations / 去 409 分支 / 去删除入口 / 加轮询 必红", () => {
  const base = uiProblems(MODAL_SRC, zh, en);
  assert.deepEqual(base, [], "基线（真实源码）必须零问题");

  const cases: Array<[string, string]> = [
    ["删标记入口按钮", MODAL_SRC.replace("dg-btn dg-relation-mark-btn", "dg-btn")],
    ["去掉 base_relations 乐观并发", MODAL_SRC.replace("action, base_relations: base }", "action }")],
    ["去掉 409 分支", MODAL_SRC.replace("if (r.status === 409) {", "if (false) {")],
    ["去掉重试路径", MODAL_SRC.replace("if (p) submit(p.action, p.source, p.type, p.target);", "")],
    ["去掉出向删除入口", MODAL_SRC.replace('submit("remove", goalId, r.type, r.goal);', "void 0;")],
    ["改成轮询", MODAL_SRC.replace("React.useEffect(() => { load(); }, [load]);", "React.useEffect(() => { load(); const t = setInterval(load, 1000); return () => clearInterval(t); }, [load]);")],
    ["去掉成功回包后重取", MODAL_SRC.replace("await load(); // 一次成功回包后重取（非轮询）", "")],
  ];
  for (const [label, mutated] of cases) {
    assert.notEqual(mutated, MODAL_SRC, `${label}：变异未生效（锚点漂移，守卫需同步）`);
    const problems = uiProblems(mutated, zh, en);
    assert.ok(problems.length > 0, `${label} 应被判红，实际零问题`);
  }
});

test("g-380 判据3：i18n 全量键集 zh/en 对称，新增 relation.* 键两语齐全且 en 零 CJK", () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "client i18n zh/en 键集必须对称");
  const keys = Object.keys(zh).filter((k) => k.startsWith("relation."));
  assert.ok(keys.length >= 20, `relation.* 键过少（${keys.length}）`);
  for (const k of keys) {
    assert.ok(zh[k] && zh[k].length > 0, `zh ${k} 为空`);
    assert.ok(en[k] && en[k].length > 0, `en ${k} 为空`);
    assert.doesNotMatch(en[k], /[\u3400-\u9fff]/, `en ${k} 含 CJK：${en[k]}`);
  }
  // 关键文案逐字钉住（可操作提示与重试路径）
  assert.match(zh["relation.conflict"], /重试/);
  assert.match(en["relation.conflict"], /Retry/);
});

test("g-380 判据3：dist bundle 已同步标记入口（未 rebuild 即红），且无第三方图库引入", () => {
  assert.ok(BUNDLE_SRC.includes("dg-relation-mark-btn"), "dist/lib/client.js 未含标记入口（需 rebuild）");
  assert.ok(BUNDLE_SRC.includes("relation.conflict"), "dist/lib/client.js 未含冲突文案（需 rebuild）");
  for (const lib of ["d3", "vis-network", "cytoscape", "mermaid", "react-flow", "dagre", "@antv"]) {
    assert.ok(!MODAL_SRC.includes(lib), `不得引入图可视化库（命中 ${lib}）`);
  }
});
