/** g-212 board cache: watcher-driven generations; payload assembly stays in ops. */
import { resolve, join } from "node:path";
import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { ensureWatcher, watcherSafe, watcherEpoch, generation, invalidate, inspectGenerations, closeWatchers } from "./cache-state.ts";
export { closeWatchers };
export interface CachedBoardEntry { etag:string; revision:string; payload:any; payloadJson:string; payloadFingerprint:string; watcherEpoch:number; cachedAt:number; }
const boardCache = new Map<string,CachedBoardEntry>();
export function invalidateBoardCache(root?:string):void {
  if (!root) { boardCache.clear(); invalidate(); return; }
  const key=resolve(root); invalidate(key);
  for (const k of boardCache.keys()) if (k.startsWith(key+"::")) boardCache.delete(k);
}
export function computeGraphRevision(root:string, includeArchived=false):string {
  const key=resolve(root); ensureWatcher(key);
  const h=createHash("sha256"); h.update(key); h.update("\0"); h.update(includeArchived?"1":"0"); h.update("\0"); h.update(String(generation(key)));
  for (const name of ["events.jsonl", "project.yaml", "order.json", "rules.md"]) { try { const s=statSync(join(key,name)); h.update(name+":"+s.mtimeMs+":"+s.size); } catch { h.update(name+":missing"); } }
  return h.digest("hex");
}
export function formatETag(revision:string):string { return "W/\""+revision+"\""; }
export function matchIfNoneMatch(value:string|null|undefined,current:string):boolean {
  if (!value) return false; if (value.trim()==="*") return true;
  const clean=(s:string)=>s.trim().replace(/^W\//,"").replace(/^"|"$/g,""); const c=clean(current);
  return value.split(",").some(x=>clean(x)===c);
}
function payloadFingerprint(payload:any):string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) { const stable={...payload}; delete stable.generated_at; return JSON.stringify(stable)??""; }
  return JSON.stringify(payload)??"";
}
export function getCachedBoardPayload(root:string,opts?:{includeArchived?:boolean}, payloadFactory?: (root:string, opts:{includeArchived:boolean}) => any) {
  const key=resolve(root), archived=opts?.includeArchived??false, cacheKey=key+"::"+(archived?"1":"0");
  const safe=watcherSafe(key), old=boardCache.get(cacheKey), epoch=watcherEpoch(key);
  const before=generation(key); const stableRevision=computeGraphRevision(key,archived);
  const rescan=old ? old.watcherEpoch!==epoch : false;
  if (safe && !rescan && old?.revision===stableRevision) return {...old,fromCache:true};
  if (!payloadFactory) throw new Error("board payload factory required");
  const payload=payloadFactory(key,{includeArchived:archived}); const after=generation(key);
  if (before!==after) { invalidate(key); return getCachedBoardPayload(key,opts,payloadFactory); }
  const currentFingerprint=payloadFingerprint(payload);
  // A close/eviction can happen without a content change. Retain the old
  // payload (including generated_at) so the ETag still names that response.
  if (safe && rescan && old && old.revision===stableRevision && old.payloadFingerprint===currentFingerprint) {
    const retained={...old,watcherEpoch:epoch}; boardCache.set(cacheKey,retained); return {...retained,fromCache:true};
  }
  let revision=stableRevision;
  if (safe && rescan && old && old.revision===stableRevision) { invalidate(key); revision=computeGraphRevision(key,archived); }
  const payloadJson=JSON.stringify(payload)??"";
  const entry={payload,payloadJson,payloadFingerprint:currentFingerprint,watcherEpoch:epoch,revision,etag:formatETag(revision),cachedAt:Date.now()};
  if (safe) boardCache.set(cacheKey,entry); else boardCache.delete(cacheKey);
  return {...entry,fromCache:false};
}
export function _inspectBoardCache(){ return {boardCache,rootGenerations:inspectGenerations()}; }
