/**
 * core/tests/g496-publish-failclosed.test.ts
 *
 * g-496 **返工**（负责人 2026-10-15 裁定）：发布上下文的读取必须**按显式布局标记**取根，
 * 且发布形态**绝不回读源码树**。本文件把「曾经真实存在过的 fail-open」钉成必红回归。
 *
 * 背景（主管实测的原始 BUG）：`dist/` 位于源码仓库内时，旧的读取实现按
 * `["./prompts/…", "../prompts/…"]` 顺序尝试 ⇒ 包内资产缺失时 `../prompts/` 命中
 * **邻接的源码树**，于是「包内漏资产」被静默掩盖（`graph_help` 成功返回而不是抛错）。
 * 以「某资产是否存在」判别形态同样 fail-open：删掉那个哨兵资产即可让判别翻转。
 *
 * 现在的口径：`package.json` 的 `dsh.promptAssets.layout` 是**显式标记**
 * （源码 `source` / 发布 `merged`，由 build 写出）。标记决定唯一根，**不扫描 cwd、
 * 不做目录搜索、不以资产/目录存在性推断**。标记缺失或非法 ⇒ 明确失败（不偷归 source）。
 *
 * 覆盖（逐项对应负责人批准的 ④ 清单）：
 *   1. 发布包「缺契约哨兵 + 缺 guide」且**邻接源码仍在**时，仍不能加载；
 *   2. 整个包 `prompts/` 缺失、而源码 `prompts/` 存在时，仍不能加载；
 *   3. 任意命名的独立包（与仓库无关）可读包内资产（正向对照，确保上面两条不是恒真）；
 *   4. source 形态下 help 能读到**正确的层**（公共层，g-496 返工改判：help 归公共）；
 *   5. 公共/宿主同名冲突保护（build fail-closed）；
 *   6. 合法唯一 host 资产加入 build 仍成功（集合对账不因新增而阻断）；
 *   7. 标记缺失 / 非法 / 目录字段缺失 ⇒ 明确失败（不静默偷归 source）。
 *
 * 所有负向用例一律 **hermetic**：只在 `tmp/` 下复制包做变异，真实 `dist/` 与源码零改动。
 */

import { test } from "node:test";

import assert from "node:assert/strict";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = join(import.meta.dirname, "../..");
const distRoot = join(repoRoot, "dist");
const publicPrompts = join(repoRoot, "prompts");

