/** 版本泳道管理：创建/重命名/删除版本泳道（g-134）+ 发布 guard（g-135）。 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { parseDoc, serializeDoc, sectionText, type GoalDoc } from "./model.ts";
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

/** 检查版本目录下是否有任何目标（含归档）
 *  覆盖所有历史位置：versions/<slug>/goals、versions/<slug>/archived、全局 versions/archived */
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

  // 检查 versions/<slug>/archived/ 目录
  const archivedDir = join(vdir, "archived");
  if (existsSync(archivedDir)) {
    const entries = readdirSync(archivedDir).filter((d) => !d.startsWith("."));
    // 检查每个目录是否包含 goal.md 文件
    for (const entry of entries) {
      const goalFile = join(archivedDir, entry, "goal.md");
      if (existsSync(goalFile)) return true;
    }
  }

  // 检查全局 versions/archived/ 目录（历史位置）
  const globalArchivedDir = join(root, "versions", "archived");
  if (existsSync(globalArchivedDir)) {
    const entries = readdirSync(globalArchivedDir).filter((d) => !d.startsWith("."));
    for (const entry of entries) {
      const goalFile = join(globalArchivedDir, entry, "goal.md");
      if (!existsSync(goalFile)) continue;
      try {
        const doc = parseDoc(readFileSync(goalFile, "utf8"));
        if (doc.meta.version === slug) return true;
      } catch {
        /* 坏目标文件跳过 */
      }
    }
  }

  return false;
}

/** 批量更新版本内所有目标的 version 字段
 *  覆盖所有历史位置：versions/<slug>/goals、versions/<slug>/archived、全局 versions/archived */
