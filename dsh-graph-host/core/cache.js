/** g-212 board cache: watcher-driven generations; payload assembly stays in ops. */
import { resolve, join } from "node:path";
import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { ensureWatcher, watcherSafe, generation, invalidate, inspectGenerations, closeWatchers } from "./cache-state.js";
export { closeWatchers };
const boardCache = new Map();
export function invalidateBoardCache(root) {
    if (!root) {
        boardCache.clear();
        invalidate();
        return;
    }
    const key = resolve(root);
    invalidate(key);
    for (const k of boardCache.keys())
        if (k.startsWith(key + "::"))
            boardCache.delete(k);
}
export function computeGraphRevision(root, includeArchived = false) {
    const key = resolve(root);
    ensureWatcher(key);
    const h = createHash("sha256");
    h.update(key);
    h.update("\0");
    h.update(includeArchived ? "1" : "0");
    h.update("\0");
    h.update(String(generation(key)));
    for (const name of ["events.jsonl", "project.yaml", "order.json", "rules.md"]) {
        try {
            const s = statSync(join(key, name));
            h.update(name + ":" + s.mtimeMs + ":" + s.size);
        }
        catch {
            h.update(name + ":missing");
        }
    }
    return h.digest("hex");
}
export function formatETag(revision) { return "W/\"" + revision + "\""; }
export function matchIfNoneMatch(value, current) {
    if (!value)
        return false;
    if (value.trim() === "*")
        return true;
    const clean = (s) => s.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
    const c = clean(current);
    return value.split(",").some(x => clean(x) === c);
}
export function getCachedBoardPayload(root, opts, payloadFactory) {
    const key = resolve(root), archived = opts?.includeArchived ?? false, cacheKey = key + "::" + (archived ? "1" : "0");
    const safe = watcherSafe(key), old = boardCache.get(cacheKey);
    const before = generation(key);
    const stableRevision = computeGraphRevision(key, archived);
    if (safe && old?.revision === stableRevision)
        return { ...old, fromCache: true };
    if (!payloadFactory)
        throw new Error("board payload factory required");
    const payload = payloadFactory(key, { includeArchived: archived });
    const after = generation(key);
    if (before !== after) {
        invalidate(key);
        return getCachedBoardPayload(key, opts, payloadFactory);
    }
    const rev = stableRevision;
    const payloadJson = JSON.stringify(payload);
    const entry = { payload, payloadJson, revision: rev, etag: formatETag(rev), cachedAt: Date.now() };
    if (safe)
        boardCache.set(cacheKey, entry);
    else
        boardCache.delete(cacheKey);
    return { ...entry, fromCache: false };
}
export function _inspectBoardCache() { return { boardCache, rootGenerations: inspectGenerations() }; }