/** 在仓库 `tmp/` 下开一个可写沙箱（不入版本控制；用后必删）。 */
function sandbox(prefix: string): { root: string; dispose: () => void } {
  const tmpBase = join(repoRoot, "tmp");
  mkdirSync(tmpBase, { recursive: true });
  const root = mkdtempSync(join(tmpBase, prefix));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** 把真实 `dist/` 复制成一个**任意名字**的包目录（发布形态自洽副本）。 */
function stagePackage(root: string, name = "arbitrary-package-name"): string {
  const pkg = join(root, name);
  cpSync(distRoot, pkg, { recursive: true, dereference: true });
  return pkg;
}

/** 让该包**邻接一份完整的源码公共层** —— 复刻「dist 被放在源码仓库内」的真实危险布局。 */
function plantAdjacentSource(root: string): string {
  const src = join(root, "prompts");
  cpSync(publicPrompts, src, { recursive: true });
  return src;
}

/** 以该包的 `index.js` 为入口注册工具，返回驱动 `graph_help` 的句柄。
 *
 *  刻意走**真实模块加载 + 真实 execute**：这正是主管复现 BUG 的路径；
 *  静态断言无法证明「加载成功」，只有真调用才能暴露 fail-open。 */
async function loadHelp(pkg: string): Promise<{ run: (args?: any) => Promise<any> } | { loadError: Error }> {
  let mod: any;
  try {
    mod = await import(pathToFileURL(join(pkg, "index.js")).href);
  } catch (error) {
    return { loadError: error as Error };
  }
  const registered: any[] = [];
  const ctx: any = {
    inject: () => ctx,
    effect: (fn: any) => fn(),
    get: (name: string) =>
      name === "webServer"
        ? { register: () => () => {} }
        : name === "skills"
          ? { register: () => () => {} }
          : null,
    tools: { register: (def: any) => { registered.push(def); return () => {}; }, get: () => ({}) },
  };
  try {
    mod.apply(ctx, {});
  } catch (error) {
    return { loadError: error as Error };
  }
  const def = registered.find((d) => d.name === "graph_help");
  assert.ok(def, "发布包必须注册 graph_help");
  return { run: (args: any = {}) => def.execute(args, { signal: new AbortController().signal }) };
}

/** 判定一次加载尝试是否**明确失败**（抛错），并返回可读原因。 */
async function expectFailure(pkg: string, what: string): Promise<string> {
  const handle: any = await loadHelp(pkg);
  if (handle.loadError) return handle.loadError.message;
  try {
    await handle.run({});
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail(`${what}：不得加载成功（发布上下文必须 fail-closed，绝不回读源码）`);
}

// ---------------------------------------------------------------- 正向基线

test("g-496 R-基线：真实 dist 包注册 graph_help 且能读资产（下面负向对照的前提）", async () => {
  const { root, dispose } = sandbox("g496r-base-");
  try {
    const pkg = stagePackage(root);
    const handle: any = await loadHelp(pkg);
    assert.ok(!handle.loadError, `真实发布包必须可加载：${handle.loadError?.message}`);
    const out = await handle.run({});
    assert.ok(out && (out.text || out.content || out), "graph_help 必须返回内容");
  } finally {
    dispose();
  }
});

// ---------------------------------------------------------------- ① 缺契约哨兵 + 缺 guide

test("g-496 R1：发布包缺契约哨兵 + 缺 guide，且邻接源码仍在 ⇒ 仍不能加载（不回读源码）", async () => {
  const { root, dispose } = sandbox("g496r1-");
  try {
    const pkg = stagePackage(root);
    const adjacent = plantAdjacentSource(root);
    // 前提断言：邻接源码**确实存在**且含我们要删的资产（否则本用例退化为恒真）。
    for (const n of ["agent-teams-contract.zh.md", "supervisor-guide.zh.md"]) {
      assert.ok(existsSync(join(adjacent, n)), `邻接源码必须含 ${n}（构造有效负向的前提）`);
    }
    rmSync(join(pkg, "prompts", "agent-teams-contract.zh.md"));
    rmSync(join(pkg, "prompts", "supervisor-guide.zh.md"));

    const reason = await expectFailure(pkg, "包内缺契约哨兵与 guide（邻接源码完整）");
    assert.match(reason, /prompt asset|layout|missing|unreadable/i, `失败原因必须可读，实得：${reason}`);
  } finally {
    dispose();
  }
});

// ---------------------------------------------------------------- ② 整个 prompts 缺失

test("g-496 R2：整个包 prompts/ 缺失、源码 prompts/ 存在 ⇒ 不能加载（不回读源码）", async () => {
  const { root, dispose } = sandbox("g496r2-");
  try {
    const pkg = stagePackage(root);
    const adjacent = plantAdjacentSource(root);
    assert.ok(existsSync(adjacent), "邻接源码 prompts/ 必须存在（构造有效负向的前提）");
    rmSync(join(pkg, "prompts"), { recursive: true, force: true });
    assert.ok(!existsSync(join(pkg, "prompts")), "包内 prompts/ 必须已删除");

    const reason = await expectFailure(pkg, "整个包 prompts/ 缺失（邻接源码完整）");
    assert.match(reason, /prompt asset|layout|missing|unreadable/i, `失败原因必须可读，实得：${reason}`);
  } finally {
    dispose();
  }
});

// ---------------------------------------------------------------- ③ 任意命名独立包

test("g-496 R3：任意命名的独立包（与仓库无关）可正常读取包内资产（正向对照）", async () => {
  const { root, dispose } = sandbox("g496r3-");
  try {
    // 刻意用一个**与 dist/仓库名毫无关系**的目录名，且**不**邻接任何源码树。
    const pkg = stagePackage(root, "totally-unrelated-name-xyz");
    assert.ok(!existsSync(join(root, "prompts")), "本用例不得有邻接源码（证明 reads 全来自包内）");
    const handle: any = await loadHelp(pkg);
    assert.ok(!handle.loadError, `独立包必须可加载：${handle.loadError?.message}`);
    const out = await handle.run({});
    assert.ok(out, "独立包 graph_help 必须返回内容");

    // 该包**不是**从仓库 dist 就地读取：它的根必须落在自己的目录里。
    const coreMod: any = await import(pathToFileURL(join(pkg, "core", "ops.js")).href);
    assert.ok(coreMod.resolvePromptAssetDirUrl().href.includes("/totally-unrelated-name-xyz/prompts/"),
      `定位必须随包（与目录名无关），实得 ${coreMod.resolvePromptAssetDirUrl().href}`);
  } finally {
    dispose();
  }
});

// ---------------------------------------------------------------- ④ source 形态 help 读对层

test("g-496 R4：source 形态下公共层资产归属 public、宿主专属资产归属 host，reader 各读其层", async () => {
  const marker = JSON.parse(readFileSync(join(repoRoot, "dsh-graph-host/package.json"), "utf8"));
  assert.equal(marker?.dsh?.promptAssets?.layout, "source", "源码清单必须声明 source 布局");
  assert.equal(marker?.dsh?.promptAssets?.publicDir, "../prompts", "source 公共层目录必须是 ../prompts");
  assert.equal(marker?.dsh?.promptAssets?.hostDir, "./prompts", "source 宿主层目录必须是 ./prompts");

  // 唯一注册表必须**携带所有权**。
  const hostSrc = readFileSync(join(repoRoot, "dsh-graph-host/index.js"), "utf8");
  assert.ok(!/HOST_OWNED_PROMPT_ASSETS\s*=\s*new Set\(/.test(hostSrc),
    "不得再持有第二份宿主专属清单（所有权必须与注册表同源）");
  // g-496 att-007：宿主专属层现在**确有** host 资产（9 类 GUI 提示词模板 × zh/en = 18）。
  // 原断言「注册表不得再有 host 登记」编码的是该层为空时的状态；分层判据本身不变 ——
  // 改为断言：host 登记**恰好**覆盖宿主专属层的 18 份，且每份都标 host（归属不得漏标/多标）。
  const hostAssetNames = readdirSync(join(repoRoot, "dsh-graph-host/prompts")).filter((n) => n.endsWith(".md"));
  assert.equal(hostAssetNames.length, 18, `宿主专属层应恰 18 份，实得 ${hostAssetNames.length}`);
  for (const n of hostAssetNames) {
    assert.ok(hostSrc.includes(`{ name: "${n}", ownership: "host"`),
      `${n} 必须在注册表中登记为 host（源码位于宿主专属层）`);
  }
  // 反向：注册表里 host 条目的条数必须恰等于宿主层文件数（不得多标）。
  const hostRegCount = (hostSrc.match(/ownership:\s*"host"/g) ?? []).length;
  assert.equal(hostRegCount, hostAssetNames.length,
    `注册表 host 条目数（${hostRegCount}）必须等于宿主专属层文件数（${hostAssetNames.length}）`);

  // 真实行为：模拟 source 形态（登记表 → 建包内 prompts 仅含 host 层、公共层在包外），
  // 断言 help 从**公共层**读到正文，而不是从空的 host 层。
  const { root, dispose } = sandbox("g496r4-");
  try {
    const pkg = join(root, "source-form-pkg");
    cpSync(join(distRoot, "index.js"), join(pkg, "index.js"));
    cpSync(join(distRoot, "core"), join(pkg, "core"), { recursive: true });
    cpSync(join(distRoot, "lib"), join(pkg, "lib"), { recursive: true });
    mkdirSync(join(pkg, "prompts"), { recursive: true });

    // 「包外公共层」（source 形态的 `../prompts`）—— help 等公共资产的**真源**。
    const outerPublic = join(root, "prompts");
    cpSync(publicPrompts, outerPublic, { recursive: true });

    // 宿主专属层（包内 `./prompts`）：**不含任何公共资产** —— 若 reader 误走 host 层，
    // 公共资产（含 help）就会读不到（这正是返工前「源形态读取错根」的形态）。
    // 但 `core`（`dist/core/ops.js`）的定位是相对自身的 `../prompts` = `pkg/prompts`，
    // 故包内也须放一份公共资产，**否则连模块加载都过不去**（前置条件，与 help 归属无关）。
    cpSync(publicPrompts, join(pkg, "prompts"), { recursive: true });

    writeFileSync(join(pkg, "package.json"), JSON.stringify({
      name: "source-form", type: "module", main: "index.js",
      dsh: { promptAssets: { layout: "source", publicDir: "../prompts", hostDir: "./prompts" } },
    }, null, 2));

    const handle: any = await loadHelp(pkg);
    assert.ok(!handle.loadError, `source 形态包必须可加载：${handle.loadError?.message}`);
    const out = await handle.run({});
    assert.ok(out, "source 形态下 graph_help 必须读到公共层 help 正文");

    // 决定性判据：只把**包外公共层**的 help 移走（包内副本仍在）—— 若 host reader 真按
    // 「help 归公共层」取根，此处必须失败；若它误走 host 层（读包内副本），则会**成功**。
    rmSync(join(outerPublic, "help.zh.md"));
    assert.ok(existsSync(join(pkg, "prompts", "help.zh.md")),
      "构造前提：包内副本必须仍在（否则无法区分「读对层」与「两层都缺」）");
    const reason = await expectFailure(pkg, "source 形态公共层 help 被移走（包内副本仍在）");
    assert.match(reason, /prompt asset|missing|unreadable/i, `失败原因必须可读，实得：${reason}`);
  } finally {
    dispose();
  }
});

// ---------------------------------------------------------------- ⑤ 同名冲突

test("g-496 R5：公共/宿主同名冲突保护（build fail-closed，不覆盖）", () => {
  const build = readFileSync(join(repoRoot, "scripts/build.sh"), "utf8");
  assert.match(build, /提示词资产同名冲突/, "build 必须检测并报告同名冲突");
  assert.match(build, /exit 1/, "冲突必须 fail-closed 退出");

  // 真实执行：在沙箱镜像里注入一个同名资产，跑 build.sh 的该段逻辑必须判红。
  const { root, dispose } = sandbox("g496r5-");
  try {
    // 复刻 build.sh 的合并语义到独立沙箱（直接跑真 build 会真构建，代价过大且与宿主争用）。
    const mergeLogic = (srcDirs: string[], dest: string) => {
      mkdirSync(dest, { recursive: true });
      for (const src of srcDirs) {
        if (!existsSync(src)) continue;
        for (const f of readdirSync(src).filter((n) => n.endsWith(".md"))) {
          const target = join(dest, f);
          if (existsSync(target)) throw new Error(`提示词资产同名冲突：${f}`);
          cpSync(join(src, f), target);
        }
      }
    };
    const pub = join(root, "prompts");
    const host = join(root, "host-prompts");
    mkdirSync(pub, { recursive: true });
    mkdirSync(host, { recursive: true });
    writeFileSync(join(pub, "dup.zh.md"), "public\n");
    writeFileSync(join(host, "dup.zh.md"), "host\n");
    assert.throws(() => mergeLogic([pub, host], join(root, "out")), /同名冲突/, "同名资产必须判红");

    // 正向对照：不同名时不得误红。
    rmSync(join(host, "dup.zh.md"));
    writeFileSync(join(host, "unique-host.zh.md"), "host\n");
    assert.doesNotThrow(() => mergeLogic([pub, host], join(root, "out2")), "不同名不得误红");
  } finally {
    dispose();
  }
});

// ---------------------------------------------------------------- ⑥ 合法唯一 host 资产

test("g-496 R6：新增合法唯一 host 资产后 build 仍成功（集合对账不因新增而阻断）", () => {
  const build = readFileSync(join(repoRoot, "scripts/build.sh"), "utf8");
  // ① 不得再有硬编码的资产总数（那是会阻断后续合法新增的维护快照）。
  assert.ok(!/期望 26|!= "26"/.test(build), "不得再有硬编码资产数（改为集合对账）");
  assert.match(build, /_prompt_src_list/, "必须有来源集合清单");
  assert.match(build, /_prompt_dist_list/, "必须有产物集合清单");
  assert.match(build, /diff -u "\$_prompt_src_list" "\$_prompt_dist_list"/, "必须双向 diff 对账");
  assert.match(build, /完整性对账失败/, "对账失败必须明确报错");

  // ② 真实行为：把「公共 + 宿主」来源集合加上一个**新的唯一 host 资产**跑同一段对账逻辑，
  //    必须成功（证明新增合法 host 资产不会被阻断）。
  const { root, dispose } = sandbox("g496r6-");
  try {
    const pub = join(root, "prompts");
    const host = join(root, "host-prompts");
    const out = join(root, "out");
    mkdirSync(pub, { recursive: true });
    mkdirSync(host, { recursive: true });
    writeFileSync(join(pub, "a.zh.md"), "a\n");
    writeFileSync(join(host, "new-gui-template.zh.md"), "gui\n");
    // 合并（同名冲突保护在先）
    mkdirSync(out, { recursive: true });
    for (const src of [pub, host]) {
      for (const f of readdirSync(src).filter((n) => n.endsWith(".md"))) {
        const target = join(out, f);
        assert.ok(!existsSync(target), `不得同名：${f}`);
        cpSync(join(src, f), target);
      }
    }
    // 集合对账（与 build.sh 同口径）：来源并集 == 产物集合，双向。
    const srcNames = [...readdirSync(pub), ...readdirSync(host)].filter((n) => n.endsWith(".md")).sort();
    const distNames = readdirSync(out).filter((n) => n.endsWith(".md")).sort();
    assert.deepEqual(distNames, srcNames, "新增唯一 host 资产后，产物集合必须仍与来源集合并集相等");
    assert.ok(distNames.includes("new-gui-template.zh.md"),
      "新增的合法 host 资产必须被纳入产物（不被固定计数阻断）");
  } finally {
    dispose();
  }
});

// ---------------------------------------------------------------- ⑦ 标记缺失/非法

test("g-496 R7：布局标记缺失或非法 ⇒ 发布上下文明确失败（绝不静默偷归 source）", async () => {
  const cases: Array<[string, any, RegExp]> = [
    ["标记整体缺失", undefined, /layout marker missing|layout/i],
    ["layout 取值非法", { layout: "whatever" }, /unknown layout|invalid/i],
    ["merged 缺 dir 字段", { layout: "merged" }, /dir required|invalid/i],
    ["source 缺 publicDir/hostDir", { layout: "source" }, /publicDir\/hostDir required|invalid/i],
  ];
  for (const [what, promptAssets, expect] of cases) {
    const { root, dispose } = sandbox("g496r7-");
    try {
      const pkg = stagePackage(root);
      plantAdjacentSource(root); // 邻接源码完整：偷归 source 就会「成功」，从而被这里抓住
      const pkgJson = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
      if (promptAssets === undefined) delete pkgJson.dsh.promptAssets;
      else pkgJson.dsh.promptAssets = promptAssets;
      writeFileSync(join(pkg, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");

      const reason = await expectFailure(pkg, `发布包${what}（邻接源码完整）`);
      assert.match(reason, expect, `${what}：失败原因必须点名布局配置问题，实得：${reason}`);
    } finally {
      dispose();
    }
  }
});

// ---------------------------------------------------------------- ⑧ 运行态紧锁常量

test("g-496 R8：运行态 merged 根常量与构建常量、g312 期望对象三处一字不差（防漂移）", async () => {
  const dist: any = await import(pathToFileURL(join(distRoot, "index.js")).href);
  assert.equal(dist.MERGED_PROMPT_ASSET_DIR, "./prompts",
    "运行时常量必须是确切构建常量 ./prompts");

  // 三处同源：运行时常量 == build.sh 写出的值 == g312 的期望对象。
  const built = JSON.parse(readFileSync(join(distRoot, "package.json"), "utf8"));
  assert.equal(built?.dsh?.promptAssets?.dir, dist.MERGED_PROMPT_ASSET_DIR,
    "发布清单 dir 必须等于运行时常量");
  assert.equal(built?.dsh?.promptAssets?.layout, "merged", "发布清单必须是 merged");

  const build = readFileSync(join(repoRoot, "scripts/build.sh"), "utf8");
  assert.match(build, /layout:\s*"merged"/, "build.sh 必须写出 merged 布局");
  assert.match(build, /dir:\s*"\.\/prompts"/, "build.sh 必须写出确切 dir ./prompts");

  // 运行态紧锁：不等于确切常量一律 layout invalid（不解析、不归一、不判定「是否在包内」）。
  const hostSrc = readFileSync(join(repoRoot, "dsh-graph-host/index.js"), "utf8");
  assert.match(hostSrc, /dir !== MERGED_PROMPT_ASSET_DIR/, "merged 分支必须与确切常量严格比较");
  // 运行态紧锁：**不得**对 dir 做路径归一/包内判定（那会重新引入「某种取值也算合法」的判据面）。
  // 断言的是「不存在对 dir 的加工」，不是「文件里不出现 resolve/normalize 字样」。
  assert.ok(!/isInsidePackage|isWithinPackage|assertInsidePackage/.test(hostSrc),
    "不得引入「是否在包内」的通用判定框架（运行态紧锁 = 严格等值比较）");
  // 只看 **merged 分支那一段**（`resolvePromptAssetRoots` 函数体），避免误伤别处的同名变量。
  const mergedBranch = hostSrc.slice(
    hostSrc.indexOf('if (layout === "merged")'),
    hostSrc.indexOf('if (layout === "source")'),
  );
  assert.ok(mergedBranch.length > 0, "必须能定位 merged 分支源码");
  assert.ok(!/(resolve|normalize|join|relative)\s*\(\s*dir\b/.test(mergedBranch),
    "merged 分支不得对 dir 做路径解析/归一（只允许严格等值比较）");
});

test("g-496 R9（负向·运行态）：merged 的 dir 被篡改为包外或非确切值 ⇒ 加载即 fail-closed", async () => {
  for (const dir of ["../prompts", "./prompts/", "prompts", ".", "..", "/tmp/prompts", "./prompts/../prompts"]) {
    const { root, dispose } = sandbox("g496r9-");
    try {
      const pkg = stagePackage(root);
      plantAdjacentSource(root); // 邻接源码完整：误信 dir 就会「成功」，从而被抓住
      const pkgJson = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
      pkgJson.dsh.promptAssets = { layout: "merged", dir };
      writeFileSync(join(pkg, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");
      const reason = await expectFailure(pkg, `merged dir=${JSON.stringify(dir)}`);
      assert.match(reason, /layout invalid/i, `必须点名 layout invalid，实得：${reason}`);
    } finally {
      dispose();
    }
  }
});
