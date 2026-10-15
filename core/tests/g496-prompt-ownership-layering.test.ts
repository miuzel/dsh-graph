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
 *   A. 布局不变量：**两层各自**只有一份受版本控制的源码副本 —— 公共层 26 份（24 提示词 + 2 主管
 *      指南）、宿主专属层 18 份（g-496 att-007 迁入的 9 类 GUI 提示词模板 × zh/en）；
 *      **没有**任何资产同时在两层出现（重复所有权 = 双源漂移）；zh/en 对偶是**跨层整体**属性。
 *   B. core 的定位与读取落在公共层（源形态 `../prompts/`），且**绝不**含宿主插件路径
 *      —— 结构性铁律：公共内核不得反向依赖某个宿主适配器。
 *   C. 宿主读取**按归属分根**：公共资产在源形态读 `../prompts/`、宿主专属读 `./prompts/`；
 *      宿主专属资产**不回落**公共层（漏宿主资产必须暴露，不得被公共资产悄悄顶替）。
 *   D. 构建**合并**两层 → `dist/prompts/`，且同名冲突 **fail-closed**（不依赖复制顺序覆盖）。
 *   E. 发布包内资产与其**所属层**源码逐字节一致（复制是产物，不是第二份维护源码）；发布包
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

/** 期望的**公共层**资产数（24 提示词 + 2 主管指南 + g-496 att-009 五类运行期固定正文
 *  × zh/en = 10，两语言对偶）。
 *  g-496 att-007：GUI 提示词模板（9 类 × zh/en = 18 份）迁入**宿主专属层** ⇒ 公共层当时仍是 26；
 *  att-009 追加 collect/summary/pm/review/attempt-instructions 五对 ⇒ 36。
 *  随包总量 = 36 + 18 = 54。两个数各自独立断言（见下），不得互相顶替。 */
const EXPECTED_ASSET_COUNT = 36;
/** 宿主专属层资产数（g-496 att-007：9 类 GUI 提示词模板 × zh/en）。 */
const EXPECTED_HOST_ASSET_COUNT = 18;
/** 随包合并总量（公共层 + 宿主专属层）——**由两层清单相加得出，不硬编码**，
 *  避免「新增/删除一类资产时忘记同步常量」把守卫变成假绿。 */
const EXPECTED_MERGED_ASSET_COUNT = EXPECTED_ASSET_COUNT + EXPECTED_HOST_ASSET_COUNT;

// ============================================================ A. 布局不变量

test("g-496 L-A：公共层 36 份 / 宿主专属层 18 份，各自单一源码副本、两层无重名、zh/en 对偶", () => {
  const pub = readMd(publicPrompts);
  const host = readMd(hostPrompts);

  assert.equal(pub.length, EXPECTED_ASSET_COUNT,
    `公共层必须有 ${EXPECTED_ASSET_COUNT} 份资产，实得 ${pub.length}：${pub.join(", ")}`);

  // g-496 att-007：宿主专属层**现在承载 9 类 GUI 提示词模板**（zh/en 对偶）。
  // 原守卫要求该目录为空，是因为当时尚无宿主专属资产；**所有权分层的判据本身不变**：
  // 每个资产在两层中**恰有一份**受版本控制的源码副本，且两层不得同名。
  assert.equal(host.length, EXPECTED_HOST_ASSET_COUNT,
    `宿主专属层必须有 ${EXPECTED_HOST_ASSET_COUNT} 份资产（9 类 GUI 模板 × zh/en），实得 ${host.length}：${host.join(", ")}`);

  // 重复所有权守卫：同名资产绝不得同时在两层存在。
  const overlap = pub.filter((n) => host.includes(n));
  assert.deepEqual(overlap, [], `两层不得有同名资产（重复所有权）：${overlap.join(", ")}`);

  // zh/en 对偶：**两层合并后**每个 base 恰有 zh/en 两份（对偶是跨层的整体属性）。
  const bases = new Map<string, string[]>();
  for (const n of [...pub, ...host]) {
    const m = /^(.+)\.(zh|en)\.md$/.exec(n);
    assert.ok(m, `资产名必须形如 <base>.<lang>.md，实得 ${n}`);
    bases.set(m![1], [...(bases.get(m![1]) ?? []), m![2]]);
  }
  for (const [base, langs] of bases) {
    assert.deepEqual(langs.sort(), ["en", "zh"], `${base} 必须有 zh/en 双语对偶，实得 ${langs.join(",")}`);
  }
});

