/**
 * core/tests/g355-mock-seed-shared-card.test.ts
 *
 * g-355 回归守卫：`scripts/dsh-graph-mock-seed.mjs` 定位卡片必须走**项目共享池**
 * `.dsh-graph/shared-cards/`（g-183 起 `add-card` CLI 默认建共享卡），而不是 goal 自有目录。
 *
 * 为什么需要（不是理论风险）：polish 第 4 步曾按 `<goal>/cards/<id>.md` 找卡，而 add-card
 * 默认把卡建进共享池 ⇒ 真实运行必然 ENOENT
 * `…/.dsh-graph/versions/v1.4/goals/g-003/cards/shared-<id>.md` 且 seed exit 1，
 * README（根 + npm）的截图复现回路整条断掉。该故障只有「真跑一次 seed」才暴露：
 * 静态读代码、单测引擎 API 都看不到 seed 自己的路径拼接。
 *
 * 两个断言面（全部 hermetic：MOCK_ROOT 落在 os.tmpdir() 的一次性沙箱，绝不触碰仓库数据，
 * 也绝不写主树 dist/）：
 *  A. 端到端（判据 1/2/4/6）：真跑 seed（带 `--validate`）⇒ exit 0、stderr 无 ENOENT、
 *     `validate: PASS` + `rebuild: consistent`、14 个目标 / 4 张共享卡；
 *     并定点断言 polish 第 4 步写的那张收集卡（g-003 引用的共享卡）在**共享池**里
 *     status=collecting、summary 已写 —— 修复后仍命中同一张卡，语义未退化。
 *  B. 负向对照「改坏即红」（判据 1）：把 seed 源码里的卡片定位锚点**锚定回退**成旧布局
 *     （锚点必须恰好命中一次，漂移即抛错，绝不静默变成永真），在沙箱镜像里重放同一 seed
 *     ⇒ 必须非 0 退出且 stderr 报 `<goal>/cards/shared-*.md` 的 ENOENT。
 *     判别力由 B 钉住：把 A 的修复撤掉，B 的断言面立刻翻转为红。
 *
 * 环境前提：`os.tmpdir()` 不得位于 `/home/` 或 `/workspace/` 下 —— seed 自带的脱敏自检会
 * （正确地）拒绝把 mock 数据落在真实工作区路径下；这属环境前提，不是本目标的断言面。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SEED = join(REPO, "scripts", "dsh-graph-mock-seed.mjs");
const VERSION_SLUG = "v1.4";

/** 解析 seed 写出的 `--- <JSON> ---` frontmatter（与 seed 的 readGoalDoc 同构）。 */
function frontmatter(file: string): Record<string, any> {
  const text = readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  assert.ok(m, `frontmatter 解析失败：${file}`);
  return JSON.parse(m![1]);
}

function runSeed(script: string, mockRoot: string) {
  return spawnSync(process.execPath, [script, "--validate"], {
    cwd: dirname(script),
    env: { ...process.env, MOCK_ROOT: mockRoot },
    encoding: "utf8",
    timeout: 300_000,
  });
}

/**
 * 让 tmp 镜像里的 `core/*.ts` 仍能解析 `yaml` 等依赖：把镜像根下的 node_modules 符号链接到
 * 仓库（或任一上层目录）的 node_modules（与 g347-help-asset-guard 同一手法）——
 * 镜像因此不必落在仓库内，沙箱保持 hermetic。
 * @returns 是否成功建立链接（未找到 node_modules 时返回 false，调用方给出可读诊断）
 */
