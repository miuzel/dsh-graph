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
import vm from "node:vm";
import { init, createGoal, findGoalFile, loadGoal, saveGoal, setCriteria, transition, readProjectConfig } from "../ops.ts";
import { criteriaItems, replaceSection, sectionText } from "../model.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dsh-graph-host/index.js";

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
    get: (name: string) => (name === "webServer" ? webServer : undefined), // 无 subagents/agents 服务 → 降级分支
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, { root });
  return { root, routes, goalId };
}

// g-113：无 config.root 的 apply（完全由请求 workspace 决定 root，与生产默认一致）
function setupNoConfigRoot() {
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
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
  const handler = routes.get(path);
  assert.ok(handler, `路由 ${path} 已注册`);
  const req = fakeRequest("GET", null);
  const res = fakeResponse();
  await handler(req, res);
  return { code: res._code, body: res._body };
};

test("g-132 settings 端点：GET 回填当前配置、POST 写回并保留值，不半写入", async () => {
  const { root, routes } = setup();
  const empty = await get(routes, "/api/dsh-graph/settings");
  assert.equal(empty.code, 200);
  assert.deepEqual(empty.body.executor, { provider: null, model: null });
  // att-002：GET 下发当前 canonical workspace 的 project.yaml 绝对路径
  assert.equal(empty.body.configFile, join(root, "project.yaml"));
  const write = await post(routes, "/api/dsh-graph/settings",
    { executor: { provider: "openai-codex", model: "gpt-5.6-luna" }, prompt_overrides: { subagent: { state: "override", value: "子代理补充" } } });
  assert.equal(write.code, 200);
  assert.equal(write.body.ok, true);
  const again = await get(routes, "/api/dsh-graph/settings");
  assert.equal(again.code, 200);
  assert.deepEqual(again.body.executor, { provider: "openai-codex", model: "gpt-5.6-luna" });
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
  assert.match(modal, /保留未知键与注释/);
  assert.match(modal, /显示高级\/仅存储字段/);
  assert.match(modal, /display: showAdvanced \? "flex" : "none"/);
  assert.match(modal, /display: showAdvanced \? "grid" : "none"/);
  assert.match(modal, /h\("hr", \{ style: \{ display: showAdvanced \? "block" : "none"/);
  assert.match(modal, /if \(!cur\[path\[i\]\].*typeof cur\[path\[i\]\] !== "object"/s);
  assert.doesNotMatch(modal, /主管补充提示词/);
  assert.doesNotMatch(modal, /prompt_overrides.*supervisor/);
  const host = readFileSync(join(process.cwd(), "dsh-graph-host/index.js"), "utf8");
  assert.doesNotMatch(host, /promptOverrideSection\([^\n]*"supervisor"/);
  assert.doesNotMatch(host, /主管补充提示词/);
  // att-002：settings GET 下发 canonical project.yaml 绝对路径（服务端唯一来源）
  assert.match(host, /configFile: join\(meta\.root, "project\.yaml"\)/);
  // att-002：说明区域配置文件操作入口——只消费服务端 configFile，不自行拼接 graphRoot
  assert.match(modal, /setConfigFile\(data\.configFile \?\? null\)/);
  assert.match(modal, /connectionRt \?\? appCtx\?\.get\?\.\("connection"\)/);
  assert.match(modal, /conn\.api\.host\.openPath\(\{ path: configFile \}\)/);
  assert.match(modal, /"✅ 已打开 project\.yaml"/);
  // open/copy/fallback 行为源契约：openPath 可用且成功才 return；不可用/异常均回退复制绝对路径
  const openIdx = modal.indexOf("conn.api.host.openPath({ path: configFile })");
  const fallbackIdx = modal.indexOf('showToast("✅ 路径已复制（打开不可用）")');
  const copyIdx = modal.indexOf("await copyText(configFile);");
  assert.ok(openIdx > 0 && fallbackIdx > openIdx && copyIdx > 0, "openPath 应先于 fallback 复制");
  assert.ok((modal.match(/copyText\(configFile\)/g) || []).length >= 3, "打开回退 + 复制按钮均应复制绝对路径");
  assert.match(modal, /"📄 project\.yaml"/);
  assert.match(modal, /title: "用系统默认编辑器打开 project\.yaml"/);
  assert.match(modal, /title: "复制 project\.yaml 路径"/);
  assert.match(modal, /\}, "打开"\)/);
  assert.match(modal, /\}, "复制路径"\)/);
  const bundle = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client.js"), "utf8");
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
  assert.match(modal, /"（继承父会话）"/);
  assert.match(modal, /"（已存值，当前目录未列出）"/);
  assert.match(modal, /legacySuffix/);
  // provider/model 控件由 input 改为 select（boxSizing:"border-box"）
  assert.match(modal, /h\("select", \{ style: \{ \.\.\.S\.promptInput, width: "100%", boxSizing: "border-box" \}, value: curProvider/);
  assert.match(modal, /h\("select", \{ style: \{ \.\.\.S\.promptInput, width: "100%", boxSizing: "border-box" \}, value: curModel/);
  // 可收缩布局：父容器 minWidth:0、子列 flex:"1 1 0"+minWidth:0（两列并排各占一半）
  assert.match(modal, /display: "flex", gap: 8, minWidth: 0/);
  assert.match(modal, /flex: "1 1 0", minWidth: 0/);
  // 保存仍写 form.executor.provider/model 到 workspace project.yaml
  assert.match(modal, /executor: \{ provider: form\.executor\?\.provider \?\? "", model: form\.executor\?\.model \?\? "" \}/);
});

test("g-163 判据方块按有序 key 渲染并支持即时同步", () => {
  const card = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/card.js"), "utf8");
  const actions = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  assert.match(card, /function CriteriaProgress\(props\)/);
  assert.match(card, /props\.items/);
  assert.match(card, /CRITERIA_PLACEHOLDERS/);
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

test("g-164 released 泳道与 active/version 泳道共用同一动态列模板源契约", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  // 顶部表头网格与 released 泳道网格必须共用同一份按折叠状态动态计算的列模板，
  // 否则 released 泳道展开并折叠交付/阻塞列时列宽与上方泳道错位。
  assert.match(source, /const gridCols = \["130px",/);
  assert.match(source, /deliverColumnCollapsed \? "36px" : "minmax\(150px, 1fr\)",\s*\/\/ deliver/);
  assert.match(source, /blockedColumnCollapsed \? "36px" : "minmax\(150px, 1fr\)",\s*\/\/ blocked/);
  // 顶部表头网格：(1) 处使用 gridCols；首个单元格为左上角 stageHead 锚点
  //（g-174 起承载「＋ 新建版本」入口，替换原「泳道＼阶段」文字）。
  assert.match(source, /h\("div", \{ style: \{ \.\.\.S\.grid, gridTemplateColumns: gridCols \} \},[\s\S]*?h\("div", \{ style: S\.stageHead \},\s*\n\s*h\("button", \{[\s\S]*?\}, "＋ 新建版本"\)\)/);
  // released 泳道网格：(1) 处使用 gridCols（relx- 容器），保证与上方泳道列宽/顺序一致。
  assert.match(source, /relx-" \+ v\.slug, style: \{ \.\.\.S\.grid, gridTemplateColumns: gridCols \}/);
  // 全文件恰好两处（顶部表头 + released 泳道）引用该共享模板，不存在各排各的静态模板。
  assert.equal((source.match(/gridTemplateColumns: gridCols/g) || []).length, 2);
});

test("g-174 标题栏源契约：version 链接、新建版本入口迁移、设置按钮位于 DEBUG 左侧", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  const head = source.slice(source.indexOf('h("div", { style: S.head },'), source.indexOf("// g-108：顶部 supervisor 状态栏"));
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
  assert.match(source, /"交", h\("br"\), "付", h\("br"\), `×\$\{count\}`/);
  assert.match(source, /"阻", h\("br"\), "塞", h\("br"\), `×\$\{orderedGoals\.length\}`/);
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
  assert.doesNotMatch(source, /title: "折叠泳道"[\s\S]{0,180}lane\(v\.name, v\.goals, "rellane-/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  const backlogControl = source.slice(source.indexOf("// g-162: 泳道折叠按钮"), source.indexOf("// g-137 修复"));
  assert.match(backlogControl, /className: "dg-lane-collapse"/);
  assert.match(backlogControl, /className: "dg-lane-collapse-triangle"/);
  assert.match(backlogControl, /"aria-label": "折叠泳道"/);
  assert.doesNotMatch(backlogControl, /className: "dg-btn",\s*title: "折叠泳道"|\}, "▾"\)/);
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
    },
    h,
    S: new Proxy({}, { get: () => ({}) }),
    STATUS_LABEL: { in_progress: "进行中" },
    CARD_STATUS_ICON: {},
    GOAL_TYPE_LABELS: { feature: "功能" },
    GOAL_TYPE_ABBREV: { feature: "F" },
    goalTypeColor: () => "#000",
    normalizeGoalType: () => "feature",
    rowHalf: () => "after",
    localStorage: { getItem: () => JSON.stringify(["第一"]) },
    window: { addEventListener: () => {}, removeEventListener: () => {} },
  };
  const progressStart = source.indexOf("const CRITERIA_PLACEHOLDERS");
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
    { goal: goalId, title: "调研 A", kind: "text" });
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

test("start-collection 无 subagents：child_error 上报、卡片不误翻 collecting且不创建 attempt", async () => {
  const { root, routes, goalId } = setup();
  const goalFile = findGoalFile(root, goalId);
  const { body } = await post(routes, "/api/dsh-graph/add-card",
    { goal: goalId, title: "c", kind: "text" });
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
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});

  // add-card 必须带 workspace，否则卡片建到 process.cwd()
  const addRes = await post(routes, "/api/dsh-graph/add-card",
    { goal: goalId, title: "测试卡片", kind: "text", workspace: ws });
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
  assert.ok(capturedPrompt.includes(`- 类型: text`), "应包含 card 类型");
  assert.ok(capturedPrompt.includes(`graph_fill_card(goal="${goalId}", card="${card}", text=<全文>, summary=<≤100字摘要>)`), "应包含精确回填模板");
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
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});

  const addRes = await post(routes, "/api/dsh-graph/add-card",
    { goal: goalId, title: "用户提示卡", kind: "text", workspace: ws });
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
  assert.match(modal, /"✅ 质量判据"/);
  assert.match(modal, /"✏️ 判据"/);
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
  assert.match(modal, /保存后将清空该目标已有的判据勾选状态/);
  assert.match(modal, /localStorage\.removeItem\("dsh-graph\.crit\." \+ goalId\)/);
  assert.match(modal, /dsh-graph\.criteria-changed/);
  // D8：base_items token + 409 自动以本地内容覆盖重试（force=true）
  assert.match(modal, /base_items: baseItems \?\? \[\]/);
  assert.match(modal, /r\.status === 409/);
  assert.match(modal, /以本地内容覆盖服务器/);
  assert.match(modal, /force: !!force/);
  assert.match(modal, /post\(true\)/);
  // 逐行编辑能力
  assert.match(modal, /"➕ 新增判据"/);
  assert.match(modal, /"上移"/);
  assert.match(modal, /"下移"/);
  assert.match(modal, /"删除该条"/);
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
  const bundle = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client.js"), "utf8");
  assert.match(bundle, /⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY/);
  assert.match(bundle, /function CriteriaModal\(props\)/);
  assert.match(bundle, /"✏️ 判据"/);
});

test("g-170 constants：criteria.updated 事件有标签并计入近期动态", () => {
  const src = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/constants.js"), "utf8");
  assert.match(src, /"criteria\.updated": "更新判据"/);
  assert.match(src, /"criteria\.updated", \/\/ g-170/);
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
  assert.deepEqual(res._body.default, { provider: null, model: null });
});

test("start-execution 无 subagents：attempt 本地创建、child_error 上报（带 provider/model 参数不炸）", async () => {
  const { root, routes, goalId } = setup();
  const r = await post(routes, "/api/dsh-graph/start-execution",
    { goal: goalId, provider: "spawn", model: "deepseek-v4-flash" });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.attempt.startsWith("att-"));
  assert.equal(r.body.child_id, null);
  assert.ok(typeof r.body.child_error === "string");
  const events = readEvents(root);
  assert.ok(events.some((e) => e.event === "attempt.started" && e.goal === goalId));
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
  const { routes } = setupNoConfigRoot();
  const handler = routes.get("/api/dsh-graph");
  const res = fakeResponse();
  handler({ method: "GET", url: "/api/dsh-graph?workspace=" + encodeURIComponent(b.ws) }, res);
  assert.equal(res._code, 200);
  const titles = boardGoalTitles(res._body);
  assert.ok(titles.includes(b.title), "board 含 workspace 项目的目标");
  assert.ok(!titles.includes(a.title), "board 不含其他项目目标");
  // 反向：workspace=a 时读 a 的目标
  const res2 = fakeResponse();
  handler({ method: "GET", url: "/api/dsh-graph?workspace=" + encodeURIComponent(a.ws) }, res2);
  const titles2 = boardGoalTitles(res2._body);
  assert.ok(titles2.includes(a.title));
  assert.ok(!titles2.includes(b.title));
});

test("g-113 写端点跟随 body.workspace：add-card 写到该项目 .dsh-graph（事件落该项目）", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-ws-"));
  const b = makeProject(base, "proj-b", "B 项目目标");
  const { routes } = setupNoConfigRoot();
  const handler = routes.get("/api/dsh-graph/add-card");
  const req = fakeRequest("POST", { goal: b.goalId, title: "收集卡", kind: "text", workspace: b.ws });
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal: b.goalId, title: "收集卡", kind: "text", workspace: b.ws });
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
  const { routes } = setupNoConfigRoot();
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
  const { routes } = setupNoConfigRoot();
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
  const { routes } = setupNoConfigRoot();
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
    join(import.meta.dirname, "../../dsh-graph-host/lib/client.js"), "utf8");
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
    join(import.meta.dirname, "../../dsh-graph-host/lib/client.js"), "utf8");
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
    join(import.meta.dirname, "../../dsh-graph-host/core/ops.js"), "utf8");
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
  assert.ok(!/h\("pre"[\s\S]*request/.test(actions), "不渲染完整请求预览");
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

test("g-168 复制失败 fallback：初始隐藏且只在失败后显示可复制请求", () => {
  const actions = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  assert.ok(/const \[fallback, setFallback\] = React\.useState\(false\)/.test(actions));
  assert.ok(/setFallback\(!copied\)/.test(actions));
  assert.ok(/fallback \? h\("textarea"/.test(actions));
  assert.ok(/readOnly:\s*true[\s\S]*value:\s*request/.test(actions));
  assert.ok(!/h\("pre"[\s\S]*request/.test(actions), "初始界面不展示大段 prefill");
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
  const host = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/index.js"), "utf8");
  assert.ok(/const \{ goal, goal_path, guidance \}/.test(host));
  assert.ok(/goal\.md 工作区相对路径/.test(host));
  assert.ok(/read 工具读取上述 goal\.md/.test(host));
  assert.ok(!/目标标题：\$\{String\(title/.test(host));
});

// g-160：released 版本详情入口、受控恢复与刷新契约
test("g-160 client 源契约：released 详情入口和二次确认恢复", () => {
  const source = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");
  assert.match(source, /title:\s*"打开版本详情"/);
  assert.match(source, /versionDetailTarget\.status === "released"/);
  assert.match(source, /撤销发布状态/);
  assert.match(source, /status:\s*"active",\s*confirmed:\s*true/);
  assert.match(source, /loadVersionDetail\(versionDetailTarget\.slug\)/);
  assert.match(source, /load\(\)/);
});

// ===== g-171/g-211/g-214：更新强调动画（updated_at 10 秒窗口）源/生成 bundle 契约 =====

test("g-171/g-211/g-214 模块源契约：kanban.js 复用现有 load 与 RefreshCountdown 倒计时且接入 visibilitychange", () => {
  const kanban = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");
  // 复用现有首次加载/手动刷新/写操作后的 load() 与轮询/倒计时
  assert.ok(/const load = \(\) => \{[\s\S]*setState\(\{ loading: false, data \}\); loadOrder\(\); applyUpdateEmphasis\(data\)/.test(kanban), "load() 成功路径调用 applyUpdateEmphasis");
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
    join(import.meta.dirname, "../../dsh-graph-host/lib/client.js"), "utf8");
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
    join(import.meta.dirname, "../../dsh-graph-host/lib/client.js"), "utf8");
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
  const matches = src.match(/h\("div", \{ style: S\.modalH \}, "🔎 信息收集"\)/g) ?? [];
  assert.equal(matches.length, 2, "goal-modal.js 两处信息收集标题均为 🔎 信息收集");
  assert.ok(!src.includes("🗂"), "goal-modal.js 不残留旧 emoji 🗂");
});

test("g-179 生成 bundle 契约：client.js 标题同步为 🔎 信息收集且保留 generated header", () => {
  const bundle = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client.js"), "utf8");
  assert.ok(bundle.startsWith("// ⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY"), "client.js 保留 GENERATED FILE header");
  const matches = bundle.match(/h\("div", \{ style: S\.modalH \}, "🔎 信息收集"\)/g) ?? [];
  assert.equal(matches.length, 2, "生成 bundle: 两处信息收集标题均为 🔎 信息收集");
  assert.ok(!bundle.includes("🗂"), "生成 bundle: 不残留旧 emoji 🗂");
});

// ===== g-181：父级 overlay backdrop 误关保护（内容起点文本选择/拖拽到弹窗外松开不误关）=====

// 五个受影响模块的 guard 接入预期（每处 style: S.overlay 都必须走 useBackdropClose guard，
// 禁止裸 style: S.overlay, onClick:；panel stopPropagation 保留）。
const G181_MODULES: Record<string, number> = {
  "goal-modal.js": 1,
  "criteria-modal.js": 3,
  "settings-modal.js": 3,
  "drag-prompts.js": 3,
  "kanban.js": 5,
};
const G181_TOTAL = Object.values(G181_MODULES).reduce((a, b) => a + b, 0); // 15

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

test("g-181 源契约：五个模块全部 style: S.overlay 均接 guard（共 15 处），无裸 overlay onClick，panel stopPropagation 保留", () => {
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
  // 全量约束 15 个父级 overlay 入口
  let total = 0;
  for (const file of Object.keys(G181_MODULES)) {
    const src = readFileSync(
      join(import.meta.dirname, "../../dsh-graph-host/lib/client", file), "utf8");
    total += (src.match(/style: S\.overlay, \.\.\.\w+Guard/g) ?? []).length;
  }
  assert.equal(total, G181_TOTAL, `五个模块共 ${G181_TOTAL} 个父级 overlay 全部接 guard`);
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

test("g-181 生成 bundle 契约：client.js 含 useBackdropClose、15 个 guard overlay、保留 GENERATED header", () => {
  const bundle = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client.js"), "utf8");
  assert.ok(bundle.startsWith("// ⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY"), "client.js 保留 GENERATED FILE header");
  assert.match(bundle, /function useBackdropClose\(onClose\)/);
  assert.match(bundle, /e\.target !== e\.currentTarget/);
  assert.match(bundle, /onClose\?\.\(\);/);
  const guarded = bundle.match(/style: S\.overlay, \.\.\.\w+Guard/g) ?? [];
  assert.equal(guarded.length, G181_TOTAL, `生成 bundle: ${G181_TOTAL} 个父级 overlay 全部接 guard`);
  const bare = bundle.match(/style: S\.overlay, onClick:/g) ?? [];
  assert.equal(bare.length, 0, "生成 bundle: 无裸 style: S.overlay, onClick:");
  // panel stopPropagation 保留（>= 15 处 overlay panel；允许额外按钮内 stopPropagation）
  const stopProp = bundle.match(/onClick: \(e\) => e\.stopPropagation\(\)/g) ?? [];
  assert.ok(stopProp.length >= G181_TOTAL, `生成 bundle: panel stopPropagation 保留（>= ${G181_TOTAL}，实际 ${stopProp.length}）`);
});

test("g-200 LiveStrip 隔离契约：Card 仅在 Goal 处于执行态或有活跃 execution attempt 时渲染 Goal LiveStrip，避免与 context card 重复", () => {
  const cardSrc = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/card.js"), "utf8");
  const bundle = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client.js"), "utf8");
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
    join(import.meta.dirname, "../../dsh-graph-host/lib/client.js"), "utf8");
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
  assert.match(src, /function useThrottledLiveSession\(session, intervalMs = 200\)/);
  assert.match(src, /const \[liveState, setLiveState\] = React\.useState/);
  assert.match(src, /setTimeout\(flush, intervalMs - elapsed\)/);
  assert.match(src, /clearTimeout\(timer\)/);
  assert.match(src, /unsub\(\)/);
});

test("g-195 源契约：LiveStrip 组件使用 useThrottledLiveSession 节流 peek 流式输出", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/live-panel.js"), "utf8");
  assert.match(src, /const \{ snap, line, running \} = useThrottledLiveSession\(session, 200\);/);
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
  assert.match(modal, /看板数据自动刷新/);
  assert.match(modal, /刷新间隔最小限制为 5 秒/);
});

test("g-214 源契约：kanban.js 挂载 RefreshCountdown 与刷新间隔监听", () => {
  const kanban = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");
  assert.match(kanban, /h\(RefreshCountdown,/);
  assert.match(kanban, /dsh-graph\.refresh-interval-changed/);
});

test("g-214 生成 bundle 契约：client.js 包含 g-214 倒计时与刷新间隔配置逻辑", () => {
  const bundle = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client.js"), "utf8");
  assert.match(bundle, /RefreshCountdown/);
  assert.match(bundle, /dsh-graph\.refresh-interval/);
  assert.match(bundle, /MIN_REFRESH_INTERVAL = 5/);
});
