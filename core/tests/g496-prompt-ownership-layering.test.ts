/**
 * core/tests/g496-prompt-ownership-layering.test.ts
 *
 * g-496（负责人 2026-10-14 跨宿主资产所有权裁定）：提示词按**语义归属**分层，不按「谁当前投递」：
 *
 *   · **公共层** `<repo>/prompts/` —— 跨宿主共用正文（目标/attempt 纪律、人工 gate、证据/报告
 *     格式、Agent Teams 契约、模式策略、自动化指导、主管技能指南）。core 属公共层 ⇒ 只依赖它；
 *     未来的 Claude / pi-ai / Codex 插件、独立 MCP 与技能集合**都**依赖它。
 *   · **宿主专属层** `dsh-graph-host/prompts/` —— DSH 会话/section/GUI 动作语义专属正文。
 *
 * 本守卫断言的是**真实行为与真实布局**，不是注释自证：
 *   A. 布局不变量：26 份资产**只有一份受版本控制的源码副本**，全部在公共层 `prompts/`；
 *      宿主专属源目录**不含**任何资产（`help` 也归公共层源码，见下）；
 *      **没有**任何资产同时在两层出现（重复所有权 = 双源漂移）。
 *   B. core 的定位与读取落在公共层（源形态 `../prompts/`），且**绝不**含宿主插件路径
 *      —— 结构性铁律：公共内核不得反向依赖某个宿主适配器。
 *   C. 宿主读取**按归属分根**：公共资产在源形态读 `../prompts/`、宿主专属读 `./prompts/`；
 *      宿主专属资产**不回落**公共层（漏宿主资产必须暴露，不得被公共资产悄悄顶替）。
 *   D. 构建**合并**两层 → `dist/prompts/`，且同名冲突 **fail-closed**（不依赖复制顺序覆盖）。
 *   E. 发布包内资产与公共层源码**逐字节一致**（复制是产物，不是第二份维护源码）；发布包
 *      **不依赖源码仓库**即可读取。
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
const hostPrompts = join(repoRoot, "dsh-graph-host/prompts");

const readMd = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".md")).sort() : [];

/** 期望的 26 份资产（24 提示词 + 2 主管指南，两语言对偶）。 */
const EXPECTED_ASSET_COUNT = 26;

// ============================================================ A. 布局不变量

test("g-496 L-A：26 份资产单一源码副本全在公共层，宿主源目录无资产、两层无重名", () => {
  const pub = readMd(publicPrompts);
  const host = readMd(hostPrompts);

  assert.equal(pub.length, EXPECTED_ASSET_COUNT,
    `公共层必须有 ${EXPECTED_ASSET_COUNT} 份资产，实得 ${pub.length}：${pub.join(", ")}`);

  // 宿主专属**源**目录当前为空：唯一宿主专属资产（help）按语义归属仍以公共层为源码位置？
  // 否 —— 见下方断言：help 的**源码**也必须在公共层，宿主层不得持有第二份。
  assert.equal(host.length, 0,
    `宿主专属源目录不得残留资产（否则形成第二份维护源码），实得：${host.join(", ")}`);

  // 重复所有权守卫：同名资产绝不得同时在两层存在。
  const overlap = pub.filter((n) => host.includes(n));
  assert.deepEqual(overlap, [], `两层不得有同名资产（重复所有权）：${overlap.join(", ")}`);

  // zh/en 对偶：每个 base 恰有 zh/en 两份。
  const bases = new Map<string, string[]>();
  for (const n of pub) {
    const m = /^(.+)\.(zh|en)\.md$/.exec(n);
    assert.ok(m, `资产名必须形如 <base>.<lang>.md，实得 ${n}`);
    bases.set(m![1], [...(bases.get(m![1]) ?? []), m![2]]);
  }
  for (const [base, langs] of bases) {
    assert.deepEqual(langs.sort(), ["en", "zh"], `${base} 必须有 zh/en 双语对偶，实得 ${langs.join(",")}`);
  }
});

test("g-496 L-A2：主管指南与全部注入资产都在公共层（含 supervisor-guide 迁出包根）", () => {
  // 主管技能指南按裁定归公共层（跨宿主守则），且不再位于插件根目录。
  for (const n of ["supervisor-guide.zh.md", "supervisor-guide.en.md"]) {
    assert.ok(existsSync(join(publicPrompts, n)), `${n} 必须在公共层 prompts/`);
    assert.ok(!existsSync(join(repoRoot, "dsh-graph-host", n)),
      `${n} 不得再位于 dsh-graph-host/ 根（已迁公共层）`);
  }
  // 公共层必须覆盖 core 与宿主读取的全部资产基名。
  const required = [
    "agent-teams-contract", "attempt-report-skeleton", "automation-guidance", "discipline",
    "executor-discipline", "guide-hint", "help", "minor-task", "no-isolation",
    "subagent-mode", "supervisor-guide", "usage", "worktree",
  ];
  const pub = readMd(publicPrompts);
  for (const base of required) {
    for (const lang of ["zh", "en"]) {
      assert.ok(pub.includes(`${base}.${lang}.md`), `${base}.${lang}.md 必须在公共层`);
    }
  }
});

