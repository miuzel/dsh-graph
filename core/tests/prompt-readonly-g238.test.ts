/** g-238：system prompt 渲染纯读化回归测试。
 *  验证：
 *  ① 无 graph 数据的普通会话渲染全部 graph systemPrompt sections 后，
 *     不创建目录/文件、不追加事件（判据1）；
 *  ② 已配置主管的会话注入纪律提醒，普通/缺失 cwd 会话不注入（判据2）；
 *  ③ 渲染缓存按 project.yaml / memory.jsonl 文件指纹失效：
 *     记忆新增/撤回、主管身份变更立即生效，不跨 workspace 混用（判据3）；
 *  ④ 显式初始化（apply 带绝对 config.root）行为不变（判据4）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, addMemory, removeMemory, recallMemory } from "../ops.ts";
import { apply } from "../../dist/index.js";

/** 与 guide-injection.test.ts 相同的 mock ctx（捕获 section 注册）。 */
function makeMockCtx() {
  const sections: any[] = [];
  const registered: any[] = [];
  const ctx: any = {
    get: (key: string) => {
      if (key === "systemPrompt") {
        return {
          section: (section: any) => {
            sections.push(section);
            return () => {};
          },
        };
      }
      return undefined; // 无 sandboxPolicy / skills / webServer 等服务
    },
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (def: any) => {
        registered.push(def);
        return () => {};
      },
      get: () => ({}),
    },
  };
  return { ctx, sections, registered };
}

/** 收集 ws 下所有可见文件/目录（用于副作用断言）。 */
function listTree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    out.push(name.name);
    if (name.isDirectory()) out.push(...listTree(p).map((c) => `${name.name}/${c}`));
  }
  return out.sort();
}

test("g-238：无 graph 数据的普通会话渲染全部 sections 后不创建任何目录/文件", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g238-"));
  const { ctx, sections } = makeMockCtx();
  // 无显式 config.root、无 sandboxPolicy：apply 不 init（推迟初始化路径）
  apply(ctx, {});
  const graphSections = sections.filter((s) => typeof s.name === "string" && s.name.startsWith("dsh-graph-"));
  assert.ok(graphSections.length >= 3, "应注册 guide-hint / supervisor-discipline / standing-memory 等 sections");
  const before = listTree(ws);
  const renderCtx = { agent: { session: { id: "session-normal", header: { cwd: ws } } } };
  for (const s of graphSections) {
    const out = s.text(renderCtx);
    assert.ok(typeof out === "string", `${s.name} 渲染应返回字符串`);
    // 非 guide-hint 的 section 在无数据时必须为空
    if (s.name !== "dsh-graph-guide-hint") {
      assert.equal(out, "", `${s.name} 无数据时应返回空字符串`);
    }
  }
  const after = listTree(ws);
  assert.deepEqual(after, before, "渲染不得创建目录/文件/追加事件");
  assert.ok(!existsSync(join(ws, ".dsh-graph")), ".dsh-graph 不得由渲染路径创建");
});

test("g-238：主管会话注入纪律提醒，普通会话/缺失 cwd 不注入", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g238-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: session-super\n");
  const { ctx, sections } = makeMockCtx();
  apply(ctx, {});
  const section = sections.find((s) => s.name === "dsh-graph-supervisor-discipline");
  assert.ok(section);
  const sup = section.text({ agent: { session: { id: "session-super", header: { cwd: ws } } } });
  assert.ok(sup.includes("主管纪律提醒"), "主管会话应注入纪律提醒");
  assert.equal(section.text({ agent: { session: { id: "session-normal", header: { cwd: ws } } } }), "",
    "普通会话不注入");
  assert.equal(section.text({ agent: { session: { id: "session-super" } } }), "",
    "缺失 cwd 不注入");
  assert.equal(section.text({}), "", "无 agent 不注入");
});