function linkDependencies(mirrorRoot: string): boolean {
  for (let dir = REPO; ; ) {
    const candidate = join(dir, "node_modules");
    if (existsSync(candidate)) {
      symlinkSync(candidate, join(mirrorRoot, "node_modules"), "dir");
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

const T = { timeout: 300_000 };

test("g-355 A：seed 端到端跑通，收集卡落在共享池（不再 ENOENT）", T, () => {
  const sandbox = mkdtempSync(join(tmpdir(), "g355-seed-"));
  const mockRoot = join(sandbox, "mock-demo");
  try {
    const r = runSeed(SEED, mockRoot);
    const stderr = r.stderr ?? "";
    const stdout = r.stdout ?? "";
    assert.equal(r.status, 0, `seed 必须 exit 0（ENOENT 回归）；stderr=${stderr}`);
    assert.doesNotMatch(stderr, /ENOENT/, "修复后不得再出现 ENOENT");
    assert.match(stdout, /validate: PASS/);
    assert.match(stdout, /rebuild: consistent/);

    // 条目计数（判据 6）：14 个目标（10 版本内 + 3 backlog + 1 独立）
    assert.equal((stdout.match(/\[seed\] 创建 g-\d+/g) ?? []).length, 14);

    const graph = join(mockRoot, ".dsh-graph");
    const sharedDir = join(graph, "shared-cards");
    assert.ok(existsSync(sharedDir), "项目共享池 .dsh-graph/shared-cards/ 必须存在");
    const shared = readdirSync(sharedDir).filter((f) => f.endsWith(".md"));
    assert.ok(shared.length >= 4, `共享卡至少 4 张（实际 ${shared.length}）`);
    for (const f of shared) assert.match(f, /^shared-[0-9a-f]{8}\.md$/);

    // 定点：g-003 的收集卡 = polish 第 4 步写入的那张，必须在共享池且语义正确
    const g3 = frontmatter(join(graph, "versions", VERSION_SLUG, "goals", "g-003", "goal.md"));
    assert.equal(g3.context_cards.length, 1, "g-003 引用 1 张共享卡");
    for (const ref of g3.context_cards as string[]) {
      const f = join(sharedDir, `${ref}.md`);
      assert.ok(existsSync(f), `收集卡必须在共享池：${ref}`);
      const meta = frontmatter(f);
      assert.equal(meta.scope, "shared");
      assert.equal(meta.status, "collecting");
      assert.equal(meta.summary, "收集子代理已派发，等待填充");
    }
    // 旧布局不得再被写：goal 自有 cards/ 目录不该出现在 mock 数据里
    assert.ok(
      !existsSync(join(graph, "versions", VERSION_SLUG, "goals", "g-003", "cards")),
      "g-003 不应再有 goal 自有 cards/ 目录",
    );

    // 其余卡片生成不退化（判据 4）：g-006 的 3 张卡同样经共享池解析
    const g6 = frontmatter(join(graph, "versions", VERSION_SLUG, "goals", "g-006", "goal.md"));
    assert.equal(g6.context_cards.length, 3, "g-006 引用 3 张共享卡");
    for (const ref of g6.context_cards as string[]) {
      const f = join(sharedDir, `${ref}.md`);
      assert.ok(existsSync(f), `g-006 的卡必须在共享池：${ref}`);
      const meta = frontmatter(f);
      assert.equal(meta.status, "reviewed");
      assert.ok(meta.summary && meta.filled_by, "填卡/复核状态不得退化");
    }

    // backlog / 版本泳道结构不退化
    assert.equal(
      readdirSync(join(graph, "backlog")).filter((f) => f.endsWith(".md")).length,
      3,
      "backlog 3 个目标",
    );
    assert.ok(existsSync(join(graph, "versions", VERSION_SLUG, "version.md")));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("g-355 B 负向对照：卡片定位回退到 goal 自有目录 ⇒ seed 必红", T, () => {
  const sandbox = mkdtempSync(join(tmpdir(), "g355-neg-"));
  const mirror = join(sandbox, "mirror");
  try {
    // 锚点化回退：每个锚点必须恰好命中一次（锚点漂移即抛错，不静默变成永真）
    const src = readFileSync(SEED, "utf8");
    const ANCHOR = "const cardFile = cardFileOf(pc.file, pc.cardId);";
    assert.equal(src.split(ANCHOR).length - 1, 1, "锚点必须恰好命中一次");
    const reverted = src.replace(
      ANCHOR,
      'const cardFile = path.join(path.dirname(pc.file), "cards", `${pc.cardId}.md`);',
    );
    assert.notEqual(reverted, src);

    mkdirSync(join(mirror, "scripts"), { recursive: true });
    writeFileSync(join(mirror, "scripts", "dsh-graph-mock-seed.mjs"), reverted);
    // 镜像只需 core 顶层 .ts（seed 经 REPO_ROOT/core/main.ts 调用引擎；main.ts 只相对引用同层 .ts）
    mkdirSync(join(mirror, "core"), { recursive: true });
    for (const f of readdirSync(join(REPO, "core"))) {
      if (f.endsWith(".ts")) cpSync(join(REPO, "core", f), join(mirror, "core", f));
    }
    assert.ok(linkDependencies(mirror), "未找到 node_modules，无法在 tmp 镜像里解析 yaml 等依赖");

    const r = runSeed(join(mirror, "scripts", "dsh-graph-mock-seed.mjs"), join(sandbox, "mock-broken"));
    assert.notEqual(r.status, 0, "回退到旧布局后 seed 必须失败");
    assert.match(r.stderr ?? "", /ENOENT/);
    assert.match(r.stderr ?? "", /cards[/\\]shared-/, "必须报出 goal 自有 cards/ 下的共享卡路径");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
