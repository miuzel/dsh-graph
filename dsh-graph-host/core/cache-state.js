import { resolve } from "node:path";
import { watch } from "node:fs";
const generations = new Map();
const watchers = new Map();
const unsafe = new Set();
const MAX_WATCHERS = 32;
const IDLE_CLOSE_MS = 500;
const idleTimers = new Map();
export function generation(root) { return generations.get(resolve(root)) ?? 0; }
export function invalidate(root) { if (!root) {
    generations.clear();
    return;
} const key = resolve(root); generations.set(key, generation(key) + 1); }
function armIdle(key, w) {
    const previous = idleTimers.get(key);
    if (previous)
        clearTimeout(previous);
    const timer = setTimeout(() => {
        if (watchers.get(key) !== w || idleTimers.get(key) !== timer)
            return;
        try {
            w.close();
        }
        catch { }
        watchers.delete(key);
        idleTimers.delete(key);
        invalidate(key);
        unsafe.add(key);
    }, IDLE_CLOSE_MS);
    timer.unref?.();
    idleTimers.set(key, timer);
}
export function ensureWatcher(root) {
    const key = resolve(root);
    const existing = watchers.get(key);
    if (existing) {
        armIdle(key, existing);
        return !unsafe.has(key);
    }
    try {
        if (watchers.size >= MAX_WATCHERS) {
            const oldest = watchers.keys().next().value;
            if (oldest) {
                const ow = watchers.get(oldest);
                const ot = idleTimers.get(oldest);
                if (ot)
                    clearTimeout(ot);
                try {
                    ow?.close();
                }
                catch { }
                watchers.delete(oldest);
                idleTimers.delete(oldest);
                invalidate(oldest);
                unsafe.add(oldest);
            }
        }
        const w = watch(key, { recursive: true }, () => invalidate(key));
        w.unref?.();
        w.on("error", () => { const t = idleTimers.get(key); if (t)
            clearTimeout(t); if (watchers.get(key) === w) {
            watchers.delete(key);
            idleTimers.delete(key);
        } unsafe.add(key); invalidate(key); try {
            w.close();
        }
        catch { } });
        watchers.set(key, w);
        unsafe.delete(key);
        armIdle(key, w);
        return true;
    }
    catch {
        unsafe.add(key);
        return false;
    }
}
export function watcherSafe(root) { return ensureWatcher(root) && !unsafe.has(resolve(root)); }
export function closeWatchers() { for (const t of idleTimers.values())
    clearTimeout(t); idleTimers.clear(); for (const w of watchers.values())
    try {
        w.close();
    }
    catch { } watchers.clear(); }
export function inspectGenerations() { return generations; }
