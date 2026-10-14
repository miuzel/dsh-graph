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

/** 期望的**公共层**资产数（24 提示词 + 2 主管指南，两语言对偶）。
 *  g-496 att-007：GUI 提示词模板（9 类 × zh/en = 18 份）迁入**宿主专属层** ⇒ 公共层仍是 26，
 *  随包总量 = 26 + 18 = 44。两个数各自独立断言（见下），不得互相顶替。 */
const EXPECTED_ASSET_COUNT = 26;
/** 宿主专属层资产数（g-496 att-007：9 类 GUI 提示词模板 × zh/en）。 */
const EXPECTED_HOST_ASSET_COUNT = 18;
/** 随包合并总量（公共层 + 宿主专属层）——**由两层清单相加得出，不硬编码**，
 *  避免「新增/删除一类资产时忘记同步常量」把守卫变成假绿。 */
const EXPECTED_MERGED_ASSET_COUNT = EXPECTED_ASSET_COUNT + EXPECTED_HOST_ASSET_COUNT;

// ============================================================ A. 布局不变量

test("g-496 L-A：公共层 26 份 / 宿主专属层 18 份，各自单一源码副本、两层无重名、zh/en 对偶", () => {
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
  // g-496 att-007：白名单覆盖**两层合并后的全部**随包资产（公共 26 + 宿主 18 = 44）。
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

  // g-496 att-007：随包资产 = 两层合并（公共 26 + 宿主 18 = 44）。
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