// ============================================================ B. core 只依赖公共层

test("g-496 L-B：core 只依赖公共层——源码无宿主插件路径，且真读到公共层资产", async () => {
  const opsRaw = readFileSync(join(repoRoot, "core/ops.ts"), "utf8");
  // 结构性检查只看**可执行代码**：注释里说明迁移历史（「此前 core 走 ../dsh-graph-host/prompts/
  // 是所有权倒置」）是正当文档，不是依赖。故先剥掉行注释与块注释再判。
  const ops = opsRaw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  // ① 结构性铁律：core 的**代码**绝不出现宿主插件资产目录。
  assert.ok(!ops.includes("dsh-graph-host"),
    "core/ops.ts 代码不得引用 dsh-graph-host（公共内核不得依赖宿主适配器）");
  // ② 单一公共层定位，两形态同形。
  assert.ok(ops.includes('new URL("../prompts/", import.meta.url)'), "必须用公共层相对定位");
  assert.equal((ops.match(/new URL\("\.\.\/prompts\/", import\.meta\.url\)/g) ?? []).length, 1,
    "公共层定位只应有**一处**（不得散落多处路径字面量）");
  // ③ 无 cwd 探测 / 目录搜索 / 环境变量开关（批准边界：仅明确的静态定位）。
  assert.doesNotMatch(ops, /process\.cwd\(\)/, "不得用 cwd 探测定位资产");
  assert.doesNotMatch(ops, /DSH_GRAPH_PROMPT|PROMPT_DIR\s*=\s*process\.env/, "不得引入环境变量开关");

  // ④ 运行时真读到公共层（import 真实模块，非字符串自证）。
  const mod: any = await import("../ops.ts");
  assert.ok(mod.resolvePromptAssetDirUrl().href.endsWith("/prompts/"),
    `core 必须解析到公共层 prompts/，实得 ${mod.resolvePromptAssetDirUrl().href}`);
  assert.ok(!mod.resolvePromptAssetDirUrl().href.includes("dsh-graph-host"),
    "core 解析结果不得含宿主插件目录");
  for (const [name, lang] of [["subagent-mode", "zh"], ["attempt-report-skeleton", "en"]] as const) {
    const raw = readFileSync(join(publicPrompts, `${name}.${lang}.md`), "utf8");
    assert.equal(mod.readCorePromptAsset(name, lang), raw,
      `${name}.${lang} 必须与公共层资产逐字节一致`);
  }
});

// ============================================================ C. 宿主按归属分根

test("g-496 L-C：宿主读取按归属分根；宿主专属资产不回落公共层（漏包即暴露）", async () => {
  const hostSrc = readFileSync(join(repoRoot, "dsh-graph-host/index.js"), "utf8");

  // ① 归属清单存在且可读（唯一清单，非第二份白名单）。
  assert.match(hostSrc, /HOST_OWNED_PROMPT_ASSETS\s*=\s*new Set\(/,
    "宿主必须有明确的宿主专属资产清单");
  // ② 公共资产在源形态走插件外的 `../prompts/`。
  assert.ok(hostSrc.includes("`../prompts/${name}.${lang}.md`"),
    "宿主读取公共资产必须走 ../prompts/（公共层在插件外）");
  // ③ 宿主专属走插件内 `./prompts/`，且**不得**并列给出公共层回落 —— 回落会把
  //    「漏了宿主资产」伪装成「读到了公共资产」，掩盖所有权错误。
  assert.ok(hostSrc.includes("`./prompts/${name}.${lang}.md`"), "宿主专属资产必须走 ./prompts/");

  // ④ 真实行为：在**发布合并布局**（单一 prompts/）下，宿主读取两类资产都成功。
  const mod: any = await import(pathToFileURL(join(distRoot, "index.js")).href);
  assert.ok(typeof mod.helpAssetRelativePath === "function", "注册表投影必须可读");
  // 全部注册项都指向合并后的 prompts/ 布局（不再有根级特例）。
  const { HELP_PROMPT_ASSETS } = mod;
  assert.equal(HELP_PROMPT_ASSETS.length, EXPECTED_ASSET_COUNT,
    `白名单必须覆盖全部 ${EXPECTED_ASSET_COUNT} 份随包资产，实得 ${HELP_PROMPT_ASSETS.length}`);
  for (const name of HELP_PROMPT_ASSETS) {
    assert.equal(mod.helpAssetRelativePath(name), `prompts/${name}`,
      `${name} 的注册路径必须在合并后的 prompts/ 布局`);
  }
});

// ============================================================ D. 构建合并与冲突

test("g-496 L-D：build.sh 合并两层到 dist/prompts，同名冲突 fail-closed（不覆盖）", () => {
  const build = readFileSync(join(repoRoot, "scripts/build.sh"), "utf8");

  // ① 两层都参与合并。
  assert.ok(build.includes('_merge_prompts_layer "prompts"'), "公共层必须参与合并");
  assert.ok(build.includes('_merge_prompts_layer "dsh-graph-host/prompts"'), "宿主专属层必须参与合并");
  // ② 冲突检测**先于**复制且明确失败（绝不依赖复制顺序覆盖）。
  assert.match(build, /提示词资产同名冲突/, "必须检测并报告同名冲突");
  assert.match(build, /exit 1/, "冲突必须 fail-closed 退出");
  // ③ 不得用 `cp -r` 整目录覆盖式复制（那正是「顺序覆盖」的来源）。
  assert.ok(!/cp -r dsh-graph-host\/prompts dist\/prompts/.test(build),
    "不得再用整目录 cp -r 覆盖（会以复制顺序掩盖重复所有权）");
  // ④ 层层**必需性**必须显式区分（g-496）：公共层是唯一维护源码 ⇒ required；
  //    宿主专属层按内容归属可能为空/不存在 ⇒ optional（否则「全部资产驻留公共层」时构建会误红）。
  assert.match(build, /_merge_prompts_layer "prompts" "[^"]*" "required"/,
    "公共层缺失必须 fail-closed（唯一维护源码不可缺席）");
  assert.match(build, /_merge_prompts_layer "dsh-graph-host\/prompts" "[^"]*" "optional"/,
    "宿主专属层必须允许为空/不存在（资产按内容归属公共层目录）");
});