function updateGoalsVersionField(root: string, slug: string, newSlug: string): void {
  const vdir = join(root, "versions", slug);

  // 更新 goals/ 下的目标
  const goalsDir = join(vdir, "goals");
  if (existsSync(goalsDir)) {
    for (const goalId of readdirSync(goalsDir)) {
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

  // 更新 versions/<slug>/archived/ 下的目标
  const archivedDir = join(vdir, "archived");
  if (existsSync(archivedDir)) {
    for (const goalId of readdirSync(archivedDir)) {
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

  // 更新全局 versions/archived/ 下的目标（历史位置）
  const globalArchivedDir = join(root, "versions", "archived");
  if (existsSync(globalArchivedDir)) {
    for (const goalId of readdirSync(globalArchivedDir)) {
      const gf = join(globalArchivedDir, goalId, "goal.md");
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
 *  校验：slug 非空且不含路径分隔符；版本目录不能已存在。
 *  事件先行：先写事件，再创建目录和文件；若事件写入失败则不创建任何内容。 */
export function createVersion(
  root: string,
  opts: { slug: string; name?: string; actor: string },
): { slug: string; name: string } {
  const slug = opts.slug.trim();
  if (!slug) throw new GraphError("版本 slug 不能为空");
  if (slug.includes("/") || slug.includes("\\")) throw new GraphError("版本 slug 不能包含路径分隔符");
  if (slug.includes("\0")) throw new GraphError("版本 slug 不能包含 NUL 字符");

  const vdir = join(root, "versions", slug);
  if (existsSync(vdir)) throw new GraphError(`版本 ${slug} 已存在`);

  const name = opts.name?.trim() || slug;
  const vId = "v-" + randomUUID().slice(0, 8);
  const createdAt = nowIso();

  // R-02：事件先行——先写事件，再创建目录和文件
  // 事件 details 包含完整元数据，使 rebuild/replay 可恢复版本泳道
  const eventDetails = {
    version: slug,
    name,
    version_id: vId,
    status: "planning",
    created_at: createdAt,
    implicit: false,
  };
  appendEvent(root, {
    actor: opts.actor,
    event: "version.created",
    details: eventDetails,
  });

  // 创建版本目录
  mkdirSync(join(vdir, "goals"), { recursive: true });

  // 创建 version.md
  const meta = {
    id: vId,
    name,
    status: "planning",
    created_at: createdAt,
  };
  const body = "\n## 范围\n\n（手动创建的版本泳道）\n";
  const doc: GoalDoc = { meta, body };
  writeFileSync(join(vdir, "version.md"), serializeDoc(doc), "utf8");

  return { slug, name };
}

/** 重命名版本泳道：更新版本目录名、version.md 的 name 字段、所有目标的 version 引用，记录 version.renamed 事件。
 *  校验：版本必须存在；新 slug 非空且不含路径分隔符；新 slug 不能已存在（除非与旧 slug 相同，此时仅更新 name）。
 *  版本目录、目标 version 引用、事件记录保持一致且可追溯。
 *  预检先行：先完成所有可能失败的校验，再写事件，再执行变更。 */
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
  if (newSlug.includes("\0")) throw new GraphError("新版本 slug 不能包含 NUL 字符");

  // 预检：如果 slug 变了，先检查新 slug 是否已存在（避免写事件后失败留下假事件）
  const slugChanged = newSlug !== slug;
  if (slugChanged) {
    const newVdir = join(root, "versions", newSlug);
    if (existsSync(newVdir)) throw new GraphError(`版本 ${newSlug} 已存在`);
  }

  // R-02：事件先行——预检通过后写事件，再执行变更
  const eventDetails = {
    old_slug: slug,
    new_slug: newSlug,
    old_name: oldName,
    new_name: newName,
    version_id: oldMeta.id,
    old_status: oldMeta.status,
    new_status: oldMeta.status, // 重命名不改变状态
  };
  appendEvent(root, {
    actor: opts.actor,
    event: "version.renamed",
    details: eventDetails,
  });

  // 执行变更
  if (slugChanged) {
    // 先更新所有目标的 version 字段
    updateGoalsVersionField(root, slug, newSlug);

    // 移动版本目录
    renameSync(vdir, join(root, "versions", newSlug));

    // 更新 version.md 的 name
    saveVersionMeta(root, newSlug, { ...oldMeta, name: newName });
  } else {
    // 仅更新 name
    saveVersionMeta(root, slug, { ...oldMeta, name: newName });
  }

  return { old_slug: slug, new_slug: newSlug, old_name: oldName, new_name: newName };
}

/** 删除版本泳道：仅删除完全空的版本泳道（含归档目录在内均无目标），记录 version.deleted 事件。
 *  校验：版本必须存在；版本下不能有任何目标（含归档）；backlog 与独立目标不是版本，不允许删除。
 *  保守删除：递归预检 goals/archived 下的结构与内容，确认完全可删后才写事件；
 *  nested orphan 拒绝时不得写假删除事件。删除事件包含完整版本元数据快照。 */
export function deleteVersion(
  root: string,
  opts: { slug: string; actor: string },
): { slug: string } {
  const slug = opts.slug.trim();
  if (!slug) throw new GraphError("版本 slug 不能为空");

  const vdir = join(root, "versions", slug);
  if (!existsSync(vdir)) throw new GraphError(`版本 ${slug} 不存在`);

  // 读取版本元数据快照（在删除前）
  const versionMeta = loadVersionMeta(root, slug);

  // 检查是否为空版本（含归档目录）
  if (versionHasGoals(root, slug)) {
    throw new GraphError(`版本 ${slug} 下仍有目标（含归档目标），不能删除——请先移走或删除所有目标`);
  }

  // 保守删除：根级目录检查
  const vdirEntries = readdirSync(vdir);
  const allowedEntries = ["goals", "archived", "version.md"];
  const orphanEntries = vdirEntries.filter((entry) => !allowedEntries.includes(entry));
  if (orphanEntries.length > 0) {
    throw new GraphError(`版本 ${slug} 下存在未知内容（${orphanEntries.join(", ")}），不能删除——请先清理`);
  }

  // 递归预检 goals/ 子目录——确认完全可删后才写事件
  const goalsDir = join(vdir, "goals");
  if (existsSync(goalsDir)) {
    for (const entry of readdirSync(goalsDir)) {
      const entryPath = join(goalsDir, entry);
      let innerEntries: string[];
      try {
        innerEntries = readdirSync(entryPath);
      } catch {
        // ENOTDIR = 非目录文件，视为 orphan
        throw new GraphError(`版本 ${slug}/goals/ 下存在非目录文件（${entry}），不能删除——请先清理`);
      }
      const allowedInner = ["goal.md", "cards"];
      const orphanInner = innerEntries.filter((e) => !allowedInner.includes(e));
      if (orphanInner.length > 0) {
        throw new GraphError(`版本 ${slug}/goals/${entry} 下存在未知内容（${orphanInner.join(", ")}），不能删除——请先清理`);
      }
      const cardsDir = join(entryPath, "cards");
      if (existsSync(cardsDir) && readdirSync(cardsDir).length > 0) {
        throw new GraphError(`版本 ${slug}/goals/${entry}/cards 下仍有内容，不能删除——请先清理`);
      }
    }
  }

  // 递归预检 archived/ 子目录
  const archivedDir = join(vdir, "archived");
  if (existsSync(archivedDir)) {
    for (const entry of readdirSync(archivedDir)) {
      const entryPath = join(archivedDir, entry);
      let innerEntries: string[];
      try {
        innerEntries = readdirSync(entryPath);
      } catch {
        throw new GraphError(`版本 ${slug}/archived/ 下存在非目录文件（${entry}），不能删除——请先清理`);
      }
      const allowedInner = ["goal.md", "cards"];
      const orphanInner = innerEntries.filter((e) => !allowedInner.includes(e));
      if (orphanInner.length > 0) {
        throw new GraphError(`版本 ${slug}/archived/${entry} 下存在未知内容（${orphanInner.join(", ")}），不能删除——请先清理`);
      }
      const cardsDir = join(entryPath, "cards");
      if (existsSync(cardsDir) && readdirSync(cardsDir).length > 0) {
        throw new GraphError(`版本 ${slug}/archived/${entry}/cards 下仍有内容，不能删除——请先清理`);
      }
    }
  }

  // 所有预检通过后才写事件
  appendEvent(root, {
    actor: opts.actor,
    event: "version.deleted",
    details: {
      version: slug,
      version_id: versionMeta.id,
      name: versionMeta.name,
      status: versionMeta.status,
      created_at: versionMeta.created_at,
      deleted_version_dir: `versions/${slug}`,
      had_goals: existsSync(goalsDir) && readdirSync(goalsDir).length > 0,
      had_archived: existsSync(archivedDir) && readdirSync(archivedDir).length > 0,
    },
  });

  // 精确非递归删除
  // 先删除 goals/ 子目录
  if (existsSync(goalsDir)) {
    for (const entry of readdirSync(goalsDir)) {
      const entryPath = join(goalsDir, entry);
      // 删除 cards/ 子目录（已确认为空）
      const cardsDir = join(entryPath, "cards");
      if (existsSync(cardsDir)) rmdirSync(cardsDir);
      // 删除 goal.md
      const goalFile = join(entryPath, "goal.md");
      if (existsSync(goalFile)) rmSync(goalFile);
      // 删除目标子目录
      rmdirSync(entryPath);
    }
    rmdirSync(goalsDir);
  }

  // 删除 archived/ 子目录
  if (existsSync(archivedDir)) {
    for (const entry of readdirSync(archivedDir)) {
      const entryPath = join(archivedDir, entry);
      const cardsDir = join(entryPath, "cards");
      if (existsSync(cardsDir)) rmdirSync(cardsDir);
      const goalFile = join(entryPath, "goal.md");
      if (existsSync(goalFile)) rmSync(goalFile);
      rmdirSync(entryPath);
    }
    rmdirSync(archivedDir);
  }

  // 删除 version.md
  const vfile = join(vdir, "version.md");
  if (existsSync(vfile)) rmSync(vfile);

  // 删除版本根目录（应为空）
  const remainingEntries = readdirSync(vdir);
  if (remainingEntries.length > 0) {
    throw new GraphError(`版本 ${slug} 根目录下存在未知内容（${remainingEntries.join(", ")}），不能删除——请先清理`);
  }
  rmdirSync(vdir);

  return { slug };
}

// ---- g-135: 版本发布 guard 与版本状态管理 ----

/** 校验版本内全部非归档目标均为 delivered；返回阻塞目标列表（空 = 可发布）。 */
export function validateVersionRelease(root: string, slug: string): Array<{ id: string; title: string; status: string }> {
  const vdir = join(root, "versions", slug);
  if (!existsSync(vdir)) throw new GraphError(`版本 ${slug} 不存在`);

  const blocking: Array<{ id: string; title: string; status: string }> = [];
  const goalsDir = join(vdir, "goals");
  if (existsSync(goalsDir)) {
    for (const entry of readdirSync(goalsDir)) {
      const gf = join(goalsDir, entry, "goal.md");
      if (!existsSync(gf)) continue;
      try {
        const doc = parseDoc(readFileSync(gf, "utf8"));
        if (doc.meta.archived === true) continue; // 跳过归档
        if (doc.meta.status !== "delivered") {
          blocking.push({
            id: String(doc.meta.id ?? entry),
            title: String(doc.meta.title ?? entry),
            status: String(doc.meta.status ?? "unknown"),
          });
        }
      } catch {
        /* 坏目标文件跳过 */
      }
    }
  }
  return blocking;
}

/** 发布版本：由负责人确认后将版本标为 released。
 *  校验：全部非归档目标必须为 delivered；否则返回阻塞清单、不写任何状态。
 *  事件先行：先写 version.released 事件，再更新 version.md 的 status。
 *  actor 必须是 human:* 或 supervisor:* 前缀（负责人确认路径），agent:* 被拒绝。 */
export function releaseVersion(
  root: string,
  opts: { slug: string; actor: string },
): { ok: true } | { ok: false; blocking: Array<{ id: string; title: string; status: string }> } {
  const slug = opts.slug.trim();
  if (!slug) throw new GraphError("版本 slug 不能为空");

  // 校验 actor 身份：仅 human:* 或 supervisor:* 可发布
  if (!opts.actor.startsWith("human:") && !opts.actor.startsWith("supervisor:")) {
    throw new GraphError(`发布操作仅限负责人确认（actor=${opts.actor}），执行子代理不能直接发布`);
  }

  const vdir = join(root, "versions", slug);
  if (!existsSync(vdir)) throw new GraphError(`版本 ${slug} 不存在`);

  const meta = loadVersionMeta(root, slug);
  if (meta.status === "released") {
    throw new GraphError(`版本 ${slug} 已经是 released 状态`);
  }

  // 校验发布前置条件：全部非归档目标必须为 delivered
  const blocking = validateVersionRelease(root, slug);
  if (blocking.length > 0) {
    return { ok: false, blocking };
  }

  // R-02：事件先行——先写 version.released 事件，再更新版本状态
  appendEvent(root, {
    actor: opts.actor,
    event: "version.released",
    details: {
      version: slug,
      version_id: meta.id,
      name: meta.name,
      old_status: meta.status,
      new_status: "released",
    },
  });

  // 更新 version.md 的 status
  saveVersionMeta(root, slug, { ...meta, status: "released" });

  return { ok: true };
}

/** 合法的 setVersionStatus 目标状态（不含 released——released 只能经 releaseVersion）。 */
const VERSION_STATUS_ALLOWLIST = ["planning", "active"] as const;

/** 设置版本状态（working -> active / active -> planning 等）。
 *  released 只能经 releaseVersion 路径，此函数拒绝。
 *  事件先行：先写 version.status_changed 事件，再更新 version.md。
 *  released->active 例外：需要 confirmed=true + human/supervisor actor。 */
export function setVersionStatus(
  root: string,
  opts: { slug: string; status: string; actor: string; confirmed?: boolean },
): void {
  const slug = opts.slug.trim();
  if (!slug) throw new GraphError("版本 slug 不能为空");

  const newStatus = opts.status.trim();
  // released 只能经 releaseVersion（含 delivered-goal guard），不能走此直接路径
  if (newStatus === "released") {
    throw new GraphError("不能通过 setVersionStatus 直接设为 released——请使用 releaseVersion（含发布前置校验）");
  }
  // allowlist：只接受合法的非 released 状态（released→active 例外路径绕过 allowlist）
  if (!(VERSION_STATUS_ALLOWLIST as readonly string[]).includes(newStatus)) {
    throw new GraphError(`非法版本状态：${newStatus}（合法值：${(VERSION_STATUS_ALLOWLIST as readonly string[]).join(", ")}）`);
  }

  const vdir = join(root, "versions", slug);
  if (!existsSync(vdir)) throw new GraphError(`版本 ${slug} 不存在`);

  const meta = loadVersionMeta(root, slug);
  const oldStatus = meta.status;
  if (oldStatus === newStatus) return; // 幂等

  // released→active 例外路径：需要确认标志和可信 actor
  if (oldStatus === "released") {
    if (newStatus !== "active") {
      throw new GraphError("版本已 released，只能恢复为 active，不能回退到其他状态");
    }
    if (!opts.confirmed) {
      throw new GraphError("恢复 released 版本需要明确确认（confirmed=true）");
    }
    if (!opts.actor.startsWith("human:") && !opts.actor.startsWith("supervisor:")) {
      throw new GraphError(`恢复 released 版本仅限负责人确认（actor=${opts.actor}），执行子代理不能操作`);
    }
  }

  // R-02：事件先行
  appendEvent(root, {
    actor: opts.actor,
    event: "version.status_changed",
    details: {
      version: slug,
      version_id: meta.id,
      old_status: oldStatus,
      new_status: newStatus,
    },
  });

  saveVersionMeta(root, slug, { ...meta, status: newStatus });
}

/** 读取版本详情：元数据 + 范围/摘要（从 version.md body 的「范围」小节提取）。 */
export function versionDetail(root: string, slug: string): {
  slug: string;
  id: string | null;
  name: string;
  status: string;
  created_at: string;
  summary: string | null;
  scope: string | null;
  goals_count: number;
  blocking: Array<{ id: string; title: string; status: string }>;
} {
  const vdir = join(root, "versions", slug);
  if (!existsSync(vdir)) throw new GraphError(`版本 ${slug} 不存在`);

  const vfile = join(vdir, "version.md");
  const doc = parseDoc(readFileSync(vfile, "utf8"));
  const meta = doc.meta;

  // 从 body 提取「范围」小节内容作为摘要/范围
  const scopeRaw = sectionText(doc.body, "范围");
  const scope = scopeRaw ? scopeRaw.replace(/<!--[\s\S]*?-->/g, "").trim() || null : null;

  // 统计非归档目标数
  let goalsCount = 0;
  const goalsDir = join(vdir, "goals");
  if (existsSync(goalsDir)) {
    for (const entry of readdirSync(goalsDir)) {
      const gf = join(goalsDir, entry, "goal.md");
      if (!existsSync(gf)) continue;
      try {
        const gdoc = parseDoc(readFileSync(gf, "utf8"));
        if (gdoc.meta.archived !== true) goalsCount++;
      } catch { /* 跳过 */ }
    }
  }

  // 发布前置校验（非 released 状态时检查阻塞清单）
  const blocking = meta.status === "released" ? [] : validateVersionRelease(root, slug);

  return {
    slug,
    id: meta.id ?? null,
    name: String(meta.name ?? slug),
    status: String(meta.status ?? "unknown"),
    created_at: String(meta.created_at ?? ""),
    summary: scope,
    scope,
    goals_count: goalsCount,
    blocking,
  };
}
