/** g-134：版本泳道管理测试——创建/重命名/删除版本泳道。 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, renameSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { init, createGoal, boardProjection, moveGoal, rebuild } from "../ops.ts";
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

  it("事件元数据：version.created 包含完整元数据用于 rebuild/replay", () => {
    createVersion(root, { slug: "v0.7", name: "版本 0.7", actor: "test" });
    const events = readEvents(root);
    const created = events.find((e) => e.event === "version.created");
    assert.ok(created, "应记录 version.created 事件");
    // 验证事件包含完整元数据
    assert.equal(created.details.version, "v0.7");
    assert.equal(created.details.name, "版本 0.7");
    assert.ok(created.details.version_id, "应包含 version_id");
    assert.equal(created.details.status, "planning");
    assert.ok(created.details.created_at, "应包含 created_at");
    assert.equal(created.details.implicit, false);
  });

  it("事件元数据：version.renamed 包含完整元数据用于 rebuild/replay", () => {
    createVersion(root, { slug: "v0.7", name: "版本 0.7", actor: "test" });
    renameVersion(root, { slug: "v0.7", newSlug: "v0.8", newName: "版本 0.8", actor: "test" });
    const events = readEvents(root);
    const renamed = events.find((e) => e.event === "version.renamed");
    assert.ok(renamed, "应记录 version.renamed 事件");
    // 验证事件包含完整元数据
    assert.equal(renamed.details.old_slug, "v0.7");
    assert.equal(renamed.details.new_slug, "v0.8");
    assert.equal(renamed.details.old_name, "版本 0.7");
    assert.equal(renamed.details.new_name, "版本 0.8");
    assert.ok(renamed.details.version_id, "应包含 version_id");
    assert.ok(renamed.details.old_status, "应包含 old_status");
    assert.ok(renamed.details.new_status, "应包含 new_status");
  });

  it("事件元数据：version.deleted 包含完整元数据用于 rebuild/replay", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    deleteVersion(root, { slug: "v0.7", actor: "test" });
    const events = readEvents(root);
    const deleted = events.find((e) => e.event === "version.deleted");
    assert.ok(deleted, "应记录 version.deleted 事件");
    // 验证事件包含完整元数据
    assert.equal(deleted.details.version, "v0.7");
    assert.equal(deleted.details.deleted_version_dir, "versions/v0.7");
    assert.equal(deleted.details.had_goals, false);
    assert.equal(deleted.details.had_archived, false);
  });

  it("rename 预检：冲突失败不留下假事件", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    createVersion(root, { slug: "v0.8", actor: "test" });
    const eventsBefore = readEvents(root).length;
    // 尝试重命名到已存在的 slug，应失败
    assert.throws(() => renameVersion(root, { slug: "v0.7", newSlug: "v0.8", actor: "test" }), /已存在/);
    // 验证事件数量未增加（没有假事件）
    const eventsAfter = readEvents(root).length;
    assert.equal(eventsAfter, eventsBefore, "冲突失败不应留下假事件");
  });

  it("保守删除：拒绝含有孤儿内容的版本", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    // 创建孤儿文件
    const orphanFile = join(root, "versions", "v0.7", "orphan.txt");
    writeFileSync(orphanFile, "orphan content");
    assert.throws(() => deleteVersion(root, { slug: "v0.7", actor: "test" }), /未知内容/);
  });

  it("保守删除：拒绝 goals/ 目录内有孤儿文件", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    // 在 goals/ 目录内创建孤儿文件（非目录）
    const orphanFile = join(root, "versions", "v0.7", "goals", "orphan.txt");
    writeFileSync(orphanFile, "orphan content");
    assert.throws(() => deleteVersion(root, { slug: "v0.7", actor: "test" }), /orphan\.txt/);
  });

  it("保守删除：拒绝 archived/ 目录内有孤儿文件", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    // 创建 archived 目录并在子目录中添加孤儿文件（不含 goal.md，不触发 versionHasGoals）
    const archivedDir = join(root, "versions", "v0.7", "archived", "orphan-dir");
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(join(archivedDir, "mystery.txt"), "orphan content");
    assert.throws(() => deleteVersion(root, { slug: "v0.7", actor: "test" }), /mystery\.txt/);
  });

  it("完整目标枚举：重命名更新全局 archived 目标", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    const goalId = createGoal(root, { title: "归档目标", version: "v0.7", actor: "test" });
    // 手动移动到全局 archived 目录
    const globalArchivedDir = join(root, "versions", "archived");
    if (!existsSync(globalArchivedDir)) {
      mkdirSync(globalArchivedDir, { recursive: true });
    }
    const goalDir = join(root, "versions", "v0.7", "goals", goalId);
    renameSync(goalDir, join(globalArchivedDir, goalId));
    // 重命名版本
    renameVersion(root, { slug: "v0.7", newSlug: "v0.8", actor: "test" });
    // 验证全局 archived 目标 version 引用更新
    const goalContent = readFileSync(join(globalArchivedDir, goalId, "goal.md"), "utf8");
    assert.ok(goalContent.includes("v0.8"), "全局 archived 目标 version 引用应更新为 v0.8");
  });

  it("rebuild：version 事件已持久化但 version.md 丢失时可恢复", () => {
    createVersion(root, { slug: "v0.7", name: "版本 0.7", actor: "test" });
    // 模拟 version.md 丢失
    const vfile = join(root, "versions", "v0.7", "version.md");
    rmSync(vfile);
    assert.ok(!existsSync(vfile));
    // rebuild 应恢复
    const drift = rebuild(root);
    assert.ok(drift.some((d) => d.includes("v0.7") && d.includes("恢复")), "应报告版本恢复");
    assert.ok(existsSync(vfile), "version.md 应被恢复");
    const content = readFileSync(vfile, "utf8");
    assert.ok(content.includes("版本 0.7"), "恢复的 version.md 应包含 name");
    assert.ok(content.includes("planning"), "恢复的 version.md 应包含 status");
  });

  it("rebuild：version 事件已持久化但整个版本目录丢失时可恢复", () => {
    createVersion(root, { slug: "v0.7", name: "版本 0.7", actor: "test" });
    // 模拟整个版本目录丢失
    const vdir = join(root, "versions", "v0.7");
    rmSync(vdir, { recursive: true, force: true });
    assert.ok(!existsSync(vdir));
    // rebuild 应恢复
    const drift = rebuild(root);
    assert.ok(drift.some((d) => d.includes("v0.7") && d.includes("恢复")), "应报告版本恢复");
    assert.ok(existsSync(join(vdir, "version.md")), "version.md 应被恢复");
    assert.ok(existsSync(join(vdir, "goals")), "goals/ 目录应被恢复");
  });

  it("rebuild：version.renamed 事件正确追踪 slug 变更", () => {
    createVersion(root, { slug: "v0.7", name: "版本 0.7", actor: "test" });
    renameVersion(root, { slug: "v0.7", newSlug: "v0.8", newName: "版本 0.8", actor: "test" });
    // 删除 v0.8 的 version.md 模拟丢失
    const vfile = join(root, "versions", "v0.8", "version.md");
    rmSync(vfile);
    // rebuild 应从 renamed 事件追踪到 v0.8 并恢复
    const drift = rebuild(root);
    assert.ok(drift.some((d) => d.includes("v0.8") && d.includes("恢复")), "应报告 v0.8 恢复");
    assert.ok(existsSync(vfile), "v0.8/version.md 应被恢复");
    const content = readFileSync(vfile, "utf8");
    assert.ok(content.includes("版本 0.8"), "恢复的 name 应为 renamed 后的名称");
  });

  it("rebuild：version.deleted 后不恢复已删除版本", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    deleteVersion(root, { slug: "v0.7", actor: "test" });
    // rebuild 不应恢复已删除版本
    const drift = rebuild(root);
    assert.ok(!drift.some((d) => d.includes("v0.7")), "不应报告已删除版本");
    assert.ok(!existsSync(join(root, "versions", "v0.7")), "已删除版本不应被恢复");
  });

  it("rename 预检：NUL 字符失败不留下假事件", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    const eventsBefore = readEvents(root).length;
    assert.throws(() => renameVersion(root, { slug: "v0.7", newSlug: "v0.8\0bad", actor: "test" }), /NUL/);
    const eventsAfter = readEvents(root).length;
    assert.equal(eventsAfter, eventsBefore, "NUL 失败不应留下假事件");
  });

  it("rename 预检：路径分隔符失败不留下假事件", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    const eventsBefore = readEvents(root).length;
    assert.throws(() => renameVersion(root, { slug: "v0.7", newSlug: "v0.8/bad", actor: "test" }), /路径分隔符/);
    const eventsAfter = readEvents(root).length;
    assert.equal(eventsAfter, eventsBefore, "路径分隔符失败不应留下假事件");
  });

  it("delete 预检：nested orphan 拒绝不留下假删除事件", () => {
    createVersion(root, { slug: "v0.7", actor: "test" });
    // 在 goals/ 下放孤儿文件（非目录），触发非目录文件检查
    const orphanFile = join(root, "versions", "v0.7", "goals", "mystery.txt");
    writeFileSync(orphanFile, "orphan");
    const eventsBefore = readEvents(root).length;
    assert.throws(() => deleteVersion(root, { slug: "v0.7", actor: "test" }), /mystery\.txt/);
    const eventsAfter = readEvents(root).length;
    assert.equal(eventsAfter, eventsBefore, "nested orphan 拒绝不应留下假删除事件");
  });

  it("delete 事件：包含完整版本元数据快照", () => {
    createVersion(root, { slug: "v0.7", name: "版本 0.7", actor: "test" });
    deleteVersion(root, { slug: "v0.7", actor: "test" });
    const events = readEvents(root);
    const deleted = events.find((e) => e.event === "version.deleted");
    assert.ok(deleted, "应记录 version.deleted 事件");
    assert.equal(deleted.details.version, "v0.7");
    assert.ok(deleted.details.version_id, "应包含 version_id");
    assert.equal(deleted.details.name, "版本 0.7");
    assert.equal(deleted.details.status, "planning");
    assert.ok(deleted.details.created_at, "应包含 created_at");
    assert.equal(deleted.details.deleted_version_dir, "versions/v0.7");
    assert.equal(deleted.details.had_goals, false);
    assert.equal(deleted.details.had_archived, false);
  });
});
