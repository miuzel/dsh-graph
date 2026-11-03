/**
 * g-612（返工）：真实宿主 HTTP 链路上的 goal 预算入口（唯一真源 meta.task_budget_seconds）：
 * owner 200 写入/清空、非法范围 400 零写零事件、匿名/伪造/跨站拒绝、方法 405。
 * 真实 0.2.1-rc.2 宿主 + 私有 workspace；不联网、不访问真实 provider/服务/用户会话。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { goalDetail, findGoalFile } from "../ops.ts";
import { readEvents } from "../events.ts";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";
import { readFileSync } from "node:fs";

const ROUTE = "/api/dsh-graph/set-goal-budget";

test("g-612 真实 HTTP：goal 预算 owner 写入/清空、非法 400 零写零事件、匿名/伪造/跨站拒绝", async () => {
  const h = await makeRealHost({ http: true, projectYaml: "supervisor:\n  session: sess-super\n  care: \"true\"\n" });
  try {
    const goal = await makeGoal(h, "review D budget http");
    const cookie = h.http.mintOwnerCookie();
    const callsBefore = h.fake.calls;
    const body = (extra: any = {}) => JSON.stringify({ workspace: h.ws, goal, ...extra });

    // 匿名与伪造 ⇒ 拒绝（不触达业务）
    const anon = await h.http.request("POST", ROUTE, { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body({ budget_seconds: 120 }));
    assert.ok([401, 403].includes(anon.status), `匿名必须拒绝（实得 ${anon.status}）`);
    const forged = await h.http.request("POST", ROUTE, { "content-type": "application/json", cookie: "dsh_auth=forged", "sec-fetch-site": "same-origin" }, body({ budget_seconds: 120 }));
    assert.ok([401, 403].includes(forged.status), `伪造 cookie 必须拒绝（实得 ${forged.status}）`);
    const cross = await h.http.request("POST", ROUTE, { "content-type": "application/json", cookie, "sec-fetch-site": "cross-site" }, body({ budget_seconds: 120 }));
    assert.equal(cross.status, 403, "跨站必须拒绝");
    assert.equal(goalDetail(h.root, goal).meta.task_budget_seconds, undefined, "拒绝路径不得写入");
    assert.equal(readEvents(h.root).filter((e: any) => e.event === "goal.budget_set").length, 0, "拒绝路径零事件");

    // owner 正向 120
    const ok = await h.http.request("POST", ROUTE, { "content-type": "application/json", cookie, "sec-fetch-site": "same-origin" }, body({ budget_seconds: 120 }));
    assert.equal(ok.status, 200, `owner 写入应 200（实得 ${ok.status}: ${JSON.stringify(ok.body)}）`);
    assert.equal(ok.body?.new_seconds, 120);
    assert.equal(goalDetail(h.root, goal).meta.task_budget_seconds, 120);
    assert.equal(readEvents(h.root).filter((e: any) => e.event === "goal.budget_set").length, 1);
    assert.equal(h.fake.calls, callsBefore, "HTTP 预算入口不得调用模型");

    // 非法值 29 ⇒ 400 且文件逐字节不变、零新事件
    const file = findGoalFile(h.root, goal);
    const bytes = readFileSync(file);
    const beforeBad = readEvents(h.root).length;
    const bad = await h.http.request("POST", ROUTE, { "content-type": "application/json", cookie, "sec-fetch-site": "same-origin" }, body({ budget_seconds: 29 }));
    assert.equal(bad.status, 400, "非法范围必须 400");
    assert.deepEqual(readFileSync(file), bytes, "非法值不得改文件");
    assert.equal(readEvents(h.root).length, beforeBad, "非法值零事件");

    // 缺字段 / 缺 goal ⇒ 400
    const missing = await h.http.request("POST", ROUTE, { "content-type": "application/json", cookie, "sec-fetch-site": "same-origin" }, JSON.stringify({ workspace: h.ws, goal }));
    assert.equal(missing.status, 400, "缺 budget_seconds 必须 400");
    const noGoal = await h.http.request("POST", ROUTE, { "content-type": "application/json", cookie, "sec-fetch-site": "same-origin" }, JSON.stringify({ workspace: h.ws, budget_seconds: 120 }));
    assert.equal(noGoal.status, 400, "缺 goal 必须 400");

    // 清空 null ⇒ 继承；再读 meta 无值
    const cleared = await h.http.request("POST", ROUTE, { "content-type": "application/json", cookie, "sec-fetch-site": "same-origin" }, body({ budget_seconds: null }));
    assert.equal(cleared.status, 200);
    assert.equal(goalDetail(h.root, goal).meta.task_budget_seconds, undefined, "null 清空继承");
    assert.equal(readEvents(h.root).filter((e: any) => e.event === "goal.budget_set").length, 2);

    // 方法不匹配 ⇒ 405（在鉴权通过之后）
    const get = await h.http.request("GET", ROUTE, { cookie, "sec-fetch-site": "same-origin" });
    assert.equal(get.status, 405, `GET 应 405（实得 ${get.status}）`);
  } finally {
    h.fake.releaseAll();
    await h.shutdown();
  }
});
