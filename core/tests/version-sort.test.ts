import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  boardProjection,
  boardPayload,
  compareVersions,
} from "../ops.ts";
import { createVersion } from "../version-lane.ts";

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-ver-sort-test-"));
  init(root);
  return root;
}

test("判据 1：数值分段倒序（v0.10.0 排在 v0.9.2 之前、v1.2.0 排在 v1.1.9 之前）", () => {
  // 单独比较断言：最新版本排在前面（返回值 < 0）
  assert.ok(compareVersions("v0.10.0", "v0.9.2") < 0, "v0.10.0 应排在 v0.9.2 之前");
  assert.ok(compareVersions("v0.9.2", "v0.10.0") > 0, "v0.9.2 应排在 v0.10.0 之后");
  assert.ok(compareVersions("v1.2.0", "v1.1.9") < 0, "v1.2.0 应排在 v1.1.9 之前");
  assert.ok(compareVersions("v1.1.9", "v1.2.0") > 0, "v1.1.9 应排在 v1.2.0 之后");

  // 多位数与跨位数排序实测
  const list = ["v0.1", "v0.10.0", "v0.2", "v0.9.2", "v1.2.0", "v1.1.9"];
  const sorted = [...list].sort(compareVersions);
  assert.deepEqual(sorted, [
    "v1.2.0",
    "v1.1.9",
    "v0.10.0",
    "v0.9.2",
    "v0.2",
    "v0.1",
  ]);
});

test("判据 2：前缀归一化（v0.1 / V0.1 / 0.1 均能正确解析数值段，前缀不影响比较结果）", () => {
  // 对比更高版本 v0.2，三者均应排在其后
  assert.ok(compareVersions("v0.2", "v0.1") < 0);
  assert.ok(compareVersions("v0.2", "V0.1") < 0);
  assert.ok(compareVersions("v0.2", "0.1") < 0);

  // 对比更低版本 v0.0.9，三者均应排在其前
  assert.ok(compareVersions("v0.1", "v0.0.9") < 0);
  assert.ok(compareVersions("V0.1", "v0.0.9") < 0);
  assert.ok(compareVersions("0.1", "v0.0.9") < 0);

  // 跨前缀混合列表排序
  const mixed = ["v0.2", "0.1", "V0.3", "v0.0.9"];
  const sorted = [...mixed].sort(compareVersions);
  assert.deepEqual(sorted, ["V0.3", "v0.2", "0.1", "v0.0.9"]);

  // 同版本不同前缀时 slug 稳定 tie-break，且绝不抛错
  const tieBreaks = ["v0.1", "0.1", "V0.1"].sort(compareVersions);
  assert.equal(tieBreaks.length, 3);
  assert.ok(tieBreaks.every((s) => ["v0.1", "0.1", "V0.1"].includes(s)));
});

test("判据 3：分段深度差异稳定（共同前缀相同时 v0.1.1 排在 v0.1.0 之前、v0.1.0 排在 v0.1 之前）", () => {
  assert.ok(compareVersions("v0.1.1", "v0.1.0") < 0, "v0.1.1 应排在 v0.1.0 之前");
  assert.ok(compareVersions("v0.1.0", "v0.1") < 0, "v0.1.0 应排在 v0.1 之前");
  assert.ok(compareVersions("v0.1.1", "v0.1") < 0, "v0.1.1 应排在 v0.1 之前");

  const list = ["v0.1", "v0.1.1", "v0.1.0"];
  const sorted = [...list].sort(compareVersions);
  assert.deepEqual(sorted, ["v0.1.1", "v0.1.0", "v0.1"]);

  // 更多深度分段测试
  const deepList = ["v1.0", "v1.0.0", "v1.0.0.1", "v1.0.0.0"];
  const deepSorted = [...deepList].sort(compareVersions);
  assert.deepEqual(deepSorted, ["v1.0.0.1", "v1.0.0.0", "v1.0.0", "v1.0"]);
});

