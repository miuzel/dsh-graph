/**
 * g-425：`dsh.client.inject` 死引用守卫（fail-closed，**无豁免开关**）。
 *
 * 为什么需要（真实成因链，逐条已取证，勿再推翻）：
 *  1. 浏览器端 loader `@deepseek-ai/dsh-client-modules/lib/client.js:655-658` 只对 `row.inject` 中
 *     **存在于客户端清单**的包名做前置加载（`arriveDependency`）；`graphRows.get(name) === undefined`
 *     时**静默跳过** ⇒ 该字段是**加载顺序边**（有目标行才前置加载），不是硬依赖、也不是「纯名录」。
 *  2. `@deepseek-ai/dsh-client-runtime` 的包清单**声明了 `dsh.client`（platform:web、immediately:true）**
 *     （npm 0.0.1-rc.1 / 0.1.1-rc.2 实测）⇒ 升级过程残留的旧副本会**重新变成一条客户端清单行**；
 *     而它在四条受支持宿主线上**都不在安装树里**（dsh 0.1.5-rc.2 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-alpha.2 实测）。
 *     ⇒ 声明它 = 本插件成为「残留坏行」的消费者，坏行失败会被级联成本插件条目失败
 *     （`client-modules: "dsh-graph" not loaded because dependency "…" failed`）；干净安装无该行故不复现。
 *  3. 负责人已在**干净安装的桌面版**上复现 issue#1 ⇒ 真实缺陷。桌面壳真机在本机不可得
 *     （`@deepseek-ai/dsh-desktop` npm E404），**本守卫不声称在本机复现了桌面症状**。
 *
 * 判据覆盖：
 *  1. 源清单每个 inject 名都必须在 `INJECT_REGISTRY` 登记，且能证明是
 *     「在 ≥1 条受支持宿主线上确为客户端清单行」（class=row）或
 *     「无 `dsh.client` 字段、只被 require 当模块用、永不成行」（class=inert-module）。
 *  2. 未登记名 / row 类空 hosts / inert-module 找不到对应 `require("…")` 一律**判红**。
 *  3. 负向对照可实拍（夹具清单确报红 + 正向样本全绿，证明检查函数真被执行）。
 *  4. 死引用回归钉：清单再次出现 `@deepseek-ai/dsh-client-runtime` 必红。
 *  5. 反越界：客户端模块运行时服务依赖仍为 `["slots","sessions"]`（本目标不得动服务依赖）。
 *  6. `dist/package.json` 存在时同口径校验其 inject 与源一致（防「只改源不重建」）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");
const SOURCE_PKG = join(repoRoot, "dsh-graph-host", "package.json");
const DIST_PKG = join(repoRoot, "dist", "package.json");
const CLIENT_SRC_DIR = join(repoRoot, "dsh-graph-host", "lib", "client");

type InjectClass = "row" | "inert-module";

interface InjectEntry {
  /** row = 客户端清单行；inert-module = 无 dsh.client 字段、只被 require 当模块用。 */
  class: InjectClass;
  /** class=row 必填且非空：哪些受支持宿主线上它确实是客户端清单行。 */
  hosts?: string[];
  /** 必填：可核验的出处（实测位置/文件/行号）。 */
  evidence: string;
  /** class=inert-module 必填：本仓客户端源码里真实存在的 require("…") specifier。 */
  required_by?: string;
}

/** 本包宿主兼容范围覆盖的受支持宿主线（验收范围，勿擅自扩表）。 */
const SUPPORTED_HOSTS = ["0.1.5-rc.2", "0.1.7-rc.2", "0.2.0-rc.2", "0.2.1-alpha.2"];

/**
 * inject 登记表：源清单里每个名字都必须在此登记，否则 fail-closed 判红。
 * 新增名字前必须先给出「客户端清单行」或「纯模块依赖」的可核验证据，不接受口头理由。
 */