test("g-238：渲染缓存按 project.yaml 指纹失效（主管身份变更立即生效）", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g238-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: session-a\n");
  const { ctx, sections } = makeMockCtx();
  apply(ctx, {});
  const section = sections.find((s) => s.name === "dsh-graph-supervisor-discipline");
  assert.ok(section);
  const render = (id: string) => section.text({ agent: { session: { id, header: { cwd: ws } } } });
  assert.ok(render("session-a").includes("主管纪律提醒"), "session-a 为现任主管");
  assert.equal(render("session-b"), "", "session-b 非主管");
  // 主管身份变更（换人）：文件指纹变化 → 缓存失效
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: session-b\n");
  assert.equal(render("session-a"), "", "旧主管身份不得因缓存残留");
  assert.ok(render("session-b").includes("主管纪律提醒"), "新主管立即生效");
});

test("g-238：standing-memory 缓存按 memory.jsonl 指纹失效（新增/撤回立即生效）", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g238-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const { ctx, sections } = makeMockCtx();
  apply(ctx, {});
  const section = sections.find((s) => s.name === "dsh-graph-standing-memory");
  assert.ok(section);
  const render = () => section.text({ agent: { session: { id: "session-x", header: { cwd: ws } } } });
  assert.equal(render(), "", "无记忆时为空");
  // 新增 standing 记忆 → 指纹变化 → 立即生效
  const { id } = addMemory(root, { kind: "project", text: "凭据绝不写入日志-238测试", scope: "standing", actor: "human:test" });
  const out1 = render();
  assert.ok(out1.includes("凭据绝不写入日志-238测试"), "新增记忆应立即渲染");
  // 撤回 → 立即失效，不得渲染已撤回约束
  removeMemory(root, { old: "凭据绝不写入日志-238测试", reason: "g-238 测试撤回", actor: "human:test" });
  assert.equal(render(), "", "撤回后不得因缓存残留已失效约束");
  void id;
});

test("g-238：缓存按 canonical.root 隔离，不跨 workspace 混用配置", () => {
  const wsA = mkdtempSync(join(tmpdir(), "dsh-graph-g238-a-"));
  const wsB = mkdtempSync(join(tmpdir(), "dsh-graph-g238-b-"));
  const rootA = join(wsA, ".dsh-graph");
  const rootB = join(wsB, ".dsh-graph");
  init(rootA);
  init(rootB);
  writeFileSync(join(rootA, "project.yaml"), "supervisor:\n  session: session-a\n");
  // wsB 未配置 supervisor
  const { ctx, sections } = makeMockCtx();
  apply(ctx, {});
  const sup = sections.find((s) => s.name === "dsh-graph-supervisor-discipline");
  assert.ok(sup);
  assert.ok(sup.text({ agent: { session: { id: "session-a", header: { cwd: wsA } } } }).includes("主管纪律提醒"));
  assert.equal(sup.text({ agent: { session: { id: "session-a", header: { cwd: wsB } } } }), "",
    "wsB 未配置主管，不得读 wsA 的配置");
  // wsA 加 standing 记忆，wsB 渲染不得混入
  addMemory(rootA, { kind: "project", text: "仅属于A项目的约束-238", scope: "standing", actor: "human:test" });
  const mem = sections.find((s) => s.name === "dsh-graph-standing-memory");
  assert.ok(mem.text({ agent: { session: { id: "s", header: { cwd: wsA } } } }).includes("仅属于A项目的约束-238"));
  assert.equal(mem.text({ agent: { session: { id: "s", header: { cwd: wsB } } } }), "",
    "wsB 不得混入 wsA 的记忆");
});

test("g-238：损坏的 project.yaml 渲染可控返回空，不崩溃", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g238-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: [broken\n  bad: : :\n");
  const { ctx, sections } = makeMockCtx();
  apply(ctx, {});
  const sup = sections.find((s) => s.name === "dsh-graph-supervisor-discipline");
  assert.equal(sup.text({ agent: { session: { id: "session-a", header: { cwd: ws } } } }), "",
    "损坏配置应 fail-closed 返回空");
});

test("g-238：显式绝对 config.root 的 apply 初始化行为不变", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g238-"));
  const root = join(ws, ".dsh-graph");
  const { ctx } = makeMockCtx();
  apply(ctx, { root });
  assert.ok(existsSync(root), "显式绝对 root 仍在 apply 时初始化");
});
