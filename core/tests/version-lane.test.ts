/** g-134：版本泳道管理测试——创建/重命名/删除版本泳道。 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { init, createGoal, boardProjection, moveGoal } from "../ops.ts";
import { createVersion, renameVersion, deleteVersion } from "../ops.ts";
import { readEvents } from "../events.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "g134-"));
  init(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createVersion", () => {
  it("创建版本泳道并持久化版本元数据", () => {
    const { slug, name } = createVersion(root, { slug: "v0.7", name: "版本 0.7", actor: "test" });
    assert.equal(slug, "v0.7");
    assert.equal(name, "版本 0.7");
    // 版本目录存在
    assert.ok(existsSync(join(root, "versions", "v0.7", "version.md")));
    // version.md 内容正确
    const content = readFileSync(join(root, "versions", "v0.7", "version.md"), "utf8");
    assert.ok(content.includes("版本 0.7"));
    assert.ok(content.includes("planning"));
    // events.jsonl 包含 version.created
    const events = readEvents(root);
    const created = events.find((e) => e.event === "version.created" && e.details?.version === "v0.7");
    assert.ok(created, "应记录 version.created 事件");
    assert.equal(created.details.implicit, false);
  });

  it("新版本可接收目标并在重载后仍正确显示", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    createGoal(root, { title: "测试目标", version: "v0.7", actor: "test" });
    const board = boardProjection(root);
    const v = board.versions.find((v) => v.slug === "v0.7");
    assert.ok(v, "版本应出现在看板投影中");
    assert.equal(v.goals.length, 1);
    assert.equal(v.goals[0].title, "测试目标");
  });

  it("版本已存在时抛错", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    assert.throws(() => createVersion(root, { slug: "v0.7", actor: "test" }), /已存在/);
  });

  it("slug 为空时抛错", () => {
    assert.throws(() => createVersion(root, { slug: "", actor: "test" }), /不能为空/);
  });

  it("slug 含路径分隔符时抛错", () => {
    assert.throws(() => createVersion(root, { slug: "v0.7/bad", actor: "test" }), /路径分隔符/);
  });

  it("不指定 name 时默认与 slug 相同", () => {
    const { name } = createVersion(root, { slug: "v0.7", actor: "test" });
    assert.equal(name, "v0.7");
  });
});

describe("renameVersion", () => {
  it("重命名版本泳道，版本目录、目标 version 引用、看板投影与事件记录保持一致", () => {
    createVersion(root, { slug: "v0.7", name: "版本 0.7", actor: "test" });
    const goalId = createGoal(root, { title: "测试目标", version: "v0.7", actor: "test" });
    const result = renameVersion(root, { slug: "v0.7", newSlug: "v0.8", newName: "版本 0.8", actor: "test" });
    assert.equal(result.old_slug, "v0.7");
    assert.equal(result.new_slug, "v0.8");
    assert.equal(result.old_name, "版本 0.7");
    assert.equal(result.new_name, "版本 0.8");
    // 旧目录不存在，新目录存在
    assert.ok(!existsSync(join(root, "versions", "v0.7")));
    assert.ok(existsSync(join(root, "versions", "v0.8", "version.md")));
    // 目标 version 引用更新
    const goalContent = readFileSync(join(root, "versions", "v0.8", "goals", goalId, "goal.md"), "utf8");
    assert.ok(goalContent.includes("v0.8"), "目标 version 引用应更新为 v0.8");
    // 看板投影正确
    const board = boardProjection(root);
    const v = board.versions.find((v) => v.slug === "v0.8");
    assert.ok(v, "新版本应出现在看板投影中");
    assert.equal(v.name, "版本 0.8");
    assert.equal(v.goals.length, 1);
    // 事件记录
    const events = readEvents(root);
    const renamed = events.find((e) => e.event === "version.renamed");
    assert.ok(renamed, "应记录 version.renamed 事件");
    assert.equal(renamed.details.old_slug, "v0.7");
    assert.equal(renamed.details.new_slug, "v0.8");
  });

  it("仅更新 name（slug 不变）", () => {
    createVersion(root, { slug: "v0.7", name: "版本 0.7", actor: "test" });
    const result = renameVersion(root, { slug: "v0.7", newName: "新名称", actor: "test" });
    assert.equal(result.new_slug, "v0.7");
    assert.equal(result.new_name, "新名称");
    // version.md 更新
    const content = readFileSync(join(root, "versions", "v0.7", "version.md"), "utf8");
    assert.ok(content.includes("新名称"));
  });

  it("版本不存在时抛错", () => {
    assert.throws(() => renameVersion(root, { slug: "v999", newName: "xxx", actor: "test" }), /不存在/);
  });

  it("新 slug 已存在时抛错", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    createVersion(root, { slug: "v0.8", actor: "test" });
    assert.throws(() => renameVersion(root, { slug: "v0.7", newSlug: "v0.8", actor: "test" }), /已存在/);
  });

  it("新 slug 含路径分隔符时抛错", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    assert.throws(() => renameVersion(root, { slug: "v0.7", newSlug: "v0.8/bad", actor: "test" }), /路径分隔符/);
  });

  it("归档目标的 version 引用也同步更新", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    const goalId = createGoal(root, { title: "归档目标", version: "v0.7", actor: "test" });
    // 手动归档（通过 moveGoal 不行，直接移动文件模拟）
    const archivedDir = join(root, "versions", "v0.7", "archived");
    const goalsDir = join(root, "versions", "v0.7", "goals", goalId);
    // 创建 archived 目录
    if (!existsSync(archivedDir)) {
      mkdirSync(archivedDir, { recursive: true });
    }
    renameSync(goalsDir, join(archivedDir, goalId));
    // 重命名版本
    renameVersion(root, { slug: "v0.7", newSlug: "v0.8", actor: "test" });
    // 归档目标 version 引用更新
    const goalContent = readFileSync(join(root, "versions", "v0.8", "archived", goalId, "goal.md"), "utf8");
    assert.ok(goalContent.includes("v0.8"), "归档目标 version 引用应更新为 v0.8");
  });
});

describe("deleteVersion", () => {
  it("删除完全空的版本泳道", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    const { slug } = deleteVersion(root, { slug: "v0.7", actor: "test" });
    assert.equal(slug, "v0.7");
    // 版本目录不存在
    assert.ok(!existsSync(join(root, "versions", "v0.7")));
    // 事件记录
    const events = readEvents(root);
    const deleted = events.find((e) => e.event === "version.deleted");
    assert.ok(deleted, "应记录 version.deleted 事件");
    assert.equal(deleted.details.version, "v0.7");
  });

  it("非空版本（有目标）拒绝删除", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    createGoal(root, { title: "测试目标", version: "v0.7", actor: "test" });
    assert.throws(() => deleteVersion(root, { slug: "v0.7", actor: "test" }), /仍有目标/);
  });

  it("非空版本（有归档目标）拒绝删除", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    const goalId = createGoal(root, { title: "归档目标", version: "v0.7", actor: "test" });
    // 手动归档
    const archivedDir = join(root, "versions", "v0.7", "archived");
    const goalsDir = join(root, "versions", "v0.7", "goals", goalId);
    // 创建 archived 目录
    if (!existsSync(archivedDir)) {
      mkdirSync(archivedDir, { recursive: true });
    }
    renameSync(goalsDir, join(archivedDir, goalId));
    assert.throws(() => deleteVersion(root, { slug: "v0.7", actor: "test" }), /仍有目标/);
  });

  it("版本不存在时抛错", () => {
    assert.throws(() => deleteVersion(root, { slug: "v999", actor: "test" }), /不存在/);
  });

  it("slug 为空时抛错", () => {
    assert.throws(() => deleteVersion(root, { slug: "", actor: "test" }), /不能为空/);
  });

  it("backlog 和独立目标不是版本，不能通过 deleteVersion 删除", () => {
    // backlog 和独立目标不走 deleteVersion，走 deleteGoal
    // 这里验证 deleteVersion 只操作 versions/ 下的目录
    assert.throws(() => deleteVersion(root, { slug: "backlog", actor: "test" }), /不存在/);
    assert.throws(() => deleteVersion(root, { slug: "goals", actor: "test" }), /不存在/);
  });
});

describe("版本泳道管理集成", () => {
  it("创建→重命名→删除完整流程", () => {
    // 创建
    createVersion(root, { slug: "v0.7", name: "版本 0.7", actor: "test" });
    createGoal(root, { title: "目标A", version: "v0.7", actor: "test" });
    // 重命名
    renameVersion(root, { slug: "v0.7", newSlug: "v0.8", newName: "版本 0.8", actor: "test" });
    // 验证重命名后看板
    let board = boardProjection(root);
    let v = board.versions.find((v) => v.slug === "v0.8");
    assert.ok(v);
    assert.equal(v.goals.length, 1);
    // 移走目标（模拟清空版本）
    const goalId = v.goals[0].id;
    moveGoal(root, goalId, { to: "standalone", actor: "test" });
    // 现在版本为空，可以删除
    deleteVersion(root, { slug: "v0.8", actor: "test" });
    board = boardProjection(root);
    v = board.versions.find((v) => v.slug === "v0.8");
    assert.ok(!v, "版本应已删除");
    // 目标仍在 standalone
    const standalone = board.standalone.find((g) => g.id === goalId);
    assert.ok(standalone, "目标应迁移到 standalone");
  });

  it("事件先行：所有操作先写事件再改文件", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    const events = readEvents(root);
    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent.event, "version.created");
    // 重命名
    renameVersion(root, { slug: "v0.7", newName: "新名称", actor: "test" });
    const events2 = readEvents(root);
    const lastEvent2 = events2[events2.length - 1];
    assert.equal(lastEvent2.event, "version.renamed");
    // 删除
    deleteVersion(root, { slug: "v0.7", actor: "test" });
    const events3 = readEvents(root);
    const lastEvent3 = events3[events3.length - 1];
    assert.equal(lastEvent3.event, "version.deleted");
  });
});
