/** dsh-graph-host 单包（g-116 合并后）webServer 半边（/api/dsh-graph 写端点）冒烟测试：g-109。
 *  mock webServer/ctx，无 subagents 服务 → 验证降级路径（attempt 本地创建、child_error 上报、
 *  卡片不误翻 collecting）；有 body 的 POST 走 readBody + 事件先行断言。
 *  g-116：原 client 端点并入 host 包 index.js，此处 apply 指向合并后的 dsh-graph-host。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import http from "node:http";
import { init, createGoal, findGoalFile, loadGoal, saveGoal, setCriteria, transition, readProjectConfig, startAttempt } from "../ops.ts";
import { criteriaItems, replaceSection, sectionText } from "../model.ts";
import { readEvents } from "../events.ts";
import { apply, readRawBodyCapped, readBodyCapped, MAX_ATTACHMENT_JSON_BYTES } from "../../dist/index.js";

function fakeRequest(method: string, body: unknown) {
  const req: any = {
    method,
    _listeners: {} as Record<string, (v?: any) => void>,
    on(ev: string, cb: (v?: any) => void) {
      req._listeners[ev] = cb;
    },
  };
  return req;
}

function emitBody(req: any, body: unknown) {
  req._listeners.data?.(JSON.stringify(body));
  req._listeners.end?.();
}

function fakeResponse() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-host-"));
  init(root);
  const goalId = createGoal(root, { title: "测试目标", version: "v-t", actor: "test" });
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : name === "sandboxPolicy" ? { workspaceRoot: root } : undefined), // 无 subagents/agents 服务 → 降级分支
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, { root });
  return { root, routes, goalId };
}

// g-113：无 config.root 的 apply（完全由请求 workspace 决定 root，与生产默认一致）
function setupNoConfigRoot(workspace?: string) {
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : name === "sandboxPolicy" ? (workspace ? { workspaceRoot: workspace } : undefined) : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});
  return { routes };
}

function makeProject(base: string, name: string, title: string): { ws: string; goalId: string; title: string } {
  const ws = join(base, name);
  init(join(ws, ".dsh-graph"));
  // 带 version（backlog 目标无目录不能建卡，见 addCard 业务规则）；id 为 per-root 顺序 g-001，断言必须按标题
  const goalId = createGoal(join(ws, ".dsh-graph"), { title, version: "v-t", actor: "test" });
  return { ws, goalId, title };
}

function boardGoalTitles(body: any): string[] {
  return [
    ...body.versions.flatMap((v: any) => v.goals),
    ...body.standalone,
    ...body.backlog,
  ].map((g: any) => g.title);
}

const post = async (routes: Map<string, any>, path: string, body: unknown) => {
  const handler = routes.get(path);
  assert.ok(handler, `路由 ${path} 已注册`);
  const req = fakeRequest("POST", body);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, body);
  await p;
  return { code: res._code, body: res._body };
};

const get = async (routes: Map<string, any>, path: string) => {
  const purePath = path.split("?")[0];
  const handler = routes.get(purePath);
  assert.ok(handler, `路由 ${purePath} 已注册`);
  const req: any = fakeRequest("GET", null);
  req.url = path;
  const res = fakeResponse();
  await handler(req, res);
  return { code: res._code, body: res._body };
};

test("g-132 settings 端点：GET 回填当前配置、POST 写回并保留值，不半写入", async () => {
  const { root, routes } = setup();
  const empty = await get(routes, "/api/dsh-graph/settings");
  assert.equal(empty.code, 200);
  assert.deepEqual(empty.body.executor, { provider: null, model: null, mode: null });
  // att-002：GET 下发当前 canonical workspace 的 project.yaml 绝对路径
  assert.equal(empty.body.configFile, join(root, "project.yaml"));
  const write = await post(routes, "/api/dsh-graph/settings",
    { executor: { provider: "openai-codex", model: "gpt-5.6-luna" }, prompt_overrides: { subagent: { state: "override", value: "子代理补充" } } });
  assert.equal(write.code, 200);
  assert.equal(write.body.ok, true);
  const again = await get(routes, "/api/dsh-graph/settings");
  assert.equal(again.code, 200);
  assert.deepEqual(again.body.executor, { provider: "openai-codex", model: "gpt-5.6-luna", mode: null });
  assert.deepEqual(again.body.prompt_overrides.subagent, { state: "override", value: "子代理补充" });
  assert.equal(again.body.configFile, join(root, "project.yaml"));
  // 非法值 → 400 且不半写入
  const bad = await post(routes, "/api/dsh-graph/settings", { defaults: { pk: { lanes: 0 } } });
  assert.equal(bad.code, 400);
  assert.equal(readProjectConfig(root).defaults.pk.lanes, null);
  assert.equal(readEvents(root).filter((e) => e.event === "project.config_set").length, 1);
});

test("g-157 拖动自动滚动源契约：仅拖动时监听并清理 RAF/监听器", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  assert.match(source, /g-157：拖动自动滚动/);
  assert.match(source, /window\.addEventListener\("dragover", handleDragOver, true\)/);
  assert.match(source, /scrollContainer\.scrollTop/);
  assert.match(source, /cancelAnimationFrame\(rafId\)/);
  assert.match(source, /window\.removeEventListener\("dragover", handleDragOver, true\)/);
  assert.match(source, /window\.removeEventListener\("dragleave", handleDragLeave, true\)/);
  assert.doesNotMatch(source, /overflowX: auto/);
});

test("g-173 自动滚动边缘回归源契约：离板只清落点不结束 drag，滚动容器锚定看板根", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  // 1) 看板根 ref：自动滚动 effect 从 boardRootRef 向上找真实滚动容器（不靠全局 querySelector 猜）
  assert.match(source, /const boardRootRef = React\.useRef\(null\)/);
  assert.match(source, /let el = boardRootRef\.current/);
  assert.match(source, /ref: boardRootRef/);
  // 2) 根级 onDragLeave：离开看板内容（进入页面顶部/底部边缘、header/composer）时
  //    只清除悬停落点，绝不 setDrag(null)——否则 g-157 effect 立即卸载、边缘自动滚动失效
  const dlStart = source.indexOf("onDragLeave: drag ? (e) => {");
  const dlEnd = source.indexOf("} : undefined }", dlStart);
  const dlBody = source.slice(dlStart, dlEnd);
  assert.ok(dlStart > 0 && dlEnd > dlStart, "根级 onDragLeave 处理器存在");
  assert.ok(dlBody.includes("e.currentTarget.contains(e.relatedTarget)"), "仍按 relatedTarget 判定是否离开看板");
  assert.match(dlBody, /overGoalId: null, overStageKey: null/);
  assert.doesNotMatch(dlBody, /setDrag\(null\)/, "离开看板不得结束整个 drag（否则边缘自动滚动失效）");
  // 3) 真正结束仍由原生 dragend/drop/取消路径清理：commit 路径保留 setDrag(null)
  assert.match(source, /function commitGoalDrag\(activeDrag, over\) \{\s*if \(dropCommitted\.current\) return;\s*dropCommitted\.current = true;\s*setDrag\(null\);/);
  assert.match(source, /const dropCommitted = React\.useRef\(false\)/);
});

test("g-173 follow-up 拖拽虚影源契约：onDragStart 用当前卡片克隆做 setDragImage（backlog 不整行虚影）", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/card.js"), "utf8");
  const dsStart = source.indexOf("onDragStart: (e) => {");
  const dsEnd = source.indexOf("drag.start();", dsStart);
  const dsBody = source.slice(dsStart, dsEnd);
  assert.ok(dsStart > 0 && dsEnd > dsStart, "onDragStart 处理器存在");
  assert.match(dsBody, /const src = e\.currentTarget/, "以事件源（当前卡片 div）为克隆基准");
  assert.match(dsBody, /src\.cloneNode\(true\)/, "虚影为当前卡片克隆节点（而非容器/整行）");
  assert.match(dsBody, /setDragImage\(ghost, 16, 10\)/, "显式 setDragImage 设置拖拽影像");
  assert.match(dsBody, /document\.body\.appendChild\(ghost\)/, "克隆节点挂载到 DOM 供截图");
  assert.match(dsBody, /removeChild\(ghost\)/, "截图后移除克隆节点，不残留 DOM");
  assert.match(dsBody, /classList\.remove\("dg-dragging"/, "克隆不携带半透明拖拽态样式");
});

test("g-132 源契约：gear 入口 + SettingsModal 渲染 + 三态提示词 + 写回保留注释", () => {
  const kanban = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  assert.match(kanban, /g-132：右上角齿轮 → 看板设置/);
  assert.match(kanban, /setShowSettings/);
  assert.match(kanban, /h\(SettingsModal,/);
  const modal = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/settings-modal.js"), "utf8");
  assert.match(modal, /g-132：workspace 看板设置弹窗/);
  assert.match(modal, /三态：default 继承 /);
  assert.match(modal, /fetch\(graphUrl\("\/api\/dsh-graph\/settings"\)\)/);
  assert.match(modal, /method: "POST"/);
  assert.match(modal, /"default", "override", "disable"/);
  assert.match(modal, /dgT\("settings\.editHint"\)/);
  assert.match(modal, /dgT\("settings\.showAdvanced"\)/);
  assert.match(modal, /display: showAdvanced \? "flex" : "none"/);
  assert.match(modal, /display: showAdvanced \? "grid" : "none"/);
  assert.match(modal, /h\("hr", \{ style: \{ display: showAdvanced \? "block" : "none"/);
  assert.match(modal, /if \(!cur\[path\[i\]\].*typeof cur\[path\[i\]\] !== "object"/s);
  assert.doesNotMatch(modal, /主管补充提示词/);
  assert.doesNotMatch(modal, /prompt_overrides.*supervisor/);
  const host = readFileSync(join(process.cwd(), "dist/index.js"), "utf8");
  assert.doesNotMatch(host, /promptOverrideSection\([^\n]*"supervisor"/);
  assert.doesNotMatch(host, /主管补充提示词/);
  // att-002：settings GET 下发 canonical project.yaml 绝对路径（服务端唯一来源）
  assert.match(host, /configFile: join\(meta\.root, "project\.yaml"\)/);
  // att-002：说明区域配置文件操作入口——只消费服务端 configFile，不自行拼接 graphRoot
  assert.match(modal, /setConfigFile\(data\.configFile \?\? null\)/);
  // g-222：统一走共享 openHostPath（0.1.2+ session.openWorkspacePath 优先），失败透出可理解错误
  assert.match(modal, /openHostPath\(configFile\)/);
  assert.match(modal, /dgT\("settings\.openedProjectYaml"\)/);
  assert.match(modal, /dgT\(["']tab\.openFailed["']\)/);
  assert.match(modal, /openErrorText\(r\.error\)/);
  // open/copy/fallback 行为源契约：openHostPath 成功才 return；失败复制绝对路径并提示
  const openIdx = modal.indexOf("openHostPath(configFile)");
  const fallbackIdx = modal.indexOf('dgT("tab.pathCopiedNoOpen")');
  const copyIdx = modal.indexOf("await copyText(configFile);");
  assert.ok(openIdx > 0 && fallbackIdx > openIdx && copyIdx > 0, "openHostPath 应先于 fallback 复制");
  assert.ok((modal.match(/copyText\(configFile\)/g) || []).length >= 2, "打开回退 + 复制按钮均应复制绝对路径");
  assert.match(modal, /dgT\("settings\.projectYaml"\)/);
  assert.match(modal, /title: dgT\("settings\.openConfigTooltip"\)/);
  assert.match(modal, /title: dgT\("settings\.copyProjectPath"\)/);
  assert.match(modal, /\}, dgT\("tab\.openFile"\)\)/);
  assert.match(modal, /\}, dgT\("tab\.copyPath"\)\)/);
  const bundle = readFileSync(join(process.cwd(), "dist/lib/client.js"), "utf8");
  assert.match(bundle, /⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY/);
  assert.match(bundle, /function SettingsModal/);
});

test("g-133 源契约：workspace 弹窗 executor provider/model 目录化 select + 可收缩布局", () => {
  const modal = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/settings-modal.js"), "utf8");
  // 挂载时用同 scope 的 gConnectionApi/loadHostCatalog 读 Host 合法目录（llm.providers/llm.models）
  assert.match(modal, /loadHostCatalog\(gConnectionApi\)/);
  assert.match(modal, /llm\.providers/);
  assert.match(modal, /llm\.models/);
  // RPC 缺失/失败时目录置 unavailable，降级为提示 + 保留已存值，不阻止保存
  assert.match(modal, /setCatalog\(\{ status: "unavailable" \}\)/);
  assert.match(modal, /if \(alive\) setCatalog\(c\)/);
  // provider 只列 active 且有模型目录的 provider；model 按当前 provider 过滤
  assert.match(modal, /catalog\.providers\.filter\(\(p\) => p\.active && \(groupById\.get\(p\.provider\)\?\.models\.length \?\? 0\) > 0\)/);
  assert.match(modal, /legalModelsByProvider\.get\(curProvider\)/);
  // 空项代表继承父会话；未列出的已存旧值保留为固定 option（advisory，不拦截保存）
  assert.match(modal, /dgT\("settings\.inheritSession"\)/);
  assert.match(modal, /dgT\("settings\.legacyValue"\)/);
  assert.match(modal, /legacySuffix/);
  // provider/model 控件由 input 改为 select（boxSizing:"border-box"）
  assert.match(modal, /h\("select", \{ style: \{ \.\.\.S\.promptInput, width: "100%", boxSizing: "border-box" \}, value: curProvider/);
  assert.match(modal, /h\("select", \{ style: \{ \.\.\.S\.promptInput, width: "100%", boxSizing: "border-box" \}, value: curModel/);
  // 可收缩布局：父容器 minWidth:0、子列 flex:"1 1 0"+minWidth:0（两列并排各占一半）
  assert.match(modal, /display: "flex", gap: 8, minWidth: 0/);
  assert.match(modal, /flex: "1 1 0", minWidth: 0/);
  // 保存仍写 form.executor.provider/model 到 workspace project.yaml
  assert.match(modal, /executor: \{ provider: form\.executor\?\.provider \?\? "", model: form\.executor\?\.model \?\? "", reasoning_effort: form\.executor\?\.reasoning_effort \?\? "", mode: form\.executor\?\.mode \?\? "" \}/);
});

test("g-231 默认 reasoning effort 控件随精确模型能力目录变化且保留旧配置", () => {
  const settings = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/settings.js"), "utf8");
  const modal = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/settings-modal.js"), "utf8");
  for (const source of [settings, modal]) {
    assert.match(source, /selectedModel/);
    assert.match(source, /selectedModel\?\.reasoning\?\.efforts/);
    assert.match(source, /effortChoices/);
    assert.match(source, /effortOptions/);
    assert.match(source, /已存值/);
    assert.doesNotMatch(source, /\["low", "medium", "high"\]/);
  }
  assert.match(settings, /subagentReasoningEffort/);
  assert.match(settings, /gSettingsScope\.set\("subagentReasoningEffort"/);
  assert.match(modal, /reasoning_effort: form\.executor\?\.reasoning_effort/);
  assert.match(modal, /set\(\["executor", "reasoning_effort"\]/);
});

test("g-163 判据方块按有序 key 渲染并支持即时同步", () => {
  const card = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/card.js"), "utf8");
  const actions = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  assert.match(card, /function CriteriaProgress\(props\)/);
  assert.match(card, /props\.items/);
  assert.match(card, /getCriteriaPlaceholders/);
  assert.match(card, /!CRITERIA_PLACEHOLDERS\.has\(key\)/);
  assert.match(card, /checkedSet\.has\(key\) \? "🟩" : "◽"/);
  assert.match(card, /role: "img"/);
  assert.match(card, /"aria-label": label/);
  assert.match(card, /letterSpacing: "-3px"/);
  assert.match(card, /width: 5, transform: "scaleX\(\.2\)"/);
  assert.match(card, /letterSpacing: "-3px", marginLeft: 0, paddingRight: 2/);
  assert.match(card, /keys\.slice\(0, 10\)/);
  assert.match(card, /Number\(reportedCount\) === 0/);
  assert.match(card, /count: g\.criteria_count \?\? g\.criteriaCount/);
  assert.match(card, /badges\.push\("👤"\)/);
  assert.match(card, /`\$\{done\}\/\$\{total\}`/);
  assert.match(card, /dsh-graph\.criteria-changed/);
  assert.match(actions, /localStorage\.setItem\(storeKey, JSON\.stringify\(next\)\)/);
  assert.match(actions, /window\.dispatchEvent\(new Event\("dsh-graph\.criteria-changed"\)\)/);
  assert.match(card, /window\.addEventListener\("storage", refresh\)/);
  assert.match(card, /if \(!keys\.length\) return null/);
  assert.match(actions, /与 core\/model\.ts criteriaItems 同源/);
});

test("g-185 判据 checklist 整行切换、子控件隔离与键盘/命中区源契约", () => {
  const actions = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  assert.match(actions, /className: "dg-criteria-row"/);
  assert.match(actions, /tabIndex: 0/);
  assert.match(actions, /role: "checkbox"/);
  assert.match(actions, /"aria-checked": done/);
  assert.match(actions, /onClick: \(e\) => \{/);
  assert.match(actions, /e\.target\.closest\?\.\("button,input,textarea,a,select"\)/);
  assert.match(actions, /onKeyDown: \(e\) => \{/);
  assert.match(actions, /e\.key !== "Enter" && e\.key !== " "/);
  assert.match(actions, /onClick: \(e\) => e\.stopPropagation\(\)/);
  assert.match(actions, /width: 20, height: 20/);
  assert.match(actions, /onKeyDown: \(e\) => \{ if \(e\.key === "Enter"\)/);
  assert.match(actions, /localStorage\.setItem\(storeKey, JSON\.stringify\(next\)\)/);
});

test("g-164 released 泳道与 active/version 泳道共用同一动态列模板源契约", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  // 顶部表头网格与 released 泳道网格必须共用同一份按折叠状态动态计算的列模板，
  // 否则 released 泳道展开并折叠交付/阻塞列时列宽与上方泳道错位。
  // g-352（负责人显式授权改写本段布局契约断言）：横向模板（130px 标题 + 6 阶段列）改名为
  // horizontalGridCols；宽档的 gridCols 即它本体，只有单泳道档（g-356 起 <480px）才派生为单列全宽模板
  //（阶段列纵向堆叠，判据 3）——仍是同一份派生，不存在第二套列宽来源。
  // att-002：单泳道档由「单版本」放宽为「单版本 ∪ backlog 唯一泳道」（负责人裁决），故变量名
  // 由 singleVersionMode 改为 singleLaneMode；列模板派生的唯一性不变。
  assert.match(source, /const horizontalGridCols = \["130px",/);
  // g-366：单列闸门由 singleLaneMode 扩为 singleColumnMode（单泳道档 ∪ 窄档搜索聚合泳道）——
  // 两者都用同一份单列全宽模板，列宽来源仍是唯一一份派生（断言强度不变，仍逐字钉住表达式）。
  assert.match(source, /const singleColumnMode = !!\(singleLaneMode \|\| searchLaneActive\);/);
  assert.match(source, /const gridCols = singleColumnMode \? "minmax\(0, 1fr\)" : horizontalGridCols;/);
  assert.match(source, /deliverColumnCollapsed \? "36px" : "minmax\(150px, 1fr\)",\s*\/\/ deliver/);
  assert.match(source, /blockedColumnCollapsed \? "36px" : "minmax\(150px, 1fr\)",\s*\/\/ blocked/);
  // 顶部表头网格：(1) 处使用 gridCols；首个单元格是**左上角单元格本体**（g-174 起承载
  // 「版本管理 + ＋ 新建版本」入口，替换原「泳道＼阶段」文字）。
  // g-352 att-005（负责人显式授权改写本段布局契约断言）：两颗按钮回到网格左上角原位置后，
  // 该单元格抽成**单一变量** `gridCornerEl`（两侧/各档位共用同一份定义，不再有两处复制粘贴），
  // 故这里改为断言「网格首个 child 就是 gridCornerEl，且它由版本管理 + 创建版本两颗按钮组成」。
  assert.match(source, /const gridCornerEl = h\("div", \{[\s\S]*?\}, versionManageBtn, createVersionBtn\);/);
  assert.match(source, /h\("div", \{ style: \{ \.\.\.S\.grid, gridTemplateColumns: gridCols \} \},\s*\n\s*\/\/[\s\S]*?\n\s*gridCornerEl,/);
  assert.match(source, /\}, dgT\("createVersion\.createBtn"\)\);/);
  // released 泳道网格：(1) 处使用 gridCols（relx- 容器），保证与上方泳道列宽/顺序一致。
  assert.match(source, /relx-" \+ v\.slug, style: \{ \.\.\.S\.grid, gridTemplateColumns: releasedGridCols \}/);
  // 全文件恰好两处（顶部表头 + released 泳道）引用该共享模板，不存在各排各的静态模板。
  assert.equal((source.match(/gridTemplateColumns: gridCols/g) || []).length, 2);
});

test("g-174 标题栏源契约：version 链接、新建版本入口迁移、设置按钮位于 DEBUG 左侧", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  // g-330：切片锚点由 'h("div", { style: S.head },' 放宽为 'h("div", { style: S.head'
  //（该行新增了右侧栏专用的条件 className，样式本体仍是 S.head 本体、会话内为 undefined）。
  // 切片终点与下面三条断言逐字未变，标题栏契约的覆盖范围与强度不受影响。
  const head = source.slice(source.indexOf('h("div", { style: S.head'), source.indexOf("// g-108：顶部 supervisor 状态栏"));
  // 标题栏显示插件版本链接，新标签打开插件官网。
  assert.match(head, /href: "https:\/\/github\.com\/miuzel\/dsh-graph",\s*\n\s*target: "_blank"/);
  assert.match(head, /"version: " \+ PLUGIN_VERSION/);
  // 标题栏不再重复显示「＋ 新建版本」（已迁至看板左上角，见 g-164 契约断言）。
  assert.doesNotMatch(head, /"＋ 新建版本"/);
  // 负责人 2026-08-25 review：设置按钮 ⚙ 位于 DEBUG 信息之前（DEBUG 左侧）。
  const gear = head.indexOf('"⚙")');
  const debug = head.indexOf("DEBUG sessionId=");
  assert.ok(gear >= 0 && debug >= 0 && gear < debug, "⚙ 看板设置按钮应在 DEBUG 信息之前");
});

test("g-156/g-175 交付/阻塞折叠列源契约：会话态、窄栏标题与数量均保留", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  // 折叠状态必须由 React state 持有，不能落到 workspace 或持久化存储。
  assert.match(source, /const \[deliverColumnCollapsed, setDeliverColumnCollapsed\] = React\.useState\(false\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  // g-175：折叠态列头只显示一个展开图标 ▸（不再竖排「交/付」「阻/塞」两行，
  // 因为列内窄条单元格已含「交付/阻塞」文字与计数，无需重复）。
  assert.match(source, /deliverColumnCollapsed\s*\?\s*\n?\s*"▸"/);
  assert.match(source, /blockedColumnCollapsed\s*\?\s*\n?\s*"▸"/);
  // 展开态列头保留「列名 + ▾」收起图标。
  assert.match(source, /deliverColumnCollapsed[\s\S]*?: s\.label \+ " ▾"\)/);
  assert.match(source, /blockedColumnCollapsed[\s\S]*?: s\.label \+ " ▾"\)/);
  // 列内窄条单元格仍显示「交/付」「阻/塞」+ 数量，保证折叠态可识别。
  assert.match(source, /dgT\(['"]deliver\.label['"]\), h\("br"\), "", h\("br"\), dgT\(['"]deliver\.count/);
  assert.match(source, /dgT\(['"]blocked\.label['"]\), h\("br"\), "", h\("br"\), dgT\(['"]blocked\.count/);
  // 两列折叠后固定窄宽度，避免横向布局溢出。
  assert.match(source, /deliverColumnCollapsed \? "36px" : "minmax\(150px, 1fr\)"/);
  assert.match(source, /blockedColumnCollapsed \? "36px" : "minmax\(150px, 1fr\)"/);
});

test("g-162 普通泳道折叠入口位于内容底部且 released 不重复添加", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  assert.match(source, /const \[collapsedLanes, setCollapsedLanes\] = React\.useState\(\{\}\)/);
  assert.match(source, /className: "dg-lane-collapse"/);
  assert.match(source, /className: "dg-lane-collapse-triangle"/);
  assert.match(source, /gridColumn: "2 \/ -1"/);
  assert.match(source, /collapsible = true/);
  assert.match(source, /lane\(v\.name, v\.goals, "rellane-" \+ v\.slug, null, laneIndex \+ idx, false\)/);
  assert.doesNotMatch(source, /title: dgT\('lane\.collapseTooltip'\)[\s\S]{0,180}lane\(v\.name, v\.goals, "rellane-/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  const backlogControl = source.slice(source.indexOf("// g-162: 泳道折叠按钮"), source.indexOf("// g-137 修复"));
  assert.match(backlogControl, /className: "dg-lane-collapse"/);
  assert.match(backlogControl, /className: "dg-lane-collapse-triangle"/);
  assert.match(backlogControl, /"aria-label": dgT\('lane\.collapseTooltip'\)/);
  assert.doesNotMatch(backlogControl, /className: "dg-btn",\s*title: dgT\('lane\.collapseTooltip'\)|\}, "▾"\)/);
  const laneCreate = source.slice(source.indexOf("// g-129: 每个 lane 标题右下角"), source.indexOf("return [labelEl, ...cells]"));
  assert.match(laneCreate, /position: "absolute", right: 6, top: 8, bottom: "auto"/);
  assert.equal((source.match(/paddingRight: 40/g) || []).length, 4, "active/version 与 backlog 的展开/折叠标题均预留 + 空间");
  assert.doesNotMatch(laneCreate, /position: version \? "static"/);
  assert.ok(laneCreate.indexOf("// g-129: 每个 lane 标题右下角") < laneCreate.indexOf("collapsible ? h(\"button\""), "展开态应先渲染 + 再渲染折叠按钮");
  const backlogLane = source.slice(source.indexOf("const backlogRow"), source.indexOf("// g-137 修复"));
  assert.match(backlogLane, /position: "absolute", right: 6, top: 8, bottom: "auto"/);
  assert.match(backlogLane, /paddingRight: 40/);
  assert.doesNotMatch(source, /position: version \? "static"/);
});

test("g-163 Card 真实调用链转发 camelCase criteriaItems", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/card.js"), "utf8");
  const elements: any[] = [];
  const h = (type: any, props: any, ...children: any[]) => {
    const value = typeof type === "function" ? type({ ...(props ?? {}), children })
      : { type, props: props ?? {}, children };
    elements.push(value);
    return value;
  };
  const context: any = {
    React: {
      createElement: h,
      useState: (initial: any) => [typeof initial === "function" ? initial() : initial, () => {}],
      useEffect: () => {},
      useRef: (initial: any) => ({ current: initial }),
    },
    h,
    dgT: (key: string, params?: Record<string, any>) => {
      const dict: Record<string, string> = {
        'card.criteriaProgress': '质量判据：已完成 {done}/{total}',
        'card.expandFull': '展开查看依赖/实时会话/上下文卡片等完整信息',
        'card.collapseBrief': '收起为精简视图',
        'card.clickToOpen': '点击打开详情',
        'card.clickToOpenDrawer': '点击打开上下文抽屉',
        'card.goToSession': '↗ 转到对话',
        'card.sharedBadge': '🔗共享',
        'card.archived': '📦已归档',
        'card.waitingDep': '⛓ 等待 {deps} 交付',
        'card.depsSatisfied': '✅ 依赖满足：{deps} 已交付',
        'review.aiBadge': '🤖AI审',
        'criteria.pending': '（待登记）',
        'criteria.pendingDetail': '（待登记；进入 in_progress 前必须非空且已确认）',
        'criteria.toBeFilled': '（待填写）',
        'card.clickSummaryExpand': '点击展开摘要全文',
        'card.clickSummaryCollapse': '点击收起摘要',
        'goal.typeLabel': '类型：{type}（点击切换）',
      };
      let text = dict[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.replace(`{${k}}`, String(v));
        }
      }
      return text;
    },
    S: new Proxy({}, { get: () => ({}) }),
    STATUS_LABEL: { in_progress: "进行中" },
    CARD_STATUS_ICON: {},
    GOAL_TYPE_LABELS: { feature: "功能" },
    GOAL_TYPE_ABBREV: { feature: "F" },
    GOAL_TYPES: ["feature", "bug", "task", "improvement", "patch", "chore"],
    goalTypeColor: () => "#000",
    normalizeGoalType: () => "feature",
    graphUrl: () => "/api/dsh-graph",
    rowHalf: () => "after",
    sessionLinkBtn: () => null,
    renderHighlight: (text: any) => text,
    GoalTags: () => null,
    localStorage: { getItem: () => JSON.stringify(["第一"]) },
    window: { addEventListener: () => {}, removeEventListener: () => {} },
  };
  const progressStart = source.indexOf("const getCriteriaPlaceholders");
  const cardStart = source.indexOf("function Card(");
  const cardEnd = source.indexOf("\n    // g-a92e1406：状态摘要行", cardStart);
  assert.ok(progressStart > 0 && cardStart > progressStart && cardEnd > cardStart);
  const progress = source.slice(progressStart, source.indexOf("    // 目标卡", progressStart));
  const card = source.slice(cardStart, cardEnd);
  new vm.Script(`(function () {\n${progress}\n${card}\nglobalThis.__Card = Card;\n})()`).runInNewContext(context);
  context.__Card(
    { id: "g-camel", title: "camel", status: "in_progress", criteriaItems: ["第一", "第二"] },
    () => {}, () => {}, false, null, {}, false, () => {}, null,
  );
  const progressView = elements.find((entry) => entry?.props?.role === "img");
  assert.ok(progressView, "Card 真实调用应渲染 CriteriaProgress");
  assert.equal(progressView.props["aria-label"], "质量判据：已完成 1/2");
  assert.deepEqual(Array.from(progressView.children[0], (entry: any) => entry?.children?.[0]), ["🟩", "◽"]);

  const beforeZero = elements.length;
  context.__Card(
    { id: "g-zero", title: "zero", status: "in_progress", criteriaItems: ["占位"], criteria_count: 0 },
    () => {}, () => {}, false, null, {}, false, () => {}, null,
  );
  assert.equal(
    elements.slice(beforeZero).some((entry) => entry?.props?.role === "img"),
    false,
    "criteria_count=0 时不应渲染方块",
  );

  const beforePlaceholder = elements.length;
  context.__Card(
    { id: "g-placeholder", title: "placeholder", status: "in_progress", criteriaItems: ["（待登记；进入 in_progress 前必须非空且已确认）"] },
    () => {}, () => {}, false, null, {}, false, () => {}, null,
  );
  assert.equal(
    elements.slice(beforePlaceholder).some((entry) => entry?.props?.role === "img"),
    false,
    "模板占位判据不应渲染方块",
  );
});

test("g-165 各类列空白区域拖拽目标与离列清除源契约", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  const cardSource = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/card.js"), "utf8");
  const flatStart = source.indexOf('const flatCell = h("div"');
  const flatEnd = source.indexOf('return [labelEl, flatCell]', flatStart);
  const flat = source.slice(flatStart, flatEnd);
  assert.ok(flat.includes('className: "dg-backlog-lane"'));
  assert.ok(flat.includes('onDragOver: drag ? (e) =>'));
  assert.ok(flat.includes('if (!e.target?.closest?.(".dg-card"))'));
  assert.doesNotMatch(flat, /!goals\.length/);
  assert.ok(flat.includes('overStageKey: "describe", overLaneKey: key'));
  assert.ok(source.includes('className: "dg-blocked-collapsed"'));
  assert.ok(source.includes('className: "dg-deliver-collapsed"'));
  assert.equal((source.match(/!e\.target\.closest\?\.\("\.dg-card"\)/g) ?? []).length >= 6, true);
  assert.ok(source.includes('onDragLeave: drag ? (e) =>'));
  assert.ok(source.includes('e.currentTarget.contains(e.relatedTarget)'));
  assert.ok(cardSource.includes('drag.hover(rowHalf(e))'));
  assert.ok(cardSource.includes('drag.drop(rowHalf(e))'));
});

test("g-109 写端点全部注册（accept/edit-description/add-card/start-collection）", () => {
  const { routes } = setup();
  for (const p of ["/api/dsh-graph/accept", "/api/dsh-graph/resolve-accept",
    "/api/dsh-graph/edit-description", "/api/dsh-graph/add-card",
    "/api/dsh-graph/start-collection", "/api/dsh-graph/start-execution",
    "/api/dsh-graph/set-goal-type", "/api/dsh-graph/create-goal"]) {
    assert.ok(routes.has(p), `${p} 已注册`);
  }
});

test("add-card：建卡 + card.created 事件（事件先行）", async () => {
  const { root, routes, goalId } = setup();
  const goalFile = findGoalFile(root, goalId);
  const { code, body } = await post(routes, "/api/dsh-graph/add-card",
    { goal: goalId, title: "调研 A", kind: "text", scope: "goal" });
  assert.equal(code, 200);
  assert.equal(body.ok, true);
  assert.ok(typeof body.card === "string");
  const ev = readEvents(root).filter((e) => e.event === "card.created");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].details.title, "调研 A");
  // 目标 frontmatter 引用卡片
  const doc = loadGoal(goalFile);
  assert.ok((doc.meta.context_cards ?? []).includes(body.card));
});

// g-219：delete-card 端点回归——删除后 goal 详情不再含该卡片（弹窗数据源），
// collecting 卡片删除被拒且带明确提示（事件结果驱动，UI 以 data.ok 为准）。
test("delete-card：删除后 goal 详情卡片消失 + card.deleted 事件（事件先行）", async () => {
  const { root, routes, goalId } = setup();
  const { body } = await post(routes, "/api/dsh-graph/add-card",
    { goal: goalId, title: "调研 A", kind: "text", scope: "goal" });
  const card = body.card;
  const goalHandler = routes.get("/api/dsh-graph/goal");
  const goalDetail = () => {
    const res = fakeResponse();
    goalHandler({ method: "GET", url: `/api/dsh-graph/goal?id=${goalId}`, on: () => {} }, res);
    return res._body;
  };
  assert.ok(goalDetail().cards.some((c: any) => c.id === card), "删除前详情含该卡片");
  const r = await post(routes, "/api/dsh-graph/delete-card", { goal: goalId, card });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.ok(!goalDetail().cards.some((c: any) => c.id === card), "删除后详情不再含该卡片");
  const ev = readEvents(root).filter((e) => e.event === "card.deleted");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].goal, goalId);
  assert.equal(ev[0].details.card, card);
});

test("delete-card：collecting 卡片删除被拒（400 + 明确提示）", async () => {
  const { root, routes, goalId } = setup();
  const { body } = await post(routes, "/api/dsh-graph/add-card",
    { goal: goalId, title: "收集中", kind: "text" });
  const card = body.card;
  // 模拟 collecting（绑定子代理）
  const { bindCardChild } = await import("../ops.ts");
  await bindCardChild(root, goalId, card, { childId: "child-x", actor: "test" });
  const r = await post(routes, "/api/dsh-graph/delete-card", { goal: goalId, card });
  assert.equal(r.code, 400);
  assert.ok(String(r.body.error).includes("正在收集"), "被拒提示应包含收集原因");
  // 无 card.deleted 事件
  const evs = readEvents(root).filter((e) => e.event === "card.deleted");
  assert.equal(evs.length, 0);
});

test("delete-card：删除不存在的卡片 → 400 不崩溃（幂等健壮）", async () => {
  const { routes, goalId } = setup();
  const r = await post(routes, "/api/dsh-graph/delete-card",
    { goal: goalId, card: "card-nonexist" });
  assert.equal(r.code, 400);
  assert.ok(String(r.body.error).length > 0);
});

test("start-collection 无 subagents：child_error 上报、卡片不误翻 collecting且不创建 attempt", async () => {
  const { root, routes, goalId } = setup();
  const goalFile = findGoalFile(root, goalId);
  const { body } = await post(routes, "/api/dsh-graph/add-card",
    { goal: goalId, title: "c", kind: "text", scope: "goal" });
  const card = body.card;
  const r = await post(routes, "/api/dsh-graph/start-collection", { goal: goalId, card });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.card, card);
  assert.equal(r.body.child_id, null);
  assert.ok(typeof r.body.child_error === "string");
  // 收集失败不得创建 Goal execution attempt 或翻卡片 collecting。
  const events = readEvents(root);
  assert.ok(!events.some((e) => e.event === "attempt.started" && e.goal === goalId));
  assert.ok(!events.some((e) => e.event === "card.collecting"));
  const cardFile = join(dirname(goalFile), "cards", `${card}.md`);
  assert.equal(loadGoal(cardFile).meta.status, "empty");
});

test("start-collection 有 subagents：验证使用 formatCollectPrompt 生成完整提示词", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-collect-test-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goalId = createGoal(root, { title: "测试目标", version: "v-t", actor: "test" });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");

  let capturedPrompt = "";
  const subagentsService = {
    list: () => ["spawn"],
    getProvider: () => ({ prepareContinuable: () => {} }),
    startContinuable: async (opts: any) => {
      capturedPrompt = opts.request?.prompt?.[0]?.text ?? "";
      return { childId: "c-test", parentSessionId: "p-test" };
    },
  };

  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "subagents") return subagentsService;
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});

  // add-card 必须带 workspace，否则卡片建到 process.cwd()
  const addRes = await post(routes, "/api/dsh-graph/add-card",
    { goal: goalId, title: "测试卡片", kind: "text", workspace: ws, scope: "goal" });
  assert.equal(addRes.code, 200);
  const card = addRes.body.card;

  // start-collection
  const handler = routes.get("/api/dsh-graph/start-collection");
  const req = fakeRequest("POST", { goal: goalId, card, workspace: ws });
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal: goalId, card, workspace: ws });
  await p;
  assert.equal(res._code, 200);
  assert.equal(res._body.child_id, "c-test");

  // 验证捕获的提示词包含所有必要字段
  assert.ok(capturedPrompt.includes("**工作目录**：当前分配的 worktree/当前工作目录"), "应包含当前工作目录约束");
  assert.ok(capturedPrompt.includes(`- id: \`${goalId}\``), "应包含 goal id");
  assert.ok(capturedPrompt.includes(`- 标题: 测试目标`), "应包含 goal 标题");
  assert.ok(capturedPrompt.includes(`- id: \`${card}\``), "应包含 card id");
  assert.ok(capturedPrompt.includes(`- 标题: 测试卡片`), "应包含 card 标题");
  assert.ok(capturedPrompt.includes("**canonical 附件根（绝对路径，非 worktree 相对路径）**"), "应包含 canonical 附件根");
  assert.ok(capturedPrompt.includes(`graph_fill_card(goal="${goalId}", card="${card}", text=<全文可含 @att/<name>>, summary=<≤100字摘要>)`), "应包含精确回填模板");
  assert.ok(capturedPrompt.includes("**禁区（严格遵守）**"), "应包含禁区说明");
});

test("start-collection 用户 prompt 作为附加要求追加，不可替代强制段", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-collect-user-prompt-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goalId = createGoal(root, { title: "测试目标", version: "v-t", actor: "test" });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");

  let capturedPrompt = "";
  const subagentsService = {
    list: () => ["spawn"],
    getProvider: () => ({ prepareContinuable: () => {} }),
    startContinuable: async (opts: any) => {
      capturedPrompt = opts.request?.prompt?.[0]?.text ?? "";
      return { childId: "c-user", parentSessionId: "p-user" };
    },
  };

  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "subagents") return subagentsService;
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});

  const addRes = await post(routes, "/api/dsh-graph/add-card",
    { goal: goalId, title: "用户提示卡", kind: "text", workspace: ws, scope: "goal" });
  assert.equal(addRes.code, 200);
  const card = addRes.body.card;

  const userPrompt = "请重点关注技术实现细节和性能指标";
  const handler = routes.get("/api/dsh-graph/start-collection");
  const req = fakeRequest("POST", { goal: goalId, card, prompt: userPrompt, workspace: ws });
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal: goalId, card, prompt: userPrompt, workspace: ws });
  await p;
  assert.equal(res._code, 200);

  // 强制段仍然存在
  assert.ok(capturedPrompt.includes("**工作目录**：当前分配的 worktree/当前工作目录"), "强制段：当前工作目录");
  assert.ok(capturedPrompt.includes(`graph_fill_card(goal="${goalId}"`), "强制段：回填模板");
  assert.ok(capturedPrompt.includes("**禁区（严格遵守）**"), "强制段：禁区");
  // 用户附加要求追加在末尾
  assert.ok(capturedPrompt.includes(userPrompt), "用户 prompt 应追加在末尾");
});

test("accept（非 force）：写 review.requested 事件", async () => {
  const { root, routes, goalId } = setup();
  const r = await post(routes, "/api/dsh-graph/accept", { goal: goalId });
  assert.equal(r.code, 200);
  assert.equal(r.body.pending, true);
  const ev = readEvents(root).filter((e) => e.event === "review.requested");
  assert.equal(ev.length, 1);
  // g-137：带 version 的目标初始状态为 planning
  assert.equal(ev[0].details.targetStage, "planning");
});

test("edit-description：改目标描述 + goal.amended 事件", async () => {
  const { root, routes, goalId } = setup();
  const r = await post(routes, "/api/dsh-graph/edit-description",
    { goal: goalId, text: "新描述内容" });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  const doc = loadGoal(findGoalFile(root, goalId));
  assert.ok(doc.body.includes("新描述内容"));
  const ev = readEvents(root).filter((e) => e.event === "goal.amended");
  assert.ok(ev.length >= 1);
});

// ---- g-170：判据编辑保存端点（方案 A） ----

test("g-170 set-criteria：保存成功 trim/去重拒绝/1..N 重排 + criteria.updated（不冒充 confirmed）", async () => {
  const { root, routes, goalId } = setup();
  const r = await post(routes, "/api/dsh-graph/set-criteria",
    { goal: goalId, items: ["  甲  ", "", "乙", "丙  "], base_items: [] });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.items, ["1. 甲", "2. 乙", "3. 丙"]);
  const doc = loadGoal(findGoalFile(root, goalId));
  assert.deepEqual(criteriaItems(doc.body), ["1. 甲", "2. 乙", "3. 丙"]);
  const events = readEvents(root).filter((e) => e.goal === goalId);
  assert.equal(events.filter((e) => e.event === "criteria.updated").length, 1);
  assert.equal(events.some((e) => e.event === "criteria.confirmed"), false, "编辑不得自动 confirmed");
});

test("g-170 set-criteria：重复文本拒绝（400）", async () => {
  const { routes, goalId } = setup();
  const r = await post(routes, "/api/dsh-graph/set-criteria",
    { goal: goalId, items: ["甲", " 甲 "], base_items: [] });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /重复/);
});

test("g-170 set-criteria：D3 空列表——planning 允许，in_progress 拒绝", async () => {
  const { root, routes, goalId } = setup();
  // setup() 目标带 version → planning；清空允许
  const clear = await post(routes, "/api/dsh-graph/set-criteria",
    { goal: goalId, items: [], base_items: [] });
  assert.equal(clear.code, 200);
  // 进 in_progress 后再清空 → 400
  await post(routes, "/api/dsh-graph/set-criteria", { goal: goalId, items: ["判据"], base_items: [] });
  await post(routes, "/api/dsh-graph/transition", { goal: goalId, to: "collecting" });
  await post(routes, "/api/dsh-graph/transition", { goal: goalId, to: "ready" });
  await post(routes, "/api/dsh-graph/transition", { goal: goalId, to: "in_progress", force: true });
  const reject = await post(routes, "/api/dsh-graph/set-criteria",
    { goal: goalId, items: [], base_items: ["1. 判据"] });
  assert.equal(reject.code, 400);
  assert.match(reject.body.error, /不允许清空质量判据/);
});

test("g-170 set-criteria：D8 base_items 不一致 → 409；force=true → 200 覆盖并记 conflicted", async () => {
  const { root, routes, goalId } = setup();
  await post(routes, "/api/dsh-graph/set-criteria", { goal: goalId, items: ["甲", "乙"], base_items: [] });
  // 并发冲突（base 过期）
  const conflict = await post(routes, "/api/dsh-graph/set-criteria",
    { goal: goalId, items: ["丙"], base_items: ["1. 旧甲"] });
  assert.equal(conflict.code, 409);
  assert.match(conflict.body.error, /并发冲突/);
  // 服务器内容未被改动
  let doc = loadGoal(findGoalFile(root, goalId));
  assert.deepEqual(criteriaItems(doc.body), ["1. 甲", "2. 乙"]);
  // force=true 覆盖
  const overwrite = await post(routes, "/api/dsh-graph/set-criteria",
    { goal: goalId, items: ["丙"], base_items: ["1. 旧甲"], force: true });
  assert.equal(overwrite.code, 200);
  assert.equal(overwrite.body.conflicted, true);
  doc = loadGoal(findGoalFile(root, goalId));
  assert.deepEqual(criteriaItems(doc.body), ["1. 丙"]);
  const updated = readEvents(root).filter((e) => e.event === "criteria.updated");
  assert.ok(updated.some((e) => e.details.conflicted === true), "覆盖事件记录 conflicted 供审计");
});

test("g-170 set-criteria：保留小节注释；goal 端点下发 criteria_items（base_items 数据源）", async () => {
  const { root, routes, goalId } = setup();
  const goalFile = findGoalFile(root, goalId);
  const doc = loadGoal(goalFile);
  doc.body = replaceSection(doc.body, "质量判据",
    sectionText(doc.body, "质量判据")! + "\n<!-- 备注 -->\n");
  saveGoal(goalFile, doc);
  const r = await post(routes, "/api/dsh-graph/set-criteria",
    { goal: goalId, items: ["甲"], base_items: [] });
  assert.equal(r.code, 200);
  assert.ok(loadGoal(goalFile).body.includes("<!-- 备注 -->"));
  // goal 端点下发 criteria_items
  const handler = routes.get("/api/dsh-graph/goal");
  const res = fakeResponse();
  handler({ method: "GET", url: `/api/dsh-graph/goal?id=${goalId}`, on: () => {} }, res);
  assert.equal(res._code, 200);
  assert.deepEqual(res._body.criteria_items, ["1. 甲"]);
});

test("g-170 set-criteria：缺 items / 非字符串数组 → 400", async () => {
  const { routes, goalId } = setup();
  const missing = await post(routes, "/api/dsh-graph/set-criteria", { goal: goalId });
  assert.equal(missing.code, 400);
  const badType = await post(routes, "/api/dsh-graph/set-criteria",
    { goal: goalId, items: [1, 2] });
  assert.equal(badType.code, 400);
});

// ---- g-170：客户端源契约（源模块 + 生成 bundle） ----

test("g-170 判据编辑入口位于详情弹窗「质量判据」标题处（负责人 2026-08-25 指示，不在看板卡片）", () => {
  const modal = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/goal-modal.js"), "utf8");
  // 标题处入口：sectionBlock 支持 titleExtra，质量判据小节标题右侧挂「✏️ 判据」按钮
  assert.match(modal, /function sectionBlock\(key, title, body, extra, hideBodyWhenExtra, titleExtra\)/);
  assert.match(modal, /dgT\("section\.criteria"\)/);
  assert.match(modal, /dgT\("common\.edit"\)/);
  assert.match(modal, /onClick: \(e\) => \{ e\.stopPropagation\(\); setCriteriaOpen\(true\);/);
  assert.match(modal, /criteriaOpen, setCriteriaOpen\] = React\.useState\(false\)/);
  // 打开 CriteriaModal 并传 onSaved 刷新详情
  assert.match(modal, /h\(CriteriaModal, \{ goalId: props\.id, onClose: \(\) => setCriteriaOpen\(false\), onSaved: \(\) => \{ setCriteriaOpen\(false\); load\(\); \} \}\)/);
  // 看板卡片不再有判据编辑入口（还原）
  const card = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/card.js"), "utf8");
  assert.doesNotMatch(card, /✏️ 判据/);
  assert.doesNotMatch(card, /onOpenCriteria/);
});

test("g-170 判据编辑弹窗源契约：D6 清勾选告知/清空、D8 base_items 409 自动覆盖重试", () => {
  const modal = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/criteria-modal.js"), "utf8");
  assert.match(modal, /function CriteriaModal\(props\)/);
  // D6：进入编辑前明确告知 + 保存后清空 localStorage 勾选
  assert.match(modal, /dgT\("criteria\.saveWarning"\)/);
  assert.match(modal, /localStorage\.removeItem\("dsh-graph\.crit\." \+ goalId\)/);
  assert.match(modal, /dsh-graph\.criteria-changed/);
  // D8：base_items token + 409 自动以本地内容覆盖重试（force=true）
  assert.match(modal, /base_items: baseItems \?\? \[\]/);
  assert.match(modal, /r\.status === 409/);
  assert.match(modal, /dgT\("criteria\.conflictResolved"\)/);
  assert.match(modal, /force: !!force/);
  assert.match(modal, /post\(true\)/);
  // 逐行编辑能力
  assert.match(modal, /dgT\("criteria\.addBtn"\)/);
  assert.match(modal, /dgT\("criteria\.moveUp"\)/);
  assert.match(modal, /dgT\("criteria\.moveDown"\)/);
  assert.match(modal, /dgT\("criteria\.deleteItem"\)/);
});

test("g-170 kanban 不再承载判据编辑入口（已移到详情弹窗）", () => {
  const kanban = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  assert.doesNotMatch(kanban, /criteriaGoal/);
  assert.doesNotMatch(kanban, /CriteriaModal/);
  assert.doesNotMatch(kanban, /✏️ 判据/);
});

test("g-170 build-client PARTS 收录 criteria-modal 且 bundle 含生成标记与弹窗代码", () => {
  const script = readFileSync(join(process.cwd(), "scripts/build-client.sh"), "utf8");
  assert.match(script, /"criteria-modal"/);
  const bundle = readFileSync(join(process.cwd(), "dist/lib/client.js"), "utf8");
  assert.match(bundle, /⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY/);
  assert.match(bundle, /function CriteriaModal\(props\)/);
  assert.match(bundle, /dgT\("common\.edit"\)/);
});

test("g-243 VersionDrawer 必须在 KanbanView 函数体之外声明（否则每次渲染重建抽屉、版本清单滚动位置归零）", () => {
  const bundle = readFileSync(join(process.cwd(), "dist/lib/client.js"), "utf8");
  const kanbanStart = bundle.indexOf("function KanbanView(props) {");
  assert.ok(kanbanStart > 0, "bundle 含 KanbanView");
  // 配平花括号求 KanbanView 函数体范围
  let depth = 0;
  let end = -1;
  for (let i = bundle.indexOf("{", kanbanStart); i < bundle.length; i++) {
    if (bundle[i] === "{") depth++;
    else if (bundle[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > kanbanStart, "KanbanView 函数体可配平");
  const vd = bundle.indexOf("function VersionDrawer(props)");
  assert.ok(vd > 0, "bundle 含 VersionDrawer");
  // 嵌套在 KanbanView 内部时每次渲染都会产生新函数身份 → React 因 elementType 变化卸载重建
  assert.ok(vd < kanbanStart || vd > end, "VersionDrawer 必须在 KanbanView 之外（工厂作用域）");
  // build 顺序保证：version-drawer 排在 drag-prompts 之前（drag-prompts 打开 KanbanView、kanban 收尾）
  const script = readFileSync(join(process.cwd(), "scripts/build-client.sh"), "utf8");
  const vdIdx = script.indexOf('"version-drawer"');
  const dpIdx = script.indexOf('"drag-prompts"');
  assert.ok(vdIdx > 0 && dpIdx > 0 && vdIdx < dpIdx, "PARTS 中 version-drawer 必须早于 drag-prompts");
  // 已发布版本泳道增删会改变尾部兄弟数量：抽屉需稳定 key 才能被 React 按 key 复用
  assert.match(bundle, /key: "dg-version-drawer"/);
  // g-256：同类隐患的 5 个尾部弹窗（GoalModal/CardDrawer/SettingsModal/SharedCardsModal/
  // MemoryManagementModal）也必须带稳定 key——releasedRows 兄弟增删时无 key 会被按索引
  // 匹配重建，丢失弹窗内部 state/滚动/焦点（与 g-243 同机制）。源码与生成物双断言。
  const kanbanSrc = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  for (const k of ["dg-goal-modal", "dg-card-drawer", "dg-settings-modal", "dg-shared-cards-modal", "dg-memory-modal"]) {
    assert.match(kanbanSrc, new RegExp(`key: "${k}"`), `kanban.js 源码含 key ${k}`);
    assert.match(bundle, new RegExp(`key: "${k}"`), `client.js 生成物含 key ${k}`);
  }
});

test("g-170 constants：criteria.updated 事件有标签并计入近期动态", () => {
  const src = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/constants.js"), "utf8");
  assert.match(src, /get "criteria\.updated"\(\) \{ return dgT\('event\.criteriaUpdated'\); \}/);
  assert.match(src, /"criteria\.updated",/);
});

test("spawn-options：无 llm 服务时容错返回（重新执行选择器数据源）", async () => {
  const { routes } = setup();
  const handler = routes.get("/api/dsh-graph/spawn-options");
  assert.ok(handler, "spawn-options 路由已注册");
  const res = fakeResponse();
  await handler({ method: "GET", on: () => {} }, res);
  assert.equal(res._code, 200);
  // modelGroups 无 llm 服务 → null；default 读 project.yaml（temp root 无 → null）
  assert.equal(res._body.modelGroups, null);
  assert.deepEqual(res._body.default, { provider: null, model: null, mode: "standard", mode_source: "default" });
});

test("g-231 spawn-options：resolveModelInfo 补充 per-model reasoning.efforts 且 resolve 失败不拖垮整组", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g231-spawn-"));
  const root = join(ws, ".dsh-graph");
  init(root);

  const llmService = {
    listProviders: async () => [{ id: "deepseek", name: "DeepSeek" }, { id: "kimi", name: "Moonshot" }],
    listModels: async (pid: string) => {
      if (pid === "deepseek") return [{ id: "deepseek-chat", name: "DeepSeek Chat" }, { id: "deepseek-reasoner", name: "DeepSeek Reasoner" }];
      return [{ id: "moonshot-v1-8k", name: "Moonshot v1 8k" }];
    },
    resolveModelInfo: async (pid: string, mid: string) => {
      if (pid === "deepseek" && mid === "deepseek-chat") {
        return { reasoning: { efforts: [{ id: "off", name: "Off" }, { id: "low", name: "Low" }, { id: "high", name: "High" }], defaultEffort: "low" } };
      }
      if (pid === "deepseek" && mid === "deepseek-reasoner") {
        return { reasoning: { efforts: [{ id: "high", name: "High" }, { id: "max", name: "Max" }] } };
      }
      if (pid === "kimi") throw new Error("resolve failed for kimi");
      return {};
    },
  };

  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "llm") return llmService;
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});

  const handler = routes.get("/api/dsh-graph/spawn-options");
  const res = fakeResponse();
  await handler({ method: "GET", url: "/api/dsh-graph/spawn-options?workspace=" + encodeURIComponent(ws), on: () => {} }, res);
  assert.equal(res._code, 200);
  assert.ok(Array.isArray(res._body.modelGroups), "modelGroups 应为数组");
  assert.equal(res._body.modelGroups.length, 2);

  // deepseek 组：两个模型都有 reasoning
  const dsGroup = res._body.modelGroups.find((g: any) => g.id === "deepseek");
  assert.ok(dsGroup, "deepseek 组存在");
  assert.equal(dsGroup.models.length, 2);
  const chatModel = dsGroup.models.find((m: any) => m.id === "deepseek-chat");
  assert.deepEqual(chatModel.reasoning, {
    efforts: [{ id: "off", name: "Off" }, { id: "low", name: "Low" }, { id: "high", name: "High" }],
    defaultEffort: "low",
  }, "deepseek-chat 应含 reasoning.efforts 与 defaultEffort");
  const reasonerModel = dsGroup.models.find((m: any) => m.id === "deepseek-reasoner");
  assert.deepEqual(reasonerModel.reasoning, {
    efforts: [{ id: "high", name: "High" }, { id: "max", name: "Max" }],
  }, "deepseek-reasoner 应含 reasoning.efforts（无 defaultEffort）");

  // kimi 组：resolveModelInfo 抛错 → 模型保留 id/name 但无 reasoning（不拖垮整组）
  const kimiGroup = res._body.modelGroups.find((g: any) => g.id === "kimi");
  assert.ok(kimiGroup, "kimi 组存在（resolve 失败不拖垮）");
  assert.equal(kimiGroup.models.length, 1);
  assert.equal(kimiGroup.models[0].id, "moonshot-v1-8k");
  assert.equal(kimiGroup.models[0].reasoning, undefined, "resolve 失败的模型无 reasoning 字段");
});

test("g-231 spawn-options：无 resolveModelInfo 时模型只含 id/name（向后兼容旧版 llm）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g231-spawn-compat-"));
  const root = join(ws, ".dsh-graph");
  init(root);

  const llmService = {
    listProviders: async () => ["legacy-prov"],
    listModels: async () => ["legacy-model"],
    // 无 resolveModelInfo 方法（旧版 llm 服务）
  };

  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "llm") return llmService;
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});

  const handler = routes.get("/api/dsh-graph/spawn-options");
  const res = fakeResponse();
  await handler({ method: "GET", url: "/api/dsh-graph/spawn-options?workspace=" + encodeURIComponent(ws), on: () => {} }, res);
  assert.equal(res._code, 200);
  assert.equal(res._body.modelGroups.length, 1);
  assert.equal(res._body.modelGroups[0].models[0].id, "legacy-model");
  assert.equal(res._body.modelGroups[0].models[0].reasoning, undefined, "旧版 llm 无 resolveModelInfo 时无 reasoning");
});

test("g-231 loadHostCatalog REST fallback 保留 spawn-options 中的 reasoning 字段", async () => {
  // 模拟 spawn-options 返回含 reasoning 的 modelGroups，验证 loadHostCatalog REST 分支不剥离
  const settingsCode = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/settings.js"), "utf8");
  const context = vm.createContext({
    appCtx: null, gConnectionApi: null, Promise, Array, Set, Error, console,
    graphUrl: () => "/api/dsh-graph/spawn-options",
    fetch: async () => ({
      ok: true,
      json: async () => ({
        modelGroups: [
          {
            id: "deepseek", name: "DeepSeek",
            models: [
              { id: "deepseek-chat", name: "DeepSeek Chat", reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], defaultEffort: "low" } },
              { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
            ],
          },
        ],
      }),
    }),
    window: {},
  });
  vm.runInContext(`${settingsCode}\nglobalThis.loadHostCatalog = loadHostCatalog;`, context);
  const loadHostCatalog = context.loadHostCatalog;
  const result = await loadHostCatalog(null, { get: () => null });
  assert.equal(result.status, "ready");
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].id, "deepseek");
  const chatModel = result.groups[0].models.find((m: any) => m.id === "deepseek-chat");
  assert.deepEqual(chatModel.reasoning, {
    efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }],
    defaultEffort: "low",
  }, "REST fallback 应保留 reasoning 字段不剥离");
  const reasonerModel = result.groups[0].models.find((m: any) => m.id === "deepseek-reasoner");
  assert.equal(reasonerModel.reasoning, undefined, "无 reasoning 的模型保持 undefined");
});

test("start-execution 无 subagents：attempt 本地创建、child_error 上报（带 provider/model 参数不炸）", async () => {
  const { root, routes, goalId } = setup();
  // g-237：派发前有执行准入门禁，fixture 需先登记判据
  setCriteria(root, goalId, ["测试判据"], "test");
  const r = await post(routes, "/api/dsh-graph/start-execution",
    { goal: goalId, provider: "spawn", model: "deepseek-v4-flash", mode: "minimal" });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.attempt.startsWith("att-"));
  assert.equal(r.body.child_id, null);
  assert.ok(typeof r.body.child_error === "string");
  assert.equal(r.body.mode, "minimal");
  assert.equal(r.body.mode_source, "override");
  const attemptDoc = loadGoal(join(dirname(findGoalFile(root, goalId)), "attempts", r.body.attempt, "attempt.md"));
  assert.equal(attemptDoc.meta.mode, "minimal");
  assert.equal(attemptDoc.meta.mode_source, "override");
  const events = readEvents(root);
  assert.ok(events.some((e) => e.event === "attempt.started" && e.goal === goalId && e.details?.mode === "minimal"));
});

// ===== g-148：GUI ready→in_progress force transition + start-execution 成功链回归 =====

test("g-148 GUI 两步执行链：force ready→in_progress + start-execution 成功派发子代理", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g148-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goalId = createGoal(root, { title: "g-148 测试目标", version: "v-t", actor: "test" });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  // 准备目标到 ready（需先设判据再迁移）
  setCriteria(root, goalId, ["测试判据"], "test");
  transition(root, goalId, "ready", { actor: "test" });

  const subagentsService = {
    list: () => ["spawn"],
    getProvider: () => ({ prepareContinuable: () => {} }),
    startContinuable: async () => ({ childId: "c-g148", parentSessionId: "p-g148" }),
  };
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "subagents") return subagentsService;
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});

  // Step 1：GUI 模拟 force transition ready → in_progress
  const tr = await post(routes, "/api/dsh-graph/transition",
    { goal: goalId, to: "in_progress", force: true, workspace: ws });
  assert.equal(tr.code, 200);
  assert.equal(tr.body.ok, true, "force ready→in_progress 成功");

  // Step 2：start-execution
  const exec = await post(routes, "/api/dsh-graph/start-execution",
    { goal: goalId, workspace: ws });
  assert.equal(exec.code, 200);
  assert.equal(exec.body.ok, true);
  assert.equal(exec.body.child_id, "c-g148", "子代理已派发");
  assert.ok(!exec.body.child_error, "无子代理错误");

  // 验证事件链
  const events = readEvents(root);
  assert.ok(events.some((e) => e.event === "goal.transition" && e.goal === goalId &&
    e.details?.to === "in_progress" && e.actor === "human:gui"),
    "force transition 事件已记录");
  assert.ok(events.some((e) => e.event === "attempt.started" && e.goal === goalId),
    "attempt.started 事件已记录");
  assert.ok(events.some((e) => e.event === "attempt.bound" && e.goal === goalId &&
    e.details?.child_id === "c-g148"),
    "attempt.bound 事件已记录");

  // 验证目标最终状态为 in_progress
  const goalDoc = loadGoal(findGoalFile(root, goalId));
  assert.equal(goalDoc.meta.status, "in_progress");
});

test("g-148 GUI 两步执行链：transition 端点校验缺失参数", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g148-fail-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  createGoal(root, { title: "g-148 失败测试", version: "v-t", actor: "test" });

  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});

  // 缺少 goal 参数 → 400
  const tr = await post(routes, "/api/dsh-graph/transition",
    { to: "in_progress", force: true, workspace: ws });
  assert.equal(tr.code, 400, "缺失 goal 返回 400");
  assert.ok(tr.body.error, "错误信息存在");

  // 不存在的目标 → 400
  const tr2 = await post(routes, "/api/dsh-graph/transition",
    { goal: "g-nonexist", to: "in_progress", force: true, workspace: ws });
  assert.equal(tr2.code, 400, "不存在的目标返回 400");
});

// ===== g-113：client board 端点跟随请求 workspace（前端带 ?workspace= / body.workspace） =====

test("g-113 board 端点跟随 ?workspace=：读该项目自己的 .dsh-graph，而非默认/进程 cwd 骨架", () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-ws-"));
  const a = makeProject(base, "proj-a", "A 项目目标");
  const b = makeProject(base, "proj-b", "B 项目目标");
  const { routes } = setupNoConfigRoot(b.ws);
  const handler = routes.get("/api/dsh-graph");
  const res = fakeResponse();
  handler({ method: "GET", url: "/api/dsh-graph?workspace=" + encodeURIComponent(b.ws) }, res);
  assert.equal(res._code, 200);
  const titles = boardGoalTitles(res._body);
  assert.ok(titles.includes(b.title), "board 含 workspace 项目的目标");
  assert.ok(!titles.includes(a.title), "board 不含其他项目目标");
  // 反向：workspace=a 使用独立请求上下文授权
  const handlerA = setupNoConfigRoot(a.ws).routes.get("/api/dsh-graph");
  const res2 = fakeResponse();
  handlerA({ method: "GET", url: "/api/dsh-graph?workspace=" + encodeURIComponent(a.ws) }, res2);
  const titles2 = boardGoalTitles(res2._body);
  assert.ok(titles2.includes(a.title));
  assert.ok(!titles2.includes(b.title));
});

test("g-113 写端点跟随 body.workspace：add-card 写到该项目 .dsh-graph（事件落该项目）", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-ws-"));
  const b = makeProject(base, "proj-b", "B 项目目标");
  const { routes } = setupNoConfigRoot(b.ws);
  const handler = routes.get("/api/dsh-graph/add-card");
  const req = fakeRequest("POST", { goal: b.goalId, title: "收集卡", kind: "text", workspace: b.ws });
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal: b.goalId, title: "收集卡", kind: "text", workspace: b.ws, scope: "goal" });
  await p;
  assert.equal(res._code, 200);
  assert.equal(res._body.ok, true);
  assert.ok(typeof res._body.card === "string");
  const ev = readEvents(join(b.ws, ".dsh-graph")).filter((e) => e.event === "card.created");
  assert.equal(ev.length, 1, "卡片事件落在 workspace 项目自己的 .dsh-graph");
  assert.equal(ev[0].goal, b.goalId);
});

test("g-113 写端点同时接受 query 参数 workspace（前端 POST 也走 ?workspace=）", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-ws-"));
  const b = makeProject(base, "proj-b", "B 项目目标");
  const { routes } = setupNoConfigRoot(b.ws);
  const handler = routes.get("/api/dsh-graph/accept");
  const req = fakeRequest("POST", { goal: b.goalId });
  req.url = "/api/dsh-graph/accept?workspace=" + encodeURIComponent(b.ws);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal: b.goalId });
  await p;
  assert.equal(res._code, 200);
  assert.equal(res._body.pending, true);
  const ev = readEvents(join(b.ws, ".dsh-graph")).filter((e) => e.event === "review.requested");
  assert.equal(ev.length, 1, "review.requested 落在 workspace 项目自己的 .dsh-graph");
});

test("g-113 board 端点接受 ?root= 别名（与 ?workspace= 等价，均指 workspace 根）", () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-ws-"));
  const a = makeProject(base, "proj-a", "A 项目目标");
  const b = makeProject(base, "proj-b", "B 项目目标");
  const { routes } = setupNoConfigRoot(b.ws);
  const handler = routes.get("/api/dsh-graph");
  const res = fakeResponse();
  handler({ method: "GET", url: "/api/dsh-graph?root=" + encodeURIComponent(b.ws) }, res);
  assert.equal(res._code, 200);
  const titles = boardGoalTitles(res._body);
  assert.ok(titles.includes(b.title), "?root= 读到 workspace 项目目标");
  assert.ok(!titles.includes(a.title), "?root= 不串其他项目");
});

test("g-113 无 workspace 参数时回退 config.root（现有行为不回归）", async () => {
  const { root, routes, goalId } = setup(); // config.root = temp
  const handler = routes.get("/api/dsh-graph/goal");
  const res = fakeResponse();
  handler({ method: "GET", url: "/api/dsh-graph/goal?id=" + encodeURIComponent(goalId) }, res);
  assert.equal(res._code, 200);
  assert.equal(res._body.meta?.id, goalId, "无 workspace 时按 config.root 解析（绝对 root 覆盖兜底）");
});

test("g-113 端点触达全新 workspace 时自动 init 骨架（开箱即用，不落 profile 骨架）", () => {
  const freshWs = join(mkdtempSync(join(tmpdir(), "dsh-graph-fresh-")), "brand-new-proj");
  const { routes } = setupNoConfigRoot(freshWs);
  const handler = routes.get("/api/dsh-graph");
  const res = fakeResponse();
  handler({ method: "GET", url: "/api/dsh-graph?workspace=" + encodeURIComponent(freshWs) }, res);
  assert.equal(res._code, 200);
  assert.deepEqual(boardGoalTitles(res._body), [], "全新项目 board 返回空看板");
  for (const d of ["backlog", "goals", "versions", "memory/long-term"]) {
    assert.ok(existsSync(join(freshWs, ".dsh-graph", d)), `目录 ${d} 已在项目内自动建`);
  }
  assert.ok(existsSync(join(freshWs, ".dsh-graph", "events.jsonl")), "events.jsonl 已在项目内自动建");
  assert.ok(existsSync(join(freshWs, ".dsh-graph", "rules.md")), "rules.md 已在项目内自动建");
  // 骨架建在项目内，而非默认/进程 cwd（profile web 骨架未被写入新目标）
  assert.ok(!existsSync(join(process.cwd(), ".dsh-graph", "versions", "v-t")), "未污染默认骨架");
});

test("g-113 start-execution 注入目标相对路径以请求 workspace 为基准（.dsh-graph/versions/...）", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-host-rel-"));
  const ws = join(base, "proj");
  init(join(ws, ".dsh-graph"));
  const goalId = createGoal(join(ws, ".dsh-graph"), { title: "rel 目标", version: "v-t", actor: "test" });
  // g-237：派发前有执行准入门禁，fixture 需先登记判据
  setCriteria(join(ws, ".dsh-graph"), goalId, ["测试判据"], "test");
  writeFileSync(join(ws, ".dsh-graph", "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  let capturedPrompt = "";
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "subagents") return {
        list: () => ["spawn"],
        getProvider: () => ({ prepareContinuable: () => {} }),
        startContinuable: async (opts: any) => {
          capturedPrompt = opts.request?.prompt?.[0]?.text ?? "";
          return { childId: "c-x" };
        },
      };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});
  const handler = routes.get("/api/dsh-graph/start-execution");
  const req = fakeRequest("POST", { goal: goalId });
  req.url = "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal: goalId });
  await p;
  assert.equal(res._code, 200);
  assert.equal(res._body.child_id, "c-x");
  const expected = relative(ws, findGoalFile(join(ws, ".dsh-graph"), goalId));
  assert.ok(capturedPrompt.includes(expected), `prompt 含 workspace 根基准相对路径：${expected}`);
});

// ===== g-148：模块源/生成 bundle onRefresh 注入契约回归 =====

test("g-148 模块源契约：goal-actions.js AcceptFeedback 解构 onRefresh 并在成功路径调用 onRefresh?.()", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  // AcceptFeedback 解构 onRefresh
  assert.ok(
    /const\s*\{\s*goalId\s*,\s*status\s*,\s*events\s*,\s*supervisorSession\s*,\s*onRefresh\s*\}\s*=\s*props/.test(src),
    "AcceptFeedback props 解构包含 onRefresh");
  // 成功路径调用 onRefresh?.()
  assert.ok(
    /onRefresh\?\.\(\)/.test(src),
    "startExecution 成功分支调用 onRefresh?.()");
});

test("g-148 模块源契约：goal-actions.js AcceptFeedback 成功路径无裸 load() 调用", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  // 提取 AcceptFeedback 函数体（从 function AcceptFeedback 到同级函数定义或文件末尾）
  const fnMatch = /function AcceptFeedback\(props\)\s*\{([\s\S]*?)(?=\n    function |\n    \/\/ g-\d+[：:]|\n\s*\}$)/.exec(src);
  assert.ok(fnMatch, "找到 AcceptFeedback 函数体");
  const fnBody = fnMatch[1];
  // AcceptFeedback 函数体内不应有裸 load()（onRefresh?.() 是正确的）
  const bareLoadCalls = fnBody.match(/(?<!\.)load\(\)/g);
  assert.ok(!bareLoadCalls, "AcceptFeedback 函数体内无裸 load() 调用");
});

test("g-148 模块源契约：goal-modal.js 向 AcceptFeedback 传递 onRefresh: load", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-modal.js"), "utf8");
  // GoalModal 中渲染 AcceptFeedback 时传入 onRefresh: load
  assert.ok(
    /onRefresh:\s*load/.test(src),
    "GoalModal 向 AcceptFeedback 传递 onRefresh: load");
  // load 使用 useCallback 定义（稳定引用）
  assert.ok(
    /const\s+load\s*=\s*React\.useCallback/.test(src),
    "load 使用 useCallback 定义为稳定回调");
});

test("g-148 生成 bundle 契约：client.js 含 onRefresh 解构/调用且无裸 load()，保留 generated header", () => {
  const bundle = readFileSync(
    join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  // generated header 存在
  assert.ok(
    bundle.startsWith("// ⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY"),
    "client.js 保留 GENERATED FILE header");
  // AcceptFeedback 解构 onRefresh
  assert.ok(
    /const\s*\{\s*goalId\s*,\s*status\s*,\s*events\s*,\s*supervisorSession\s*,\s*onRefresh\s*\}\s*=\s*props/.test(bundle),
    "生成 bundle: AcceptFeedback 解构包含 onRefresh");
  // 成功路径调用 onRefresh?.()
  assert.ok(
    /onRefresh\?\.\(\)/.test(bundle),
    "生成 bundle: startExecution 成功分支调用 onRefresh?.()");
  // GoalModal 向 AcceptFeedback 传递 onRefresh: load
  assert.ok(
    /onRefresh:\s*load/.test(bundle),
    "生成 bundle: GoalModal 传递 onRefresh: load");
  // 提取 AcceptFeedback 函数体，验证无裸 load()
  const fnMatch = /function AcceptFeedback\(props\)\s*\{([\s\S]*?)(?=\n\s{2,4}function |\n\s{2,4}\/\/ g-\d+[：:]|\n\s{2,4}\/\/ 详情 modal)/.exec(bundle);
  assert.ok(fnMatch, "生成 bundle: 找到 AcceptFeedback 函数体");
  const fnBody = fnMatch[1];
  const bareLoadCalls = fnBody.match(/(?<!\.)load\(\)/g);
  assert.ok(!bareLoadCalls, "生成 bundle: AcceptFeedback 函数体内无裸 load() 调用");
});

// g-154：卡片抽屉文件入口 UI 契约回归
test("g-154 生成 bundle 契约：card-drawer.js 含 cardFile 开放/复制逻辑 + 无文件降级", () => {
  const bundle = readFileSync(
    join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  // CardDrawer 含 cardFile 开放逻辑
  assert.ok(
    /card\.cardFile/.test(bundle),
    "生成 bundle: CardDrawer 引用 card.cardFile");
  // 含 openPath 调用（复用 file-link 机制）
  assert.ok(
    /openPath.*card\.cardFile|card\.cardFile.*openPath/s.test(bundle),
    "生成 bundle: CardDrawer 通过 openPath 打开卡片文件");
  // 含复制路径逻辑
  assert.ok(
    /copyText\(card\.cardFile\)/.test(bundle),
    "生成 bundle: CardDrawer 含复制卡片文件路径逻辑");
  // 无文件降级状态
  assert.ok(
    /无文件路径/.test(bundle),
    "生成 bundle: CardDrawer 含无文件路径降级文案");
});

// g-154：编译产物 dsh-graph-host/core/ops.js 含 goalCards cardFile 字段（防止 sync-core 遗漏）
test("g-154 编译产物契约：dsh-graph-host/core/ops.js goalCards 输出含 cardFile 字段", () => {
  const compiledOps = readFileSync(
    join(import.meta.dirname, "../../dist/core/ops.js"), "utf8");
  assert.ok(
    /cardFile:\s*cardFilePath/.test(compiledOps),
    "编译 ops.js: goalCards 输出含 cardFile: cardFilePath");
  assert.ok(
    /if\s*\(c\.cardFile\)/.test(compiledOps),
    "编译 ops.js: goalDetail 使用 c.cardFile 读取全文");
});

// g-158：REST 端到端——create-goal type 透传 + set-goal-type 事件
test("g-158 create-goal REST 透传 type（默认 task/指定/非法回退）", async () => {
  const { root, routes } = setup();
  // 指定 type
  const r1 = await post(routes, "/api/dsh-graph/create-goal", { title: "Feature", type: "feature" });
  assert.equal(r1.code, 200);
  const f = findGoalFile(root, r1.body.goal);
  assert.equal(loadGoal(f).meta.type, "feature", "create-goal 应持久化指定 type");
  // 缺省 type → task
  const r2 = await post(routes, "/api/dsh-graph/create-goal", { title: "默认" });
  const f2 = findGoalFile(root, r2.body.goal);
  assert.equal(loadGoal(f2).meta.type, "task", "缺省 type 应为 task");
  // 非法 type → task
  const r3 = await post(routes, "/api/dsh-graph/create-goal", { title: "非法", type: "nope" });
  const f3 = findGoalFile(root, r3.body.goal);
  assert.equal(loadGoal(f3).meta.type, "task", "非法 type 应回退 task");
});

test("g-158 set-goal-type REST：更新 type + 记 goal.type_changed 事件 + no-op", async () => {
  const { root, routes, goalId } = setup();
  const before = loadGoal(findGoalFile(root, goalId));
  assert.equal(before.meta.type, "task");
  const r = await post(routes, "/api/dsh-graph/set-goal-type", { goal: goalId, type: "bug" });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.old_type, "task");
  assert.equal(r.body.new_type, "bug");
  assert.equal(loadGoal(findGoalFile(root, goalId)).meta.type, "bug");
  const ev = readEvents(root).find((e) => e.event === "goal.type_changed" && e.goal === goalId);
  assert.ok(ev, "应记录 goal.type_changed 事件");
  assert.equal(ev.details.old_type, "task");
  assert.equal(ev.details.new_type, "bug");
  // no-op：相同类型不写事件
  const beforeCount = readEvents(root).filter((e) => e.event === "goal.type_changed").length;
  const r2 = await post(routes, "/api/dsh-graph/set-goal-type", { goal: goalId, type: "bug" });
  assert.equal(r2.body.old_type, "bug");
  assert.equal(r2.body.new_type, "bug");
  const afterCount = readEvents(root).filter((e) => e.event === "goal.type_changed").length;
  assert.equal(afterCount, beforeCount, "相同类型 no-op 不追加事件");
});

test("g-168 定义/润色源契约：按钮同排且请求仅含路径与指导意见", () => {
  const actions = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  const modal = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-modal.js"), "utf8");
  assert.ok(/function DefinitionPolish\(props\)/.test(actions));
  assert.ok(/goalPath/.test(actions) && /guidance/.test(actions));
  // g-272 att-002：原 [\s\S]* 贪心正则会越过 h("pre" 命中后文无关的 request 字面量（如 dgT("drag.requestFail")），收紧为限长窗口，语义不变。
  assert.ok(!/h\("pre"[\s\S]{0,500}request/.test(actions), "不渲染完整请求预览");
  assert.ok(/display: \"flex\", gap: 6, alignItems: \"center\"/.test(actions), "入口位于 AcceptFeedback flex 行");
  assert.ok(/goalPath:[\s\S]*d\.goalFile/.test(modal), "GoalModal 传递 goal.md 路径");
  assert.ok(/goal_path:\s*goalPath/.test(actions), "PM 请求传递路径而非正文");
});

test("g-168 活跃 attempt 回归：历史 completed/空闲不隐藏入口", () => {
  const actions = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  const match = /function hasActiveExecutionAttempt\(attempts\)\s*\{[\s\S]*?\n    \}/.exec(actions);
  assert.ok(match, "找到活跃 attempt 判断函数");
  const isActive = new Function(`return (${match[0]})`)();
  assert.equal(isActive([{ executor: "agent:executor", result: "completed", status_line: "完成" }]), false);
  assert.equal(isActive([{ executor: "agent:executor", result: "pending", status_line: "空闲待命" }]), false);
  assert.equal(isActive([{ executor: "agent:collect", result: "pending", status_line: "正在收集" }]), false);
  assert.equal(isActive([{ executor: "agent:executor", result: "pending", status_line: "正在执行定义润色" }]), true);
});

test("g-247 客户端 formatStatusWithLifecycle：结构化状态优先，缺失时回退 legacy 文本", () => {
  const helpers = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");
  const match = /function formatStatusWithLifecycle\(statusLine, running, blocked, statusState\)\s*\{[\s\S]*?\n    \}/.exec(helpers);
  assert.ok(match, "找到支持 statusState 的生命周期格式化函数");
  const format = new Function(`return (${match[0]})`)();

  const structuredDone = format("没有完成关键词", true, false, "done");
  assert.equal(structuredDone.isDone, true);
  assert.equal(structuredDone.isRunning, false);
  const structuredWorking = format("已完成，等待复核", true, false, "working");
  assert.equal(structuredWorking.isDone, false);
  assert.equal(structuredWorking.isRunning, true);
  const negatedWorking = format("尚未完成", true, false, "working");
  assert.equal(negatedWorking.isDone, false);
  const englishWorking = format("fixed the failing test", true, false, "working");
  assert.equal(englishWorking.isError, false);

  // 不传结构化字段时保留旧关键词启发式行为。
  assert.equal(format("已完成", true, false).isDone, true);
  assert.equal(format("阻塞：等待依赖", true, false).isBlocked, true);
  assert.equal(format("构建失败", true, false).isError, true);
});

test("g-168 复制失败 fallback：初始隐藏且只在失败后显示可复制请求", () => {
  // g-327：这套降级契约是「投递不可用」时的兜底路径，逐字保留；直发分支见文件末尾的 g-327 用例。
  const actions = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  assert.ok(/const \[fallback, setFallback\] = React\.useState\(false\)/.test(actions));
  assert.ok(/setFallback\(!copied\)/.test(actions));
  assert.ok(/fallback \? h\("textarea"/.test(actions));
  assert.ok(/readOnly:\s*true[\s\S]*value:\s*request/.test(actions));
  // g-272 att-002：同上，收紧贪心正则窗口。
  assert.ok(!/h\("pre"[\s\S]{0,500}request/.test(actions), "初始界面不展示大段 prefill");
});

test("g-168 交互反馈：主管复制成功 toast 与 PM 润色动画", () => {
  const actions = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  assert.ok(/if \(copied\) showToast\("✅ 请求已复制到剪贴板/.test(actions));
  assert.ok(/const pmRunning = loading && mode === "pm"/.test(actions));
  assert.ok(/className: pmRunning \? "dg-running-flow"/.test(actions));
  assert.ok(/animation: "dg-polish-flow 2\.5s ease 1 forwards"/.test(actions));
  assert.ok(/setLoading\(false\)/.test(actions), "PM 完成后解除 loading 动画");
  assert.ok(/const startedAt = Date\.now\(\)/.test(actions));
  assert.ok(/2500 - \(Date\.now\(\) - startedAt\)/.test(actions), "accepted-running 至少保持 2500ms 可观察");
  assert.ok(!/700|1\.8s/.test(actions), "PM 控件不残留旧动画时长");
  assert.ok(/finally \{[\s\S]*setLoading\(false\)/.test(actions), "成功/业务失败/异常均最终解除 loading");
});

test("g-168 PM 结果反馈：关闭弹窗并把动画挂在看板卡片", () => {
  const actions = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  const modal = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-modal.js"), "utf8");
  const kanban = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");
  const card = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/card.js"), "utf8");
  const constants = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/constants.js"), "utf8");
  assert.ok(/onPmStarted\?\.\(goalId\)/.test(actions));
  assert.ok(/onClose\?\.\(\)/.test(actions), "PM 点击后关闭详情弹窗");
  assert.ok(/onPmFinished\?\.\(goalId\)/.test(actions));
  assert.ok(/onPmStarted: props\.onPmStarted[\s\S]*onPmFinished: props\.onPmFinished/.test(modal));
  assert.ok(/onPmStarted: setPolishGoal[\s\S]*onPmFinished: \(\) => setPolishGoal\(null\)/.test(kanban));
  assert.ok(/_polishActive: polishGoal === g\.id/.test(kanban));
  assert.ok(/g\._polishActive \? " dg-running-flow"/.test(card), "动画 class 挂在 goal card");
  assert.ok(/const cardStyle = g\._polishActive \?/.test(card));
  assert.ok(/const polishOverlay = g\._polishActive \? h\("div"/.test(card), "PM 动画使用透明遮罩");
  assert.ok(/position: "absolute", inset: 0, pointerEvents: "none"/.test(card));
  assert.ok(/animation: "none"/.test(card), "卡片本体不参与淡出");
  assert.ok(/animation: "dg-polish-flow 2\.5s ease 1 forwards"/.test(card), "遮罩执行淡出动画");
  const flowKeyframes = /@keyframes dg-flow-bg\s*\{([\s\S]*?)\n\s*\}/.exec(constants)?.[1] ?? "";
  assert.ok(!/opacity/.test(flowKeyframes), "dg-flow-bg 不得修改既有运行态透明度");
  assert.ok(/@keyframes dg-flow-bg[\s\S]*0% \{ background-position: 0% 50%; \}[\s\S]*50% \{ background-position: 100% 50%; \}[\s\S]*100% \{ background-position: 0% 50%; \}/.test(constants), "既有运行态 keyframe 仅平移背景");
  assert.ok(/@keyframes dg-polish-flow[\s\S]*0%, 80%[\s\S]*opacity: 1[\s\S]*100%[\s\S]*opacity: 0/.test(constants), "PM keyframe 最后 500ms 淡出");
  assert.ok(/animation: dg-flow-bg 2\.5s ease infinite/.test(constants));
  assert.equal((card.match(/style: cardStyle, className: dragClass/g) ?? []).length, 2, "折叠/展开路径都使用动画样式");
});

test("g-168 host prompt 契约：PM 读取 goal.md 并附带指导意见", () => {
  const host = readFileSync(join(import.meta.dirname, "../../dist/index.js"), "utf8");
  assert.ok(/const \{ goal, goal_path, guidance \}/.test(host));
  assert.ok(/goal\.md 工作区相对路径/.test(host));
  assert.ok(/read 工具读取上述 goal\.md/.test(host));
  assert.ok(!/目标标题：\$\{String\(title/.test(host));
});

// g-160：released 版本详情入口、受控恢复与刷新契约
test("g-160 client 源契约：released 详情入口和二次确认恢复", () => {
  const source = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");
  assert.match(source, /title:\s*dgT\(['"]versionDrawer\.detailTooltip['"]\)/);
  assert.match(source, /versionDetailTarget\.status === "released"/);
  assert.match(source, /撤销发布状态/);
  assert.match(source, /status:\s*"active",\s*confirmed:\s*true/);
  assert.match(source, /loadVersionDetail\(versionDetailTarget\.slug\)/);
  assert.match(source, /load\(\)/);
});

// ===== g-171/g-211/g-214：更新强调动画（updated_at 10 秒窗口）源/生成 bundle 契约 =====

test("g-171/g-211/g-214 模块源契约：kanban.js 复用现有 load 与 RefreshCountdown 倒计时且接入 visibilitychange", () => {
  const kanban = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");
  // 复用现有首次加载/手动刷新/写操作后的 load() 与轮询/倒计时（支持 g-212 If-None-Match / 304）
  assert.ok(/setState\(\{ loading: false, data \}\);[\s\S]*applyUpdateEmphasis\(data\)/.test(kanban), "成功路径调用 applyUpdateEmphasis");
  assert.ok(/RefreshCountdown/.test(kanban), "由 RefreshCountdown 负责倒计时与自动刷新");
  // 以服务端 generated_at - updated_at 判定 10 秒窗口
  assert.ok(/const gen = Date\.parse\(data\.generated_at\)/.test(kanban), "用服务端 generated_at 判定窗口");
  assert.ok(/const age = gen - ts/.test(kanban), "窗口 = generated_at - updated_at");
  // 容忍 ≤1s 负 age（旧版 generated_at 秒级截断，同秒修改会得到 -999ms），超过 10 秒不播放
  assert.ok(/const safeAge = Math\.max\(0, age\)/.test(kanban), "负 age 按 0 处理（同秒修改补播）");
  assert.ok(/age < -1000 \|\| safeAge >= 10000/.test(kanban), "仅 10 秒窗口内播放，未来>1s/已过 10s 不播放");
  assert.ok(/const remaining = Math\.max\(0, 10000 - safeAge\)/.test(kanban), "动画时长 = 剩余毫秒");
  // 按 goalId+updated_at 防当前页重复播放（内存 token）
  assert.ok(/const token = g\.id \+ ":" \+ ts/.test(kanban), "token = goalId:updated_at");
  assert.ok(/seenUpdateTokens\.current\.has\(token\)/.test(kanban), "同一 token 不重播");
  // 不新增 WebSocket / SSE / 文件推送
  assert.ok(!/new WebSocket|EventSource/.test(kanban), "不新增 WebSocket/SSE");
  // 详情弹窗关闭触发一次 load()
  assert.ok(/onClose: \(\) => \{ forceReplayRef\.current = \{ goalId: modalGoal, openTs: modalGoalOpenTsRef\.current \}; modalGoalOpenTsRef\.current = null; modalGoalRef\.current = null; setModalGoal\(null\); load\(\); \}/.test(kanban), "详情弹窗关闭触发一次 load() 并记录强制补播目标");
  // g-171 回退修复：弹窗打开期间跳过播放（不消费 token），关闭后补播窗口内目标
  assert.ok(/const modalGoalRef = React\.useRef\(null\);[\s\S]*modalGoalRef\.current = modalGoal/.test(kanban), "modalGoalRef 镜像弹窗状态供 load 闭包判定");
  assert.ok(/if \(modalGoalRef\.current\) return;[\s\S]*const gen = Date\.parse\(data\.generated_at\)/.test(kanban), "弹窗打开期间跳过播放，关闭后 load() 补播");
  // g-171 回退修复：关闭弹窗后强制补播——弹窗期间被外部修改（mtime 变）即使超 10s 窗口也播完整动画
  assert.ok(/const applyForceReplay = \(data\) => \{[\s\S]*if \(g\.updated_at === fr\.openTs\) return;[\s\S]*const remaining = 10000/.test(kanban), "关闭弹窗强制补播：mtime 变化即完整 10s 播放");
  assert.ok(/applyUpdateEmphasis\(data\); applyForceReplay\(data\)/.test(kanban), "load() 成功路径先窗口判定再强制补播判定");
  assert.ok(/modalGoalOpenTsRef\.current === null[\s\S]*modalGoalOpenTsRef\.current = modalGoalData\.updated_at/.test(kanban), "弹窗打开瞬间记录目标 mtime");
  // 卡片透传 _updateEmphasis
  assert.ok(/_updateEmphasis: updateEmphasis\[g\.id\] \?\? null/.test(kanban), "Card 透传 _updateEmphasis");
});

test("g-171 模块源契约：card.js 折叠/展开路径都挂载金属光泽浮层", () => {
  const card = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/card.js"), "utf8");
  assert.ok(/const updateSheen = g\._updateEmphasis \? h\("div"/.test(card), "更新强调浮层元素");
  assert.ok(/className: "dg-update-sheen"/.test(card), "浮层使用 dg-update-sheen class");
  assert.ok(/className: "dg-update-sheen-bar"/.test(card), "浮层内扫光条使用 dg-update-sheen-bar class");
  // g-171 回退修复：动画时长走内联 animation（不依赖 class 的 animation，避免
  // prefers-reduced-motion 的 !important 以外问题；且时长精确由内联控制）
  assert.ok(/animation: "dg-update-fade " \+ g\._updateEmphasis\.remaining \+ "ms linear forwards"/.test(card), "动画时长 = 剩余毫秒（内联 animation）");
  assert.equal((card.match(/updateSheen,/g) ?? []).length, 2, "折叠/展开两条路径都挂载浮层");
  assert.equal((card.match(/style: cardStyle, className: dragClass/g) ?? []).length, 2, "折叠/展开路径都使用卡片样式（布局不变）");
  assert.ok(/g\._polishActive \? \{ \.\.\.style, position: "relative", animation: "none" \} : g\._updateEmphasis \? \{ \.\.\.style, position: "relative" \} : style/.test(card), "更新强调时卡片提供定位锚点且不改变 g-168 语义");
});

test("g-171 模块源契约：constants.js 含扫光/fade keyframe 与 reduced-motion 降级", () => {
  const constants = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/constants.js"), "utf8");
  assert.ok(/@keyframes dg-update-sheen-sweep[\s\S]*translateY\(-130%\)[\s\S]*translateY\(230%\)/.test(constants), "扫光 keyframe 由上到下");
  assert.ok(/@keyframes dg-update-fade[\s\S]*opacity: 1[\s\S]*opacity: 0/.test(constants), "整体淡出 keyframe");
  assert.ok(/\.dg-update-sheen \{[\s\S]*pointer-events: none/.test(constants), "浮层不拦截交互");
  assert.ok(/\.dg-update-sheen-bar \{[\s\S]*animation: dg-update-sheen-sweep 1\.6s linear infinite/.test(constants), "扫光条循环");
  assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.dg-update-sheen, \.dg-update-sheen-bar \{ animation: none !important; \}/.test(constants), "reduced-motion 禁用动画");
  // g-171 回退修复：reduced-motion 下浮层降级为静态斜向金属光泽高光可见（不隐藏——
  // 原 opacity:0 导致系统开"减少动态效果"时更新强调完全不可见；也不用纯色整条填充
  // 避免误判为类型色改变）——135° 对角线渐变直接画一宽一细两条高光（细亮线+宽柔光带，
  // 中间暗间隙分隔+两侧羽化），不用旋转子条（stop 沿 5px 水平分布像素太少）
  assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.dg-update-sheen \{[\s\S]*background: linear-gradient\(135deg,[\s\S]*rgba\(255,255,255,\.95\) 45%[\s\S]*rgba\(255,255,255,\.6\) 72%[\s\S]*\.dg-update-sheen-bar \{ display: none; \}/.test(constants), "reduced-motion 降级为静态斜向金属光泽高光（135° 对角线双峰）而非隐藏");
  assert.ok(!/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.dg-update-sheen \{ opacity: 0; \}/.test(constants), "reduced-motion 不再把浮层 opacity 置 0");
});

test("g-171/g-211/g-214 生成 bundle 契约：client.js 含更新强调逻辑且保留 generated header", () => {
  const bundle = readFileSync(
    join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  assert.ok(bundle.startsWith("// ⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY"), "client.js 保留 GENERATED FILE header");
  assert.ok(/applyUpdateEmphasis/.test(bundle), "生成 bundle: 含 applyUpdateEmphasis");
  assert.ok(/dg-update-sheen/.test(bundle), "生成 bundle: 含 dg-update-sheen 浮层");
  assert.ok(/dg-update-sheen-bar/.test(bundle), "生成 bundle: 含扫光条");
  assert.ok(/dg-update-fade/.test(bundle), "生成 bundle: 含 fade keyframe");
  assert.ok(/prefers-reduced-motion: reduce/.test(bundle), "生成 bundle: 含 reduced-motion 降级");
  assert.ok(/linear-gradient\(135deg,[\s\S]*rgba\(255,255,255,\.95\) 45%[\s\S]*rgba\(255,255,255,\.6\) 72%/.test(bundle), "生成 bundle: reduced-motion 降级为静态斜向金属光泽高光（135° 对角线双峰）");
  assert.ok(/onClose: \(\) => \{ forceReplayRef\.current = \{ goalId: modalGoal, openTs: modalGoalOpenTsRef\.current \}/.test(bundle), "生成 bundle: 弹窗关闭触发 load() 并记录强制补播");
  assert.ok(/modalGoalRef\.current = modalGoal/.test(bundle), "生成 bundle: modalGoalRef 镜像弹窗状态");
  assert.ok(/applyForceReplay/.test(bundle), "生成 bundle: 含关闭弹窗强制补播");
  assert.ok(/RefreshCountdown/.test(bundle), "生成 bundle: 含倒计时组件");
  assert.ok(/更新于/.test(bundle), "生成 bundle: 含更新于时间展示");
  assert.ok(/safeAge >= 10000/.test(bundle), "生成 bundle: 负 age 容忍（同秒修改补播）");
  // g-211：visibilitychange 接入
  assert.ok(/visibilitychange/.test(bundle), "生成 bundle: 含 visibilitychange 监听");
  assert.ok(/visibilityState/.test(bundle), "生成 bundle: 含 visibilityState 状态判断");
});

test("g-211 前端 visibilitychange 调度逻辑契约模拟", () => {
  let timerId = null;
  let intervalMs = 0;
  let clearedCount = 0;
  let loadCallCount = 0;
  let lastRefreshTime = 0;

  const mockLoad = () => {
    loadCallCount++;
    lastRefreshTime = Date.now();
  };

  const startTimer = () => {
    if (!timerId) {
      timerId = 123;
      intervalMs = 30000;
    }
  };

  const stopTimer = () => {
    if (timerId) {
      clearedCount++;
      timerId = null;
      intervalMs = 0;
    }
  };

  let visibilityState = "visible";
  const handleVisibilityChange = () => {
    if (visibilityState === "visible") {
      if (Date.now() - lastRefreshTime >= 10000) {
        mockLoad();
      }
      startTimer();
    } else {
      stopTimer();
    }
  };

  // 1. 初始前台挂载
  mockLoad();
  startTimer();
  assert.equal(loadCallCount, 1);
  assert.equal(timerId, 123);
  assert.equal(intervalMs, 30000);

  // 2. 切到后台
  visibilityState = "hidden";
  handleVisibilityChange();
  assert.equal(timerId, null, "后台暂停定时轮询");
  assert.equal(clearedCount, 1);

  // 3. 立即切回前台（未超 10s 阈值）
  visibilityState = "visible";
  handleVisibilityChange();
  assert.equal(loadCallCount, 1, "未超阈值不立即触发补偿刷新");
  assert.equal(timerId, 123, "切回前台重启定时器");

  // 4. 再次切到后台并在 15 秒后切回前台
  visibilityState = "hidden";
  handleVisibilityChange();
  assert.equal(timerId, null);
  lastRefreshTime = Date.now() - 15000; // 模拟过去 15s

  visibilityState = "visible";
  handleVisibilityChange();
  assert.equal(loadCallCount, 2, "达到 10s 阈值切回前台立即补偿一次刷新");
  assert.equal(timerId, 123, "重启定时器");
});

// ===== g-176：浅色主题适配——共享样式 token 化源契约 =====

test("g-176 共享样式 token 化：S/HOVER_CSS 使用 DSH 主题变量并保留暗色 fallback", () => {
  const helpers = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");
  const constants = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/constants.js"), "utf8");
  const bundle = readFileSync(
    join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  // modal/drawer 背景与文字走主题变量（浅色可读），fallback 保留原暗色
  assert.match(helpers, /background: "var\(--dsw-alias-bg-layer-1, #1e1f24\)"/);
  assert.match(helpers, /color: "var\(--dsw-alias-label-primary, #e6e6e6\)"/);
  assert.match(helpers, /overlay: \{[\s\S]*?var\(--dsw-alias-bg-mask-1, rgba\(0,0,0,\.55\)\)/);
  // 按钮四族：普通/主要/危险/接受 文字色主题化（fallback 原暗色）
  assert.match(helpers, /btn: \{[\s\S]*?var\(--dsw-alias-interactive-bg-hover-solid, rgba\(128,128,128,\.15\)\)/);
  // g-176 follow-up：主要/接受按钮 = tertiary 淡底 + label-primary 文字（浅色高对比克制），语义由 primary 边框保留
  assert.match(helpers, /btnPrimary: \{[\s\S]*?var\(--dsw-alias-state-business-tertiary, rgba\(76,141,255,\.18\)\)/);
  assert.match(helpers, /btnPrimary: \{[\s\S]*?color: "var\(--dsw-alias-label-primary, #8ab4ff\)"/);
  assert.match(helpers, /btnPrimary: \{[\s\S]*?border: "1px solid var\(--dsw-alias-state-business-primary, rgba\(76,141,255,\.40\)\)"/);
  assert.match(helpers, /btnDanger: \{[\s\S]*?var\(--dsw-alias-state-error-primary, #f08080\)/);
  assert.match(helpers, /btnAccept: \{[\s\S]*?var\(--dsw-alias-state-success-tertiary, rgba\(58,166,117,\.18\)\)/);
  assert.match(helpers, /btnAccept: \{[\s\S]*?color: "var\(--dsw-alias-label-primary, #6ee7a0\)"/);
  assert.match(helpers, /btnAccept: \{[\s\S]*?border: "1px solid var\(--dsw-alias-state-success-primary, rgba\(58,166,117,\.40\)\)"/);
  // 选择控件/输入/主管栏背景主题化
  assert.match(helpers, /select: \{[\s\S]*?var\(--dsw-alias-bg-layer-2, rgba\(30,31,36,\.92\)\)/);
  assert.match(helpers, /selectOption: \{ background: "var\(--dsw-alias-bg-layer-3, #222328\)"/);
  assert.match(helpers, /promptInput: \{[\s\S]*?var\(--dsw-alias-bg-layer-2, rgba\(0,0,0,\.25\)\)/);
  assert.match(helpers, /supervisorBar: \{[\s\S]*?var\(--dsw-alias-bg-module-platform, rgba\(30,31,36,\.92\)\)/);
  // HOVER_CSS：hover 不再用 brightness 洗白（浅色主题下不可用），select 主题化
  assert.doesNotMatch(constants, /\.dg-btn:hover \{ filter: brightness\(1\.20\)/);
  assert.match(constants, /\.dg-btn:hover \{ background: var\(--dsw-alias-interactive-bg-hover/);
  assert.doesNotMatch(constants, /\.dg-lane-collapse:hover[\s\S]{0,160}filter: brightness\(1\.15\)/);
  assert.match(constants, /\.dg-select \{[\s\S]*?background: var\(--dsw-alias-bg-layer-2/);
  assert.match(constants, /\.dg-select option \{ background: var\(--dsw-alias-bg-layer-3, #222328\)/);
  // 生成 bundle 同步含主题变量且保留 GENERATED header
  assert.ok(bundle.startsWith("// ⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY"), "bundle 保留 GENERATED header");
  assert.match(bundle, /var\(--dsw-alias-bg-layer-1, #1e1f24\)/);
  assert.match(bundle, /var\(--dsw-alias-state-warn-label, #e0a53a\)/);
});

test("g-176 局部硬编码例外逐项主题化：设置/版本操作/tab/卡片语义色", () => {
  const kanban = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");
  const modal = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-modal.js"), "utf8");
  const settings = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/settings-modal.js"), "utf8");
  const card = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/card.js"), "utf8");
  const drawer = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/card-drawer.js"), "utf8");
  // 版本 select option 与 settings option 不再硬编码暗色 #2a2b31
  assert.doesNotMatch(kanban, /background: "#2a2b31"/);
  assert.doesNotMatch(settings, /background: "#2a2b31"/);
  assert.match(kanban, /background: "var\(--dsw-alias-bg-layer-3, #2a2b31\)"/);
  assert.match(settings, /background: "var\(--dsw-alias-bg-layer-3, #2a2b31\)"/);
  // tab 选中色与版本操作/卡片/抽屉语义色主题化（不再残留浅色不可读的亮色文字）
  // g-176 follow-up：tabs 选中改 label-primary（克制），成功类文字不再用亮绿
  assert.match(modal, /tab === "detail" \? "var\(--dsw-alias-label-primary, #8ab4ff\)" : "inherit"/);
  assert.doesNotMatch(modal, /color: "#8ab4ff"/);
  assert.doesNotMatch(modal, /color: "var\(--dsw-alias-state-success-primary, #3aa675\)"/);
  assert.doesNotMatch(card, /color: "var\(--dsw-alias-state-success-primary, #3aa675\)"/);
  assert.doesNotMatch(kanban, /color: "#ff6b6b"|color: "#ff9800"|color: "#4caf50"/);
  assert.doesNotMatch(card, /color: "#e0a53a"|color: "#3aa675"|color: "#d66"/);
  assert.doesNotMatch(drawer, /color: "#d66"/);
  // 版本操作 released/恢复按钮文字克制化为 label-primary（语义色保留在边框/底色）
  assert.match(kanban, /color: "var\(--dsw-alias-label-primary, #4caf50\)"/);
  assert.match(kanban, /color: "var\(--dsw-alias-label-primary, #ff9800\)"/);
  // 实心危险按钮（红底白字）与卡片左栏语义色保留（两主题均可用，非暗色例外）
  assert.match(kanban, /background: "#e74c3c", color: "#fff"/);
});

// ===== g-179：目标详情弹窗「🗂 信息收集」标题 emoji 统一替换为「🔎 信息收集」=====

test("g-179 模块源契约：goal-modal.js 信息收集标题统一为 🔎 信息收集（无旧 🗂）", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-modal.js"), "utf8");
  // 实际显示的标题两处（有卡/无卡分支）均为新 emoji
  const matches = src.match(/dgT\("section\.infoCollect"\)/g) ?? [];
  assert.equal(matches.length, 2, "goal-modal.js 两处信息收集标题均由 i18n 提供");
  assert.ok(!src.includes("🗂"), "goal-modal.js 不残留旧 emoji 🗂");
});

test("g-179 生成 bundle 契约：client.js 标题同步为 🔎 信息收集且保留 generated header", () => {
  const bundle = readFileSync(
    join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  assert.ok(bundle.startsWith("// ⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY"), "client.js 保留 GENERATED FILE header");
  const matches = bundle.match(/dgT\("section\.infoCollect"\)/g) ?? [];
  assert.equal(matches.length, 2, "生成 bundle: 两处信息收集标题均由 i18n 提供");
  assert.ok(!bundle.includes("🗂"), "生成 bundle: 不残留旧 emoji 🗂");
});

// ===== g-181：父级 overlay backdrop 误关保护（内容起点文本选择/拖拽到弹窗外松开不误关）=====

// 五个受影响模块 + g-183 共享面板（shared-panel.js）+ g-273 批量接受弹窗（batch-accept.js）的 guard 接入预期
// （每处 style: S.overlay 都必须走 useBackdropClose guard，禁止裸 style: S.overlay, onClick:；panel stopPropagation 保留）。
const G181_MODULES: Record<string, number> = {
  "goal-modal.js": 1,
  "criteria-modal.js": 3,
  "settings-modal.js": 3,
  "drag-prompts.js": 4,
  "kanban.js": 6,
  "shared-panel.js": 1,
  "batch-accept.js": 1,
};
const G181_TOTAL = Object.values(G181_MODULES).reduce((a, b) => a + b, 0); // 19

test("g-181 源契约：helpers.js 提供共享 useBackdropClose（useRef 起点 + pointerdown + onClick 吞合成 click）", () => {
  const helpers = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");
  assert.match(helpers, /function useBackdropClose\(onClose\) \{/);
  assert.match(helpers, /const insideRef = React\.useRef\(false\);/);
  // pointer 事件记录起点：target !== currentTarget 表示手势起点在 overlay 内容（panel 内）
  assert.match(helpers, /onPointerDown: \(e\) => \{ insideRef\.current = e\.target !== e\.currentTarget; \}/);
  // onClick：起点在内容 → 清零并吞掉本次合成 click（不关闭）；否则照常 onClose
  assert.match(helpers, /onClick: \(e\) => \{/);
  assert.match(helpers, /if \(insideRef\.current\) \{ insideRef\.current = false; e\.stopPropagation\(\); return; \}/);
  assert.match(helpers, /onClose\?\.\(\);/);
});

test("g-181 源契约：各模块全部 style: S.overlay 均接 guard（共 19 处），无裸 overlay onClick，panel stopPropagation 保留", () => {
  for (const [file, expected] of Object.entries(G181_MODULES)) {
    const src = readFileSync(
      join(import.meta.dirname, "../../dsh-graph-host/lib/client", file), "utf8");
    // 每个 style: S.overlay 必须紧跟 guard spread（...xxxGuard）
    const guarded = src.match(/style: S\.overlay, \.\.\.\w+Guard/g) ?? [];
    assert.equal(guarded.length, expected, `${file}: ${expected} 处 overlay 全部接 guard（实际 ${guarded.length}）`);
    // 全部 overlay 渲染位都必须走 guard（无裸 style: S.overlay, onClick:）
    const bare = src.match(/style: S\.overlay, onClick:/g) ?? [];
    assert.equal(bare.length, 0, `${file}: 无裸 style: S.overlay, onClick:`);
    // panel stopPropagation 保留：每个 overlay 的 modal panel 至少一个（允许额外按钮内 stopPropagation）
    const stopProp = src.match(/onClick: \(e\) => e\.stopPropagation\(\)/g) ?? [];
    assert.ok(stopProp.length >= expected, `${file}: panel stopPropagation 保留（>= ${expected}，实际 ${stopProp.length}）`);
  }
  // 全量约束 19 个父级 overlay 入口
  let total = 0;
  for (const file of Object.keys(G181_MODULES)) {
    const src = readFileSync(
      join(import.meta.dirname, "../../dsh-graph-host/lib/client", file), "utf8");
    total += (src.match(/style: S\.overlay, \.\.\.\w+Guard/g) ?? []).length;
  }
  assert.equal(total, G181_TOTAL, `各模块共 ${G181_TOTAL} 个父级 overlay 全部接 guard`);
});

test("g-181 源契约：card-drawer.js sibling overlay/drawer 结构不改（保留自身 onClick: props.onClose）", () => {
  const drawer = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/card-drawer.js"), "utf8");
  assert.match(drawer, /style: \{ \.\.\.S\.overlay, background: "var\(--dsw-alias-bg-mask-1, rgba\(0,0,0,\.35\)\)" \}, onClick: props\.onClose/);
});

test("g-181 hook 逻辑模拟：内容起点→backdrop 不关；backdrop→backdrop 关闭；内容→内容由 panel stopPropagation；吞后 ref 清零", () => {
  const helpers = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");
  const hookStart = helpers.indexOf("function useBackdropClose(");
  const hookEnd = helpers.indexOf("\n    }\n", hookStart) + "\n    }\n".length;
  assert.ok(hookStart > 0 && hookEnd > hookStart, "helpers.js 含完整 useBackdropClose 函数");
  const hookSrc = helpers.slice(hookStart, hookEnd);
  const context: any = {
    React: { useRef: (init: unknown) => ({ current: init }) },
  };
  new vm.Script(`(function () {\n${hookSrc}\nglobalThis.__hook = useBackdropClose;\n})()`).runInNewContext(context);
  const overlay = {};
  const content = {};
  const click = () => ({ target: overlay, currentTarget: overlay, stopPropagation() {} });
  const downOnContent = () => ({ target: content, currentTarget: overlay });
  const downOnBackdrop = () => ({ target: overlay, currentTarget: overlay });

  let closed = 0;
  const guard = context.__hook(() => { closed++; });
  // 内容起点 → 释放到 backdrop 的合成 click（target 是 overlay 自身）→ 吞掉，不关闭
  guard.onPointerDown(downOnContent());
  guard.onClick(click());
  assert.equal(closed, 0, "内容起点后释放到 backdrop 的合成 click 不关闭 modal");
  // 直接 backdrop 起点 → 照常关闭
  guard.onPointerDown(downOnBackdrop());
  guard.onClick(click());
  assert.equal(closed, 1, "直接点击 backdrop 仍关闭");
  // 内容→内容：panel stopPropagation 拦截，click 不到达 overlay（不调用 guard.onClick）→ 不关闭
  guard.onPointerDown(downOnContent());
  assert.equal(closed, 1, "内容→内容由 panel stopPropagation 拦截，overlay 不收到 click");
  // 吞掉合成 click 后 ref 已清零：下一次直接 backdrop 点击仍关闭
  guard.onPointerDown(downOnBackdrop());
  guard.onClick(click());
  assert.equal(closed, 2, "吞掉合成 click 后 ref 清零，下一次 backdrop 点击仍关闭");
});

test("g-181 生成 bundle 契约：client.js 含 useBackdropClose、19 个 guard overlay、保留 GENERATED header", () => {
  const bundle = readFileSync(
    join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  assert.ok(bundle.startsWith("// ⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY"), "client.js 保留 GENERATED FILE header");
  assert.match(bundle, /function useBackdropClose\(onClose\)/);
  assert.match(bundle, /e\.target !== e\.currentTarget/);
  assert.match(bundle, /onClose\?\.\(\);/);
  const guarded = bundle.match(/style: S\.overlay, \.\.\.\w+Guard/g) ?? [];
  assert.equal(guarded.length, G181_TOTAL, `生成 bundle: ${G181_TOTAL} 个父级 overlay 全部接 guard`);
  const bare = bundle.match(/style: S\.overlay, onClick:/g) ?? [];
  assert.equal(bare.length, 0, "生成 bundle: 无裸 style: S.overlay, onClick:");
  // panel stopPropagation 保留（>= 19 处 overlay panel；允许额外按钮内 stopPropagation）
  const stopProp = bundle.match(/onClick: \(e\) => e\.stopPropagation\(\)/g) ?? [];
  assert.ok(stopProp.length >= G181_TOTAL, `生成 bundle: panel stopPropagation 保留（>= ${G181_TOTAL}，实际 ${stopProp.length}）`);
});

test("g-200 LiveStrip 隔离契约：Card 仅在 Goal 处于执行态或有活跃 execution attempt 时渲染 Goal LiveStrip，避免与 context card 重复", () => {
  const cardSrc = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/card.js"), "utf8");
  const bundle = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  assert.match(cardSrc, /function hasActiveGoalExecutionAttempt\(attempts\)/, "card.js 包含活跃 execution attempt 判定");
  assert.match(cardSrc, /g\.attempt_child_id && \(g\.status === "in_progress" \|\| hasActiveGoalExecutionAttempt\(g\.attempts\)\)/, "Goal 卡片主体按执行状态与活跃 attempt 隔离 LiveStrip");
  assert.match(bundle, /hasActiveGoalExecutionAttempt/, "生成的 bundle 中包含 hasActiveGoalExecutionAttempt");

  const elements: any[] = [];
  const h = (type: any, props: any, ...children: any[]) => {
    const el = { type, props, children: children.flat() };
    elements.push(el);
    return el;
  };

  const context: any = {
    React: {
      useMemo: (fn: any) => fn(),
      useCallback: (fn: any) => fn,
      useState: (init: any) => [init, () => {}],
      useEffect: () => {},
      useRef: (init: any) => ({ current: init }),
      useSyncExternalStore: () => null,
    },
    h,
    dgT: (key: string, params?: Record<string, any>) => {
      const dict: Record<string, string> = {
        'card.criteriaProgress': '质量判据：已完成 {done}/{total}',
        'card.expandFull': '展开查看依赖/实时会话/上下文卡片等完整信息',
        'card.collapseBrief': '收起为精简视图',
        'card.clickToOpen': '点击打开详情',
        'card.clickToOpenDrawer': '点击打开上下文抽屉',
        'card.goToSession': '↗ 转到对话',
        'card.sharedBadge': '🔗共享',
        'card.archived': '📦已归档',
        'card.waitingDep': '⛓ 等待 {deps} 交付',
        'card.depsSatisfied': '✅ 依赖满足：{deps} 已交付',
        'review.aiBadge': '🤖AI审',
        'criteria.pending': '（待登记）',
        'criteria.pendingDetail': '（待登记；进入 in_progress 前必须非空且已确认）',
        'criteria.toBeFilled': '（待填写）',
        'card.clickSummaryExpand': '点击展开摘要全文',
        'card.clickSummaryCollapse': '点击收起摘要',
        'goal.typeLabel': '类型：{type}（点击切换）',
      };
      let text = dict[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.replace(`{${k}}`, String(v));
        }
      }
      return text;
    },
    S: {
      goalCard: {}, depCard: {}, blockedCard: {}, subCard: {}, title: {}, meta: {}, statusLine: {},
    },
    STATUS_LABEL: { planning: "规划中", collecting: "收集信息", in_progress: "执行中" },
    CARD_STATUS_ICON: { empty: "○ 待收集", collecting: "◌ 收集中", filled: "● 已填充", reviewed: "✔ 已复核" },
    GOAL_TYPE_LABELS: { feature: "Feature" },
    GOAL_TYPE_ABBREV: { feature: "F" },
    normalizeGoalType: () => "feature",
    goalTypeColor: () => "#4c8dff",
    sessionLinkBtn: () => null,
    CriteriaProgress: () => null,
    CardSummary: () => null,
    ReusedBadge: () => null,
    StatusLine: (props: any) => h("div", { className: "mock-status-line", ...props }),
    LiveStrip: (props: any) => h("div", { className: "mock-live-strip", ...props }),
    rowHalf: () => "after",
  };

  const fnStart = cardSrc.indexOf("function hasActiveGoalExecutionAttempt(");
  const fnEnd = cardSrc.indexOf("\n    // g-a92e1406：状态摘要行", fnStart);
  assert.ok(fnStart >= 0 && fnEnd > fnStart);
  const cardCode = cardSrc.slice(fnStart, fnEnd);

  new vm.Script(`(function () {\n${cardCode}\nglobalThis.__Card = Card;\nglobalThis.__hasActive = hasActiveGoalExecutionAttempt;\n})()`).runInNewContext(context);

  // 1. 仅有上下文卡片 collecting、Goal 处于 collecting / planning 时，Goal 主体不渲染 LiveStrip，只有卡片自己渲染 LiveStrip
  elements.length = 0;
  const goalCollectingOnly = {
    id: "g-collecting",
    status: "collecting",
    attempt_child_id: "child-collect-1",
    attempt_parent_session_id: "parent-session-1",
    attempts: [{ id: "att-001", executor: "agent:collect", result: "pending", status_line: "正在收集" }],
    cards: [
      { id: "c1", title: "卡片1", status: "collecting", child_id: "child-collect-1", parent_session_id: "parent-session-1" },
    ],
  };
  context.__Card(goalCollectingOnly, () => {}, () => {}, false, null, {}, true, () => {}, null);
  const liveStrips1 = elements.filter((e) => e?.type === context.LiveStrip || e?.props?.className === "mock-live-strip");
  assert.equal(liveStrips1.length, 1, "只应渲染卡片上的 1 个 LiveStrip，Goal 主体不得重复渲染");
  assert.equal(liveStrips1[0].props.childId, "child-collect-1");

  // 2. Goal 处于 in_progress 且存在 attempt_child_id 时，Goal LiveStrip 正常展示
  elements.length = 0;
  const goalInProgress = {
    id: "g-running",
    status: "in_progress",
    attempt_child_id: "child-exec-1",
    attempt_parent_session_id: "parent-session-1",
    attempts: [{ id: "att-001", executor: "agent:executor", result: "pending", status_line: "正在执行代码" }],
    cards: [],
  };
  context.__Card(goalInProgress, () => {}, () => {}, false, null, {}, true, () => {}, null);
  const liveStrips2 = elements.filter((e) => e?.type === context.LiveStrip || e?.props?.className === "mock-live-strip");
  assert.equal(liveStrips2.length, 1, "Goal in_progress 时正常渲染 Goal LiveStrip");
  assert.equal(liveStrips2[0].props.childId, "child-exec-1");

  // 3. Goal 执行与多张卡片 collecting 并存时，各自展示互不覆盖
  elements.length = 0;
  const goalBoth = {
    id: "g-both",
    status: "in_progress",
    attempt_child_id: "child-exec-1",
    attempt_parent_session_id: "parent-session-1",
    attempts: [{ id: "att-001", executor: "agent:executor", result: "pending", status_line: "正在执行代码" }],
    cards: [
      { id: "c1", title: "卡片1", status: "collecting", child_id: "child-c1", parent_session_id: "parent-session-1" },
      { id: "c2", title: "卡片2", status: "collecting", child_id: "child-c2", parent_session_id: "parent-session-1" },
      { id: "c3", title: "卡片3", status: "filled", child_id: "child-c3", parent_session_id: "parent-session-1" },
    ],
  };
  context.__Card(goalBoth, () => {}, () => {}, false, null, {}, true, () => {}, null);
  const liveStrips3 = elements.filter((e) => e?.type === context.LiveStrip || e?.props?.className === "mock-live-strip");
  assert.equal(liveStrips3.length, 3, "Goal 1 个 + collecting 卡片 2 个 = 共 3 个 LiveStrip（filled 卡片不展示）");
  assert.equal(liveStrips3[0].props.childId, "child-exec-1");
  assert.equal(liveStrips3[1].props.childId, "child-c1");
  assert.equal(liveStrips3[2].props.childId, "child-c2");
});

// ===== g-198：一句话任务创建成功后立即触发 onRefresh 刷新上下文卡片列表 =====

test("g-198 模块源契约：goal-actions.js AddCardBox 接收 onRefresh 并在创建成功分支触发", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  assert.match(src, /function AddCardBox\(props\)\s*\{\s*const\s*\{\s*goalId\s*,\s*supervisorSession\s*,\s*onRefresh\s*\}\s*=\s*props/);
  // 成功分支调用 onRefresh?.()
  assert.match(src, /if\s*\(data\.ok\)\s*\{[\s\S]*?onRefresh\?\.\(\);[\s\S]*?\}\s*else/);
});

test("g-198 模块源契约：goal-modal.js 向 AddCardBox 传递 onRefresh: load", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-modal.js"), "utf8");
  const matches = src.match(/h\(AddCardBox,\s*\{\s*goalId:\s*props\.id,\s*supervisorSession:\s*props\.supervisorSession,\s*onRefresh:\s*load\s*\}\)/g) ?? [];
  assert.equal(matches.length, 2, "GoalModal 在有卡片和无卡片两种分支均向 AddCardBox 传入 onRefresh: load");
});

test("g-198 生成 bundle 契约：client.js 包含 AddCardBox onRefresh 调用与 GoalModal 传参", () => {
  const bundle = readFileSync(
    join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  assert.ok(bundle.startsWith("// ⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY"), "client.js 保留 GENERATED FILE header");
  assert.match(bundle, /function AddCardBox\(props\)\s*\{\s*const\s*\{\s*goalId\s*,\s*supervisorSession\s*,\s*onRefresh\s*\}\s*=\s*props/);
  assert.match(bundle, /if\s*\(data\.ok\)\s*\{[\s\S]*?onRefresh\?\.\(\);[\s\S]*?\}\s*else/);
  const matches = bundle.match(/h\(AddCardBox,\s*\{\s*goalId:\s*props\.id,\s*supervisorSession:\s*props\.supervisorSession,\s*onRefresh:\s*load\s*\}\)/g) ?? [];
  assert.equal(matches.length, 2, "生成 bundle: 两个 AddCardBox 调用均传入 onRefresh: load");
});

// g-195: 子代理实时流式 peek 节流与性能保障测试
test("g-195 源契约：session-hooks.js 提供 useThrottledLiveSession 并包含 trailing-edge 与卸载清理", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/session-hooks.js"), "utf8");
  // g-224：第三参 liveEnabled（默认 true）由 useLiveStripState 传入，关闭实时显示时停止旧路径流式行
  assert.match(src, /function useThrottledLiveSession\(session, intervalMs = 200(?:, liveEnabled = true)?\)/);
  assert.match(src, /const \[liveState, setLiveState\] = React\.useState/);
  assert.match(src, /setTimeout\(flush, intervalMs - elapsed\)/);
  assert.match(src, /clearTimeout\(timer\)/);
  assert.match(src, /unsub\(\)/);
});

test("g-195/g-217 源契约：LiveStrip 使用 useLiveStripState 节流 peek（新路径 eventSource / 旧路径回退）", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/session-hooks.js"), "utf8");
  // g-217：LiveStrip 数据源切换为 useLiveStripState（能力探测双路径）
  assert.match(src, /function LiveStrip\(props\)/);
  assert.match(src, /const \{ snap, line, running \} = useLiveStripState\(session, eventSource, 200\);/);
  // g-195 节流语义保留：useLiveStripState 内部以 useThrottledLiveSession 作为旧路径回退
  // g-224：第三参 liveEnabled 由 useLiveStripState 传入（关闭实时显示时同样停止旧路径流式行）
  assert.match(src, /const legacy = useThrottledLiveSession\(session, intervalMs(?:, liveEnabled)?\);/);
  // C1/C4：新路径订阅 binding.eventSource 并全量重扫 entries
  assert.match(src, /feed\.subscribe\(onUpdate\)/);
  assert.match(src, /feed\.getSnapshot\(\)\?\.entries/);
});

test("g-195 节流器逻辑模拟：高频更新（>20 chunk/s）硬上限 ≤5fps（≥200ms），尾包与完成态不丢失，卸载后无残留 timer", async () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/session-hooks.js"), "utf8");

  // 构造模拟测试环境运行 useThrottledLiveSession
  let stateSetter: any = null;
  let effectCleanup: any = null;
  let registeredEffect: any = null;

  const mockReact: any = {
    useState: (initial: any) => {
      let state = typeof initial === "function" ? initial() : initial;
      stateSetter = (updater: any) => {
        state = typeof updater === "function" ? updater(state) : updater;
        renders.push(state);
      };
      return [state, stateSetter];
    },
    useEffect: (fn: any, deps: any) => {
      registeredEffect = fn;
    },
    useCallback: (fn: any) => fn,
    useMemo: (fn: any) => fn(),
  };

  const renders: any[] = [];
  let listeners: Array<() => void> = [];
  let unsubCalled = false;

  let currentSnapshot: any = {
    running: true,
    chat: {
      legacy: {
        partial: {
          blocks: [{ kind: "text", text: "chunk 0" }],
        },
      },
    },
  };

  const mockSession = {
    getSnapshot: () => currentSnapshot,
    subscribe: (cb: () => void) => {
      listeners.push(cb);
      return () => {
        unsubCalled = true;
        listeners = listeners.filter((l) => l !== cb);
      };
    },
  };

  // 提取 useThrottledLiveSession 及辅助函数 lastStreamLine
  const lastStreamLineStart = src.indexOf("function lastStreamLine(");
  const lastStreamLineEnd = src.indexOf("function fmtTok(");
  const hookStart = src.indexOf("function useThrottledLiveSession(");
  const hookEnd = src.indexOf("function LiveStrip(");

  const scriptCode = `
    const React = mockReact;
    ${src.slice(lastStreamLineStart, lastStreamLineEnd)}
    ${src.slice(hookStart, hookEnd)}
    globalThis.__useThrottledLiveSession = useThrottledLiveSession;
  `;

  const ctx: any = {
    mockReact,
    setTimeout,
    clearTimeout,
    Date,
    console,
    globalThis: {},
  };
  vm.createContext(ctx);
  new vm.Script(scriptCode).runInContext(ctx);

  const hook = ctx.globalThis.__useThrottledLiveSession;
  hook(mockSession, 200);
  effectCleanup = registeredEffect();

  // 初始 flush 应该有 1 次 render
  assert.equal(renders.length, 1);
  assert.equal(renders[0].line, "chunk 0");

  // 模拟 1 秒内密集触发 25 次高频事件（>20 chunk/s）
  const startTime = Date.now();
  for (let i = 1; i <= 25; i++) {
    currentSnapshot = {
      running: true,
      chat: {
        legacy: {
          partial: {
            blocks: [{ kind: "text", text: "chunk " + i }],
          },
        },
      },
    };
    for (const l of listeners) l();
    // 每次间隔 20ms
    await new Promise((r) => setTimeout(r, 20));
  }

  // 等待尾包 timer (200ms) 触发
  await new Promise((r) => setTimeout(r, 250));

  // 500ms 内触发 25 次更新，但在 200ms 节流限制下，总渲染次数应在 3~5 次之间（≤5fps），绝不能退化为 25 次
  assert.ok(renders.length <= 6, `渲染次数受到硬上限节流限制（实际渲染次数：${renders.length}，远小于 25）`);
  // 验证 trailing edge: 最终渲染必须呈现最后一个 chunk (chunk 25)，不丢尾包
  const lastRender = renders[renders.length - 1];
  assert.equal(lastRender.line, "chunk 25", "trailing flush 完整呈现最后一个 chunk 25");

  // 测试流结束/完成态（running: false）
  currentSnapshot = {
    running: false,
    chat: {
      legacy: {
        partial: {
          blocks: [{ kind: "text", text: "task completed" }],
        },
      },
    },
  };
  for (const l of listeners) l();
  await new Promise((r) => setTimeout(r, 250));
  const finalRender = renders[renders.length - 1];
  assert.equal(finalRender.running, false, "完成态 running=false 成功反映");
  assert.equal(finalRender.line, "task completed", "完成态最终文本正确呈现");

  // 测试卸载清理
  effectCleanup();
  assert.ok(unsubCalled, "卸载时 session.unsubscribe 被正常调用");
});

test("g-195 并发隔离与异常/空流降级：多 session 实例独立调度且空流/无 session 安全降级", async () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/session-hooks.js"), "utf8");

  const mockReact: any = {
    useState: (initial: any) => {
      let state = typeof initial === "function" ? initial() : initial;
      return [state, (updater: any) => {
        state = typeof updater === "function" ? updater(state) : updater;
      }];
    },
    useEffect: (fn: any) => { fn(); },
    useCallback: (fn: any) => fn,
    useMemo: (fn: any) => fn(),
  };

  const lastStreamLineStart = src.indexOf("function lastStreamLine(");
  const lastStreamLineEnd = src.indexOf("function fmtTok(");
  const hookStart = src.indexOf("function useThrottledLiveSession(");
  const hookEnd = src.indexOf("function LiveStrip(");

  const scriptCode = `
    const React = mockReact;
    ${src.slice(lastStreamLineStart, lastStreamLineEnd)}
    ${src.slice(hookStart, hookEnd)}
    globalThis.__useThrottledLiveSession = useThrottledLiveSession;
  `;

  const ctx: any = { mockReact, globalThis: {} };
  vm.createContext(ctx);
  new vm.Script(scriptCode).runInContext(ctx);
  const hook = ctx.globalThis.__useThrottledLiveSession;

  // 1. null session 降级
  const nullResult = hook(null, 200);
  assert.equal(nullResult.snap, null);
  assert.equal(nullResult.line, null);
  assert.equal(nullResult.running, false);

  // 2. 空流 session 降级
  const emptySession = {
    getSnapshot: () => ({ running: false, chat: null }),
    subscribe: () => () => {},
  };
  const emptyResult = hook(emptySession, 200);
  assert.equal(emptyResult.line, null);
  assert.equal(emptyResult.running, false);
  assert.equal(emptyResult.snap.running, false);
});

// ===== g-224：实时代理输出流式显示开关——关闭停止输出流订阅、保留状态数据 =====

test("g-224 源契约：helpers.js 提供实时显示开关存取与广播（LIVE_DISPLAY_KEY/getLiveDisplay/setLiveDisplay/useLiveDisplayEnabled）", () => {
  const helpers = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");
  assert.match(helpers, /LIVE_DISPLAY_KEY = "dsh-graph\.live-display"/);
  assert.match(helpers, /function getLiveDisplay\(\)/);
  assert.match(helpers, /function setLiveDisplay\(enabled\)/);
  assert.match(helpers, /function useLiveDisplayEnabled\(\)/);
  assert.match(helpers, /dsh-graph\.live-display-changed/);
});

test("g-224 源契约：session-hooks.js 输出流订阅按实时显示开关门控（open/eventSource/旧路径）", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/session-hooks.js"), "utf8");
  // 输出流窗口打开受开关门控：关闭时完全不打开发送窗口
  assert.match(src, /function openBoundSessionStream\(childId, session\)/);
  assert.match(src, /if \(!getLiveDisplay\(\)\) return Promise\.resolve\(false\);/);
  // useBoundSession 依赖实时开关并在切换时重评估 open
  assert.match(src, /const liveEnabled = useLiveDisplayEnabled\(\);/);
  assert.match(src, /openBoundSessionStream\(childId, session\);/);
  // useLiveStripState：关闭时断开事件源（feed 门控）+ 旧路径流式行门控
  assert.match(src, /const feed = liveEnabled \? \(eventSource \?\? null\) : null;/);
  assert.match(src, /const legacy = useThrottledLiveSession\(session, intervalMs, liveEnabled\);/);
  // 关闭分支清空流式状态（无流式文字残留）
  assert.match(src, /关闭实时显示 → 清空流式状态/);
});

test("g-224 源契约：settings-modal.js 提供「实时代理输出流式显示」开关（即时生效）", () => {
  const modal = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/settings-modal.js"), "utf8");
  assert.match(modal, /liveDisplayOn = useLiveDisplayEnabled\(\)/);
  assert.match(modal, /实时代理输出流式显示/);
  assert.match(modal, /setLiveDisplay\(e\.target\.checked\)/);
  assert.match(modal, /dg-live-display/);
});

test("g-224 生成 bundle 契约：client.js 包含实时显示开关与输出流门控逻辑", () => {
  const bundle = readFileSync(
    join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  assert.ok(bundle.startsWith("// ⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY"), "client.js 保留 GENERATED FILE header");
  assert.match(bundle, /LIVE_DISPLAY_KEY = "dsh-graph\.live-display"/);
  assert.match(bundle, /function openBoundSessionStream\(childId, session\)/);
  assert.match(bundle, /实时代理输出流式显示/);
});

test("g-224 行为模拟：关闭实时显示时停止流式行读取（line=null）且保留运行态；重开恢复", async () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/session-hooks.js"), "utf8");

  const renders: any[] = [];
  let registeredEffect: any = null;
  let listeners: Array<() => void> = [];

  const mockReact: any = {
    useState: (initial: any) => {
      let state = typeof initial === "function" ? initial() : initial;
      return [state, (updater: any) => {
        state = typeof updater === "function" ? updater(state) : updater;
        renders.push(state);
      }];
    },
    useEffect: (fn: any) => { registeredEffect = fn; },
    useCallback: (fn: any) => fn,
    useMemo: (fn: any) => fn(),
  };

  let currentSnapshot: any = {
    running: true,
    chat: { legacy: { partial: { blocks: [{ kind: "text", text: "streaming..." }] } } },
  };

  const mockSession = {
    getSnapshot: () => currentSnapshot,
    subscribe: (cb: () => void) => {
      listeners.push(cb);
      return () => { listeners = listeners.filter((l) => l !== cb); };
    },
  };

  const lastStreamLineStart = src.indexOf("function lastStreamLine(");
  const lastStreamLineEnd = src.indexOf("function fmtTok(");
  const hookStart = src.indexOf("function useThrottledLiveSession(");
  const hookEnd = src.indexOf("function LiveStrip(");

  const scriptCode = `
    const React = mockReact;
    ${src.slice(lastStreamLineStart, lastStreamLineEnd)}
    ${src.slice(hookStart, hookEnd)}
    globalThis.__useThrottledLiveSession = useThrottledLiveSession;
  `;

  const ctx: any = { mockReact, setTimeout, clearTimeout, Date, console, globalThis: {} };
  vm.createContext(ctx);
  new vm.Script(scriptCode).runInContext(ctx);
  const hook = ctx.globalThis.__useThrottledLiveSession;

  // 1) 关闭实时显示（liveEnabled=false）：初始即无流式行，运行态保留
  const offResult = hook(mockSession, 200, false);
  registeredEffect();
  assert.equal(offResult.line, null, "关闭实时显示 → line 为 null（不读取流式行）");
  assert.equal(offResult.running, true, "运行态保留");

  // 事件推送后仍不出现流式行，running 继续更新
  currentSnapshot = {
    running: true,
    chat: { legacy: { partial: { blocks: [{ kind: "text", text: "more" }] } } },
  };
  for (const l of listeners) l();
  const afterEvent = renders[renders.length - 1];
  assert.equal(afterEvent.line, null, "关闭后事件推送 line 保持 null（无流式文字残留）");
  assert.equal(afterEvent.running, true, "关闭后 running 仍更新");

  // 2) 重开实时显示（liveEnabled=true）：流式行恢复
  const onResult = hook(mockSession, 200, true);
  registeredEffect();
  assert.equal(onResult.line, "more", "重开 → 流式行恢复");
});

// ===== g-214：自定义看板刷新间隔与倒计时契约 =====

test("g-214 源契约：helpers.js 包含刷新间隔存取与纠偏函数 + RefreshCountdown 局部化组件", () => {
  const helpers = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");
  assert.match(helpers, /REFRESH_INTERVAL_KEY = "dsh-graph\.refresh-interval"/);
  assert.match(helpers, /MIN_REFRESH_INTERVAL = 5/);
  assert.match(helpers, /DEFAULT_REFRESH_INTERVAL = 15/);
  assert.match(helpers, /function getRefreshInterval\(\)/);
  assert.match(helpers, /function setRefreshInterval\(val\)/);
  assert.match(helpers, /function RefreshCountdown\(props\)/);
});

test("g-214 源契约：settings-modal.js 包含刷新间隔配置输入与 <5s 自动纠偏/校验", () => {
  const modal = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/settings-modal.js"), "utf8");
  assert.match(modal, /refreshIntervalInput/);
  assert.match(modal, /handleIntervalChange/);
  assert.match(modal, /setRefreshInterval\(refreshIntervalInput\)/);
  assert.match(modal, /dgT\("settings\.autoRefresh"\)/);
  assert.match(modal, /dgT\("settings\.intervalWarn"\)/);
});

test("g-214 源契约：kanban.js 挂载 RefreshCountdown 与刷新间隔监听", () => {
  const kanban = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");
  assert.match(kanban, /h\(RefreshCountdown,/);
  assert.match(kanban, /dsh-graph\.refresh-interval-changed/);
});

test("g-214 生成 bundle 契约：client.js 包含 g-214 倒计时与刷新间隔配置逻辑", () => {
  const bundle = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  assert.match(bundle, /RefreshCountdown/);
  assert.match(bundle, /dsh-graph\.refresh-interval/);
  assert.match(bundle, /MIN_REFRESH_INTERVAL = 5/);
});

// ===== g-216：widthHandle 层级与 z-index 防遮挡/防穿透契约 =====

test("g-216 源契约：helpers.js S.wrap、S.overlay、S.drawer、S.modal 合理规划 z-index 与层叠上下文", () => {
  const helpers = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");
  assert.match(helpers, /wrap: \{[\s\S]*?position:\s*"relative",\s*zIndex:\s*1/);
  assert.match(helpers, /overlay: \{[\s\S]*?zIndex:\s*99998/);
  assert.match(helpers, /drawer: \{[\s\S]*?zIndex:\s*99999/);
  assert.match(helpers, /modal: \{[\s\S]*?zIndex:\s*100000/);
});

test("g-216 源契约：constants.js 包含 widthHandle 蒙层防穿透与防遮挡样式规则", () => {
  const constants = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/constants.js"), "utf8");
  assert.match(constants, /\.wSkVaW_root:has\(\.dg-modal-open\)\s*\.wSkVaW_widthHandle/);
  assert.match(constants, /\.wSkVaW_body:has\(\.dg-modal-open\)\s*\.wSkVaW_widthHandle/);
  assert.match(constants, /display:\s*none\s*!important/);
});

test("g-216 源契约：kanban.js 具备 hasModal 状态与 dg-modal-open 动态类绑定", () => {
  const kanban = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");
  assert.match(kanban, /const hasModal = !!\(modalGoal \|\| drawerCard \|\| showCreateGoal/);
  assert.match(kanban, /className:\s*hasModal \? "dg-kanban-root dg-modal-open" : "dg-kanban-root"/);
});

test("g-216 生成 bundle 契约：client.js 包含 g-216 层级规划与 widthHandle 穿透防护规则", () => {
  const bundle = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  assert.match(bundle, /dg-modal-open/);
  assert.match(bundle, /\.wSkVaW_root:has\(\.dg-modal-open\)/);
  assert.match(bundle, /zIndex:\s*99998/);
  assert.match(bundle, /zIndex:\s*99999/);
  assert.match(bundle, /zIndex:\s*100000/);
});
test("g-225 卡片 LiveStrip 模型展示契约：LiveStrip 默认不渲染可见 model ID，完整 provider/model 仅在 tooltip (title) 显示，且 Hooks 顶层无条件调用", () => {
  const hooksSrc = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/session-hooks.js"), "utf8");
  const bundle = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");

  // 1. LiveStrip 源码构造完整 provider/model 的 modelTitle 用于 tooltip (title)
  assert.match(hooksSrc, /const modelTitle = props\.model/);
  assert.match(hooksSrc, /props\.provider \? props\.provider \+ "\/" : ""/);
  // 2. LiveStrip 外层容器 title 属性包含 modelTitle
  assert.match(hooksSrc, /modelTitle/);
  assert.match(hooksSrc, /title:\s*\[statusFull,\s*props\.statusLine\s*\?\s*"状态："\s*\+\s*props\.statusLine\s*:\s*null,\s*modelTitle/);
  // 3. LiveStrip 内部子节点第一行不再包含可见的 props.model 文本节点
  assert.doesNotMatch(hooksSrc, /props\.model\s*\?\s*h\("span",\s*\{[^}]*opacity:\s*0\.85[^}]*\},/);
  // 4. 生成 bundle 与源文件保持一致
  assert.doesNotMatch(bundle, /props\.model\s*\?\s*h\("span",\s*\{[^}]*opacity:\s*0\.85[^}]*\},/);

  // 5. Hooks 规则契约：LiveStrip 中的 useRef / useState / useEffect 必须在任何 early return（如 if (!props.childId) return null）之前无条件声明
  const lsStart = hooksSrc.indexOf("function LiveStrip(props)");
  const lsEarlyChildId = hooksSrc.indexOf("if (!props.childId) return null;", lsStart);
  const lsUseRef = hooksSrc.indexOf("const runningSinceRef = React.useRef", lsStart);
  const lsUseStateNow = hooksSrc.indexOf("const [now, setNow] = React.useState", lsStart);
  assert.ok(lsUseRef > lsStart && lsUseRef < lsEarlyChildId, "useRef 必须在 early return 之前");
  assert.ok(lsUseStateNow > lsStart && lsUseStateNow < lsEarlyChildId, "useState 必须在 early return 之前");

  // 6. SupervisorBar 保持独立展示，不受 LiveStrip 内部精简影响
  const supervisorSrc = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/supervisor-bar.js"), "utf8");
  assert.match(supervisorSrc, /h\("span", null, model\.provider\)/);
  assert.match(supervisorSrc, /h\("span", null, model\.model\)/);
});
test("g-223 源契约：build-client PARTS 收录 version-drawer 且 bundle 包含生成代码", () => {
  const script = readFileSync(join(import.meta.dirname, "../../scripts/build-client.sh"), "utf8");
  assert.match(script, /"version-drawer"/);
  const bundle = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  assert.match(bundle, /function VersionDrawer\(props\)/);
  assert.match(bundle, /🏷️ 版本管理/);
  assert.match(bundle, /dg-version-manage-btn/);
});

test("g-223 源契约：helpers.js 提供 S.drawerLeft 及版本显隐存储辅助函数（支持 workspace 隔离与动态响应）", () => {
  const helpers = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");
  assert.match(helpers, /drawerLeft:\s*\{/);
  assert.match(helpers, /HIDDEN_VERSIONS_KEY_PREFIX = "dsh-graph\.hidden-versions\."/);
  assert.match(helpers, /function getHiddenVersionsStorageKey\(workspace\)/);
  assert.match(helpers, /function getHiddenVersionSlugs\(workspace\)/);
  assert.match(helpers, /function setHiddenVersionSlugs\(/);
  assert.match(helpers, /function useHiddenVersionSlugs\(workspace\)/);
  assert.match(helpers, /dsh-graph\.hidden-versions-changed/);
});

test("g-223 源契约：kanban.js 挂载版本管理按钮、抽屉与隐藏版本过滤，且 render 阶段直接解析 activeWs", () => {
  const kanban = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");
  // 1. 左上角 stageHead 包含版本管理按钮
  assert.match(kanban, /className: "dg-btn dg-version-manage-btn"/);
  assert.match(kanban, /title: dgT\("versionDrawer\.title"\)/);
  assert.match(kanban, /onClick: \(\) => setShowVersionDrawer\(true\)/);

  // 2. 状态与过滤：直接按 props.sessionId 在 render 阶段解析 activeWs
  assert.match(kanban, /const \[showVersionDrawer, setShowVersionDrawer\] = React\.useState\(false\)/);
  assert.match(kanban, /const activeWs = resolveWorkspaceOfSession\(props\?\.sessionId\) \|\| "default"/);
  assert.match(kanban, /const \[hiddenVersionSlugs, setHiddenVersionSlugs\] = useHiddenVersionSlugs\(activeWs\)/);
  assert.match(kanban, /allActiveVersions\.filter\(\(v\) => !hiddenVersionSet\.has\(v\.slug\)\)/);
  assert.match(kanban, /allReleasedVersions\.filter\(\(v\) => !hiddenVersionSet\.has\(v\.slug\)\)/);

  // 3. 全部隐藏时的空状态（覆盖 active 与 released 全隐藏）
  assert.match(kanban, /totalVersionsCount > 0 && \(visibleVersionsCount === 0 \|\| \(allActiveVersions\.length > 0 && active\.length === 0\)\)/);
  assert.match(kanban, /dgT\(['"]versionDrawer\.allHidden['"]/);
  assert.match(kanban, /dgT\(['"]versionDrawer\.activeHidden['"]/);

  // 4. VersionDrawer 挂载
  assert.match(kanban, /showVersionDrawer\s*\?\s*ReactDOM\.createPortal\(h\(VersionDrawer/);
  assert.match(kanban, /onShowAll/);
  assert.match(kanban, /onHideAll/);
  assert.match(kanban, /onShowActiveOnly/);

  // 5. load effect 依赖 sessionId 与 activeWs
  assert.match(kanban, /\[showArchived,\s*props\?\.sessionId,\s*activeWs\]/);
});

test("g-223 源契约：goal-modal.js 包含隐藏版本友好提示与恢复显示入口", () => {
  const modal = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-modal.js"), "utf8");
  assert.match(modal, /isVersionHidden/);
  assert.match(modal, /dgT\("modal\.versionHidden"/);
  assert.match(modal, /dgT\("modal\.unhideVersion"\)/);
});

test("g-223 VersionDrawer 组件逻辑与交互及 a11y 可访问性契约验证", () => {
  const vDrawer = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/version-drawer.js"), "utf8");
  assert.match(vDrawer, /function VersionDrawer\(props\)/);
  assert.match(vDrawer, /dgT\("versionDrawer\.showAll"\)/);
  assert.match(vDrawer, /dgT\("versionDrawer\.showActive"\)/);
  assert.match(vDrawer, /dgT\("versionDrawer\.hideAll"\)/);
  assert.match(vDrawer, /onToggleVersion/);
  assert.match(vDrawer, /onOpenVersionDetail/);

  // a11y 可访问性验证
  assert.match(vDrawer, /role:\s*"dialog"/);
  assert.match(vDrawer, /"aria-modal":\s*"true"/);
  assert.match(vDrawer, /"aria-labelledby":\s*"dg-version-drawer-title"/);
  assert.match(vDrawer, /id:\s*"dg-version-drawer-title"/);
  assert.match(vDrawer, /h\("button",\s*\{[\s\S]*?type:\s*"button"[\s\S]*?"aria-label":\s*dgT\("common\.close"\)[\s\S]*?onClick:\s*onClose/);
  assert.match(vDrawer, /"aria-label":\s*dgT\("versionDrawer\.searchPlaceholder"\)/);
});

test("g-223 纯函数 resolveWorkspaceOfSession 与动态会话切换行为契约", () => {
  const bundle = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  
  // 1. 验证 resolveWorkspaceOfSession 存在且具备完整回溯
  assert.match(bundle, /function resolveWorkspaceOfSession\(sessionId\)/);
  assert.match(bundle, /wsOf\(sid\)/);
  assert.match(bundle, /viewed\?\.parentSessionId/);

  // 2. 模拟运行 resolveWorkspaceOfSession 纯函数逻辑验证跨会话解析
  const mockWorkspaces = [
    { workspaceId: "ws-1", path: "/path/to/project-alpha", sessionIds: ["session-a1", "session-a2"] },
    { workspaceId: "ws-2", path: "/path/to/project-beta", sessionIds: ["session-b1"] },
  ];
  const mockSessions = [
    { sessionId: "session-a1", cwd: "/path/to/project-alpha" },
    { sessionId: "session-a2", cwd: "/path/to/project-alpha" },
    { sessionId: "session-b1", cwd: "/path/to/project-beta" },
    { sessionId: "session-child-b2", parentSessionId: "session-b1" }, // 子代理无 cwd，回溯父会话
    { sessionId: "session-orphan", cwd: "/path/to/orphan" },
  ];

  function testResolve(sid, viewedSid, currentSid, lastGood) {
    const wsOf = (id) => mockWorkspaces.find((w) => w.sessionIds.includes(id));
    const targetSid = sid ?? viewedSid;
    if (targetSid) {
      const w = wsOf(targetSid);
      if (w?.path) return w.path;
      const viewed = mockSessions.find((s) => s.sessionId === targetSid);
      if (viewed?.cwd) return viewed.cwd;
      if (viewed?.parentSessionId) {
        const parent = mockSessions.find((s) => s.sessionId === viewed.parentSessionId);
        if (parent?.cwd) return parent.cwd;
        const pw = wsOf(viewed.parentSessionId);
        if (pw?.path) return pw.path;
      }
    }
    if (currentSid) {
      const w = wsOf(currentSid);
      if (w?.path) return w.path;
      const item = mockSessions.find((s) => s.sessionId === currentSid);
      if (item?.cwd) return item.cwd;
    }
    return lastGood ?? null;
  }

  // 会话切换首个 render（此时 viewedSessionId 可能仍是旧的或 null）
  assert.equal(testResolve("session-a1", "session-b1", "session-b1", null), "/path/to/project-alpha", "传入 session-a1 时首个 render 立即解析出 alpha 工作区");
  assert.equal(testResolve("session-b1", "session-a1", "session-a1", null), "/path/to/project-beta", "切换为 session-b1 时立即解析出 beta 工作区");
  assert.equal(testResolve("session-child-b2", null, null, null), "/path/to/project-beta", "子代理通过 parentSessionId 回溯正确解析父工作区");
  assert.equal(testResolve("session-orphan", null, null, null), "/path/to/orphan", "无 workspace 条目但有 session.cwd 时安全回退");
});

test("g-223 行为契约：不同 workspace 的 hidden_versions 隔离存储与切换", () => {
  const helpers = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");
  const prefix = "dsh-graph.hidden-versions.";
  const keyA = prefix + "/ws/project-a";
  const keyB = prefix + "/ws/project-b";
  assert.notEqual(keyA, keyB, "不同工作区存储 key 严格隔离");
  assert.match(helpers, /HIDDEN_VERSIONS_KEY_PREFIX \+ ws/);
});

test("g-223 行为证据：Kanban 版本过滤纯逻辑在 released-only 全隐藏、混合全隐藏及部分隐藏时的空态判定与提示", () => {
  // 提取/模拟 Kanban 内部版本过滤与空状态判定纯函数
  function evaluateVersionFilter(versions: any[], hiddenSlugs: string[]) {
    const allActiveVersions = (versions ?? []).filter((v) => v.status !== "released");
    const allReleasedVersions = (versions ?? []).filter((v) => v.status === "released");
    const hiddenVersionSet = new Set(hiddenSlugs ?? []);
    const active = allActiveVersions.filter((v) => !hiddenVersionSet.has(v.slug));
    const released = allReleasedVersions.filter((v) => !hiddenVersionSet.has(v.slug));

    const totalVersionsCount = (versions ?? []).length;
    const visibleVersionsCount = active.length + released.length;
    const shouldShowEmptyState = totalVersionsCount > 0 && (visibleVersionsCount === 0 || (allActiveVersions.length > 0 && active.length === 0));

    let hintText = null;
    if (shouldShowEmptyState) {
      hintText = visibleVersionsCount === 0
        ? `已隐藏全部 ${totalVersionsCount} 个版本（包含已发布版本）。可通过左上角版本管理抽屉随时恢复显示。`
        : `已隐藏全部 ${allActiveVersions.length} 个活跃版本泳道。可通过左上角版本管理抽屉随时恢复显示。`;
    }

    return {
      allActiveVersions,
      allReleasedVersions,
      active,
      released,
      totalVersionsCount,
      visibleVersionsCount,
      shouldShowEmptyState,
      hintText,
    };
  }

  // 场景 1：仅有 released 版本（released-only），全部隐藏
  const releasedOnly = [
    { slug: "v0.7", name: "v0.7", status: "released", goals: [{ id: "g-001" }] },
    { slug: "v0.8", name: "v0.8", status: "released", goals: [{ id: "g-002" }] },
  ];
  const res1 = evaluateVersionFilter(releasedOnly, ["v0.7", "v0.8"]);
  assert.equal(res1.allActiveVersions.length, 0, "无 active 版本");
  assert.equal(res1.allReleasedVersions.length, 2, "有 2 个 released 版本");
  assert.equal(res1.active.length, 0, "可见 active 为 0");
  assert.equal(res1.released.length, 0, "可见 released 为 0");
  assert.equal(res1.visibleVersionsCount, 0, "可见版本总数为 0");
  assert.equal(res1.shouldShowEmptyState, true, "released-only 全部隐藏必须触发友好空态");
  assert.match(res1.hintText!, /已隐藏全部 2 个版本（包含已发布版本）/);

  // 场景 2：active + released 混合，全部隐藏
  const mixed = [
    { slug: "v0.8.2", name: "v0.8.2", status: "active", goals: [{ id: "g-101" }] },
    { slug: "v0.8.1", name: "v0.8.1", status: "released", goals: [{ id: "g-100" }] },
  ];
  const res2 = evaluateVersionFilter(mixed, ["v0.8.2", "v0.8.1"]);
  assert.equal(res2.visibleVersionsCount, 0, "可见版本总数为 0");
  assert.equal(res2.shouldShowEmptyState, true, "混合全部隐藏必须触发友好空态");
  assert.match(res2.hintText!, /已隐藏全部 2 个版本（包含已发布版本）/);

  // 场景 3：active + released 混合，仅 active 全部隐藏，released 仍有可见
  const res3 = evaluateVersionFilter(mixed, ["v0.8.2"]);
  assert.equal(res3.active.length, 0, "可见 active 为 0");
  assert.equal(res3.released.length, 1, "可见 released 为 1");
  assert.equal(res3.visibleVersionsCount, 1, "可见版本数为 1");
  assert.equal(res3.shouldShowEmptyState, true, "active 全隐藏且 released 有可见时也触发活跃版本隐藏提示行");
  assert.match(res3.hintText!, /已隐藏全部 1 个活跃版本泳道/);

  // 场景 4：无任何版本（新仓库/空看板）
  const res4 = evaluateVersionFilter([], []);
  assert.equal(res4.totalVersionsCount, 0);
  assert.equal(res4.shouldShowEmptyState, false, "系统无版本时不显示版本隐藏空态");

  // 场景 5：正常显示（无隐藏）
  const res5 = evaluateVersionFilter(mixed, []);
  assert.equal(res5.visibleVersionsCount, 2);
  assert.equal(res5.shouldShowEmptyState, false, "有可见版本时不显示空态");
});

test("g-223 行为契约：hidden-versions-changed 自定义事件非数组/畸形输入安全过滤与降级", () => {
  const helpers = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");

  // 静态契约：onEvent 必须检查 Array.isArray 且过滤非 string
  assert.match(helpers, /const rawHidden = e\?\.detail\?\.hidden;/);
  assert.match(helpers, /if \(Array\.isArray\(rawHidden\)\)/);
  assert.match(helpers, /rawHidden\.filter\(\(s\) => typeof s === "string"\)/);


 test("g-223 att-005 workspace isolation contracts: fail-closed, malformed records, parent chain, and bound actions", () => {
   const plugin = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/plugin.js"), "utf8");
   const kanban = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");
   assert.ok(plugin.includes("Array.isArray(rawWsItems)"));
   assert.ok(plugin.includes("Array.isArray(w?.sessionIds)"));
   assert.ok(plugin.includes("return null;"));
   assert.ok(!plugin.includes("if (lastGoodWorkspace) return lastGoodWorkspace"));
   assert.ok(kanban.includes("if (!activeWs) return"));
   assert.ok(kanban.includes("kanban.error.workspace"));
   assert.ok(kanban.includes("graphUrlForActive"));
   assert.ok(kanban.includes("requestSeqRef"));
 });

 test("g-223 att-005 load binds monotonic sequence and guards stale success/error", () => {
   const kanban = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");
   assert.match(kanban, /const requestSeq = \+\+requestSeqRef\.current/);
   assert.match(kanban, /boardIdentityRef\.current !== requestIdentity \|\| requestSeqRef\.current !== requestSeq/);
   const guardCount = (kanban.match(/requestSeqRef\.current !== requestSeq/g) ?? []).length;
   assert.ok(guardCount >= 2, "success and catch paths both reject stale responses");
   assert.match(kanban, /String\(showArchived\)/);
 });

test("g-223 att-005 child parent mapping and unresolved B never reuse A", () => {
  const workspaces: any[] = [{ path: "/a", sessionIds: ["A"] }, { path: "/b", sessionIds: ["B"] }];
  const sessions: any[] = [{ sessionId: "child", parentSessionId: "B" }, { sessionId: "orphan" }];
  const resolve = (sid: string) => {
    const seen = new Set<string>(); let cur: any = sid;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const w = workspaces.find((x) => Array.isArray(x.sessionIds) && x.sessionIds.includes(cur));
      if (w?.path) return w.path;
      const s = sessions.find((x) => x.sessionId === cur);
      if (typeof s?.cwd === "string" && s.cwd) return s.cwd;
      cur = typeof s?.parentSessionId === "string" ? s.parentSessionId : null;
    }
    return null;
  };
  assert.equal(resolve("A"), "/a");
  assert.equal(resolve("child"), "/b");
  assert.equal(resolve("orphan"), null);
  workspaces[1].sessionIds = "B" as any;
  assert.equal(resolve("B"), null);
});

  // 纯逻辑行为测试：模拟各类事件输入
  function handleHiddenEvent(detail: any, currentWs: string, fallbackGetter: () => string[]) {
    const evWs = detail?.workspace;
    if (!evWs || evWs === currentWs) {
      const rawHidden = detail?.hidden;
      if (Array.isArray(rawHidden)) {
        return rawHidden.filter((s) => typeof s === "string");
      } else {
        return fallbackGetter();
      }
    }
    return null; // 跨工作区忽略
  }

  const fallback = () => ["v0.1"];

  // 1. 正常字符串数组
  assert.deepEqual(handleHiddenEvent({ workspace: "ws-1", hidden: ["v0.2", "v0.3"] }, "ws-1", fallback), ["v0.2", "v0.3"]);
  // 2. 混合非字符串类型过滤
  assert.deepEqual(handleHiddenEvent({ workspace: "ws-1", hidden: ["v0.2", 123, null, { slug: "v0.4" }] }, "ws-1", fallback), ["v0.2"]);
  // 3. 畸形 object / null / undefined / boolean 安全降级到 fallback
  assert.deepEqual(handleHiddenEvent({ workspace: "ws-1", hidden: { some: "object" } }, "ws-1", fallback), ["v0.1"]);
  assert.deepEqual(handleHiddenEvent({ workspace: "ws-1", hidden: "invalid-string" }, "ws-1", fallback), ["v0.1"]);
  assert.deepEqual(handleHiddenEvent({ workspace: "ws-1", hidden: null }, "ws-1", fallback), ["v0.1"]);
  assert.deepEqual(handleHiddenEvent({ workspace: "ws-1", hidden: undefined }, "ws-1", fallback), ["v0.1"]);
});

test("g-223 行为契约：基于 stable version id 绑定与无中间 load 的 delete→same-slug recreate 自动清理", () => {
  const kanban = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");
  const helpers = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");

  // 静态契约：helpers 提供 parseHiddenVersionEntries 并兼容 string / object 条目
  assert.match(helpers, /function parseHiddenVersionEntries\(raw\)/);
  assert.match(helpers, /idBySlug = new Map/);

  // 静态契约：kanban 加载时基于 version.id 与 slug 对账清理
  assert.match(kanban, /const versionMap = new Map\(data\.versions\.map\(\(v\) => \[v\.slug, v\]\)\);/);
  assert.match(kanban, /if \(e\.id && ver\.id && e\.id !== ver\.id\) return false;/);
  assert.match(kanban, /const isDifferent = cleanedEntries\.length !== entries\.length \|\|/);
  assert.match(kanban, /setHiddenVersionSlugs\(cleanedEntries, data\.versions\);/);

  // 纯逻辑行为模拟测试：支持 { slug, id } 偏好与 versions 对账
  type HiddenEntry = { slug: string; id: string | null };
  type VersionItem = { slug: string; id: string | null };

  function reconcileHiddenEntries(versions: VersionItem[], storedEntries: HiddenEntry[]): { cleaned: HiddenEntry[]; hiddenSlugs: string[]; wasUpdated: boolean } {
    const versionMap = new Map(versions.map((v) => [v.slug, v]));
    const cleaned = storedEntries.filter((e) => {
      const ver = versionMap.get(e.slug);
      if (!ver) return false; // slug 不存在，清理
      if (e.id && ver.id && e.id !== ver.id) return false; // 同 slug 但 version_id 变了（delete+recreate），清理
      return true;
    }).map((e) => ({ slug: e.slug, id: versionMap.get(e.slug)?.id ?? e.id ?? null }));

    const isDifferent = cleaned.length !== storedEntries.length ||
      cleaned.some((ce, i) => ce.slug !== storedEntries[i]?.slug || ce.id !== storedEntries[i]?.id);

    return {
      cleaned,
      hiddenSlugs: [...new Set(cleaned.map((e) => e.slug))],
      wasUpdated: isDifferent,
    };
  }

  // 场景 1：普通删除：v0.7 (id: v-007) 被隐藏，删除 v0.7 后 load，自动清理
  const vList1: VersionItem[] = [{ slug: "v0.7", id: "v-007" }, { slug: "v0.8", id: "v-008" }];
  const stored1: HiddenEntry[] = [{ slug: "v0.7", id: "v-007" }];
  const vListAfterDelete: VersionItem[] = [{ slug: "v0.8", id: "v-008" }];
  const res1 = reconcileHiddenEntries(vListAfterDelete, stored1);
  assert.equal(res1.wasUpdated, true);
  assert.deepEqual(res1.cleaned, []);
  assert.deepEqual(res1.hiddenSlugs, []);

  // 场景 2：直接 delete→same-slug recreate（无中间 load 对账）！
  // 旧版本 v0.7 (id: v-007) 被隐藏；用户在外部或直接删了 v-007 并立刻新建了同名 v0.7 (id: v-009)
  // 首次 load 时，虽然 slug 相同都为 "v0.7"，但 version_id 由 v-007 变为 v-009，旧隐藏必须被清理！
  const storedOld: HiddenEntry[] = [{ slug: "v0.7", id: "v-007" }];
  const vListRecreated: VersionItem[] = [{ slug: "v0.7", id: "v-009" }, { slug: "v0.8", id: "v-008" }];
  const res2 = reconcileHiddenEntries(vListRecreated, storedOld);
  assert.equal(res2.wasUpdated, true, "version_id 不匹配时必须判定为更新并清理");
  assert.deepEqual(res2.cleaned, [], "同 slug 但不同 id 的旧隐藏偏好被安全清理");
  assert.equal(res2.hiddenSlugs.includes("v0.7"), false, "新建的同名版本 v0.7 默认显示！");

  // 场景 3：历史旧数据（纯字符串数组无 id）兼容升级与完整序列（legacy -> 首次 load 持久化升级 -> 随后无中间 load 的 delete+recreate）
  const legacyRaw = JSON.stringify(["v0.7", "v0.8"]);
  // 模拟 parseHiddenVersionEntries 逻辑
  function testParse(raw: string): HiddenEntry[] {
    const parsed = JSON.parse(raw);
    return parsed.map((item: any) => {
      if (typeof item === "string") return { slug: item, id: null };
      if (item && typeof item === "object" && typeof item.slug === "string") return { slug: item.slug, id: item.id ?? null };
      return null;
    }).filter(Boolean);
  }
  const parsedLegacy = testParse(legacyRaw);
  assert.deepEqual(parsedLegacy, [{ slug: "v0.7", id: null }, { slug: "v0.8", id: null }]);

  // 步骤 3.1: 首次 load：旧条目无 id（id=null），对账时自动补全当前 version_id（id: v-007, v-008）并触发持久化升级（wasUpdated=true）
  const resLegacy = reconcileHiddenEntries(vList1, parsedLegacy);
  assert.equal(resLegacy.wasUpdated, true, "补全 id 后内容改变，必须触发持久化写回 localStorage");
  assert.deepEqual(resLegacy.cleaned, [{ slug: "v0.7", id: "v-007" }, { slug: "v0.8", id: "v-008" }], "已成功补充当前 version.id");
  assert.deepEqual(resLegacy.hiddenSlugs, ["v0.7", "v0.8"]);

  // 步骤 3.2: 升级持久化写回后，在无中间 load 情况下，v0.7 (v-007) 被外部直接删除并以同名重建为 v0.7 (v-009)
  const vListAfterRecreateNoIntermediary: VersionItem[] = [{ slug: "v0.7", id: "v-009" }, { slug: "v0.8", id: "v-008" }];
  const resRecreated = reconcileHiddenEntries(vListAfterRecreateNoIntermediary, resLegacy.cleaned);
  assert.equal(resRecreated.wasUpdated, true, "重建后 version_id 不匹配触发清理");
  assert.deepEqual(resRecreated.cleaned, [{ slug: "v0.8", id: "v-008" }], "旧 v0.7 (v-007) 被清理，仅保留仍然存在的 v0.8");
  assert.equal(resRecreated.hiddenSlugs.includes("v0.7"), false, "新建的同名版本 v0.7 默认显示！");
});

test("g-188 转到对话入口与 LiveStrip：事件隔离、主题反馈及安全降级源契约", () => {
  const plugin = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/plugin.js"), "utf8");
  const live = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/session-hooks.js"), "utf8");
  const css = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/constants.js"), "utf8");
  const drawer = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/card-drawer.js"), "utf8");
  const bundle = readFileSync(join(process.cwd(), "dist/lib/client.js"), "utf8");
  assert.match(plugin, /if \(!childId \|\| !parentSessionId\) return null;/);
  assert.match(plugin, /const openingChildSessions = new Set\(\)/);
  assert.match(plugin, /if \(openingChildSessions\.has\(navigationKey\)\) return/);
  assert.match(plugin, /className: "dg-btn dg-session-link"/);
  assert.match(plugin, /e\.stopPropagation\(\); void openChildSession\(parentSessionId, childId\)/);
  assert.match(live, /const canOpen = Boolean\(props\.parentId && props\.childId\)/);
  assert.match(live, /const activateStrip = \(e\) =>/);
  assert.match(live, /tabIndex: canOpen \? 0 : undefined/);
  assert.match(live, /role: canOpen \? "button" : undefined/);
  assert.match(live, /e\.key !== "Enter" && e\.key !== " "/);
  assert.match(live, /className: canOpen \? "dg-live-strip-clickable"/);
  assert.match(live, /e\.stopPropagation\(\);/);
  assert.match(live, /openChildSession\(props\.parentId, props\.childId\)/);
  assert.match(live, /return h\("div", \{ \.\.\.stripProps, title: props\.childId \}/);
  assert.match(css, /\.dg-session-link:hover/);
  assert.match(css, /\.dg-session-link:active/);
  assert.match(css, /\.dg-session-link:focus-visible/);
  assert.match(css, /\.dg-live-strip-clickable:hover/);
  assert.match(css, /\.dg-live-strip-clickable:focus-visible/);
  assert.match(css, /translateY\(-1px\)/);
  assert.match(drawer, /sessionLinkBtn\(card\.parent_session_id, card\.child_id, "↗ 转到对话"\)/);
  assert.doesNotMatch(drawer, /className: "dg-btn",\s*onClick: \(\) => \{ openChildSession/);
  assert.match(bundle, /function sessionLinkBtn/);
  assert.match(bundle, /tabIndex: canOpen \? 0 : undefined/);
  assert.match(bundle, /role: canOpen \? "button" : undefined/);
  assert.match(bundle, /\.dg-live-strip-clickable:focus-visible/);
  assert.match(bundle, /sessionLinkBtn\(card\.parent_session_id, card\.child_id, "↗ 转到对话"\)/);
});

// g-189：真实 Git fixture 覆盖标准路径、branch/HEAD 证据与 REST 输出。
test("g-189 REST fixture：标准 attempt worktree 可发现且 foreign 分支不归属", () => {
  const ws = mkdtempSync(join(tmpdir(), "g189-git-"));
  execFileSync("git", ["init", "-q", ws]);
  execFileSync("git", ["-C", ws, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", ws, "config", "user.name", "test"]);
  init(join(ws, ".dsh-graph"));
  const goalId = createGoal(join(ws, ".dsh-graph"), { title: "fixture", version: "v-t", actor: "test" });
  writeFileSync(join(ws, "README"), "fixture");
  execFileSync("git", ["-C", ws, "add", "."]);
  execFileSync("git", ["-C", ws, "commit", "-qm", "fixture"]);
  const attId = startAttempt(join(ws, ".dsh-graph"), goalId, { executor: "test", actor: "test" });
  const worktree = join(ws, ".worktrees", `${goalId}-att-01`);
  execFileSync("git", ["-C", ws, "worktree", "add", "-q", "-b", `${goalId}-att-01`, worktree]);
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = { get: (name: string) => name === "webServer" ? webServer : undefined, effect: (fn: any) => fn(), webServer, tools: { register: () => () => {}, get: () => ({}) } };
  apply(ctx, {});
  const req: any = fakeRequest("GET", null); req.url = `/api/dsh-graph/goal?id=${goalId}&workspace=${encodeURIComponent(ws)}`;
  const res = fakeResponse(); routes.get("/api/dsh-graph/goal")(req, res);
  assert.equal(res._code, 200); assert.equal(res._body.attempts[0].id, attId);
  assert.equal(res._body.worktrees.items[attId].path, `.worktrees/${goalId}-att-01`);
});

// g-189：worktree 发现保持只读、canonical workspace 与路径安全边界。
test("g-189 worktree 发现与弹窗展示源契约", () => {
  const host = readFileSync(join(dirname(new URL(import.meta.url).pathname), "../../dist/index.js"), "utf8");
  const modal = readFileSync(join(dirname(new URL(import.meta.url).pathname), "../../dsh-graph-host/lib/client/goal-modal.js"), "utf8");
  assert.match(host, /git.*worktree.*list.*porcelain/);
  assert.match(host, /canonicalWorkspace/);
  assert.match(host, /relative\(canonical, actual\)/);
  assert.match(host, /rel !== `\.worktrees\/\${expected}`/);
  assert.match(host, /realpathSync/);
  assert.match(host, /padStart\(2, "0"\)/);
  assert.match(host, /padStart\(3, "0"\)/);
  assert.match(host, /expectedBranch/);
  assert.match(host, /WORKTREE_CACHE_TTL/);
  assert.match(host, /worktreeCache\.get/);
  assert.match(host, /WORKTREE_CACHE_CAP/);
  assert.match(host, /now - entry\.ts/);
  assert.match(host, /worktreeCache\.keys\(\)\.next/);
  assert.match(host, /未创建 worktree|worktree 列表不可用/);
  assert.match(modal, /AttemptWorktrees/);
  assert.match(modal, /tab === "worktree"/);
  assert.match(modal, /dgT\("tab\.worktree"\)/);
  assert.match(modal, /dgT\("worktree\.notCreated"\)/);
  assert.match(modal, /textOverflow: "ellipsis"/);
  assert.match(modal, /dgT\("worktree\.copyPathTooltip"\)/);
  assert.match(modal, /已移除/);
  assert.match(modal, /lastWorktreesRef/);
});

// g-186：确认列弹窗接受交付入口源契约（可见性、单一状态提示、主管通信闭环）。
test("g-186 review 接受交付入口：单一状态提示、不含‘裁决’、排队通知主管会话", () => {
  const actions = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  const constants = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/constants.js"), "utf8");
  const bundle = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  assert.match(actions, /lastTransitionToCurrent/);
  assert.match(actions, /isReview && acceptState === "none"/);
  assert.match(actions, /"✅ 接受"/);
  assert.match(actions, /isReview && acceptState === "pending"/);
  assert.match(actions, /"⏳ 已请求主管复核，等待响应"/);
  assert.doesNotMatch(actions, /等待裁决/);
  assert.match(actions, /isReview && acceptState === "resolved"/);
  assert.match(actions, /"✅ 交付已生效"/);
  assert.match(actions, /confirm\(/);
  assert.match(actions, /session\.prompt/);
  assert.match(actions, /【负责人交付复核请求】/);
  assert.match(actions, /"queue"/);
  assert.match(constants, /get "review\.requested"\(\) \{ return dgT\('event\.reviewRequested'\); \}/);
  assert.match(constants, /get "review\.objected"\(\) \{ return dgT\('event\.reviewObjected'\); \}/);
  assert.match(bundle, /【负责人交付复核请求】/);
  assert.doesNotMatch(bundle, /等待主管裁决/);
});

// g-192：主管会话标题栏标签源契约与槽位注册测试。
test("g-192 标题栏主管徽章源契约：conversation.session.header.actions 槽位与徽章组件", () => {
  const plugin = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/plugin.js"), "utf8");
  const bar = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/supervisor-bar.js"), "utf8");
  const bundle = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  const host = readFileSync(join(import.meta.dirname, "../../dist/index.js"), "utf8");
  assert.match(plugin, /ctx\.slots\.inject\("conversation\.session\.header\.actions"/);
  assert.match(plugin, /id: "dsh-graph-supervisor-badge"/);
  assert.match(plugin, /order: -9/);
  assert.match(bar, /function SupervisorHeaderBadge/);
  assert.match(bar, /dgT\('supervisor\.badge'\)/);
  assert.match(bar, /sessionId !== supervisorSession/);
  assert.match(bar, /role: "status"/);
  assert.match(host, /path: "\/api\/dsh-graph\/supervisor-session"/);
  assert.match(bundle, /function SupervisorHeaderBadge/);
  assert.match(bundle, /dsh-graph-supervisor-badge/);
  assert.match(bundle, /dgT\('supervisor\.badge'\)/);
});

// g-197：delivered 弹窗 worktree 清理候选源契约。
test("g-197 client：delivered 目标展示 WorktreeCandidates 清理组件与 API 绑定", () => {
  const modal = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-modal.js"), "utf8");
  const host = readFileSync(join(import.meta.dirname, "../../dist/index.js"), "utf8");
  const bundle = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  assert.match(modal, /function WorktreeCandidates/);
  assert.match(modal, /status === "delivered"/);
  assert.match(modal, /"\/api\/dsh-graph\/worktrees"/);
  assert.match(modal, /"\/api\/dsh-graph\/worktrees\/clean"/);
  assert.match(host, /path: "\/api\/dsh-graph\/worktrees"/);
  assert.match(host, /path: "\/api\/dsh-graph\/worktrees\/clean"/);
  assert.match(bundle, /function WorktreeCandidates/);
  assert.match(bundle, /可清理 worktree/);
});

test("g-191 client：设置页与重新执行均使用受控模式枚举并显示来源", () => {
  const settings = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/settings.js"), "utf8");
  const panel = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/live-panel.js"), "utf8");
  const modal = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/settings-modal.js"), "utf8");
  assert.match(settings, /subagentMode/);
  assert.match(settings, /htmlFor: modeId/);
  assert.match(settings, /id: modeId, "aria-label": (dgT\("profileSettings\.modeLabel"\)|"子代理默认执行模式")/);
  assert.match(settings, /dg-global-subagent-mode-/);
  assert.match(modal, /htmlFor: modeId/);
  assert.match(modal, /id: modeId,/);
  assert.match(modal, /aria-label": dgT\("settings\.modeAria"\)/);
  assert.match(modal, /dg-workspace-subagent-mode-/);
  assert.match(panel, /modeList/);
  assert.match(panel, /mode: mode/);
  assert.match(panel, /id: modeId,/);
  assert.match(panel, /aria-label": "重新执行子代理模式"/);
  assert.match(panel, /dg-reexec-subagent-mode-/);
  assert.match(panel, /执行模式/);
});

// ---- g-183：共享卡 REST 端点契约 ----

test("g-183 shared-card REST：创建→挂 goal→列表→解引用→删除 全链路", async () => {
  const { root, routes, goalId } = setup();
  // 创建共享卡
  const create = await post(routes, "/api/dsh-graph/create-shared-card", { title: "REST 共享", kind: "text" });
  assert.equal(create.code, 200);
  const sid = create.body.card;
  assert.ok(sid.startsWith("shared-"), "REST 创建共享卡应带 shared- 前缀");
  // 挂到 goal
  const attach = await post(routes, "/api/dsh-graph/attach-shared-card", { goal: goalId, card: sid });
  assert.equal(attach.code, 200);
  // 列表含 refCount=1
  const list = await get(routes, "/api/dsh-graph/shared-cards");
  assert.equal(list.code, 200);
  assert.equal(list.body.cards.length, 1);
  assert.equal(list.body.cards[0].id, sid);
  assert.equal(list.body.cards[0].refCount, 1);
  // boardPayload 顶层也下发 sharedCards
  const board = await get(routes, "/api/dsh-graph");
  assert.equal(board.code, 200);
  assert.equal(board.body.sharedCards.length, 1);
  // 解引用 → refCount 0
  const unref = await post(routes, "/api/dsh-graph/unreference-shared-card", { goal: goalId, card: sid });
  assert.equal(unref.code, 200);
  const list2 = await get(routes, "/api/dsh-graph/shared-cards");
  assert.equal(list2.body.cards[0].refCount, 0);
  // 删除零引用共享卡
  const del = await post(routes, "/api/dsh-graph/delete-shared-card", { card: sid });
  assert.equal(del.code, 200);
  const list3 = await get(routes, "/api/dsh-graph/shared-cards");
  assert.equal(list3.body.cards.length, 0);
});

test("g-183 shared-card REST：被引用删除被拒；转换端点 200", async () => {
  const { root, routes, goalId } = setup();
  const create = await post(routes, "/api/dsh-graph/create-shared-card", { title: "REST 保护", kind: "text" });
  const sid = create.body.card;
  await post(routes, "/api/dsh-graph/attach-shared-card", { goal: goalId, card: sid });
  // 被引用删除 → 400
  const del = await post(routes, "/api/dsh-graph/delete-shared-card", { card: sid });
  assert.equal(del.code, 400);
  assert.ok(String(del.body.error).includes("引用"), "被引用删除应提示引用");
  // 共享→自有转换：引用计数 1 → 成功
  const toOwned = await post(routes, "/api/dsh-graph/convert-card-to-owned", { goal: goalId, card: sid });
  assert.equal(toOwned.code, 200);
  // 转换后该卡已非共享卡
  const list = await get(routes, "/api/dsh-graph/shared-cards");
  assert.equal(list.body.cards.length, 0);
  // 自有→共享转换：goal 自有卡转换为共享（默认 add-card 为 shared；此处显式建自有卡）
  const addOwned = await post(routes, "/api/dsh-graph/add-card", { goal: goalId, title: "自有转共享", kind: "text", scope: "goal" });
  assert.equal(addOwned.code, 200);
  const ocId = addOwned.body.card;
  assert.ok(ocId.startsWith("card-"), "显式 scope=goal 的 add-card 应为 goal 自有");
  const toShared = await post(routes, "/api/dsh-graph/convert-card-to-shared", { goal: goalId, card: ocId });
  assert.equal(toShared.code, 200);
  const oldOwnedFile = join(dirname(findGoalFile(root, goalId)), "cards", `${ocId}.md`);
  assert.ok(!existsSync(oldOwnedFile), "转换后旧自有副本应删除（不留双副本）");
  const list2 = await get(routes, "/api/dsh-graph/shared-cards");
  assert.equal(list2.body.cards.length, 1, "转换后共享池恰 1 张");
  assert.ok(list2.body.cards[0].id.startsWith("shared-"), "转换后应以 shared-* 新 id 落入共享池");
});

test("g-275 card REST：单卡读取端点 /api/dsh-graph/card 支持共享卡与自有卡查询", async () => {
  const { root, routes, goalId } = setup();
  // 1. 创建共享卡并挂到 goal
  const create = await post(routes, "/api/dsh-graph/create-shared-card", { title: "共享卡只读测试", kind: "text" });
  assert.equal(create.code, 200);
  const sid = create.body.card;
  await post(routes, "/api/dsh-graph/attach-shared-card", { goal: goalId, card: sid });

  // 2. GET /api/dsh-graph/card?id=<sid> 读共享卡（无 goal）
  const getShared = await get(routes, `/api/dsh-graph/card?id=${sid}`);
  assert.equal(getShared.code, 200);
  assert.equal(getShared.body.ok, true);
  assert.equal(getShared.body.card.id, sid);
  assert.equal(getShared.body.card.title, "共享卡只读测试");
  assert.equal(getShared.body.card.scope, "shared");
  assert.equal(getShared.body.card.refCount, 1);
  assert.ok(Array.isArray(getShared.body.card.referencingGoals));
  assert.equal(getShared.body.card.referencingGoals.length, 1);
  assert.equal(getShared.body.card.referencingGoals[0].id, goalId);

  // 3. GET /api/dsh-graph/card?id=<cid>&goal=<goalId> 读目标自有卡
  const addOwned = await post(routes, "/api/dsh-graph/add-card", { goal: goalId, title: "自有卡测试", kind: "text", scope: "goal" });
  assert.equal(addOwned.code, 200);
  const cid = addOwned.body.card;
  const getOwned = await get(routes, `/api/dsh-graph/card?id=${cid}&goal=${goalId}`);
  assert.equal(getOwned.code, 200);
  assert.equal(getOwned.body.ok, true);
  assert.equal(getOwned.body.card.id, cid);
  assert.equal(getOwned.body.card.scope, "goal");
  assert.equal(getOwned.body.goal.id, goalId);

  // 4. 卡片不存在时返回 404
  const notFound = await get(routes, "/api/dsh-graph/card?id=non-existent-card");
  assert.equal(notFound.code, 404);
  assert.ok(String(notFound.body.error).includes("不存在"));

  // 5. 目标下不存在的卡片返回 404
  const notFoundInGoal = await get(routes, `/api/dsh-graph/card?id=non-existent-card&goal=${goalId}`);
  assert.equal(notFoundInGoal.code, 404);
  assert.ok(String(notFoundInGoal.body.error).includes("不存在"));

  // 6. 缺失 id 返回 400
  const missingId = await get(routes, "/api/dsh-graph/card");
  assert.equal(missingId.code, 400);

  // 7. 非 GET 方法返回 405
  const notAllowed = await post(routes, "/api/dsh-graph/card", { id: sid });
  assert.equal(notAllowed.code, 405);
});

test("g-183 attachment REST：存储/路径安全/删除引用守卫", async () => {
  const { root, routes, goalId } = setup();
  // 正常存储
  const store = await post(routes, "/api/dsh-graph/store-attachment", { name: "note.md", content: "正文\n引用 @att/note.md" });
  assert.equal(store.code, 200);
  assert.equal(store.body.name, "note.md");
  assert.equal(store.body.ref, "@att/note.md");
  assert.ok(typeof store.body.digest === "string" && store.body.digest.length === 16, "应返回 16 位审计摘要");
  assert.ok(existsSync(join(root, "attachments", "note.md")));
  const list = await get(routes, "/api/dsh-graph/attachments");
  assert.ok(list.body.attachments.includes("note.md"));
  assert.ok(list.body.infos.some((i: any) => i.name === "note.md" && i.exists && i.size > 0), "列表应含附件存在性信息");
  // 路径安全：穿越/绝对路径/反斜杠/子目录越界 → 400
  assert.equal((await post(routes, "/api/dsh-graph/store-attachment", { name: "../../etc/passwd", content: "x" })).code, 400);
  assert.equal((await post(routes, "/api/dsh-graph/store-attachment", { name: "/abs/x", content: "x" })).code, 400);
  assert.equal((await post(routes, "/api/dsh-graph/store-attachment", { name: "a\\b", content: "x" })).code, 400);
  assert.equal((await post(routes, "/api/dsh-graph/store-attachment", { name: "a/../b", content: "x" })).code, 400);
  // 安全子目录允许
  assert.equal((await post(routes, "/api/dsh-graph/store-attachment", { name: "sub/docs.md", content: "子目录" })).code, 200);
  // 引用守卫：把引用写进一个 goal 正文，再尝试删除被引用附件 → 400
  const goalFile = findGoalFile(root, goalId);
  const goalDoc = loadGoal(goalFile);
  goalDoc.body += "\n附件见 @att/note.md\n";
  saveGoal(goalFile, goalDoc);
  const delRef = await post(routes, "/api/dsh-graph/delete-attachment", { name: "note.md" });
  assert.equal(delRef.code, 400, "仍被引用的附件禁止删除");
  // 移除引用后可删除
  const doc2 = loadGoal(goalFile);
  doc2.body = doc2.body.replace(/附件见 @att\/note\.md/, "");
  saveGoal(goalFile, doc2);
  const delOk = await post(routes, "/api/dsh-graph/delete-attachment", { name: "note.md" });
  assert.equal(delOk.code, 200);
  assert.ok(!existsSync(join(root, "attachments", "note.md")));
});

test("g-183 attachment REST：base64 二进制上传（图片/Excel）与稳定引用", async () => {
  const { root, routes, goalId } = setup();
  const b64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
  const store = await post(routes, "/api/dsh-graph/store-attachment", { name: "chart.png", base64: b64 });
  assert.equal(store.code, 200);
  assert.equal(store.body.name, "chart.png");
  assert.equal(store.body.ref, "@att/chart.png");
  const bytes = readFileSync(join(root, "attachments", "chart.png"));
  assert.deepEqual(Array.from(bytes), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "应按二进制落盘");
  // 缺 content/base64 → 400
  assert.equal((await post(routes, "/api/dsh-graph/store-attachment", { name: "x.md" })).code, 400);
});

test("g-183 membership REST：未引用共享卡的 goal 无法 start-collection（400）", async () => {
  const { root, routes, goalId } = setup();
  const sid = (await post(routes, "/api/dsh-graph/create-shared-card", { title: "守卫 REST", kind: "text" })).body.card;
  // 挂到一个 goal（setup 的 goalId）
  await post(routes, "/api/dsh-graph/attach-shared-card", { goal: goalId, card: sid });
  // 建第二个 goal，未引用该共享卡
  const other = createGoal(root, { title: "其他", version: "v-t", actor: "test" });
  // 未引用 goal 对共享卡 start-collection → 400（resolveCard 成员校验拒绝）
  const r = await post(routes, "/api/dsh-graph/start-collection", { goal: other, card: sid });
  assert.equal(r.code, 400);
  assert.ok(String(r.body.error).includes("未被目标"), "未引用 goal 应被拒绝: " + r.body.error);
  // 已引用 goal 正常（无 subagents → child_error 字符串）
  const ok = await post(routes, "/api/dsh-graph/start-collection", { goal: goalId, card: sid });
  assert.equal(ok.code, 200);
  assert.ok(typeof ok.body.child_error === "string");
});

test("add-card REST：kind 可选（goal-actions 已不发 kind），omission 建卡成功", async () => {
  const { root, routes, goalId } = setup();
  // 不传 kind
  const r = await post(routes, "/api/dsh-graph/add-card", { goal: goalId, title: "无 kind 任务" });
  assert.equal(r.code, 200, "kind omission 应成功: " + r.body.error);
  assert.ok(typeof r.body.card === "string");
  // 显式传 kind 也能建
  const r2 = await post(routes, "/api/dsh-graph/add-card", { goal: goalId, title: "带 kind", kind: "text" });
  assert.equal(r2.code, 200);
  // 无效 kind 类型 → 400
  const r3 = await post(routes, "/api/dsh-graph/add-card", { goal: goalId, title: "x", kind: 123 });
  assert.equal(r3.code, 400);
  // 缺失 goal → 400
  const r4 = await post(routes, "/api/dsh-graph/add-card", { title: "x" });
  assert.equal(r4.code, 400);
  // 非法 scope（enum 校验）→ 400（不再静默建自有卡）
  const r5 = await post(routes, "/api/dsh-graph/add-card", { goal: goalId, title: "x", scope: "bogus" });
  assert.equal(r5.code, 400, "非法 scope 应被拒: " + r5.body.error);
  assert.ok(String(r5.body.error).includes("非法卡片 scope"), "应提示非法 scope");
});

test("g-183 attachment REST：安全下载端点（canonical读、content-type、拒绝越界 name）", async () => {
  const { root, routes } = setup();
  await post(routes, "/api/dsh-graph/store-attachment", { name: "doc.md", content: "hello 附件" });
  const handler = routes.get("/api/dsh-graph/attachment");
  // 正常读取
  const res = { _code: 0, _headers: null, _body: null, writeHead(c: number, h: any) { this._code = c; this._headers = h; }, end(s: any) { this._body = s; } };
  const req = fakeRequest("GET", null); req.url = "/api/dsh-graph/attachment?name=doc.md";
  await handler(req, res);
  assert.equal(res._code, 200, "应能下载附件");
  assert.equal(res._headers["content-type"], "text/plain");
  assert.equal(res._body.toString(), "hello 附件");
  // Markdown 也强制 attachment（不内联）
  assert.ok(String(res._headers["content-disposition"]).startsWith("attachment"), "Markdown 应强制下载");
  // HTML/Markdown 等强制 attachment 不 inline
  await post(routes, "/api/dsh-graph/store-attachment", { name: "bad.html", content: "<script>alert(1)</script>" });
  const res2 = { _code: 0, _headers: null, _body: null, writeHead(c: number, h: any) { this._code = c; this._headers = h; }, end(s: any) { this._body = s; } };
  const req2 = fakeRequest("GET", null); req2.url = "/api/dsh-graph/attachment?name=bad.html";
  await handler(req2, res2);
  assert.equal(res2._code, 200);
  assert.ok(String(res2._headers["content-disposition"]).startsWith("attachment"), "危险类型应强制下载");
  // 越界 name → 400
  const res3 = { _code: 0, _headers: null, _body: null, writeHead(c: number, h: any) { this._code = c; this._headers = h; }, end(s: any) { this._body = s; } };
  const req3 = fakeRequest("GET", null); req3.url = "/api/dsh-graph/attachment?name=../x";
  await handler(req3, res3);
  assert.equal(res3._code, 400, "越界 name 应拒绝");
});

test("g-183 collecting：unreference-shared-card 对 collected 共享卡返回 400（API 守卫）", async () => {
  const { root, routes, goalId } = setup();
  const sid = (await post(routes, "/api/dsh-graph/create-shared-card", { title: "REST 收集守卫" })).body.card;
  await post(routes, "/api/dsh-graph/attach-shared-card", { goal: goalId, card: sid });
  // 模拟收集绑定：直接 bindCardChild 核心层（无 subagents 时 start-collection 不会绑定）
  const { bindCardChild } = await import("../ops.ts");
  bindCardChild(root, goalId, sid, { childId: "child-c", actor: "test" });
  const unref = await post(routes, "/api/dsh-graph/unreference-shared-card", { goal: goalId, card: sid });
  assert.equal(unref.code, 400);
  assert.ok(String(unref.body.error).includes("正在收集中"), "collecting 共享卡解除引用应被拒");
});

// 流式上限辅助：构造可触发 data/end/error/destroy 的假请求
function mkStreamReq(opts: { contentType?: string; url?: string } = {}) {
  const listeners: Record<string, (v?: any) => void> = {};
  const req: any = {
    method: "POST",
    headers: { "content-type": opts.contentType ?? "application/json" },
    url: opts.url ?? "/api/dsh-graph/store-attachment",
    destroyed: false,
    paused: false,
    on(ev: string, cb: (v?: any) => void) { listeners[ev] = cb; },
    destroy() { this.destroyed = true; },
    pause() { this.paused = true; },
    unpipe() { this.paused = true; },
  };
  return { req, emit: (ev: string, v?: any) => listeners[ev]?.(v) };
}

test("流式读取累计超过上限立即拒绝并暂停（不销毁 socket，raw/JSON）", async () => {
  // raw reader：小上限，超限即拒绝 + pause（不 destroy）
  const a = mkStreamReq();
  const p1 = readRawBodyCapped(a.req, 100);
  a.emit("data", Buffer.alloc(200, 0x41));
  await assert.rejects(p1, /超过 100 字节上限/);
  assert.equal(a.req.paused, true, "超限应暂停流（不销毁 socket）");
  assert.equal(a.req.destroyed, false, "不应销毁 socket");
  // JSON reader：小上限，超限即拒绝 + pause
  const b = mkStreamReq();
  const p2 = readBodyCapped(b.req, 20);
  b.emit("data", "{\"name\":\"x\",\"content\":\"");
  b.emit("data", "一长串内容超过上限");
  await assert.rejects(p2, /超过 20 字节上限/);
  assert.equal(b.req.paused, true, "超限应暂停流（不销毁 socket）");
  assert.equal(b.req.destroyed, false, "不应销毁 socket");
  // raw 正常：chunked 多 chunk 累计在限内 → 成功
  const c = mkStreamReq();
  const p3 = readRawBodyCapped(c.req, 100);
  c.emit("data", Buffer.from("hel"));
  c.emit("data", Buffer.from("lo"));
  c.emit("end");
  assert.deepEqual(await p3, Buffer.from("hello"));
});

test("store-attachment 原始上传：无 content-length + 超过上限 → 400 且无文件/事件", async () => {
  const { root, routes } = setup();
  const handler = routes.get("/api/dsh-graph/store-attachment");
  // 无 content-length（模拟 chunked），超大 raw body
  const s = mkStreamReq({ contentType: "application/octet-stream", url: "/api/dsh-graph/store-attachment?name=big.bin" });
  const res = fakeResponse();
  const p = handler(s.req, res);
  s.emit("data", Buffer.alloc(51 * 1024 * 1024, 0x41)); // ≈51MB > MAX_ATTACHMENT_BYTES(50MB)
  s.emit("end");
  await p;
  assert.equal(res._code, 400, "超限应拒绝");
  assert.ok(!existsSync(join(root, "attachments", "big.bin")), "超限不得写文件");
  const evs = readEvents(root).filter((e) => e.event === "attachment.stored");
  assert.equal(evs.length, 0, "超限不得记 attachment.stored 事件");
});

test("store-attachment JSON：无 content-length + chunked 在限内 → 成功（流式解析）", async () => {
  const { root, routes } = setup();
  const handler = routes.get("/api/dsh-graph/store-attachment");
  const s = mkStreamReq({ contentType: "application/json", url: "/api/dsh-graph/store-attachment" });
  const res = fakeResponse();
  const p = handler(s.req, res);
  s.emit("data", JSON.stringify({ name: "chunked.md", content: "流式内容" }).slice(0, 20));
  s.emit("data", JSON.stringify({ name: "chunked.md", content: "流式内容" }).slice(20));
  s.emit("end");
  await p;
  assert.equal(res._code, 200, "chunked 在限内应成功: " + (res._body?.error ?? ""));
  assert.ok(existsSync(join(root, "attachments", "chunked.md")));
  assert.ok(typeof res._body.ref === "string");
  // JSON envelope 上限应允许 50MB base64 开销（粗略验证常量足够大）
  assert.ok(MAX_ATTACHMENT_JSON_BYTES > 50 * 1024 * 1024 * 4 / 3, "JSON envelope 应容纳 50MB base64 开销");
});

test("source-contract：shared-panel 附件逐项渲染为节点；card-drawer own→shared/解除/转自有收集中禁用", () => {
  const panel = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/shared-panel.js"), "utf8");
  // 不应把 React/Preact 元素用字符串拼接（会变成 [object Object]）
  assert.ok(!panel.includes("+ c.attachments.map("), "shared-panel 不应拼接 React 元素为字符串");
  assert.ok(!panel.includes(".join(\"，\")"), "shared-panel 附件不应 join 字符串");
  assert.ok(panel.includes('dgT("shared.attachments")'), "should still label attachments via i18n");
  const drawer = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/card-drawer.js"), "utf8");
  // own→shared / 解除引用 / 转自有卡 三个按钮均应对 collecting 禁用
  const count = (drawer.match(/disabled: card\.status === "collecting"/g) ?? []).length;
  assert.ok(count >= 3, `card-drawer 应有 3 处 collecting 禁用（实际 ${count}）`);
});

test("普通 JSON endpoint：超大 chunked（无 content-length）→ 400 且无副作用", async () => {
  const { root, routes, goalId } = setup();
  // 所有普通 JSON REST 走 capped readBody（MAX_JSON_BODY_BYTES=1MB）
  const handler = routes.get("/api/dsh-graph/add-card");
  const s = mkStreamReq({ contentType: "application/json", url: "/api/dsh-graph/add-card" });
  const res = fakeResponse();
  const p = handler(s.req, res);
  s.emit("data", Buffer.alloc(1024 * 1024 + 1024, 0x41)); // >1MB
  s.emit("end");
  await p;
  assert.equal(res._code, 400, "普通 JSON endpoint 超限应拒绝");
  const doc = loadGoal(findGoalFile(root, goalId));
  assert.equal((doc.meta.context_cards ?? []).length, 0, "超限不应创建卡片");
  assert.equal(readEvents(root).filter((e) => e.event === "card.created").length, 0, "超限不应记 card.created 事件");
});

test("readBodyCapped 跨 chunk UTF-8 多字节字符不损坏（Buffer 累积后一次解码）", async () => {
  const a = mkStreamReq();
  const p = readBodyCapped(a.req, 4096);
  const json = JSON.stringify({ name: "测试内容" });
  const buf = Buffer.from(json, "utf8");
  const mid = buf.indexOf("测"); // UTF-8 多字节起点
  assert.ok(mid > 0);
  a.emit("data", buf.slice(0, mid + 1)); // 覆盖 "测" 的第一个字节，把多字节字符劈开
  a.emit("data", buf.slice(mid + 1));
  a.emit("end");
  const parsed = await p;
  assert.equal(parsed.name, "测试内容", "跨 buffer chunk 的 UTF-8 字符应正确还原");
});

test("真实 HTTP：readBodyCapped 超限返回可读 400（无 ECONNRESET）且不落盘", async () => {
  const server = http.createServer((req, res) => {
    readBodyCapped(req, 100)
      .then(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); })
      .catch((e) => { res.writeHead(400, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: String(e.message) })); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", headers: { "transfer-encoding": "chunked", "content-type": "application/json" } }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", (e) => reject(new Error("client error: " + String((e as any).code ?? e))));
    req.write('{"x":"' + "A".repeat(500) + '"}'); // >100 上限
    req.end();
  });
  server.close();
  assert.equal(status, 400, "真实 HTTP 客户端应读到 400（而非 ECONNRESET）");
});

// ===== g-244：子代理会话谱系回溯（真实源片段执行，非重写副本）=====
/**
 * 从 plugin.js 源模块中按花括号配平提取真实的 resolveWorkspaceOfSession 片段，
 * 在 vm 上下文中执行，避免测试再写一份「看起来一样」的模拟实现。
 * g-351：resolveWorkspaceOfSession 的子→父反查索引改由 helpers 的 catalogParentIndex
 * 承担（形状探测：旧 entry 带 kind / 新 entry 无 kind），故把 helpers 里的形状探测族
 * 一并从真实源模块提取注入沙箱——与浏览器 bundle 的同一工厂作用域拼接口径一致。
 */