test("判据 4：异构/预发布标识优雅降级与非语义版本（-rc.1/-beta 降序兜底、nightly 排在语义版本之后、绝不抛异常）", () => {
  // 1. 同一数值下预发布标识与正式版本：正式发布版排在预发布版前
  assert.ok(compareVersions("v0.10.0", "v0.10.0-rc.1") < 0, "正式发布版 v0.10.0 应排在 -rc.1 之前");

  // 2. 预发布标识之间按降序兜底（rc > beta）
  assert.ok(compareVersions("v0.10.0-rc.1", "v0.10.0-beta.1") < 0, "-rc.1 应排在 -beta.1 之前");
  assert.ok(compareVersions("v0.10.0-rc.2", "v0.10.0-rc.1") < 0, "-rc.2 应排在 -rc.1 之前");

  // 3. 预发布版本与不同主要版本：数值仍然优先
  assert.ok(compareVersions("v0.10.0-rc.1", "v0.9.0") < 0, "v0.10.0-rc.1 应排在 v0.9.0 之前");
  assert.ok(compareVersions("v1.0.0-alpha", "v0.9.9") < 0, "v1.0.0-alpha 应排在 v0.9.9 之前");

  // 4. 非语义命名（首段无数字，如 nightly）排在所有语义版本之后
  assert.ok(compareVersions("nightly", "v0.1.0") > 0, "nightly 应排在语义版本 v0.1.0 之后");
  assert.ok(compareVersions("v0.1.0", "nightly") < 0, "语义版本 v0.1.0 应排在 nightly 之前");
  assert.ok(compareVersions("v-t", "v0.1.0") > 0, "v-t 应排在语义版本之后");

  // 5. 非语义版本之间按字符串降序兜底
  assert.ok(compareVersions("nightly", "alpha") < 0, "nightly 字典序降序排在 alpha 之前");
  assert.ok(compareVersions("alpha", "nightly") > 0);

  // 6. 空值、缺失值与非法输入绝不抛异常
  assert.equal(compareVersions("", ""), 0);
  assert.ok(compareVersions("v0.1", "") < 0);
  assert.ok(compareVersions("", "v0.1") > 0);
  assert.equal(compareVersions(undefined as any, null as any), 0);
  assert.equal(compareVersions("same", "same"), 0);

  const fullList = [
    "alpha",
    "v0.1",
    "nightly",
    "v0.10.0-rc.1",
    "v0.10.0",
    "v0.10.0-beta",
    "v0.9.2",
    "v0.10.0-rc.2",
  ];
  const fullSorted = [...fullList].sort(compareVersions);
  assert.deepEqual(fullSorted, [
    "v0.10.0",
    "v0.10.0-rc.2",
    "v0.10.0-rc.1",
    "v0.10.0-beta",
    "v0.9.2",
    "v0.1",
    "nightly",
    "alpha",
  ]);
});

test("判据 5：后端投影一致性（boardProjection 与 boardPayload 返回的 versions 满足最新在前契约，过滤空目录）", () => {
  const root = createTempRoot();
  try {
    // 创建若干版本
    createVersion(root, { slug: "v0.1", actor: "test" });
    createVersion(root, { slug: "v0.9.2", actor: "test" });
    createVersion(root, { slug: "v0.10.0", actor: "test" });
    createVersion(root, { slug: "v0.2", actor: "test" });
    createVersion(root, { slug: "nightly", actor: "test" });

    // 建立一个空目录（无 version.md），应被过滤，不进排序池
    mkdirSync(join(root, "versions", "empty-dir"), { recursive: true });

    // 1. 验证 boardProjection
    const board = boardProjection(root);
    const slugs = board.versions.map((v) => v.slug);
    assert.deepEqual(slugs, ["v0.10.0", "v0.9.2", "v0.2", "v0.1", "nightly"]);
    assert.ok(!slugs.includes("empty-dir"), "空目录不应出现在 versions 中");

    // 2. 验证 boardPayload
    const payload = boardPayload(root);
    const payloadSlugs = payload.versions.map((v) => v.slug);
    assert.deepEqual(payloadSlugs, ["v0.10.0", "v0.9.2", "v0.2", "v0.1", "nightly"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("判据 6：UI 交互与动态新建置顶（新建 v0.11.0 后立即置顶）", () => {
  const root = createTempRoot();
  try {
    createVersion(root, { slug: "v0.1", actor: "test" });
    createVersion(root, { slug: "v0.9.2", actor: "test" });
    createVersion(root, { slug: "v0.10.0", actor: "test" });

    let board = boardProjection(root);
    assert.equal(board.versions[0].slug, "v0.10.0", "初始最新版本为 v0.10.0");

    // 新建 v0.11.0
    createVersion(root, { slug: "v0.11.0", actor: "test" });

    board = boardProjection(root);
    assert.equal(board.versions[0].slug, "v0.11.0", "新建 v0.11.0 后立即置顶");
    assert.deepEqual(
      board.versions.map((v) => v.slug),
      ["v0.11.0", "v0.10.0", "v0.9.2", "v0.1"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
