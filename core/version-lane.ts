/** 版本泳道管理：创建/重命名/删除版本泳道（g-134）。 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { parseDoc, serializeDoc, type GoalDoc } from "./model.ts";
import { appendEvent, readEvents, nowIso } from "./events.ts";
import { GraphError } from "./machine.ts";

// ---- 辅助函数 ----

/** 读取版本元数据文件 */
function loadVersionMeta(root: string, slug: string): Record<string, any> {
  const vfile = join(root, "versions", slug, "version.md");
  if (!existsSync(vfile)) throw new GraphError(`版本 ${slug} 不存在`);
  const doc = parseDoc(readFileSync(vfile, "utf8"));
  return doc.meta;
}

/** 保存版本元数据文件 */
function saveVersionMeta(root: string, slug: string, meta: Record<string, any>): void {
  const vfile = join(root, "versions", slug, "version.md");
  const doc = parseDoc(readFileSync(vfile, "utf8"));
  doc.meta = meta;
  writeFileSync(vfile, serializeDoc(doc), "utf8");
}

/** 检查版本目录下是否有任何目标（含归档） */
function versionHasGoals(root: string, slug: string): boolean {
  const vdir = join(root, "versions", slug);

  // 检查 goals/ 目录
  const goalsDir = join(vdir, "goals");
  if (existsSync(goalsDir)) {
    const entries = readdirSync(goalsDir).filter((d) => !d.startsWith("."));
    // 检查每个目录是否包含 goal.md 文件
    for (const entry of entries) {
      const goalFile = join(goalsDir, entry, "goal.md");
      if (existsSync(goalFile)) return true;
    }
  }

  // 检查 archived/ 目录
  const archivedDir = join(vdir, "archived");
  if (existsSync(archivedDir)) {
    const entries = readdirSync(archivedDir).filter((d) => !d.startsWith("."));
    // 检查每个目录是否包含 goal.md 文件
    for (const entry of entries) {
      const goalFile = join(archivedDir, entry, "goal.md");
      if (existsSync(goalFile)) return true;
    }
  }

  return false;
}

/** 批量更新版本内所有目标的 version 字段 */
function updateGoalsVersionField(root: string, slug: string, newSlug: string): void {
  const vdir = join(root, "versions", slug);

  // 更新 goals/ 下的目标
  const goalsDir = join(vdir, "goals");
  if (existsSync(goalsDir)) {
    for (const goalId of readdirSync(goalsDir)) {
      if (!goalId.startsWith("g-")) continue;
      const gf = join(goalsDir, goalId, "goal.md");
      if (!existsSync(gf)) continue;
      try {
        const doc = parseDoc(readFileSync(gf, "utf8"));
        if (doc.meta.version === slug) {
          doc.meta.version = newSlug;
          writeFileSync(gf, serializeDoc(doc), "utf8");
        }
      } catch {
        /* 坏目标文件跳过 */
      }
    }
  }

  // 更新 archived/ 下的目标
  const archivedDir = join(vdir, "archived");
  if (existsSync(archivedDir)) {
    for (const goalId of readdirSync(archivedDir)) {
      if (!goalId.startsWith("g-")) continue;
      const gf = join(archivedDir, goalId, "goal.md");
      if (!existsSync(gf)) continue;
      try {
        const doc = parseDoc(readFileSync(gf, "utf8"));
        if (doc.meta.version === slug) {
          doc.meta.version = newSlug;
          writeFileSync(gf, serializeDoc(doc), "utf8");
        }
      } catch {
        /* 坏目标文件跳过 */
      }
    }
  }
}

// ---- 公开 API ----

/** 创建版本泳道：创建版本目录与 version.md，记录 version.created 事件。
 *  校验：slug 非空且不含路径分隔符；版本目录不能已存在。 */