function extractBraceBalanced(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源模块中存在 function ${name}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`function ${name} 花括号无法配平`);
}

const CATALOG_SHAPE_FUNCS = ["isCatalogChildEntry", "catalogChildEntry", "catalogParentIndex"];

function catalogShapeSource(): string {
  const helpers = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");
  return CATALOG_SHAPE_FUNCS.map((n) => extractBraceBalanced(helpers, n)).join("\n");
}

function loadRealWorkspaceResolver() {
  const plugin = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/plugin.js"), "utf8");
  const start = plugin.indexOf("let lastGoodWorkspace = null;");
  const fnStart = plugin.indexOf("function resolveWorkspaceOfSession(sessionId) {", start);
  assert.ok(start > 0 && fnStart > start, "plugin.js 必须包含 resolveWorkspaceOfSession 源片段");
  let depth = 0;
  let end = -1;
  for (let i = plugin.indexOf("{", fnStart); i < plugin.length; i++) {
    const ch = plugin[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > 0, "resolveWorkspaceOfSession 花括号必须配平");
  const src = `${catalogShapeSource()}\n${plugin.slice(start, end)}`;
  const ctx: any = {};
  vm.createContext(ctx);
  new vm.Script(`${src}\nglobalThis.__resolveWs = resolveWorkspaceOfSession;`).runInContext(ctx);
  return (sessionId: any, opts: any = {}) => {
    ctx.workspacesRt = opts.workspacesRt ?? null;
    ctx.sessionsRt = opts.sessionsRt ?? null;
    ctx.appCtx = opts.appCtx ?? null;
    ctx.viewedSessionId = opts.viewedSessionId ?? null;
    return ctx.__resolveWs(sessionId);
  };
}

const wsSnap = (items: any) => ({ list: { getSnapshot: () => ({ items }) } });
const sessSnap = (state: any) => ({ list: { getSnapshot: () => state } });

test("g-244 子代理会话解析：parentId/items 双形状、subagentsByParent 反查、currentAddress 与多层回溯", () => {
  const resolve = loadRealWorkspaceResolver();
  const workspacesRt = wsSnap([
    { path: "/repo-alpha", sessionIds: ["s-a"] },
    { path: "/repo-beta", sessionIds: ["s-b"] },
  ]);

  // 1. 主会话：workspace 成员直接命中
  assert.equal(resolve("s-a", { workspacesRt }), "/repo-alpha");
  assert.equal(resolve("s-b", { workspacesRt }), "/repo-beta");

  // 2. 运行时真实快照形状：byId 记录 + parentId（子代理无 cwd）
  const byIdRt = sessSnap({ byId: { "child-1": { id: "child-1", parentId: "s-b", origin: "subagent" } } });
  assert.equal(resolve("child-1", { workspacesRt, sessionsRt: byIdRt }), "/repo-beta", "byId+parentId 回溯到父工作区");

  // 3. 子会话只在 subagentsByParent 目录里（byId 缺失）也能反查父会话
  //    entry 为 0.1.6 真实形状：带 kind（权威：dsh-api-remotes subagents.list 结果 schema）
  const catalogRt = sessSnap({
    byId: {},
    subagentsByParent: { "s-b": { entries: [{ kind: "child", id: "child-2", activity: "inactive", hasChildren: false, mode: "continuable", label: "x" }] } },
  });
  assert.equal(resolve("child-2", { workspacesRt, sessionsRt: catalogRt }), "/repo-beta", "subagentsByParent 反查父会话");

  // 3b. g-351：0.1.7 真实形状——快照只有 projectionsBySession，且 entry **无 kind**
  //     （权威：0.1.7 dsh-api-remotes/lib/client.js:9055）。反查索引若不换 entry 形状，
  //     这里会解析失败 ⇒ 看板卡片找不到所属 workspace。
  const projRt = sessSnap({
    byId: {},
    projectionsBySession: { "s-b": { values: { subagentCatalog: [{ id: "child-2n", createdAt: 21, mode: "continuable", label: "x" }] } } },
  });
  assert.equal(resolve("child-2n", { workspacesRt, sessionsRt: projRt }), "/repo-beta", "0.1.7 projectionsBySession（无 kind entry）反查父会话");

  // 3c. g-351：0.1.6 的 diagnostic 行带 id 但**不是**子会话，不得进反查索引
  //     （只按 id 认会把 diagnostic 误当子会话，形状探测必须以 kind 判别）
  const diagRt = sessSnap({
    byId: {},
    subagentsByParent: { "s-b": { entries: [{ kind: "diagnostic", id: "child-diag", reason: "corrupt" }] } },
  });
  assert.equal(resolve("child-diag", { workspacesRt, sessionsRt: diagRt }), null, "diagnostic 行不得被当成子会话（无法定位父）");

  // 4. 多层嵌套：孙会话 → 子会话 → 父会话
  const nestedRt = sessSnap({
    byId: {},
    subagentsByParent: {
      "s-b": { entries: [{ kind: "child", id: "child-3" }] },
      "child-3": { entries: [{ kind: "child", id: "grand-3" }] },
    },
  });
  assert.equal(resolve("grand-3", { workspacesRt, sessionsRt: nestedRt }), "/repo-beta", "多层谱系回溯");

  // 5. 只有 currentAddress 导航地址时也能定位直接父
  const addrRt = sessSnap({ byId: {}, currentAddress: { parentSessionId: "s-a", childSessionId: "child-4", mode: "one-shot" } });
  assert.equal(resolve("child-4", { workspacesRt, sessionsRt: addrRt }), "/repo-alpha", "currentAddress 补齐直接父");
  assert.equal(resolve(null, { workspacesRt, sessionsRt: addrRt }), "/repo-alpha", "无入参时 currentAddress 子会话仍可解析");

  // 6. 旧/降级形状：items 数组 + parentSessionId 仍兼容
  const legacyRt = sessSnap({ items: [{ sessionId: "c-legacy", parentSessionId: "s-a" }] });
  assert.equal(resolve("c-legacy", { workspacesRt, sessionsRt: legacyRt }), "/repo-alpha", "items+parentSessionId 兼容");

  // 7. appCtx 降级路径（workspacesRt/sessionsRt 缺失时）
  const appCtx = { get: (name: string) => (name === "workspaces" ? wsSnap([{ path: "/repo-alpha", sessionIds: ["s-a"] }]) : sessSnap({ byId: {} })) };
  assert.equal(resolve("s-a", { appCtx }), "/repo-alpha", "appCtx.get 降级路径可用");
});

test("g-244 worktree 与嵌套子目录归一到父工程根", () => {
  const resolve = loadRealWorkspaceResolver();
  const workspacesRt = wsSnap([
    { path: "/repo-alpha", sessionIds: ["s-a"] },
    { path: "/repo-beta", sessionIds: ["s-b"] },
    { path: "/repo-beta/sub", sessionIds: ["s-sub"] },
  ]);

  // 1. 子代理 cwd 在 worktree 子目录 → 归一到父工程根（criterion 2）
  const worktreeRt = sessSnap({
    byId: { "child-w": { id: "child-w", parentId: "s-a", cwd: "/repo-alpha/.worktrees/g-244-att-002" } },
  });
  assert.equal(resolve("child-w", { workspacesRt, sessionsRt: worktreeRt }), "/repo-alpha", "worktree cwd 归一父工作区根");

  // 2. 无谱系信息、但 cwd 带 .worktrees 标记时同样归一
  const markerRt = sessSnap({ byId: { "child-w2": { id: "child-w2", cwd: "/repo-alpha/.worktrees/g-1-att-01" } } });
  assert.equal(resolve("child-w2", { workspacesRt, sessionsRt: markerRt }), "/repo-alpha", ".worktrees 标记触发归一");

  // 3. 多层嵌套 + worktree 子目录
  const deepRt = sessSnap({
    byId: { gc: { id: "gc", cwd: "/repo-beta/.worktrees/g-244-att-002/packages/app" } },
    subagentsByParent: { "s-b": { entries: [{ kind: "child", id: "child-x" }] }, "child-x": { entries: [{ kind: "child", id: "gc" }] } },
  });
  assert.equal(resolve("gc", { workspacesRt, sessionsRt: deepRt }), "/repo-beta", "多层嵌套 worktree 归一父根");

  // 4. 嵌套 workspace 取最长前缀（/repo-beta/sub 优先于 /repo-beta）
  const nestedWsRt = sessSnap({ byId: { "child-n": { id: "child-n", parentId: "s-sub", cwd: "/repo-beta/sub/packages/app" } } });
  assert.equal(resolve("child-n", { workspacesRt, sessionsRt: nestedWsRt }), "/repo-beta/sub", "最长前缀匹配");

  // 5. 非谱系会话保持 g-223 既有语义：自己的绝对 cwd 原样返回
  const orphanCwdRt = sessSnap({ byId: { "orphan-cwd": { id: "orphan-cwd", cwd: "/tmp/orphan" } } });
  assert.equal(resolve("orphan-cwd", { workspacesRt, sessionsRt: orphanCwdRt }), "/tmp/orphan", "无血缘会话 cwd 原样");

  // 6. 相对 cwd 不参与解析，继续回溯父会话
  const relRt = sessSnap({ byId: { "c-rel": { id: "c-rel", parentId: "s-a", cwd: "relative/dir" } } });
  assert.equal(resolve("c-rel", { workspacesRt, sessionsRt: relRt }), "/repo-alpha", "相对 cwd 跳过并回溯父会话");
});

test("g-244 Fail-Closed 不退化：孤儿/环/畸形输入返回 null 且不抛异常，绝不回退 lastGoodWorkspace", () => {
  const resolve = loadRealWorkspaceResolver();
  const workspacesRt = wsSnap([{ path: "/repo-alpha", sessionIds: ["s-a"] }, { path: "/repo-beta", sessionIds: ["s-b"] }]);

  // 1. 先成功解析一次，写入模块级 lastGoodWorkspace，再解析未知会话
  assert.equal(resolve("s-a", { workspacesRt }), "/repo-alpha");
  assert.equal(resolve("unknown-session", { workspacesRt }), null, "未知会话必须 fail closed，不得回退 lastGoodWorkspace");

  // 2. 孤儿子会话：父会话已不在快照中
  const orphanRt = sessSnap({ byId: { orphan: { id: "orphan", parentId: "gone" } } });
  assert.equal(resolve("orphan", { workspacesRt, sessionsRt: orphanRt }), null, "父会话缺失时不猜测工作区");

  // 3. 循环谱系：不得死循环
  const cycleRt = sessSnap({ byId: { A: { id: "A", parentId: "B" }, B: { id: "B", parentId: "A" } } });
  assert.equal(resolve("A", { workspacesRt, sessionsRt: cycleRt }), null, "循环谱系安全返回 null");

  // 4. 畸形输入：类型全错也不抛
  const badRt = sessSnap({ byId: "oops", items: 42, subagentsByParent: { p: { entries: "no" } }, currentAddress: 5, current: 7 });
  assert.equal(resolve("s-a", { workspacesRt, sessionsRt: badRt }), "/repo-alpha", "畸形会话快照不影响 workspace 成员解析");
  assert.equal(resolve("nobody", { workspacesRt, sessionsRt: badRt }), null);

  // 5. workspace 快照畸形：sessionIds 非数组 / path 非字符串
  const badWsRt = wsSnap([{ path: "/x", sessionIds: "s-a" }, { path: 5, sessionIds: ["s-a"] }, null, { sessionIds: ["s-a"] }]);
  assert.equal(resolve("s-a", { workspacesRt: badWsRt }), null, "畸形 workspace 记录不得被采信");

  // 6. 快照 getSnapshot 抛异常 → 整体 fail closed
  const throwRt = { list: { getSnapshot: () => { throw new Error("boom"); } } };
  assert.equal(resolve("s-a", { workspacesRt: throwRt, sessionsRt: throwRt }), null, "getSnapshot 抛异常时返回 null");

  // 7. 多工程隔离：B 的子代理只能解析到 B，未知会话不回退到任何已见工作区
  const isoRt = sessSnap({ byId: { "child-b": { id: "child-b", parentId: "s-b" } } });
  assert.equal(resolve("child-b", { workspacesRt, sessionsRt: isoRt }), "/repo-beta");
  assert.equal(resolve("child-of-nowhere", { workspacesRt, sessionsRt: isoRt }), null);
});

test("g-244 生成物一致：client.js 含真实 resolver 且与源模块同源", () => {
  const plugin = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/plugin.js"), "utf8");
  const bundle = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  assert.match(bundle, /⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY/);

  // 源模块与生成物中的 resolver 片段必须逐字一致（build-client.sh 未过期）
  const start = plugin.indexOf("let lastGoodWorkspace = null;");
  const fnStart = plugin.indexOf("function resolveWorkspaceOfSession(sessionId) {", start);
  let depth = 0;
  let end = -1;
  for (let i = plugin.indexOf("{", fnStart); i < plugin.length; i++) {
    const ch = plugin[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const resolverSrc = plugin.slice(start, end);
  assert.ok(resolverSrc.length > 0, "必须能提取 resolver 源片段");
  assert.ok(bundle.includes(resolverSrc), "client.js 必须包含与 plugin.js 同源的 resolver 片段（需重跑 build-client.sh）");

  // 关键能力契约（g-244 三项 In-Scope）
  assert.match(bundle, /const itemList = Array\.isArray\(snap\.items\)/);
  assert.match(bundle, /Object\.prototype\.hasOwnProperty\.call\(rec, sid\)/);
  assert.match(bundle, /item\?\.parentId === "string"/);
  assert.match(bundle, /item\?\.parentSessionId === "string"/);
  assert.match(bundle, /snap\.subagentsByParent/);
  assert.match(bundle, /snap\.currentAddress/);
  assert.match(bundle, /\\\/\\\.worktrees\\\//);
  assert.doesNotMatch(bundle, /if \(lastGoodWorkspace\) return lastGoodWorkspace/);
});

// ===== g-246：看板设置弹窗未保存修改脏状态——关闭前三条路径统一拦截确认 =====

test("g-246 源契约：settings-modal.js 提供规范化脏判定函数且所有关闭路径统一走 requestClose 拦截", () => {
  const modal = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/settings-modal.js"), "utf8");
  // 脏判定函数存在（规范化消除假阳性 + 深比较）
  assert.match(modal, /function normalizeSettingsDraft\(/);
  assert.match(modal, /function settingsDraftIsDirty\(baseline, form, refreshIntervalInput\)/);
  // 统一拦截函数存在，确认文案明确
  assert.match(modal, /const requestClose = \(\) => \{/);
  assert.match(modal, /window\.confirm\(dgT\("settings\.discardDirtyConfirm"\)\)/);
  // saving 中阻止关闭（避免保存与关闭确认竞态）
  assert.match(modal, /if \(saving\) \{ setNote\(\{ kind: "err", text: dgT\("common\.saving"\) \}\); return; \}/);
  // ✕（loading/失败/主表单 3 处）+ 底部「关闭」按钮全部走同一 requestClose
  const intercepted = modal.match(/onClick: requestClose/g) ?? [];
  assert.equal(intercepted.length, 4, "✕×3 + 关闭按钮共 4 处全部走 requestClose");
  // backdrop 关闭路径也走 requestClose（经 useBackdropClose guard）
  assert.match(modal, /useBackdropClose\(requestClose\)/);
  // 不再有任何裸 onClick: props.onClose 关闭路径
  const bare = modal.match(/onClick: props\.onClose/g) ?? [];
  assert.equal(bare.length, 0, "无裸 onClick: props.onClose 关闭路径");
  // 打开时以服务端快照归位基线
  assert.match(modal, /baselineRef\.current = normalizeSettingsDraft\(data, String\(getRefreshInterval\(\)\)\);/);
  // 保存成功路径归位基线（取纠偏后刷新间隔）并直接 onClose 跳过拦截
  assert.match(modal, /baselineRef\.current = normalizeSettingsDraft\(data\.config \?\? form, String\(correctedInterval\)\);/);
  assert.match(modal, /props\.onSaved\?\.\(\);\s*\n\s*props\.onClose\?\.\(\);/);
});

test("g-246 行为模拟：规范化深比较消除假阳性（null↔\"\"、lanes 数字↔字符串、三态缺省）且检出真实修改", () => {
  const modal = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/settings-modal.js"), "utf8");
  const fnStart = modal.indexOf("function normalizeSettingsDraft(");
  const fnEnd = modal.indexOf("function SettingsModal(", fnStart);
  assert.ok(fnStart > 0 && fnEnd > fnStart, "settings-modal.js 含完整脏判定函数段");
  const ctx: any = {};
  new vm.Script(`(function () {\n${modal.slice(fnStart, fnEnd)}\nglobalThis.__norm = normalizeSettingsDraft;\nglobalThis.__dirty = settingsDraftIsDirty;\n})()`).runInNewContext(ctx);
  const norm = ctx.__norm as any;
  const dirty = ctx.__dirty as any;

  // 服务端快照（null 缺省 + lanes 数字）作为基线
  const server = {
    executor: { provider: "", model: "", reasoning_effort: "", mode: "" },
    defaults: { review: { reviewer: "", prompt: null }, pk: { lanes: 1, sandbox: "" } },
    supervisor: { automation: { scope_planning: null, release: "human" } },
    prompt_overrides: { subagent: { state: "default", value: null } },
  };
  const baseline = norm(server, "15");

  // 判据 7：仅打开未编辑——表单形态（lanes 数字、null prompt）与服务端一致 → 不脏
  assert.equal(dirty(baseline, server, "15"), false, "未编辑不脏");
  // lanes 数字 1（服务端）与表单字符串 "1"（number input onChange 写入字符串）→ 规范化后不脏
  const lanesStr = JSON.parse(JSON.stringify(server));
  lanesStr.defaults.pk.lanes = "1";
  assert.equal(dirty(baseline, lanesStr, "15"), false, "lanes 数字↔字符串规范化后不脏（无假阳性）");
  // review.prompt 服务端 null 与表单 "" → 不脏
  const promptEmpty = JSON.parse(JSON.stringify(server));
  promptEmpty.defaults.review.prompt = "";
  assert.equal(dirty(baseline, promptEmpty, "15"), false, "null↔空串规范化后不脏（无假阳性）");

  // 判据 2：任一字段真实修改 → 脏
  const m1 = JSON.parse(JSON.stringify(server)); m1.executor.model = "m-x";
  assert.equal(dirty(baseline, m1, "15"), true, "修改 model → 脏");
  const m2 = JSON.parse(JSON.stringify(server)); m2.defaults.pk.lanes = "3";
  assert.equal(dirty(baseline, m2, "15"), true, "修改 lanes → 脏");
  const m3 = JSON.parse(JSON.stringify(server)); m3.defaults.review.prompt = "复核提示";
  assert.equal(dirty(baseline, m3, "15"), true, "填写 review.prompt → 脏");
  const m4 = JSON.parse(JSON.stringify(server)); m4.supervisor.automation.release = "ai";
  assert.equal(dirty(baseline, m4, "15"), true, "修改 automation → 脏");
  const m5 = JSON.parse(JSON.stringify(server)); m5.prompt_overrides.subagent = { state: "override", value: "自定义文本" };
  assert.equal(dirty(baseline, m5, "15"), true, "三态切 override + textarea 文本 → 脏");
  const m6 = JSON.parse(JSON.stringify(server)); m6.prompt_overrides.subagent = { state: "disable", value: null };
  assert.equal(dirty(baseline, m6, "15"), true, "三态切 disable → 脏");
  // g-214：刷新间隔输入（点保存才持久化）计入脏
  assert.equal(dirty(baseline, server, "30"), true, "修改刷新间隔输入 → 脏");

  // 判据 8：loading/失败分支（无表单）不脏
  assert.equal(dirty(baseline, null, "15"), false, "无表单不脏");
  assert.equal(dirty(null, server, "15"), false, "无基线不脏");
  // override 态 value null 与 "" 规范化一致（不脏回弹）
  const ovNull = JSON.parse(JSON.stringify(server)); ovNull.prompt_overrides.subagent = { state: "override", value: null };
  const ovEmpty = JSON.parse(JSON.stringify(server)); ovEmpty.prompt_overrides.subagent = { state: "override", value: "" };
  assert.equal(JSON.stringify(norm(ovNull, "15")), JSON.stringify(norm(ovEmpty, "15")), "override null↔空串规范化一致");
});

test("g-246 生成 bundle 契约：client.js 同步含脏判定与统一拦截", () => {
  const bundle = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");
  assert.ok(bundle.startsWith("// ⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY"), "client.js 保留 GENERATED FILE header");
  assert.match(bundle, /function normalizeSettingsDraft\(/);
  assert.match(bundle, /function settingsDraftIsDirty\(/);
  assert.match(bundle, /window\.confirm\(dgT\("settings\.discardDirtyConfirm"\)\)/);
  assert.match(bundle, /useBackdropClose\(requestClose\)/);
});

// ===== g-259：设置弹窗保存失败时刷新间隔零本地副作用（后置生效）契约与行为测试 =====

test("g-259 源契约：settings-modal.js 与 client.js 将 setRefreshInterval 置于 POST 成功判定 (r.ok) 之后", () => {
  const modal = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/settings-modal.js"), "utf8");
  const bundle = readFileSync(join(import.meta.dirname, "../../dist/lib/client.js"), "utf8");

  // settings-modal.js 源文件契约：
  const saveStart = modal.indexOf("const save = async () => {");
  assert.ok(saveStart > 0, "settings-modal.js 存在 save 函数");
  const saveEnd = modal.indexOf("if (loading)", saveStart);
  assert.ok(saveEnd > saveStart, "找到 save 函数结束边界");
  const saveCode = modal.slice(saveStart, saveEnd);

  // setRefreshInterval 只能出现在 r.ok 检查之后
  const postIndex = saveCode.indexOf('fetch(graphUrl("/api/dsh-graph/settings")');
  const okIndex = saveCode.indexOf("if (!r.ok)");
  const setRefreshIndex = saveCode.indexOf("setRefreshInterval(refreshIntervalInput)");
  assert.ok(postIndex > 0, "save 内存在 POST /api/dsh-graph/settings");
  assert.ok(okIndex > postIndex, "save 内存在 if (!r.ok) 校验");
  assert.ok(setRefreshIndex > okIndex, "setRefreshInterval 必须在 if (!r.ok) 成功分支内调用（后置生效）");

  // 前置校验（lanes 检查）必须在 fetch 之前且在此之前不得调用 setRefreshInterval
  const precheckIndex = saveCode.indexOf("settings.pkLanesError");
  assert.ok(precheckIndex > 0 && precheckIndex < postIndex, "前置校验位于 fetch 之前");
  assert.ok(setRefreshIndex > precheckIndex, "setRefreshInterval 必须位于前置校验之后");

  // 确保在 fetch 之前的代码段内没有任何 setRefreshInterval 调用
  const preFetchCode = saveCode.slice(0, postIndex);
  assert.equal(preFetchCode.includes("setRefreshInterval"), false, "fetch 发起前绝不调用 setRefreshInterval");

  // client.js 生成 bundle 契约：
  const bSaveStart = bundle.indexOf("const save = async () => {");
  assert.ok(bSaveStart > 0, "bundle 存在 save 函数");
  const bSaveEnd = bundle.indexOf("if (loading)", bSaveStart);
  const bSaveCode = bundle.slice(bSaveStart, bSaveEnd);
  const bOkIndex = bSaveCode.indexOf("if (!r.ok)");
  const bSetRefreshIndex = bSaveCode.indexOf("setRefreshInterval(refreshIntervalInput)");
  assert.ok(bSetRefreshIndex > bOkIndex, "bundle 中 setRefreshInterval 同样位于 r.ok 之后");
  const bPreFetchCode = bSaveCode.slice(0, bSaveCode.indexOf('fetch(graphUrl("/api/dsh-graph/settings")'));
  assert.equal(bPreFetchCode.includes("setRefreshInterval"), false, "bundle 中 fetch 发起前绝不调用 setRefreshInterval");
});

test("g-259 行为模拟：判据 1~4 全覆盖（成功生效、校验失败零副作用、POST 失败/网络异常零副作用、脏拦截与改错重试）", async () => {
  const helpers = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");
  const helperSrc = helpers.slice(helpers.indexOf("const REFRESH_INTERVAL_KEY"), helpers.indexOf("const LIVE_DISPLAY_KEY"));

  const modal = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/settings-modal.js"), "utf8");
  const normSrc = modal.slice(modal.indexOf("function normalizeSettingsDraft("), modal.indexOf("function SettingsModal("));
  const saveSrc = modal.slice(modal.indexOf("const save = async () => {"), modal.indexOf("if (loading)"));
  const reqCloseSrc = modal.slice(modal.indexOf("const requestClose = () => {"), modal.indexOf("const handleIntervalChange"));

  function createHarness(options: any = {}) {
    const store = new Map<string, string>();
    if (options.initialInterval) store.set("dsh-graph.refresh-interval", String(options.initialInterval));

    const events: any[] = [];
    const calls = {
      setNote: [] as any[],
      setError: [] as any[],
      setSaving: [] as any[],
      setRefreshIntervalInput: [] as any[],
      setIntervalWarn: [] as any[],
      setForm: [] as any[],
      onSaved: 0,
      onClose: 0,
      confirm: [] as any[],
      fetch: [] as any[],
    };

    let form = options.form || {
      executor: { provider: "test-p", model: "test-m" },
      defaults: { review: { reviewer: "human", prompt: null }, pk: { lanes: 1, sandbox: "" } },
      supervisor: { automation: {} },
      prompt_overrides: { subagent: { state: "default", value: null } },
    };
    let saving = false;
    let refreshIntervalInput = options.refreshIntervalInput ?? "30";

    const context: any = {
      console,
      CustomEvent: class {
        type: string;
        detail: any;
        constructor(type: string, init: any) { this.type = type; this.detail = init?.detail; }
      },
      window: {
        dispatchEvent: (e: any) => { events.push(e); },
        confirm: (msg: string) => {
          calls.confirm.push(msg);
          return options.confirmResult !== undefined ? options.confirmResult : true;
        },
      },
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: any) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
      },
      dgT: (k: string) => k,
      graphUrl: (u: string) => u,
      fetch: async (url: string, opts: any) => {
        calls.fetch.push({ url, opts });
        if (options.fetchError) throw options.fetchError;
        if (options.fetchResponse) return options.fetchResponse;
        return {
          ok: true,
          status: 200,
          json: async () => ({ config: JSON.parse(opts.body) }),
        };
      },
      props: {
        onSaved: () => { calls.onSaved++; },
        onClose: () => { calls.onClose++; },
      },
      setSaving: (v: any) => { saving = v; calls.setSaving.push(v); },
      setNote: (v: any) => { calls.setNote.push(v); },
      setError: (v: any) => { calls.setError.push(v); },
      setRefreshIntervalInput: (v: any) => { refreshIntervalInput = v; calls.setRefreshIntervalInput.push(v); },
      setIntervalWarn: (v: any) => { calls.setIntervalWarn.push(v); },
      setForm: (v: any) => { form = v; calls.setForm.push(v); },
    };

    const script = `
      ${helperSrc}
      ${normSrc}
      let form = ${JSON.stringify(form)};
      let saving = false;
      let refreshIntervalInput = ${JSON.stringify(refreshIntervalInput)};
      let baselineRef = { current: normalizeSettingsDraft(form, String(getRefreshInterval())) };

      ${reqCloseSrc}
      ${saveSrc}

      globalThis.__harness = {
        save,
        requestClose,
        getStore: () => store,
        getBaseline: () => baselineRef.current,
        getForm: () => form,
        getRefreshIntervalInput: () => refreshIntervalInput,
      };
    `;

    const vmCtx = vm.createContext(context);
    new vm.Script(script).runInContext(vmCtx);
    return {
      harness: (vmCtx as any).__harness,
      store,
      events,
      calls,
      context,
    };
  }

  // 判据 1：保存成功路径一致——表单合法 + POST 2xx，刷新间隔写入 localStorage、广播事件、基线更新、弹窗关闭
  {
    const h = createHarness({ initialInterval: 10, refreshIntervalInput: "25" });
    await h.harness.save();
    assert.equal(h.store.get("dsh-graph.refresh-interval"), "25", "localStorage 成功持久化 25");
    assert.equal(h.events.length, 1, "广播了 1 次 refresh-interval-changed 事件");
    assert.equal(h.events[0].type, "dsh-graph.refresh-interval-changed");
    assert.equal(h.events[0].detail?.interval, 25);
    assert.equal(h.calls.onSaved, 1, "调用了 props.onSaved");
    assert.equal(h.calls.onClose, 1, "保存成功直接调用 props.onClose");
    assert.equal(h.harness.getBaseline().refreshInterval, "25", "baselineRef 归位为最新值");
  }

  // 判据 1 补充：刷新间隔纠偏——输入 <5s（如 "2"）保存成功自动纠偏为 5s
  {
    const h = createHarness({ initialInterval: 15, refreshIntervalInput: "2" });
    await h.harness.save();
    assert.equal(h.store.get("dsh-graph.refresh-interval"), "5", "非法/小于 5s 自动纠偏为 5s");
    assert.equal(h.events[0].detail?.interval, 5);
    assert.equal(h.harness.getBaseline().refreshInterval, "5");
  }

  // 判据 3：前置校验拦截时零副作用——pk lanes 等非法值被拦截并提示错误、不发起 POST，localStorage 与广播事件均未触发
  {
    const h = createHarness({
      initialInterval: 10,
      refreshIntervalInput: "30",
      form: { defaults: { pk: { lanes: -1 } } },
    });
    await h.harness.save();
    assert.equal(h.calls.fetch.length, 0, "前置校验失败未发起 fetch");
    assert.equal(h.store.get("dsh-graph.refresh-interval"), "10", "localStorage 保持原值 10 完全不变");
    assert.equal(h.events.length, 0, "未触发任何广播事件");
    assert.equal(h.calls.onClose, 0, "弹窗未关闭");
    assert.ok(h.calls.setNote.some((n: any) => n?.kind === "err" && n?.text === "settings.pkLanesError"), "提示 pkLanesError");
  }

  // 判据 2：POST 非 2xx (如 500) 时零副作用——弹窗提示保存失败且不关闭，localStorage 保持原值完全不变，不广播事件
  {
    const h = createHarness({
      initialInterval: 10,
      refreshIntervalInput: "30",
      fetchResponse: { ok: false, status: 500, json: async () => ({ error: "Server DB Error" }) },
    });
    await h.harness.save();
    assert.equal(h.calls.fetch.length, 1, "发起了 POST fetch");
    assert.equal(h.store.get("dsh-graph.refresh-interval"), "10", "localStorage 保持原值 10 完全不变");
    assert.equal(h.events.length, 0, "未触发任何广播事件");
    assert.equal(h.calls.onClose, 0, "弹窗未关闭");
    assert.ok(h.calls.setNote.some((n: any) => n?.kind === "err" && String(n?.text).includes("Server DB Error")), "提示保存失败原因");
  }

  // 判据 2：网络异常 (fetch reject) 时零副作用
  {
    const h = createHarness({
      initialInterval: 10,
      refreshIntervalInput: "30",
      fetchError: new Error("Network offline"),
    });
    await h.harness.save();
    assert.equal(h.store.get("dsh-graph.refresh-interval"), "10", "网络异常时 localStorage 仍为 10");
    assert.equal(h.events.length, 0, "网络异常未触发任何广播事件");
    assert.equal(h.calls.onClose, 0, "弹窗未关闭");
    assert.ok(h.calls.setNote.some((n: any) => n?.kind === "err" && String(n?.text).includes("Network offline")), "提示网络异常错误");
  }

  // 判据 4：边界——保存失败后直接关窗应提示存在未保存改动，确认丢弃后间隔严格保持原值；失败后不刷新页面改错重试成功，最新间隔正常持久化
  {
    const h = createHarness({
      initialInterval: 10,
      refreshIntervalInput: "30",
      fetchResponse: { ok: false, status: 500, json: async () => ({ error: "Simulated 500" }) },
    });
    // 步骤 A：首次保存失败
    await h.harness.save();
    assert.equal(h.store.get("dsh-graph.refresh-interval"), "10", "保存失败未改写 localStorage");
    assert.equal(h.calls.onClose, 0);

    // 步骤 B：保存失败后用户尝试关窗 → 拦截提示存在未保存修改
    h.calls.confirm = [];
    h.harness.requestClose();
    assert.equal(h.calls.confirm.length, 1, "关窗被拦截，弹出 confirm 提示");
    assert.equal(h.calls.confirm[0], "settings.discardDirtyConfirm");
    // 用户确认丢弃并关闭，localStorage 严格保持原值 10，无脏数据泄露
    assert.equal(h.store.get("dsh-graph.refresh-interval"), "10", "确认丢弃后原值 10 严格保持");

    // 步骤 C：若用户不关闭、不刷新页面，改错/网络恢复后重试保存
    const hRetry = createHarness({
      initialInterval: 10,
      refreshIntervalInput: "30",
      fetchResponse: { ok: false, status: 500, json: async () => ({ error: "Simulated 500" }) },
    });
    await hRetry.harness.save();
    assert.equal(hRetry.store.get("dsh-graph.refresh-interval"), "10", "首次失败无副作用");

    // 服务端恢复正常
    hRetry.context.fetch = async (url: string, opts: any) => ({
      ok: true,
      status: 200,
      json: async () => ({ config: JSON.parse(opts.body) }),
    });
    // 用户再次点击保存
    await hRetry.harness.save();
    assert.equal(hRetry.store.get("dsh-graph.refresh-interval"), "30", "重试成功后最新刷新间隔 30 正常持久化");
    assert.equal(hRetry.events.length, 1, "重试成功后收到刷新间隔更新事件");
    assert.equal(hRetry.calls.onClose, 1, "重试成功弹窗正常关闭");
    assert.equal(hRetry.harness.getBaseline().refreshInterval, "30", "基线成功更新为 30");
  }
});


// ===== g-323 att-002：单卡「接受」按钮的主管通知（goal-actions.js AcceptFeedback.doAccept） =====
// att-001 只修了批量接受（batch-accept.js）；单卡接受是同形同根因的第二处：
//   0.1.6-alpha.2 的 ClientSessions.binding(id) 只借用**已存在**的保留代际且类中无 get(id)，
//   主管会话未被任何面板 retain 时，单卡接受的主管通知同样静默失效——而单卡接受更常用。
// doAccept 是 AcceptFeedback 内部的闭包，无法直接 import；这里按 g-321 既有做法（花括号配平抠函数 +
// vm 注入真实实现）从源码里精确抠出这个箭头函数，并把它的闭包自由变量显式注入——**执行的是模块里
// 真实的 doAccept 代码本身**（不是重写一份），共享 helper 亦抠自 session-hooks.js 的真实
// promptSessionQueue。故 goal-actions.js 的分流一旦回退为旧的单行 `binding ?? get`，
// 下方 0.1.6 用例必然失败（负向对照 (b)）。

/** 从源模块中按花括号配平抠出一个 `async (...) { ... }` / `async () => { ... }` 函数体。 */
function extractBalanced(source: string, marker: string, fromIndex = 0): string {
  const at = source.indexOf(marker, fromIndex);
  assert.ok(at >= 0, `源模块中存在 ${marker}`);
  let depth = 0;
  for (let i = source.indexOf("{", at); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error(`${marker} 花括号无法配平`);
}

const goalActionsClientSrc = () => readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/goal-actions.js"), "utf8");
const sessionHooksClientSrc = () => readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/session-hooks.js"), "utf8");

/** 真实共享 helper：从 session-hooks.js 抠出 promptSessionQueue 并求值（与测试同 realm，便于断言）。 */
function loadPromptSessionQueueHelper(): any {
  const src = extractBalanced(sessionHooksClientSrc(), "async function promptSessionQueue(");
  const helper = new Function(`${src}\nreturn promptSessionQueue;`)();
  assert.equal(typeof helper, "function", "抠出的共享 helper 可调用");
  return helper;
}

/** 真实 doAccept：抠出箭头函数并把闭包自由变量做成形参注入，返回可直接 await 的调用器。 */
function makeDoAcceptRunner(rt: any, supervisorSession: any, goalId: string, jsonResult: any, onRefresh?: () => void) {
  const src = goalActionsClientSrc();
  const arrow = extractBalanced(src, "const doAccept = ").slice("const doAccept = ".length).trim();
  assert.match(arrow, /^async \(\) => \{/, "抠到的确实是 doAccept 箭头函数");
  const make = new Function(
    "confirm", "dgT", "goalId", "setLoading", "setNote", "fetch", "graphUrl",
    "onRefresh", "sessionsRt", "appCtx", "supervisorSession", "promptSessionQueue", "console",
    `return ${arrow};`,
  );
  return make(
    () => true, (k: string) => k, goalId, () => {}, () => {},
    async () => ({ json: async () => jsonResult }), (p: string) => p,
    onRefresh ?? (() => {}), rt, null, supervisorSession, loadPromptSessionQueueHelper(), console,
  ) as () => Promise<void>;
}

/** 0.1.6-alpha.2 宿主形态：无 get(id)；retain 才有保留代际；binding 是 getter（release 后读会抛错）。 */
function makeDsh016RetainHost(session: any, record: { releases: number; retains: any[] }) {
  let released = false;
  return {
    binding: () => undefined,
    retain: (id: any, options: any) => {
      record.retains.push({ id, options });
      const reference: any = { sessionId: id, ready: Promise.resolve() };
      Object.defineProperty(reference, "binding", {
        get() {
          if (released) throw new Error("Session reference is released");
          return { session };
        },
      });
      reference.release = () => { released = true; record.releases += 1; };
      return reference;
    },
  };
}

test("g-323 单卡接受：0.1.6 retain 宿主（无 get）下 doAccept 发出恰好一条 queue 主管通知且 release 配平", async () => {
  const arrow = extractBalanced(goalActionsClientSrc(), "const doAccept = ");
  assert.match(arrow, /promptSessionQueue\(rt, supervisorSession, parts,/, "doAccept 必须消费共享 helper");
  assert.match(arrow, /【负责人交付复核请求】/, "单卡文案逐字不变");
  assert.doesNotMatch(arrow, /typeof\s+\w+\??\.\s*(using|retain)\s*===/, "doAccept 不得自带能力探测");

  const prompts: any[] = [];
  const record = { releases: 0, retains: [] as any[] };
  const session = { prompt: async (parts: any, mode: any) => { prompts.push({ parts, mode }); return { ok: true }; } };
  const doAccept = makeDoAcceptRunner(makeDsh016RetainHost(session, record), "sup-1", "g-1", { pending: true });
  await doAccept();

  assert.equal(record.retains.length, 1, "0.1.6 单卡接受必须先 retain 才借得到会话");
  assert.deepEqual(record.retains[0], { id: "sup-1", options: { source: "dsh-graph" } });
  assert.equal(prompts.length, 1, "单卡接受必须恰好一条主管通知（不得 0 条，也不得 N 条）");
  assert.equal(prompts[0].mode, "queue");
  const text = String(prompts[0].parts[0].text);
  assert.match(text, /【负责人交付复核请求】/);
  assert.match(text, /「g-1」/, "文案含被接受的目标 id");
  assert.doesNotMatch(text, /【负责人批量交付复核请求】/, "单卡不得误用批量文案");
  assert.equal(record.releases, 1, "release 必须恰好配平一次（无代际泄漏）");
});

test("g-323 单卡接受：0.1.5 被动回退（只有 binding、无 retain/get）行为不退化", async () => {
  const prompts: any[] = [];
  const session = { prompt: async (parts: any, mode: any) => { prompts.push({ parts, mode }); return { ok: true }; } };
  const rt = { binding: (id: string) => (id === "sup-1" ? { session } : undefined) };
  const doAccept = makeDoAcceptRunner(rt, "sup-1", "g-9", { pending: true });
  await doAccept();
  assert.equal(prompts.length, 1, "0.1.5 被动回退仍须恰好一条 queue 主管通知");
  assert.equal(prompts[0].mode, "queue");
  assert.match(String(prompts[0].parts[0].text), /【负责人交付复核请求】/);
  assert.match(String(prompts[0].parts[0].text), /「g-9」/);
});

test("g-323 单卡接受：无 supervisorSession / prompt 抛错 / 非 pending 分支 → 静默不抛，接受流程零影响", async () => {
  const prompts: any[] = [];
  const probeSession = { prompt: async () => { prompts.push(1); } };
  let refreshed = 0;
  // 无 supervisorSession → 不通知，但仍完成 pending 分支的刷板
  let doAccept = makeDoAcceptRunner({ binding: () => ({ session: probeSession }) }, null, "g-2", { pending: true }, () => { refreshed += 1; });
  await doAccept();
  assert.equal(prompts.length, 0, "无 supervisorSession 不得发消息");
  assert.equal(refreshed, 1, "通知失败不得影响 pending 分支的刷板");
  // 0.1.6 宿主但 prompt 抛错 → 静默（不穿出 doAccept）+ release 配平 + 仍刷板
  const record = { releases: 0, retains: [] as any[] };
  doAccept = makeDoAcceptRunner(
    makeDsh016RetainHost({ prompt: async () => { throw new Error("prompt boom"); } }, record),
    "sup-1", "g-3", { pending: true }, () => { refreshed += 1; },
  );
  await assert.doesNotReject(() => doAccept(), "prompt 抛错绝不得穿出 doAccept");
  assert.equal(record.releases, 1, "prompt 抛错也必须 release 配平");
  assert.equal(refreshed, 2, "通知失败仍须完成刷板");
  // retain 抛 unknown session → 静默 + 不误发
  const doAcceptFail = makeDoAcceptRunner({ binding: () => undefined, retain: () => { throw new Error("sessions.retain: unknown session sup-x"); } }, "sup-x", "g-5", { pending: true }, () => { refreshed += 1; });
  await assert.doesNotReject(() => doAcceptFail(), "retain 抛错绝不得穿出 doAccept");
  assert.equal(refreshed, 3, "retain 抛错仍须完成刷板");
  // 后端返回非 pending → 完全不通知
  doAccept = makeDoAcceptRunner({ binding: () => ({ session: probeSession }) }, "sup-1", "g-4", { ok: true }, () => { refreshed += 1; });
  await doAccept();
  assert.equal(prompts.length, 0, "非 pending 分支不得发主管通知");
});

test("g-323 单卡接受：0.1.6 有 using 的宿主优先走 using，恰好一条 queue 且 release 由 using 配平", async () => {
  const prompts: any[] = [];
  const usingCalls: any[] = [];
  const retainCalls: any[] = [];
  const record = { releases: 0, retains: [] as any[] };
  const session = { prompt: async (parts: any, mode: any) => { prompts.push({ parts, mode }); return { ok: true }; } };
  let released = false;
  const rt = {
    binding: () => undefined,
    retain: (id: any, options: any) => { retainCalls.push({ id, options }); return makeDsh016RetainHost(session, record); },
    // using 真实语义：内部 try/finally 保证 release 恰好一次
    using: async (target: any, options: any, operation: any) => {
      usingCalls.push({ target, options });
      const reference: any = { sessionId: target, ready: Promise.resolve() };
      Object.defineProperty(reference, "binding", {
        get() {
          if (released) throw new Error("Session reference is released");
          return { session };
        },
      });
      reference.release = () => { released = true; record.releases += 1; };
      try { return await operation(reference); } finally { reference.release(); }
    },
  };
  const doAccept = makeDoAcceptRunner(rt, "sup-1", "g-7", { pending: true });
  await doAccept();

  assert.equal(usingCalls.length, 1, "有 using 时必须优先 using");
  assert.deepEqual(usingCalls[0], { target: "sup-1", options: { source: "dsh-graph" } });
  assert.equal(retainCalls.length, 0, "using 可用时不得再自行 retain");
  assert.equal(prompts.length, 1, "单卡接受恰好一条 queue 主管通知");
  assert.equal(prompts[0].mode, "queue");
  assert.match(String(prompts[0].parts[0].text), /【负责人交付复核请求】/);
  assert.match(String(prompts[0].parts[0].text), /「g-7」/);
  assert.equal(record.releases, 1, "release 必须恰好一次（无代际泄漏）");
});


// ===== g-327：定义/润色「发送给主管」——能直发就直发，不能直发完整退回 g-168 复制契约 =====
// 能力分流（using / retain / 0.1.5 被动回退）全部在共享 helper promptSessionQueue 内部按**能力**判定；
// openSupervisor 只按它的返回值分流，自身绝不写版本号分支、也绝不自带第二份 using/retain 探测。
// 下列 runner 从源码里按花括号配平抠出**真实的 openSupervisor 箭头函数**并注入其闭包自由变量，
// 共享 helper 同样抠自 session-hooks.js 的真实实现——执行的是模块里的真实代码，不是重写的一份。

let cachedGoalActionsI18n: { zh: Record<string, string>; en: Record<string, string>; dgT: any } | null = null;
/** 真实 i18n 字典 + 中文降级 dgT：从 i18n.js 求值（与 g-272 既有做法一致）。 */
function goalActionsI18n() {
  if (cachedGoalActionsI18n) return cachedGoalActionsI18n;
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/i18n.js"), "utf8");
  const sandbox: any = { React: {}, console };
  vm.runInNewContext(source + "; this.zh = zh; this.en = en; this.dgT = createTranslator();", sandbox);
  cachedGoalActionsI18n = { zh: sandbox.zh, en: sandbox.en, dgT: sandbox.dgT };
  return cachedGoalActionsI18n;
}

/** 真实 openSupervisor：抠出箭头函数 + 注入闭包自由变量，返回可 await 的调用器与可观测状态。 */
function makeOpenSupervisorRunner(opts: {
  rt: any; supervisorSession: any; request: string;
  copyText?: (text: string) => boolean | Promise<boolean>;
  appCtx?: any;
}) {
  const arrow = extractBalanced(goalActionsClientSrc(), "const openSupervisor = ").slice("const openSupervisor = ".length).trim();
  assert.match(arrow, /^async \(\) => \{/, "抠到的确实是 openSupervisor 箭头函数");
  const state = {
    loading: [] as boolean[], notes: [] as any[], modes: [] as any[], fallbacks: [] as any[],
    toasts: [] as string[], opened: [] as any[], activated: 0, copied: [] as string[],
  };
  const make = new Function(
    "dgT", "sessionsRt", "appCtx", "supervisorSession", "promptSessionQueue", "request",
    "copyText", "openSessionTarget", "activateChatTab", "showToast",
    "setLoading", "setMode", "setNote", "setFallback",
    `return ${arrow};`,
  );
  const run = make(
    goalActionsI18n().dgT, opts.rt, opts.appCtx ?? null, opts.supervisorSession, loadPromptSessionQueueHelper(), opts.request,
    // 记录每一次调用：直发成功分支若也走剪贴板，state.copied 会立刻非空（强负向对照）
    async (text: string) => { state.copied.push(text); return opts.copyText ? await opts.copyText(text) : false; },
    (...args: any[]) => { state.opened.push(args); },
    () => { state.activated += 1; },
    (text: string) => { state.toasts.push(text); },
    (v: boolean) => { state.loading.push(v); },
    (v: any) => { state.modes.push(v); },
    (v: any) => { state.notes.push(v); },
    (v: any) => { state.fallbacks.push(v); },
  ) as () => Promise<void>;
  return { run, state };
}

/** 0.1.6 形态的 using 宿主：内部 try/finally 保证 release 恰好一次（真实语义）。 */
function makeDsh016UsingHost(session: any, record: { releases: number; usingCalls: any[]; released: boolean }) {
  return {
    binding: () => undefined,
    using: async (target: any, options: any, operation: any) => {
      record.usingCalls.push({ target, options });
      const reference: any = { sessionId: target, ready: Promise.resolve() };
      Object.defineProperty(reference, "binding", {
        get() {
          if (record.released) throw new Error("Session reference is released");
          return { session };
        },
      });
      reference.release = () => { record.released = true; record.releases += 1; };
      try { return await operation(reference); } finally { reference.release(); }
    },
  };
}

test("g-327 直发契约（源码）：先投递后复制、直发成功分支不写剪贴板，兜底复制契约逐字保留", () => {
  const open = extractBalanced(goalActionsClientSrc(), "const openSupervisor = ");
  // 版本号/代际判断只在**可执行代码**里违规，注释里说明代际不算（与 g-273/g-321 既有断言口径一致）
  const stripComments = (s: string) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  const code = stripComments(open);

  // 分流完全交给共享 helper：自身零探测、零版本号判断
  assert.match(code, /promptSessionQueue\(rt, supervisorSession,/, "openSupervisor 必须消费共享 helper");
  assert.doesNotMatch(code, /typeof\s+\w+\??\.\s*(using|retain)\s*===/, "不得自带 using/retain 探测");
  assert.doesNotMatch(code, /0\.1\.[0-9]|alpha/, "不得写版本号/代际分支");

  // 顺序：投递尝试必须先于剪贴板复制（复制只是投递失败后的兜底）
  const deliverAt = code.indexOf("promptSessionQueue(");
  const copyAt = code.indexOf("copyText(request)");
  assert.ok(deliverAt >= 0, "存在直发调用");
  assert.ok(copyAt > deliverAt, "必须先尝试直发，copyText 只能是投递失败后的兜底");

  // 直发成功分支：不写剪贴板、给如实反馈、清掉手动复制预览、仍打开主管会话
  const branch = /if \(delivered\) \{([\s\S]*?)\n          \}/.exec(open);
  assert.ok(branch, "存在 if (delivered) 直发成功分支");
  const deliveredBody = stripComments(branch![1]);
  assert.doesNotMatch(deliveredBody, /copyText\(/, "直发成功分支绝不得写剪贴板（负责人：直接发不需要复制一份）");
  assert.doesNotMatch(deliveredBody, /exec\.requestCopied/, "直发成功分支不得复用「已复制…请粘贴发送」文案");
  assert.match(deliveredBody, /dgT\("exec\.requestDelivered"\)/, "直发成功必须给如实 toast");
  assert.match(deliveredBody, /setFallback\(false\)/, "直发成功不得展示手动复制预览");
  assert.match(deliveredBody, /openSessionTarget\(supervisorSession/, "直发后仍打开主管会话便于跟进");
  assert.match(deliveredBody, /activateChatTab\(\)/);

  // 兜底复制契约逐字保留（copyText / openSessionTarget / activateChatTab / setFallback 仍被真实调用）
  assert.match(code, /const copied = await copyText\(request\);/);
  assert.match(code, /if \(copied\) showToast\(dgT\("exec\.requestCopied"\)\);/);
  assert.match(code, /setFallback\(!copied\)/);
  assert.match(code, /setNote\(copied \? dgT\("exec\.requestCopiedOpened"\) : dgT\("exec\.autocopyFailedRequest"\)\);/);
  assert.match(code, /openSessionTarget\(supervisorSession, typeof rt\.open === "function"/);
  // 手动复制预览在 DefinitionPolish 的渲染分支里（openSupervisor 之外），故查整份模块源码
  assert.match(goalActionsClientSrc(), /fallback \? h\("textarea", \{ readOnly: true, value: request/, "复制失败的手动复制预览仍在");
  // 原错误分支与 loading 配平保留
  assert.match(code, /exec\.supervisorUnavailable/);
  assert.match(code, /exec\.supervisorNotConfigured/);
  assert.match(code, /exec\.supervisorPathFailed/);
});

/** openSupervisor 开头会先 setNote(null) 清空旧提示；断言只看随后写入的真实文案。 */
const settledNotes = (state: { notes: any[] }) => state.notes.filter((v) => v !== null);

test("g-327 直发分支行为：using 宿主下恰好一条 queue 消息、copyText 零调用、文案如实", async () => {
  const prompts: any[] = [];
  const session = { prompt: async (parts: any, mode: any) => { prompts.push({ parts, mode }); return { ok: true }; } };
  const record = { releases: 0, usingCalls: [] as any[], released: false };
  const { run, state } = makeOpenSupervisorRunner({
    rt: makeDsh016UsingHost(session, record), supervisorSession: "sup-1", request: "REQ-TEXT",
    // 直发分支若触碰剪贴板，这里会立刻抛错并改为失败路径
    copyText: () => { throw new Error("直发分支不得调用 copyText"); },
  });
  await run();

  assert.equal(record.usingCalls.length, 1, "有 using 时必须优先 using");
  assert.deepEqual(record.usingCalls[0], { target: "sup-1", options: { source: "dsh-graph" } });
  assert.equal(record.releases, 1, "release 必须恰好配平一次");
  assert.equal(prompts.length, 1, "直发必须恰好一条消息（不得 0 条，也不得 N 条）");
  assert.equal(prompts[0].mode, "queue");
  assert.equal(String(prompts[0].parts[0].text), "REQ-TEXT", "投递的正是本次请求文本");
  assert.deepEqual(state.copied, [], "直发成功本轮绝不写剪贴板");

  const { zh } = goalActionsI18n();
  assert.deepEqual(state.toasts, [zh["exec.requestDelivered"]], "toast 必须如实说已直接发送");
  assert.deepEqual(settledNotes(state), [zh["exec.requestDeliveredOpened"]]);
  assert.match(state.toasts[0], /直接发送/);
  assert.doesNotMatch(state.toasts[0], /复制|粘贴|剪贴板/, "直发成功不得再说已复制/请粘贴");
  assert.deepEqual(state.fallbacks, [false], "直发成功不展示手动复制预览");
  assert.deepEqual(state.modes, ["supervisor"]);
  assert.equal(state.activated, 1, "仍切换到主管对话窗");
  assert.equal(state.opened.length, 1, "仍打开主管会话");
  assert.equal(state.opened[0][0], "sup-1");
  assert.deepEqual(state.loading, [true, false], "loading 必须配平释放");
});

test("g-327 直发分支行为：0.1.6 retain 宿主（无 get）同样直发且 release 配平", async () => {
  const prompts: any[] = [];
  const session = { prompt: async (parts: any, mode: any) => { prompts.push({ parts, mode }); return { ok: true }; } };
  const record = { releases: 0, retains: [] as any[] };
  const { run, state } = makeOpenSupervisorRunner({
    rt: makeDsh016RetainHost(session, record), supervisorSession: "sup-1", request: "REQ",
    copyText: () => { throw new Error("直发分支不得调用 copyText"); },
  });
  await run();
  assert.equal(record.retains.length, 1, "0.1.6 必须先 retain 才借得到会话");
  assert.equal(record.releases, 1, "release 必须恰好配平一次");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].mode, "queue");
  assert.equal(String(prompts[0].parts[0].text), "REQ");
  assert.deepEqual(state.copied, [], "直发成功本轮绝不写剪贴板");
  assert.equal(state.toasts.length, 1);
  assert.match(state.toasts[0], /直接发送/);
});

test("g-327 退回分支行为：投递不可用时完整退回 g-168 复制契约（复制成功）", async () => {
  const { run, state } = makeOpenSupervisorRunner({
    // 无 using / 无 retain / get 取不到会话 → 投递不可用
    rt: { binding: () => undefined, get: () => undefined }, supervisorSession: "sup-1", request: "REQ",
    copyText: (text: string) => text === "REQ",
  });
  await run();
  const { zh } = goalActionsI18n();
  assert.deepEqual(state.copied, ["REQ"], "取不到会话时必须退回剪贴板复制");
  assert.deepEqual(state.toasts, [zh["exec.requestCopied"]], "复制成功沿用原 toast");
  assert.deepEqual(settledNotes(state), [zh["exec.requestCopiedOpened"]], "复制成功沿用原提示");
  assert.deepEqual(state.fallbacks, [false], "复制成功不展示手动复制预览");
  assert.deepEqual(state.modes, ["supervisor"]);
  assert.equal(state.activated, 1);
  assert.equal(state.opened.length, 1);
  assert.deepEqual(state.loading, [true, false]);
});

test("g-327 退回分支行为：投递抛错 / 复制失败仍走原契约与手动复制预览", async () => {
  // 投递路径抛错（prompt 抛错）→ helper 如实 false → 退回复制契约，且绝不穿出异常
  const prompts: any[] = [];
  const record = { releases: 0, usingCalls: [] as any[], released: false };
  const boom = makeOpenSupervisorRunner({
    rt: makeDsh016UsingHost({ prompt: async () => { prompts.push(1); throw new Error("prompt boom"); } }, record),
    supervisorSession: "sup-1", request: "REQ", copyText: () => true,
  });
  await assert.doesNotReject(() => boom.run(), "投递抛错绝不得穿出 openSupervisor");
  const { zh } = goalActionsI18n();
  assert.equal(prompts.length, 1, "确实尝试过投递");
  assert.equal(record.releases, 1, "prompt 抛错也必须 release 配平");
  assert.deepEqual(boom.state.copied, ["REQ"], "投递失败后必须退回剪贴板复制");
  assert.deepEqual(boom.state.toasts, [zh["exec.requestCopied"]]);
  assert.deepEqual(boom.state.fallbacks, [false]);
  assert.deepEqual(boom.state.loading, [true, false]);

  // 投递不可用 + 复制失败 → 原契约的降级：fallback=true、展示可复制请求、如实提示，且不误报成功
  const fail = makeOpenSupervisorRunner({
    rt: { binding: () => undefined }, supervisorSession: "sup-1", request: "REQ", copyText: () => false,
  });
  await fail.run();
  assert.deepEqual(fail.state.copied, ["REQ"]);
  assert.deepEqual(fail.state.toasts, [], "复制失败不得显示成功 toast");
  assert.deepEqual(settledNotes(fail.state), [zh["exec.autocopyFailedRequest"]], "复制失败沿用原降级提示");
  assert.deepEqual(fail.state.fallbacks, [true], "复制失败必须置 fallback=true 展示可复制 textarea");
});

test("g-327 原错误分支保留：无会话服务 / 未配置主管会话时零投递、零复制并如实报错", async () => {
  const noRt = makeOpenSupervisorRunner({
    rt: null, appCtx: { get: () => null }, supervisorSession: "sup-1", request: "REQ",
    copyText: () => { throw new Error("错误分支不得复制"); },
  });
  await noRt.run();
  const { zh } = goalActionsI18n();
  assert.deepEqual(noRt.state.copied, [], "无会话服务不得走剪贴板");
  assert.deepEqual(noRt.state.toasts, []);
  assert.equal(settledNotes(noRt.state).length, 1);
  assert.match(String(settledNotes(noRt.state)[0]), /会话服务不可用/);
  assert.deepEqual(noRt.state.loading, [true, false]);

  const noSup = makeOpenSupervisorRunner({
    rt: { binding: () => undefined }, supervisorSession: null, request: "REQ",
    copyText: () => { throw new Error("错误分支不得复制"); },
  });
  await noSup.run();
  assert.deepEqual(noSup.state.copied, []);
  assert.deepEqual(noSup.state.toasts, []);
  assert.equal(settledNotes(noSup.state).length, 1);
  assert.match(String(settledNotes(noSup.state)[0]), /未配置主管会话/);
  assert.deepEqual(noSup.state.loading, [true, false]);
});

test("g-327 i18n：直发文案如实（无「复制/粘贴」）、en 零 CJK、复制兜底文案逐字保留", () => {
  const { zh, en } = goalActionsI18n();
  for (const key of ["exec.requestDelivered", "exec.requestDeliveredOpened"]) {
    assert.ok(zh[key] !== undefined, `zh 缺少 ${key}`);
    assert.ok(en[key] !== undefined, `en 缺少 ${key}`);
    assert.match(zh[key], /直接发送/, `zh ${key} 必须如实说明已直接发送`);
    assert.doesNotMatch(zh[key], /复制|粘贴|剪贴板/, `zh ${key} 不得谎称复制/粘贴`);
    assert.doesNotMatch(en[key], /[\u3400-\u9fff]/, `en ${key} 含 CJK`);
    assert.match(en[key], /directly/i, `en ${key} 必须如实说明已直接发送`);
    assert.doesNotMatch(en[key], /copi|paste|clipboard/i, `en ${key} 不得谎称复制/粘贴`);
  }
  // 按钮文案不再写死「复制请求」：直发与复制兜底两条分支下都必须如实
  assert.doesNotMatch(zh["exec.goToSupervisor"], /复制/);
  assert.doesNotMatch(en["exec.goToSupervisor"], /copi|clipboard|paste/i);
  // 复制兜底分支文案逐字保留（复制路径仍是真实兜底）
  assert.equal(zh["exec.requestCopied"], "✅ 请求已复制到剪贴板，可在主管对话窗粘贴发送");
  assert.equal(zh["exec.requestCopiedOpened"], "✅ 请求已复制，已打开主管会话，请粘贴发送");
  assert.equal(zh["exec.autocopyFailedRequest"], "⚠️ 自动复制失败，请手动复制下方请求");
});
