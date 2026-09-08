/** 事件流：events.jsonl 是全部状态的唯一真相源（R-02）。 */
import { appendFileSync, readFileSync, existsSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { invalidate as invalidateBoardCache } from "./cache-state.js";
import { STATUSES } from "./machine.js";
export function nowIso() {
    // 本地时区 ISO（含偏移），与历史手写事件（+08:00）保持一致
    const d = new Date();
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
    const mm = String(Math.abs(off) % 60).padStart(2, "0");
    const pad = (n) => String(n).padStart(2, "0");
    return (`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`);
}
/** 毫秒精度 nowIso：boardProjection 的 generated_at 使用它（g-171），
 *  与 updated_at（goal.md mtimeMs，毫秒级）同秒比较时不会被秒级截断产生负 age。 */
export function nowIsoMs() {
    const d = new Date();
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
    const mm = String(Math.abs(off) % 60).padStart(2, "0");
    const pad = (n) => String(n).padStart(2, "0");
    return (`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
        `.${String(d.getMilliseconds()).padStart(3, "0")}${sign}${hh}:${mm}`);
}
export function appendEvent(root, ev) {
    const rec = { ts: ev.ts ?? nowIso(), ...ev };
    appendFileSync(join(root, "events.jsonl"), JSON.stringify(rec) + "\n", "utf8");
    try {
        invalidateBoardCache(root);
    }
    catch {
        /* 忽略缓存失效失败 */
    }
    return rec;
}
export function readEvents(root) {
    const file = join(root, "events.jsonl");
    if (!existsSync(file))
        return [];
    const out = [];
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line)
            continue;
        let rec;
        try {
            rec = JSON.parse(line);
        }
        catch {
            throw new Error(`events.jsonl 第 ${i + 1} 行不是合法 JSON`);
        }
        if (!rec.event || !rec.actor) {
            throw new Error(`events.jsonl 第 ${i + 1} 行缺少 event/actor 字段`);
        }
        out.push(rec);
    }
    return out;
}
/**
 * 从事件流重建各版本泳道最终状态：
 * version.created → 存活；version.renamed → slug 变更；version.deleted → 删除。
 * version.released → 状态 released；version.status_changed → 状态切换（g-135）。
 * 返回 Map<slug, { alive, meta }>，其中 alive=false 表示已删除。
 */
export function replayVersionLanes(events) {
    const lanes = new Map();
    for (const ev of events) {
        if (ev.event === "version.created") {
            const slug = ev.details?.version;
            if (!slug)
                continue;
            lanes.set(slug, {
                alive: true,
                meta: {
                    id: ev.details.version_id ?? null,
                    name: ev.details.name ?? slug,
                    status: ev.details.status ?? "planning",
                    created_at: ev.details.created_at ?? ev.ts,
                },
            });
        }
        else if (ev.event === "version.renamed") {
            const oldSlug = ev.details?.old_slug;
            const newSlug = ev.details?.new_slug;
            if (!oldSlug || !newSlug)
                continue;
            const existing = lanes.get(oldSlug);
            if (existing && existing.alive) {
                lanes.delete(oldSlug);
                lanes.set(newSlug, {
                    alive: true,
                    meta: {
                        ...existing.meta,
                        name: ev.details.new_name ?? existing.meta.name,
                    },
                });
            }
        }
        else if (ev.event === "version.deleted") {
            const slug = ev.details?.version;
            if (!slug)
                continue;
            const existing = lanes.get(slug);
            if (existing) {
                lanes.set(slug, { ...existing, alive: false });
            }
        }
        else if (ev.event === "version.released") {
            // g-135：版本发布事件 → 状态设为 released
            const slug = ev.details?.version;
            if (!slug)
                continue;
            const existing = lanes.get(slug);
            if (existing && existing.alive) {
                lanes.set(slug, {
                    alive: true,
                    meta: { ...existing.meta, status: "released" },
                });
            }
        }
        else if (ev.event === "version.status_changed") {
            // g-135：版本状态切换事件（如 working → active）
            const slug = ev.details?.version;
            if (!slug)
                continue;
            const existing = lanes.get(slug);
            if (existing && existing.alive) {
                lanes.set(slug, {
                    alive: true,
                    meta: { ...existing.meta, status: ev.details.new_status ?? existing.meta.status },
                });
            }
        }
    }
    return lanes;
}
/**
 * 从事件流重建各目标状态：
 * goal.created → draft（无 version）或 planning（有 version）；
 * goal.planned 在 draft 时 → planning；goal.transition → details.to。
 * （goal.planned 视为 planning 阶段的隐式进入，覆盖规划期未显式迁移的补记场景。）
 * g-140：goal.deleted 为终态——replay 时标记已删除目标，后续事件忽略。
 */
export function replayStatuses(events) {
    const statuses = new Map();
    for (const ev of events) {
        if (!ev.goal)
            continue;
        // g-140：已删除目标不再响应任何事件
        if (statuses.get(ev.goal) === "deleted")
            continue;
        if (ev.event === "goal.created") {
            // g-137：带 version → 初始状态 planning；不带 version → draft
            const hasVersion = ev.details?.version != null;
            statuses.set(ev.goal, hasVersion ? "planning" : "draft");
        }
        if (ev.event === "goal.planned" && statuses.get(ev.goal) === "draft") {
            statuses.set(ev.goal, "planning");
        }
        if (ev.event === "goal.transition" &&
            typeof ev.details?.to === "string" &&
            STATUSES.includes(ev.details.to)) {
            statuses.set(ev.goal, ev.details.to);
        }
        // g-138：goal.postponed 回到 backlog → draft
        if (ev.event === "goal.postponed") {
            statuses.set(ev.goal, "draft");
        }
        // g-140：goal.deleted 终态
        if (ev.event === "goal.deleted") {
            statuses.set(ev.goal, "deleted");
        }
    }
    return statuses;
}
/** Serialize writers per graph root. mkdir is an atomic lock/CAS; the append is fsync'd. */
export function withMemoryLock(root, fn) {
    const memDir = join(root, "memory");
    mkdirSync(memDir, { recursive: true });
    const lock = join(memDir, ".memory.lock");
    let fd = -1;
    for (let i = 0; i < 600; i++) {
        try {
            fd = openSync(lock, "wx");
            const lease = JSON.stringify({ pid: process.pid, owner: `${process.pid}:${Date.now()}`, expires: Date.now() + 30_000 });
            writeSync(fd, lease, undefined, "utf8");
            fsyncSync(fd);
            break;
        }
        catch (e) {
            if (e?.code !== "EEXIST")
                throw e;
            try {
                const lease = JSON.parse(readFileSync(lock, "utf8"));
                let alive = true;
                try {
                    process.kill(Number(lease.pid), 0);
                }
                catch {
                    alive = false;
                }
                if (!alive && Number(lease.expires) < Date.now()) {
                    unlinkSync(lock);
                    continue;
                }
            }
            catch { }
            const wait = new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(wait, 0, 0, 5);
        }
    }
    if (fd < 0)
        throw new Error("memory lock timeout");
    try {
        return fn();
    }
    finally {
        closeSync(fd);
        try {
            unlinkSync(lock);
        }
        catch { }
    }
}
export function appendMemoryEvent(root, ev) {
    const rec = { ts: ev.ts ?? nowIso(), ...ev };
    const memDir = join(root, "memory");
    mkdirSync(memDir, { recursive: true });
    const fd = openSync(join(memDir, "memory.jsonl"), "a");
    try {
        writeSync(fd, JSON.stringify(rec) + "\n", undefined, "utf8");
        fsyncSync(fd);
        const dirfd = openSync(memDir, "r");
        try {
            fsyncSync(dirfd);
        }
        finally {
            closeSync(dirfd);
        }
    }
    finally {
        closeSync(fd);
    }
    return rec;
}
export function readMemoryEvents(root) {
    const file = join(root, "memory", "memory.jsonl");
    if (!existsSync(file))
        return [];
    const out = [];
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line)
            continue;
        let rec;
        try {
            rec = JSON.parse(line);
        }
        catch {
            // 容错损坏行（损坏行不中断整体读取与重放）
            continue;
        }
        if (!rec || typeof rec !== "object" || Array.isArray(rec) || typeof rec.event !== "string" || typeof rec.actor !== "string") {
            continue;
        }
        out.push(rec);
    }
    return out;
}
export function memoryDiagnostics(root) {
    const file = join(root, "memory", "memory.jsonl");
    if (!existsSync(file))
        return [];
    const out = [];
    for (const [i, raw] of readFileSync(file, "utf8").split("\n").entries()) {
        const line = raw.trim();
        if (!line)
            continue;
        try {
            const rec = JSON.parse(line);
            if (!rec || typeof rec !== "object" || Array.isArray(rec) || typeof rec.event !== "string" || typeof rec.actor !== "string")
                out.push(`memory.jsonl 第 ${i + 1} 行 schema 非法`);
            else if (!["memory.added", "memory.replaced", "memory.removed"].includes(rec.event))
                out.push(`memory.jsonl 第 ${i + 1} 行事件类型非法`);
        }
        catch {
            out.push(`memory.jsonl 第 ${i + 1} 行不是合法 JSON`);
        }
    }
    return out;
}
export function replayMemory(events) {
    const entries = new Map();
    for (const ev of events) {
        if (ev.event === "memory.added") {
            const id = ev.details?.id;
            const text = ev.details?.text;
            const kind = ev.details?.kind === "user" ? "user" : "project";
            const scope = ev.details?.scope === "standing" ? "standing" : "on_demand";
            const created_by = typeof ev.details?.created_by === "string" ? ev.details.created_by : (ev.actor || undefined);
            if (!id || typeof text !== "string")
                continue;
            const entry = {
                id,
                kind,
                scope,
                created_by,
                text,
                importance: typeof ev.details?.importance === "number" ? ev.details.importance : undefined,
                source_goal: typeof ev.details?.source_goal === "string" ? ev.details.source_goal : undefined,
                created_at: ev.details?.created_at ?? ev.ts,
                updated_at: ev.details?.updated_at ?? ev.ts,
            };
            if (kind === "user")
                Object.defineProperty(entry, "owner", { value: ev.actor, enumerable: false, writable: true });
            entries.set(id, entry);
        }
        else if (ev.event === "memory.replaced") {
            const id = ev.details?.id;
            const text = ev.details?.text;
            if (!id || typeof text !== "string")
                continue;
            const existing = entries.get(id);
            if (existing) {
                const kind = ev.details?.kind === "user" || ev.details?.kind === "project" ? ev.details.kind : existing.kind;
                const scope = ev.details?.scope === "standing" || ev.details?.scope === "on_demand" ? ev.details.scope : (existing.scope ?? "on_demand");
                const created_by = existing.created_by ?? (typeof ev.details?.created_by === "string" ? ev.details.created_by : ev.actor);
                const updated = {
                    id: existing.id, kind, scope, created_by, text,
                    importance: typeof ev.details?.importance === "number" ? ev.details.importance : existing.importance,
                    source_goal: typeof ev.details?.source_goal === "string" ? ev.details.source_goal : existing.source_goal,
                    created_at: existing.created_at,
                    updated_at: ev.details?.updated_at ?? ev.ts,
                };
                const owner = existing.owner ?? (typeof ev.details?.owner === "string" ? ev.details.owner : undefined);
                if (kind === "user" && owner)
                    Object.defineProperty(updated, "owner", { value: owner, enumerable: false, writable: true });
                entries.set(id, updated);
            }
        }
        else if (ev.event === "memory.removed") {
            const id = ev.details?.id;
            if (!id)
                continue;
            entries.delete(id);
        }
    }
    return Array.from(entries.values());
}