const INJECT_REGISTRY: Record<string, InjectEntry> = {
  "@deepseek-ai/dsh-client-ui-settings": {
    class: "row",
    hosts: ["0.1.5-rc.2", "0.1.7-rc.2", "0.2.0-rc.2", "0.2.1-alpha.2"],
    evidence:
      "0.1.x：隔离实例 dsh 0.1.5-rc.2 / 0.1.7-rc.2 的 web profile effective-config.yml 客户端清单均含该行；" +
      "0.2.0-rc.2：安装树 .pnpm/@deepseek-ai+dsh-client-ui-settings/*/package.json 声明 dsh.client（platform:web）；" +
      "0.2.1-alpha.2：实读安装树 .pnpm/@deepseek-ai+dsh-client-ui-settings@0.2.1-alpha.2_*/node_modules/@deepseek-ai/dsh-client-ui-settings/package.json " +
      "L28-33 声明 dsh.client（inject=[@deepseek-ai/dsh-api-remotes]、platform:\"web\"）；composed 配置 " +
      "tmp/dsh-test/0.2.1-alpha.2/effective-config.yml L538-539 亦有该 id/name 行",
  },
  "@deepseek-ai/dsh-client-ui-sidebar-right": {
    class: "row",
    hosts: ["0.1.5-rc.2", "0.1.7-rc.2", "0.2.0-rc.2", "0.2.1-alpha.2"],
    evidence:
      "同 ui-settings 口径：0.1.x effective-config.yml 客户端清单行 + 0.2.0-rc.2 安装树 .pnpm/@deepseek-ai+dsh-client-ui-sidebar-right/*/package.json 声明 dsh.client；" +
      "0.2.1-alpha.2：实读安装树 .pnpm/@deepseek-ai+dsh-client-ui-sidebar-right@0.2.1-alpha.2_*/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/package.json " +
      "L28-38（dsh.client，platform:\"web\"）；composed 配置 tmp/dsh-test/0.2.1-alpha.2/effective-config.yml L526 该 name 行",
  },
  "@deepseek-ai/dsh-client-ui-primitives": {
    class: "inert-module",
    required_by: "@deepseek-ai/dsh-client-ui-primitives",
    evidence:
      "该包清单**无 `dsh` 字段** ⇒ 永远成不了客户端清单行（0.2.1-alpha.2 安装树 " +
      ".pnpm/@deepseek-ai+dsh-client-ui-primitives@0.2.1-alpha.2_*/…/package.json 亦 grep \"dsh\" 0 命中）；" +
      "本仓客户端 _wrapper-top.js 以 require(\"@deepseek-ai/dsh-client-ui-primitives\") 当模块用（MarkdownText 原语）",
  },
};

/**
 * 死引用黑名单：出现即判红，**即使有人把它补进 INJECT_REGISTRY 也仍然判红**。
 * `@deepseek-ai/dsh-client-runtime`：最后发布 2026-08-21、未随 dsh 0.2.x 分发；但它的包清单
 * 声明了 `dsh.client`（platform:web、immediately:true）⇒ 升级残留副本会重新变成客户端清单行，
 * 而它在 0.1.5-rc.2 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-alpha.2 四条受支持线上都不在安装树里 ⇒ 让它成行必级联失败。
 * 机制出处：`@deepseek-ai/dsh-client-modules/lib/client.js:655-658`（只对存在于清单的 inject 名前置加载）。
 */
const DEAD_REFERENCES: Record<string, string> = {
  "@deepseek-ai/dsh-client-runtime":
    "死引用 @deepseek-ai/dsh-client-runtime：该包未随 dsh 0.1.5-rc.2/0.1.7-rc.2/0.2.0-rc.2/0.2.1-alpha.2 分发（安装树 0 命中），" +
    "但其包清单声明 dsh.client ⇒ 升级残留副本会重新成为客户端清单行并把本插件一起拖死" +
    "（client-modules/lib/client.js:655-658：inject 名存在则前置加载；坏行失败级联）。绝不声明用不到的名字。",
};

function clientSourceText(): string {
  return readdirSync(CLIENT_SRC_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => readFileSync(join(CLIENT_SRC_DIR, f), "utf8"))
    .join("\n");
}

function hasRequire(source: string, specifier: string): boolean {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`require\\(\\s*(['"])${escaped}\\1\\s*\\)`).test(source);
}

/**
 * 判定函数（唯一实现）：返回问题列表，**空数组 = 通过**；任何一条即判红。
 * registry / clientSource 可注入，用于负向对照夹具（真实调用不传，走真实登记表与真实源码）。
 */
