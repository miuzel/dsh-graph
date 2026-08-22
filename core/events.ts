/** 事件流：events.jsonl 是全部状态的唯一真相源（R-02）。 */

import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { STATUSES } from "./machine.ts";

export interface GraphEvent {
  ts: string;
  actor: string;
  event: string;
  goal?: string;
  details: Record<string, any>;
}

export function nowIso(): string {
  // 本地时区 ISO（含偏移），与历史手写事件（+08:00）保持一致
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`
  );
}

export function appendEvent(
  root: string,
  ev: Omit<GraphEvent, "ts"> & { ts?: string },
): GraphEvent {
  const rec: GraphEvent = { ts: ev.ts ?? nowIso(), ...ev } as GraphEvent;
  appendFileSync(
    join(root, "events.jsonl"),
    JSON.stringify(rec) + "\n",
    "utf8",
  );
  return rec;
}

export function readEvents(root: string): GraphEvent[] {
  const file = join(root, "events.jsonl");
  if (!existsSync(file)) return [];
  const out: GraphEvent[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec: GraphEvent;
    try {
      rec = JSON.parse(line);
    } catch {
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
 * 从事件流重建各目标状态：
 * goal.created → draft（无 version）或 planning（有 version）；
 * goal.planned 在 draft 时 → planning；goal.transition → details.to。
 * （goal.planned 视为 planning 阶段的隐式进入，覆盖规划期未显式迁移的补记场景。）
 */
export function replayStatuses(events: GraphEvent[]): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const ev of events) {
    if (!ev.goal) continue;
    if (ev.event === "goal.created") {
      // g-137：带 version → 初始状态 planning；不带 version → draft
      const hasVersion = ev.details?.version != null;
      statuses.set(ev.goal, hasVersion ? "planning" : "draft");
    }
    if (ev.event === "goal.planned" && statuses.get(ev.goal) === "draft") {
      statuses.set(ev.goal, "planning");
    }
    if (
      ev.event === "goal.transition" &&
      typeof ev.details?.to === "string" &&
      (STATUSES as readonly string[]).includes(ev.details.to)
    ) {
      statuses.set(ev.goal, ev.details.to);
    }
  }
  return statuses;
}