export function createVersion(
  root: string,
  opts: { slug: string; name?: string; actor: string },
): { slug: string; name: string } {
  const slug = opts.slug.trim();
  if (!slug) throw new GraphError("版本 slug 不能为空");
  if (slug.includes("/") || slug.includes("\\")) throw new GraphError("版本 slug 不能包含路径分隔符");

  const vdir = join(root, "versions", slug);
  if (existsSync(vdir)) throw new GraphError(`版本 ${slug} 已存在`);

  const name = opts.name?.trim() || slug;
  const vId = "v-" + randomUUID().slice(0, 8);

  // 创建版本目录
  mkdirSync(join(vdir, "goals"), { recursive: true });

  // 创建 version.md
  const meta = {
    id: vId,
    name,
    status: "planning",
    created_at: nowIso(),
  };
  const body = "\n## 范围\n\n（手动创建的版本泳道）\n";
  const doc: GoalDoc = { meta, body };
  writeFileSync(join(vdir, "version.md"), serializeDoc(doc), "utf8");

  // 记录事件（R-02：事件先行）
  appendEvent(root, {
    actor: opts.actor,
    event: "version.created",
    details: { version: slug, name, implicit: false },
  });

  return { slug, name };
}

/** 重命名版本泳道：更新版本目录名、version.md 的 name 字段、所有目标的 version 引用，记录 version.renamed 事件。
 *  校验：版本必须存在；新 slug 非空且不含路径分隔符；新 slug 不能已存在（除非与旧 slug 相同，此时仅更新 name）。
 *  版本目录、目标 version 引用、事件记录保持一致且可追溯。 */
export function renameVersion(
  root: string,
  opts: { slug: string; newSlug?: string; newName?: string; actor: string },
): { old_slug: string; new_slug: string; old_name: string; new_name: string } {
  const slug = opts.slug.trim();
  if (!slug) throw new GraphError("版本 slug 不能为空");

  const vdir = join(root, "versions", slug);
  if (!existsSync(vdir)) throw new GraphError(`版本 ${slug} 不存在`);

  const oldMeta = loadVersionMeta(root, slug);
  const oldName = String(oldMeta.name ?? slug);

  const newSlug = opts.newSlug?.trim() || slug;
  const newName = opts.newName?.trim() || oldName;

  if (newSlug.includes("/") || newSlug.includes("\\")) throw new GraphError("新版本 slug 不能包含路径分隔符");

  // 如果 slug 变了，需要移动目录
  const slugChanged = newSlug !== slug;
  if (slugChanged) {
    const newVdir = join(root, "versions", newSlug);
    if (existsSync(newVdir)) throw new GraphError(`版本 ${newSlug} 已存在`);

    // 先更新所有目标的 version 字段
    updateGoalsVersionField(root, slug, newSlug);

    // 移动版本目录
    renameSync(vdir, newVdir);

    // 更新 version.md 的 name
    saveVersionMeta(root, newSlug, { ...oldMeta, name: newName });
  } else {
    // 仅更新 name
    saveVersionMeta(root, slug, { ...oldMeta, name: newName });
  }

  // 记录事件（R-02：事件先行）
  appendEvent(root, {
    actor: opts.actor,
    event: "version.renamed",
    details: {
      old_slug: slug,
      new_slug: newSlug,
      old_name: oldName,
      new_name: newName,
    },
  });

  return { old_slug: slug, new_slug: newSlug, old_name: oldName, new_name: newName };
}

/** 删除版本泳道：仅删除完全空的版本泳道（含归档目录在内均无目标），记录 version.deleted 事件。
 *  校验：版本必须存在；版本下不能有任何目标（含归档）；backlog 与独立目标不是版本，不允许删除。 */
export function deleteVersion(
  root: string,
  opts: { slug: string; actor: string },
): { slug: string } {
  const slug = opts.slug.trim();
  if (!slug) throw new GraphError("版本 slug 不能为空");

  const vdir = join(root, "versions", slug);
  if (!existsSync(vdir)) throw new GraphError(`版本 ${slug} 不存在`);

  // 检查是否为空版本（含归档目录）
  if (versionHasGoals(root, slug)) {
    throw new GraphError(`版本 ${slug} 下仍有目标（含归档目标），不能删除——请先移走或删除所有目标`);
  }

  // 删除版本目录
  rmSync(vdir, { recursive: true, force: true });

  // 记录事件（R-02：事件先行）
  appendEvent(root, {
    actor: opts.actor,
    event: "version.deleted",
    details: { version: slug },
  });

  return { slug };
}