function injectProblems(
  inject: unknown,
  opts: { registry?: Record<string, InjectEntry>; clientSource?: string; supportedHosts?: string[] } = {},
): string[] {
  const registry = opts.registry ?? INJECT_REGISTRY;
  const source = opts.clientSource ?? clientSourceText();
  const hosts = opts.supportedHosts ?? SUPPORTED_HOSTS;
  const problems: string[] = [];

  if (!Array.isArray(inject)) return ["dsh.client.inject 必须是数组"];
  // 空表是**合法且最安全**的状态：零条依赖边 ⇒ loader 按「无前置依赖」处理，绝无坏行可级联。
  // 本守卫**不禁止空表**——本次事故的根因恰恰是「声明了用不到的名字」，禁止空表等于逼未来的
  // 维护者在宿主线变化时为过守卫而保留/添加一个用不到的名字，即把事故成因写进守卫。
  // 被判红的只有：未登记名、证据缺失、row 类空 hosts / hosts 越出 SUPPORTED_HOSTS、
  // inert-module 的 required_by 与本仓真实 require() 对不上、重复名、非 string、死引用黑名单。

  const seen = new Set<string>();
  for (const raw of inject) {
    if (typeof raw !== "string" || raw.trim() === "") {
      problems.push(`inject 名必须是非空 string：${JSON.stringify(raw)}`);
      continue;
    }
    if (seen.has(raw)) problems.push(`inject 名单重复：${raw}`);
    seen.add(raw);

    const dead = DEAD_REFERENCES[raw];
    if (dead) problems.push(dead);

    const entry = registry[raw];
    if (!entry) {
      problems.push(
        `未登记名：${raw}（不在 INJECT_REGISTRY ⇒ fail-closed 判红；登记前必须证明它是客户端清单行或纯模块依赖）`,
      );
      continue;
    }
    if (typeof entry.evidence !== "string" || entry.evidence.trim() === "") {
      problems.push(`登记项缺证据串：${raw}`);
    }
    if (entry.class === "row") {
      if (!Array.isArray(entry.hosts) || entry.hosts.length === 0) {
        problems.push(`row 类空 hosts：${raw}（必须给出 ≥1 条受支持宿主线上它确为客户端清单行）`);
      } else {
        for (const host of entry.hosts) {
          if (!hosts.includes(host)) problems.push(`row 类 hosts 含未受支持宿主线：${raw} → ${host}`);
        }
      }
    } else if (entry.class === "inert-module") {
      const spec = entry.required_by;
      if (typeof spec !== "string" || spec.trim() === "") {
        problems.push(`inert-module 缺 required_by：${raw}`);
      } else if (!hasRequire(source, spec)) {
        problems.push(`inert-module 找不到对应 require("${spec}")：${raw}（须是客户端源码里真实存在的 specifier）`);
      }
    } else {
      problems.push(`未知 class：${raw} → ${String((entry as { class?: unknown }).class)}`);
    }
  }
  return problems;
}

/** dist 与源 inject 一致性判定（唯一实现）：不一致即判红。 */
function distInjectProblems(sourceInject: unknown, distInject: unknown): string[] {
  const a = Array.isArray(sourceInject) ? sourceInject : [];
  const b = Array.isArray(distInject) ? distInject : null;
  if (b === null) return ["dist/package.json 的 dsh.client.inject 不是数组"];
  const problems = injectProblems(b);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    problems.push(
      `dist/package.json 的 inject 与源不一致（源=${JSON.stringify(a)}，dist=${JSON.stringify(b)}）` +
        `：源改了必须重建（bash scripts/build.sh）`,
    );
  }
  return problems;
}

