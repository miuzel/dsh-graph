// dsh-graph-client — host 半边（Node）：具名导出，禁止 export default。
// 职责：注册 GET /api/dsh-graph（看板投影 + supervisorSession，g-108）与 /api/dsh-graph/goal?id=（目标详情）。
import { resolve } from "node:path";
import { goalDetail } from "../core/ops.ts";
import { boardPayload } from "../dsh-graph-host/index.js";

export const name = "dsh-graph-client";
export const inject = ["webServer"];

export function apply(ctx, config) {
  const root = config?.root
    ? resolve(config.root)
    : resolve(process.cwd(), ".dsh-graph");
  const json = (res, code, data) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  };
  ctx.effect(() => {
    const d1 = ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-graph",
      handler: (_req, res) => {
        try {
          json(res, 200, boardPayload(root));
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    });
    const d2 = ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-graph/goal",
      handler: (req, res) => {
        try {
          const id = new URL(req.url ?? "", "http://x").searchParams.get("id");
          if (!id) return json(res, 400, { error: "missing id" });
          json(res, 200, goalDetail(root, id));
        } catch (e) {
          json(res, 404, { error: String(e?.message ?? e) });
        }
      },
    });
    return () => {
      d1();
      d2();
    };
  });
  process.stderr.write(`[dsh-graph-client] host apply: /api/dsh-graph(+goal) registered (root=${root})\n`);
}