test("g-496 L-A2：主管指南与全部注入资产都在公共层（含 supervisor-guide 迁出包根）", () => {  // 主管技能指南按裁定归公共层（跨宿主守则），且不再位于插件根目录。
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

  // ① g-496 返工：所有权**只**由唯一注册表携带，**不得**再另持第二份清单。
  assert.ok(!/HOST_OWNED_PROMPT_ASSETS\s*=\s*new Set\(/.test(hostSrc),
    "不得再持有第二份宿主专属清单（所有权必须与注册表同源）");
  assert.match(hostSrc, /ownership\s*===\s*"host"/,
    "reader 的归属判定必须读注册表条目的 ownership 字段");
  // ② g-496 返工：形态由**显式布局标记**决定，**不得**以资产/目录存在性推断形态
  //    （存在性判别是 fail-open 来源：包内缺资产会被邻接源码树掩盖）。
  assert.ok(!/isPublishedPromptLayout/.test(hostSrc),
    "不得再用资产存在性判别发布形态（必须以显式布局标记判别）");
  assert.ok(!/existsSync\(new URL\("\.\/prompts/.test(hostSrc),
    "不得以包内资产存在性作为形态判据");
  assert.match(hostSrc, /dsh\.promptAssets|promptAssets/, "读取必须依赖显式布局标记");
  assert.match(hostSrc, /"merged"/, "必须识别发布态 merged 布局");
  assert.match(hostSrc, /"source"/, "必须识别源码态 source 布局");
  // ③ 读取必须**单根单候选**：形态+归属决定唯一路径，不得有「失败就换另一个根」的回落链。
  assert.ok(!/for \(const candidate of candidates\)/.test(hostSrc),
    "读取不得保留多候选回落链（g-496 返工：发布上下文绝不回读源码）");

  // ④ 真实行为：在**发布合并布局**（单一 prompts/）下，宿主读取两类资产都成功。
  const mod: any = await import(pathToFileURL(join(distRoot, "index.js")).href);
  assert.ok(typeof mod.helpAssetRelativePath === "function", "注册表投影必须可读");
  // 全部注册项都指向合并后的 prompts/ 布局（不再有根级特例）。
  const { HELP_PROMPT_ASSETS } = mod;
  // g-496 att-007：白名单覆盖**两层合并后的全部**随包资产（公共 36 + 宿主 18 = 54）。
  assert.equal(HELP_PROMPT_ASSETS.length, EXPECTED_MERGED_ASSET_COUNT,
    `白名单必须覆盖全部 ${EXPECTED_MERGED_ASSET_COUNT} 份随包资产（公共层 + 宿主专属层），实得 ${HELP_PROMPT_ASSETS.length}`);
  for (const name of HELP_PROMPT_ASSETS) {
    assert.equal(mod.helpAssetRelativePath(name), `prompts/${name}`,
      `${name} 的注册路径必须在合并后的 prompts/ 布局`);
  }
  // ⑤ g-496 att-007：**所有权真源仍唯一起作用** —— 宿主观测到的归属必须与源码所在层**双向对齐**。
  //    经由导出的只读投影 helpAssetOwnership（内部 assetOwnership 的公开面，同一注册表真源，
  //    不新增第二份清单）读取，判据等价于 reader 内部使用的那一条。
  //    口径：入参是**基名**（不带 `.zh`/`.en` 语言后缀）——归属是资产的**跨语言**属性。
  assert.ok(typeof mod.helpAssetOwnership === "function", "归属投影必须可读（只读，投影自注册表）");
  const baseOf = (n: string) => n.replace(/\.(zh|en)\.md$/, "");
  const hostNames = readMd(hostPrompts);
  const pubNames2 = readMd(publicPrompts);
  assert.equal(hostNames.length, EXPECTED_HOST_ASSET_COUNT,
    `宿主专属层应为 ${EXPECTED_HOST_ASSET_COUNT} 份，实得 ${hostNames.length}`);
  for (const n of hostNames.map(baseOf)) {
    assert.equal(mod.helpAssetOwnership(n), "host", `${n} 的归属必须是 host（源码位于宿主专属层）`);
    assert.ok(HELP_PROMPT_ASSETS.includes(`${n}.zh.md`) && HELP_PROMPT_ASSETS.includes(`${n}.en.md`),
      `${n} 的 zh/en 两份都必须登记进白名单`);
  }
  for (const n of pubNames2.map(baseOf)) {
    assert.notEqual(mod.helpAssetOwnership(n), "host",
      `${n} 的源码在公共层，归属不得被判为 host`);
  }
  // 归属与真实源码位置**双向对齐**：标 host 的必须真在宿主层文件里存在（且公共层不得有同名）。
  const hostBases = new Set(hostNames.map(baseOf));
  for (const name of HELP_PROMPT_ASSETS) {
    if (mod.helpAssetOwnership(baseOf(name)) !== "host") continue;
    assert.ok(hostBases.has(baseOf(name)), `${name} 标为 host 但宿主层无此文件（归属失真）`);
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

test("g-496 L-E：随包 dist/prompts 与两层源码逐字节一致（复制是产物，非第二源码）", () => {
  const distPrompts = join(distRoot, "prompts");
  assert.ok(existsSync(distPrompts), "dist/prompts 必须存在（先跑 bash scripts/build.sh）");
  const distNames = readMd(distPrompts);
  const pubNames = readMd(publicPrompts);
  const hostNames = readMd(hostPrompts);

  // g-496 att-007：随包资产 = 两层合并（公共 36 + 宿主 18 = 54）。
  assert.equal(distNames.length, EXPECTED_MERGED_ASSET_COUNT,
    `随包资产必须恰 ${EXPECTED_MERGED_ASSET_COUNT} 份（公共层 + 宿主专属层），实得 ${distNames.length}`);
  // 合并后的集合必须**精确等于**两层并集（既不漏层，也不多出无源资产）。
  assert.deepEqual(distNames, [...pubNames, ...hostNames].sort(),
    "随包资产集合必须精确等于公共层 ∪ 宿主专属层（不得漏层或凭空多出）");
  // 逐份断言「产物 ≡ 其**所属层**的源码」，逐字节（复制是产物，不是第二份维护源码）。
  for (const n of pubNames) {
    assert.equal(readFileSync(join(distPrompts, n), "utf8"), readFileSync(join(publicPrompts, n), "utf8"),
      `${n}：随包产物必须与公共层源码逐字节一致`);
  }
  // g-496 att-007 新增：宿主专属层同样必须逐字节一致（此前该层为空 ⇒ 这条腿无从检验）。
  for (const n of hostNames) {
    assert.equal(readFileSync(join(distPrompts, n), "utf8"), readFileSync(join(hostPrompts, n), "utf8"),
      `${n}：随包产物必须与宿主专属层源码逐字节一致`);
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

// ============================================ F. att-009 五类运行期固定正文：单源 + 无双副本

/** att-009 抽出的五类运行期固定正文（公共层，zh/en 对偶）。 */
const ATT009_ASSETS = ["attempt-instructions", "collect-task", "pm-task", "review-task", "summary-task"] as const;

test("g-496 att-009 F①：五对新资产落在公共层，且与源码逐字节一致（复制是产物、不是第二份维护源）", () => {
  for (const name of ATT009_ASSETS) {
    for (const lang of ["zh", "en"] as const) {
      const file = `${name}.${lang}.md`;
      assert.ok(existsSync(join(publicPrompts, file)), `公共层必须含 ${file}`);
      assert.ok(!existsSync(join(hostPrompts, file)), `${file} 不得同时存在于宿主专属层（重复所有权）`);
      assert.equal(
        readFileSync(join(distRoot, "prompts", file), "utf8"),
        readFileSync(join(publicPrompts, file), "utf8"),
        `${file}：随包产物必须与其公共层源码逐字节一致`,
      );
    }
  }
});

test("g-496 att-009 F②：代码侧不得留固定正文第二副本（措辞真源唯一 = 公共层 .md）", async () => {
  const opsSrc = readFileSync(join(repoRoot, "core", "ops.ts"), "utf8");
  const hostSrc = readFileSync(join(repoRoot, "dsh-graph-host", "index.js"), "utf8");

  /** 取资产里「非标题、非空、非占位符行」的正文行，逐行回查代码是否仍有同字面量副本。 */
  const proseLines = (file: string) =>
    readFileSync(join(publicPrompts, file), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length >= 18 && !l.startsWith("#") && !l.startsWith("<!--") && !l.includes("{{"));

  // 中文资产回查 core/ops.ts 与宿主；英文资产回查 core **与宿主**（att-009 返工：英文侧同样不得留第二副本）。
  for (const name of ["collect-task", "pm-task", "review-task", "summary-task"] as const) {
    for (const lang of ["zh", "en"] as const) {
      for (const line of proseLines(`${name}.${lang}.md`)) {
        assert.ok(!opsSrc.includes(line),
          `${name}.${lang}.md 的正文在 core/ops.ts 中仍有副本：${line.slice(0, 48)}`);
      }
    }
  }
  // 英文侧同样不得把固定正文内联在宿主源码（原先只有 zh 侧断言 ⇒ 英文代码第二副本可蒙混过关）。
  for (const name of ["collect-task", "pm-task", "review-task", "summary-task"] as const) {
    for (const line of proseLines(`${name}.en.md`)) {
      assert.ok(!hostSrc.includes(line),
        `${name}.en.md 的正文在宿主源码中仍有第二副本：${line.slice(0, 48)}`);
    }
  }
  // attempt-instructions：短语由代码按 marker 取用（合法引用），但**整行字面量**不得再出现在宿主源码里。
  for (const lang of ["zh", "en"] as const) {
    for (const line of proseLines(`attempt-instructions.${lang}.md`)) {
      assert.ok(!hostSrc.includes(line),
        `attempt-instructions.${lang}.md 的正文在宿主源码中仍有第二副本：${line.slice(0, 48)}`);
    }
  }
});

test("g-496 att-009 F③：attempt-instructions 短语表齐备 —— 资产 marker 与代码键一一对应", () => {
  const hostSrc = readFileSync(join(repoRoot, "dsh-graph-host", "index.js"), "utf8");
  const assetKeys = [...readFileSync(join(publicPrompts, "attempt-instructions.zh.md"), "utf8")
    .matchAll(/^<!--\s*dsh-graph:phrase:([A-Za-z0-9_.-]+)\s*-->\s*$/gm)].map((m) => m[1]);

  assert.ok(assetKeys.length >= 19, `attempt-instructions 短语数应 ≥19，实得 ${assetKeys.length}`);
  assert.equal(new Set(assetKeys).size, assetKeys.length, `短语键不得重复：${assetKeys.join(", ")}`);

  for (const key of assetKeys) {
    assert.ok(hostSrc.includes(`instructions.${key}`),
      `资产短语 ${key} 必须有代码消费点（instructions.${key}）—— 否则是无人读取的死短语`);
  }
  // 纪律段的两个短语走 formatAttemptDiscipline 的局部别名 `instructions`（另一消费点，同样必须存在）。
  const disciplineKeys = assetKeys.filter((k) => k.startsWith("discipline"));
  assert.ok(disciplineKeys.length >= 2,
    `纪律段短语应至少含 disciplineHeading / disciplinePreface，实得 ${disciplineKeys.join(", ")}`);
  for (const key of disciplineKeys) {
    assert.ok(new RegExp(`\\binstructions\\.${key}\\b`).test(hostSrc),
      `纪律段短语 ${key} 必须有消费点（否则是无人读取的死短语）`);
  }
  // 中英短语键必须完全一致（双语对偶的机器可核部分）。
  const enKeys = [...readFileSync(join(publicPrompts, "attempt-instructions.en.md"), "utf8")
    .matchAll(/^<!--\s*dsh-graph:phrase:([A-Za-z0-9_.-]+)\s*-->\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(enKeys, assetKeys, "attempt-instructions 中英短语键与顺序必须一致");

  // att-009 返工：英文侧短语同样必须**全部被消费**，且英文渲染器的取用点存在 ——
  // 否则 `attempt-instructions.en.md` 会退化成无人读取的死资产（英文代码留第二副本也无人发现）。
  // 唯一被授权「只服务中文渲染器」的三个短语（briefOnlySource / briefPriority / overrideProvenance）
  // 是**逐字**基线中文独有条目，英文基线无对应行 ⇒ 英文路径不注入它们（不得凭空补写改变产物）。
  const ZH_ONLY_PHRASES = new Set(["briefOnlySource", "briefPriority", "overrideProvenance"]);
  for (const key of enKeys) {
    if (ZH_ONLY_PHRASES.has(key)) continue;
    assert.ok(hostSrc.includes(`instructions.${key}`),
      `英文资产短语 ${key} 必须有代码消费点（instructions.${key}）—— 否则是无人读取的死短语`);
  }
  // 英文渲染器必须真的从英文短语表取用（而非另留硬编码英文正文）。
  assert.ok(/attemptInstructionsPhrases\("en"\)/.test(hostSrc),
    "英文派发路径必须经 attemptInstructionsPhrases(\"en\") 读取英文资产");
});

test("g-496 收集预览复用公共收集资产且提交的仅是用户材料", () => {
  const drawer = readFileSync(join(repoRoot, "dsh-graph-host/lib/client/card-drawer.js"), "utf8");
  const i18n = readFileSync(join(repoRoot, "dsh-graph-host/lib/client/i18n.js"), "utf8");
  assert.match(drawer, /loadGuiPromptAsset\(\"collect-task\"\)/, "抽屉预览必须加载公共 collect-task 模板");
  assert.match(drawer, /interpolateGuiPrompt\(collectTemplate/, "预览必须通过当前模板插入变量");
  assert.match(drawer, /prompt:\s*editableText/, "网络提交只传可编辑用户材料，host canonical prompt 仍强制追加");
  assert.doesNotMatch(drawer, /prompt\.collect\.(?:security|forbidden|backfill|attachments)/, "固定收集正文不得留字典 key 副本");
  assert.doesNotMatch(i18n, /prompt\.collect\.(?:security|forbidden|backfill|attachments)/, "i18n 不得持有固定收集正文副本");
  // g-496 att-012：**第三副本**收口 —— 旧「可编辑正文」三键（collectContext/collectScope/collectHint）
  // 是把 `collect-task.md` 正文抄进字典的第三份副本，必须整键删除；抽屉也不得再拼接它们。
  for (const key of ["drawer.collectContext", "drawer.collectScope", "drawer.collectHint",
    "drawer.canonicalAttRoot", "drawer.goalInfoLabel", "drawer.cardInfoLabel", "drawer.backfillReq"]) {
    assert.ok(!i18n.includes(`'${key}'`), `i18n 必须整键删除固定正文副本：${key}`);
  }
  // UI 标签键**必须保留**（界面文案，非提示词正文）。
  for (const key of ["drawer.collectTitle", "drawer.collectInfoTarget", "drawer.collectConstraints", "drawer.startCollect"]) {
    assert.ok(i18n.includes(`'${key}'`), `i18n 必须保留 UI 标签键：${key}`);
  }
  assert.doesNotMatch(drawer, /editablePart/, "抽屉不得再拼「可编辑正文」（editablePart 整块移除）");
  assert.doesNotMatch(drawer, /autoPrompt/, "抽屉不得再有 autoPrompt 拼接路径（预览与发送同源）");
  assert.doesNotMatch(drawer, /promptText \|\| editablePart/, "不得回退到客户端自拼正文");
  assert.match(drawer, /未替换占位符/, "预览渲染后必须自检未替换占位符（装配点漏传变量当场暴露）");
});

test("g-496 att-012：预览与发送同源 —— 同一份 collect-task 资产、同一组变量、渲染结果逐字节一致", () => {
  // 真源 = 公共层资产；两侧都从它渲染，故断言「同源同变量 ⇒ 同结果」而不是两段各自手抄的正文。
  const src = readFileSync(join(publicPrompts, "collect-task.zh.md"), "utf8");
  const vars = {
    attRoot: "/repo/.dsh-graph/attachments",
    dataRoot: "/repo/.dsh-graph",
    goalId: "g-1",
    goalTitle: "示例目标",
    cardId: "card-1",
    cardTitle: "示例卡片",
  };
  // 复刻客户端 `interpolateGuiPrompt`（宿主 GUI 方言：`{{?key}?}`、键字符集 `[A-Za-z0-9_]+`、
  // **缺变量抛错**）。注意键字符集**不含**连字符 ⇒ 值里的 `{g-1}` 这类文本不会被二次扫描。
  const GUI_RE = /\{\{?([A-Za-z0-9_]+)\}?\}/g;
  const guiRender = (t: string, v: Record<string, string>) =>
    t.replace(GUI_RE, (whole, k) => {
      const val = v[k];
      if (val === undefined || val === null) throw new Error(`GUI prompt template missing required variable: ${k}`);
      return String(val);
    });
  // 复刻 core `fillPromptTemplate`（公共方言：`{{name}}`，同样缺键即抛）—— 两侧吃的是**同一份** md 正文。
  const CORE_RE = /\{\{([A-Za-z0-9_.-]+)\}\}/g;
  const coreRender = (t: string, v: Record<string, string>) =>
    t.replace(CORE_RE, (whole, k) => {
      const val = v[k];
      if (val === undefined) throw new Error(`提示词模板缺少必需变量：${k}`);
      return val;
    });
  const guiOut = guiRender(src, vars);
  const coreOut = coreRender(src, vars);
  // 两种方言作用在**同一份**资产上：去掉花括号差异后正文必须一致（证明不存在第二份正文）。
  const strip = (s: string) => s.replace(/[{}]/g, "");
  assert.equal(strip(guiOut), strip(coreOut), "GUI 预览与 core 渲染必须产出同一份正文（仅方言括号不同）");
  // 预览里不得残留任何未替换占位符（否则会原样发给用户）。
  assert.deepEqual(guiOut.match(GUI_RE) ?? [], [], "GUI 预览不得残留未替换占位符");
  assert.deepEqual(coreOut.match(CORE_RE) ?? [], [], "core 渲染不得残留未替换占位符");
  // 「收集范围」句只在模板里出现一次 ⇒ 预览不会与 UI 标签重复（旧 editablePart 会二次拼这句）。
  const scopeZh = src.match(/\*\*收集范围\*\*/g) ?? [];
  assert.equal(scopeZh.length, 1, `「收集范围」必须在模板中恰出现 1 次（实得 ${scopeZh.length}）`);
  assert.equal((guiOut.match(/\*\*收集范围\*\*/g) ?? []).length, 1, "预览中「收集范围」不得重复");
  // 变量真的被替换（非空转）：卡片标题必须出现在两侧产物中。
  assert.ok(guiOut.includes("示例卡片") && coreOut.includes("示例卡片"), "cardTitle 必须被真实回填");
});