function readPkg(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function injectOf(pkgPath: string): unknown {
  return readPkg(pkgPath).dsh?.client?.inject;
}

const deadName = "@deepseek-ai/dsh-client-runtime";
const fixtureRow = "@deepseek-ai/dsh-client-ui-fixture-row";

// ------------------------------------------------------------------ 判据 1 / 4

test("g-425 判据1/4：源清单每个 inject 名 ∈ 登记表，且不含死引用 @deepseek-ai/dsh-client-runtime", () => {
  const inject = injectOf(SOURCE_PKG);
  assert.ok(Array.isArray(inject), "源 dsh-graph-host/package.json 必须有 dsh.client.inject 数组");
  assert.ok(!(inject as string[]).includes(deadName), `源 inject 不得包含死引用 ${deadName}`);
  assert.deepEqual(injectProblems(inject), [], `源 inject 必须全部可证明：${JSON.stringify(inject)}`);
  assert.deepEqual(inject, [
    "@deepseek-ai/dsh-client-ui-settings",
    "@deepseek-ai/dsh-client-ui-primitives",
    "@deepseek-ai/dsh-client-ui-sidebar-right",
  ]);
});

test("g-425 判据1：登记表自洽——row 类非空 hosts 且落在受支持宿主线，inert-module 有可解析 require", () => {
  const problems = injectProblems(Object.keys(INJECT_REGISTRY));
  assert.deepEqual(problems, [], `登记表自身必须自洽：${JSON.stringify(problems)}`);
  for (const [name, entry] of Object.entries(INJECT_REGISTRY)) {
    if (entry.class === "row") assert.ok((entry.hosts ?? []).length > 0, `${name} 是 row 类必须有 hosts`);
    else assert.ok(entry.required_by, `${name} 是 inert-module 必须有 required_by`);
  }
});

test("g-425 判据2：空表合法且最安全——禁止的是未登记名/证据缺失/黑名单命中，不是空表", () => {
  // 空表 = 零条加载顺序边（loader 对缺省即按空表处理）⇒ 无坏行可级联，是**最安全**状态。
  // 本次事故根因是「声明了用不到的名字」，故守卫绝不能禁止空表：那会逼维护者在宿主线变化时
  // 为过守卫而保留/添加用不到的名字，等于把事故成因写进守卫本身。
  assert.deepEqual(injectProblems([]), [], "空 inject 表必须全绿（零依赖边最安全）");
  // dist 同口径判定里，源与 dist 同为 [] 也必须全绿（只有与源不一致才判红）
  assert.deepEqual(distInjectProblems([], []), [], "源与 dist 同为空表必须全绿");
  // 反向对照：非空 + 未登记名仍然必红（证明「空表全绿」不是因为判定函数被短路）
  assert.ok(injectProblems(["@deepseek-ai/dsh-client-ui-not-registered"]).length > 0, "非空未登记名仍必红");
  // 源与 dist 一个空、一个非空 ⇒ 仍按「与源不一致」判红（空表合法 ≠ 可以不同步）
  assert.ok(distInjectProblems(["@deepseek-ai/dsh-client-ui-settings"], []).length > 0, "源/dist 不一致仍必红");
});

// ------------------------------------------------------------------ 判据 2 / 3（负向对照）

test("g-425 判据2/3：负向对照——未登记名必红，且同用例正向样本全绿（证明检查函数真被执行）", () => {
  const realInject = injectOf(SOURCE_PKG) as string[];
  // 正向样本：真实清单必须全绿（若检查函数从未被执行，下面这条会因对比失效而暴露）
  assert.deepEqual(injectProblems(realInject), [], "正向样本必须全绿");

  const fixture = [...realInject, "@deepseek-ai/dsh-client-ui-not-registered"];
  const problems = injectProblems(fixture);
  assert.ok(problems.length > 0, "注入未登记名必须判红");
  assert.ok(
    problems.some((p) => p.includes("未登记名") && p.includes("dsh-client-ui-not-registered")),
    `必须点名未登记名，实际：${JSON.stringify(problems)}`,
  );
  // 检查函数确实在跑：同一输入换个名字就从红变绿
  assert.deepEqual(injectProblems([...realInject]), [], "未注入未登记名时仍须全绿");
});

test("g-425 判据2/3：负向对照——row 类空 hosts 必红，正向同表全绿", () => {
  const registry: Record<string, InjectEntry> = {
    ...INJECT_REGISTRY,
    [fixtureRow]: { class: "row", hosts: [], evidence: "夹具：故意留空 hosts" },
  };
  const withEmptyHosts = injectProblems([fixtureRow], { registry });
  assert.ok(withEmptyHosts.length > 0, "row 类空 hosts 必须判红");
  assert.ok(
    withEmptyHosts.some((p) => p.includes("row 类空 hosts") && p.includes(fixtureRow)),
    `必须点名 row 类空 hosts，实际：${JSON.stringify(withEmptyHosts)}`,
  );

  const fixed = injectProblems([fixtureRow], {
    registry: { ...registry, [fixtureRow]: { class: "row", hosts: ["0.2.0-rc.2"], evidence: "夹具：补上 hosts" } },
  });
  assert.deepEqual(fixed, [], "同一夹具补上 hosts 后必须全绿（证明判红来自空 hosts 而非夹具本身）");
});

test("g-425 判据2：负向对照——inert-module 找不到对应 require 必红", () => {
  const registry: Record<string, InjectEntry> = {
    ...INJECT_REGISTRY,
    [fixtureRow]: { class: "inert-module", required_by: "@deepseek-ai/dsh-client-no-such-require", evidence: "夹具" },
  };
  const problems = injectProblems([fixtureRow], { registry });
  assert.ok(problems.length > 0, "inert-module 无对应 require 必须判红");
  assert.ok(
    problems.some((p) => p.includes("找不到对应 require") && p.includes("dsh-client-no-such-require")),
    `必须点名缺失的 require，实际：${JSON.stringify(problems)}`,
  );
  // 用真实存在的一条 require 复核同一夹具 → 绿
  const ok = injectProblems([fixtureRow], {
    registry: {
      ...registry,
      [fixtureRow]: {
        class: "inert-module",
        required_by: "@deepseek-ai/dsh-client-ui-primitives",
        evidence: "夹具：真实存在的 require",
      },
    },
  });
  assert.deepEqual(ok, [], "required_by 指向真实 require 时必须全绿");
});

// ------------------------------------------------------------------ 判据 4（回归钉）

test("g-425 判据4：死引用回归钉——清单再次出现 @deepseek-ai/dsh-client-runtime 必红（含成因）", () => {
  const names = (injectOf(SOURCE_PKG) as string[]) ?? [];
  const problems = injectProblems([...names, deadName]);
  assert.ok(problems.length > 0, `重新声明 ${deadName} 必须判红`);
  const hit = problems.find((p) => p.includes(deadName) && p.includes("死引用"));
  assert.ok(hit, `必须给出死引用判红条目，实际：${JSON.stringify(problems)}`);
  assert.match(hit!, /dsh\.client/, "判红说明必须交代「该包声明 dsh.client ⇒ 残留副本会成行」这一成因");
  assert.match(hit!, /client\.js:655-658/, "判红说明必须给出 loader 机制出处");
  // 即便有人把它补进登记表，黑名单仍然判红（无豁免开关）
  const bypassAttempt = injectProblems([deadName], {
    registry: { [deadName]: { class: "row", hosts: ["0.2.0-rc.2"], evidence: "试图豁免" } },
  });
  assert.ok(bypassAttempt.some((p) => p.includes("死引用")), "登记表不得豁免死引用黑名单");
});

// ------------------------------------------------------------------ 判据 5（反越界钉）

test("g-425 判据5：反越界钉——客户端模块运行时服务依赖仍为 [slots, sessions]（逐字未变）", () => {
  const src = readFileSync(join(CLIENT_SRC_DIR, "plugin.js"), "utf8");
  assert.match(src, /inject: \["slots", "sessions"\]/, "客户端硬 inject 必须逐字仍为 [slots, sessions]");
  // 只数**代码行**形态（行首即 inject:），注释里提到该串不算一处声明
  assert.equal(
    src.match(/^[ \t]*inject: \["slots", "sessions"\],[ \t]*$/gm)!.length,
    1,
    "硬 inject 声明应恰有一处代码行（多出即越界）",
  );
  // 本目标不得把可选能力（右侧栏/远程）塞进硬 inject
  assert.doesNotMatch(src, /inject: \[[^\]]*"sidebarRightTabs"[^\]]*\]/);
  assert.doesNotMatch(src, /inject: \[[^\]]*"remote"[^\]]*\]/);
});