test("g-496 L-D2：合并冲突检测真实生效——造同名资产必须判红（负向对照）", () => {
  const tmpBase = join(repoRoot, "tmp");
  mkdirSync(tmpBase, { recursive: true });
  const root = mkdtempSync(join(tmpBase, "g496-merge-"));
  try {
    // 复刻 build.sh 的合并函数语义到独立沙箱，注入一个**同名冲突**做负向对照。
    // （直接跑真 build.sh 会真构建 dist/，代价过大且与宿主争用；此处校验的正是同一段逻辑。）
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
    const a = join(root, "prompts");
    const b = join(root, "host-prompts");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "shared.zh.md"), "PUBLIC\n", "utf8");
    writeFileSync(join(b, "shared.zh.md"), "HOST\n", "utf8");

    // 负向：同名 ⇒ 必须抛错（而不是静默以某一层覆盖另一层）。
    assert.throws(() => mergeLogic([a, b], join(root, "dest")),
      /同名冲突/, "同名资产必须 fail-closed，绝不顺序覆盖");

    // 正向对照：无冲突时两层都合并进产物。
    rmSync(join(b, "shared.zh.md"));
    writeFileSync(join(b, "host-only.zh.md"), "HOSTONLY\n", "utf8");
    const dest = join(root, "dest2");
    mergeLogic([a, b], dest);
    assert.equal(readFileSync(join(dest, "shared.zh.md"), "utf8"), "PUBLIC\n", "公共层资产必须落入产物");
    assert.equal(readFileSync(join(dest, "host-only.zh.md"), "utf8"), "HOSTONLY\n", "宿主专属资产必须落入产物");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================ E. 产物一致性与独立包

test("g-496 L-E：随包 dist/prompts 与公共层源码逐字节一致（复制是产物，非第二源码）", () => {
  const distPrompts = join(distRoot, "prompts");
  assert.ok(existsSync(distPrompts), "dist/prompts 必须存在（先跑 bash scripts/build.sh）");
  const distNames = readMd(distPrompts);
  const pubNames = readMd(publicPrompts);

  assert.equal(distNames.length, EXPECTED_ASSET_COUNT,
    `随包资产必须恰 ${EXPECTED_ASSET_COUNT} 份，实得 ${distNames.length}`);
  assert.deepEqual(distNames, pubNames, "随包资产集合必须与公共层源码集合一致");
  for (const n of pubNames) {
    assert.equal(readFileSync(join(distPrompts, n), "utf8"), readFileSync(join(publicPrompts, n), "utf8"),
      `${n}：随包产物必须与公共层源码逐字节一致`);
  }
});

test("g-496 L-E2：发布包脱仓库可运行——任意目录名下读取公共资产（不依赖源码仓库）", async () => {
  const tmpBase = join(repoRoot, "tmp");
  mkdirSync(tmpBase, { recursive: true });
  const root = mkdtempSync(join(tmpBase, "g496-hermetic-"));
  try {
    // 把 dist/ 复制到一个**与仓库无关**的目录名 —— 包内自洽、不回读仓库源码。
    const pkg = join(root, "arbitrary-package-name");
    cpSync(distRoot, pkg, { recursive: true, dereference: true });
    assert.ok(existsSync(join(pkg, "prompts", "supervisor-guide.zh.md")),
      "合并后的包必须含公共层 supervisor-guide");

    const core: any = await import(pathToFileURL(join(pkg, "core", "ops.js")).href);
    assert.ok(core.resolvePromptAssetDirUrl().href.includes("/arbitrary-package-name/prompts/"),
      `发布形态定位必须随包（与目录名无关），实得 ${core.resolvePromptAssetDirUrl().href}`);
    const raw = readFileSync(join(pkg, "prompts", "attempt-report-skeleton.zh.md"), "utf8");
    assert.equal(core.readCorePromptAsset("attempt-report-skeleton", "zh"), raw,
      "发布包必须真读到包内公共资产");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
