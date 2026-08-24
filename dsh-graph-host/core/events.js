/** 事件流：events.jsonl 是全部状态的唯一真相源（R-02）。 */
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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
export function appendEvent(root, ev) {
    const rec = { ts: ev.ts ?? nowIso(), ...ev };
    appendFileSync(join(root, "events.jsonl"), JSON.stringify(rec) + "\n", "utf8");
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
        // g-140：goal.deleted 终态
        if (ev.event === "goal.deleted") {
            statuses.set(ev.goal, "deleted");
        }
    }
    return statuses;
}