// ------------------------------------------------------------------ 判据 6（dist 同口径）

test("g-425 判据6：dist/package.json 存在时其 inject 与源一致（防只改源不重建）", () => {
  const sourceInject = injectOf(SOURCE_PKG);
  // 判定逻辑先做夹具负向对照，确保「只改源不重建」这条真的会被抓到
  const fixtureProblems = distInjectProblems(sourceInject, [
    deadName,
    "@deepseek-ai/dsh-client-ui-settings",
    "@deepseek-ai/dsh-client-ui-primitives",
    "@deepseek-ai/dsh-client-ui-sidebar-right",
  ]);
  assert.ok(fixtureProblems.length > 0, "陈旧 dist（仍含死引用的 4 项）必须判红");
  assert.ok(
    fixtureProblems.some((p) => p.includes("死引用") || p.includes("与源不一致")),
    `夹具必须命中死引用/不一致，实际：${JSON.stringify(fixtureProblems)}`,
  );
  assert.deepEqual(distInjectProblems(sourceInject, sourceInject), [], "同值夹具必须全绿");

  if (existsSync(DIST_PKG)) {
    const distInject = injectOf(DIST_PKG);
    assert.deepEqual(
      distInjectProblems(sourceInject, distInject),
      [],
      `dist/package.json 的 inject 必须与源同口径通过：${JSON.stringify(distInject)}`,
    );
  } else {
    // dist 缺失不是本守卫的责任（只读新鲜度守卫 g-312 会判红）；此处只留可追踪痕迹
    assert.ok(true, "dist/package.json 不存在：跳过真实产物同口径校验（由 dist-freshness-g312 兜底）");
  }
});
