// dsh-graph-client — 浏览器半边：手写 classic script，零构建。
// 二维泳道看板：横轴生命周期阶段，纵轴版本 + 独立目标 + backlog。
// 已发布版本默认收起置底（点击展开）；目标卡显示上下文子卡片，点击展开详情。
window.__ModuleLoader__.load({
  id: "dsh-graph-client",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const STAGES = [
      { key: "describe", label: "描述", statuses: ["draft", "planning"] },
      { key: "collect", label: "收集", statuses: ["collecting", "ready"] },
      { key: "execute", label: "执行", statuses: ["in_progress"] },
      { key: "confirm", label: "确认", statuses: ["review"] },
      { key: "deliver", label: "交付", statuses: ["delivered"] },
      { key: "blocked", label: "阻塞", statuses: ["blocked"] },
    ];

    const S = {
      wrap: { padding: 12, fontFamily: "inherit", fontSize: 13, color: "inherit", overflowX: "auto" },
      head: { display: "flex", alignItems: "center", gap: 12, marginBottom: 8 },
      grid: { display: "grid", gridTemplateColumns: "130px repeat(6, minmax(150px, 1fr))", gap: 4 },
      laneLabel: { fontWeight: 600, padding: "8px 6px", borderTop: "1px solid rgba(128,128,128,.35)" },
      stageHead: { fontWeight: 600, textAlign: "center", padding: 4, opacity: 0.75 },
      cell: { borderTop: "1px solid rgba(128,128,128,.35)", padding: 4, minHeight: 40, verticalAlign: "top" },
      card: {
        border: "1px solid rgba(128,128,128,.45)",
        borderRadius: 6,
        padding: "6px 8px",
        marginBottom: 6,
        background: "rgba(128,128,128,.08)",
        cursor: "pointer",
      },
      cardBlocked: { border: "1px solid #d66" },
      title: { fontWeight: 600, marginBottom: 2 },
      meta: { opacity: 0.65, fontSize: 12 },
      statusLine: { fontStyle: "italic", opacity: 0.85, marginTop: 3 },
      chip: {
        display: "inline-block",
        fontSize: 11,
        padding: "1px 6px",
        margin: "3px 4px 0 0",
        borderRadius: 8,
        border: "1px solid rgba(128,128,128,.4)",
        opacity: 0.85,
      },
      collapsed: {
        padding: "6px",
        opacity: 0.75,
        borderTop: "1px dashed rgba(128,128,128,.35)",
        cursor: "pointer",
        userSelect: "none",
      },
      detail: {
        border: "1px solid rgba(128,128,128,.5)",
        borderRadius: 6,
        padding: 10,
        margin: "4px 0 8px",
        background: "rgba(128,128,128,.12)",
        whiteSpace: "pre-wrap",
        fontSize: 12,
      },
      btn: { fontSize: 12, padding: "2px 10px", cursor: "pointer" },
    };

    function stageOf(status) {
      for (const s of STAGES) if (s.statuses.includes(status)) return s.key;
      return "describe";
    }

    const CARD_STATUS_ICON = { empty: "○", collecting: "◌", filled: "●", reviewed: "✔" };

    function Card(g, expanded, onToggle) {
      const badges = [];
      if (g.reviewer === "human") badges.push("👤人审");
      if (g.reviewer === "ai") badges.push("🤖AI审");
      if (g.pk_lanes > 1) badges.push("PK×" + g.pk_lanes);
      if (g.depends_on?.length) badges.push("⛓" + g.depends_on.join(","));
      return h(
        "div",
        {
          key: g.id,
          style: { ...S.card, ...(g.status === "blocked" ? S.cardBlocked : {}) },
          title: "点击查看详情",
          onClick: (e) => {
            e.stopPropagation();
            onToggle(g.id);
          },
        },
        h("div", { style: S.title }, (expanded ? "▾ " : "▸ ") + g.title),
        h("div", { style: S.meta }, g.id + (badges.length ? " ｜ " + badges.join(" ") : "")),
        g.status_line ? h("div", { style: S.statusLine }, "⏳ " + g.status_line) : null,
        g.status === "blocked" && g.blocked_reason
          ? h("div", { style: { ...S.statusLine, color: "#d66" } }, "⛔ " + g.blocked_reason)
          : null,
        g.cards?.length
          ? h(
              "div",
              null,
              g.cards.map((c) =>
                h("span", { key: c.id, style: S.chip, title: c.id + " / " + c.status },
                  (CARD_STATUS_ICON[c.status] ?? "?") + " " + c.title),
              ),
            )
          : null,
      );
    }

    function GoalDetail(props) {
      const [state, setState] = React.useState({ loading: true });
      React.useEffect(() => {
        let alive = true;
        fetch("/api/dsh-graph/goal?id=" + encodeURIComponent(props.id))
          .then((r) => r.json())
          .then((data) => alive && setState({ loading: false, data }))
          .catch((e) => alive && setState({ loading: false, error: String(e) }));
        return () => { alive = false; };
      }, [props.id]);
      if (state.loading) return h("div", { style: S.detail }, "加载详情…");
      if (state.error) return h("div", { style: S.detail }, "详情获取失败：" + state.error);
      const d = state.data;
      if (d.error) return h("div", { style: S.detail }, "详情错误：" + d.error);
      return h(
        "div",
        { style: S.detail },
        h("div", { style: { fontWeight: 600, marginBottom: 6 } },
          `${d.meta.id} · ${d.meta.title} · ${d.meta.status}`),
        h("div", null, (d.body ?? "").trim() || "（无正文）"),
        d.events?.length
          ? h(
              "div",
              { style: { marginTop: 8, opacity: 0.75 } },
              h("div", { style: { fontWeight: 600 } }, "近期事件："),
              d.events.slice(-12).map((e, i) =>
                h("div", { key: i, style: S.meta },
                  `${(e.ts ?? "").replace("T", " ").slice(0, 19)}  ${e.event}  by ${e.actor}`),
              ),
            )
          : null,
      );
    }

    function KanbanView() {
      const [state, setState] = React.useState({ loading: true });
      const [expandedGoal, setExpandedGoal] = React.useState(null);
      const [openReleased, setOpenReleased] = React.useState({});
      const load = () => {
        fetch("/api/dsh-graph")
          .then((r) => r.json())
          .then((data) => setState({ loading: false, data }))
          .catch((e) => setState({ loading: false, error: String(e) }));
      };
      React.useEffect(() => {
        load();
        const t = setInterval(load, 15000);
        return () => clearInterval(t);
      }, []);

      if (state.loading) return h("div", { style: S.wrap }, "dsh-graph 看板加载中…");
      if (state.error) return h("div", { style: S.wrap }, "看板数据获取失败：" + state.error);
      const b = state.data;
      if (b.error) return h("div", { style: S.wrap }, "看板数据错误：" + b.error);

      const active = b.versions.filter((v) => v.status !== "released");
      const released = b.versions.filter((v) => v.status === "released");

      const toggleGoal = (id) => setExpandedGoal(expandedGoal === id ? null : id);

      const lane = (label, goals, key) => {
        const cells = STAGES.map((s) => {
          const cellGoals = goals.filter((g) => stageOf(g.status) === s.key);
          return h(
            "div",
            { key: s.key, style: S.cell },
            cellGoals.map((g) => Card(g, expandedGoal === g.id, toggleGoal)),
            cellGoals.some((g) => expandedGoal === g.id)
              ? h(GoalDetail, { id: expandedGoal })
              : null,
          );
        });
        return [h("div", { key: key + "-label", style: S.laneLabel }, label), ...cells];
      };

      const rows = [];
      for (const v of active) rows.push(...lane(`🏷 ${v.name}`, v.goals, "v-" + v.slug));
      rows.push(...lane("独立目标", b.standalone, "standalone"));
      rows.push(...lane("backlog", b.backlog, "backlog"));

      const releasedRows = released.map((v) => {
        const open = !!openReleased[v.slug];
        return [
          h(
            "div",
            {
              key: "rel-" + v.slug,
              style: S.collapsed,
              title: "点击展开/收起",
              onClick: () => setOpenReleased({ ...openReleased, [v.slug]: !open }),
            },
            `${open ? "▾" : "▸"} ${v.name} ✅ ${v.goals.length} 目标全部交付 · released · ${v.slug}`,
          ),
          open
            ? h("div", { key: "relx-" + v.slug, style: S.grid },
                ...lane(v.name, v.goals, "rellane-" + v.slug))
            : null,
        ];
      });

      return h(
        "div",
        { style: S.wrap },
        h(
          "div",
          { style: S.head },
          h("strong", null, "dsh-graph 看板"),
          h("span", { style: S.meta }, "数据时间：" + (b.generated_at ?? "").replace("T", " ").slice(0, 19)),
          h("button", { style: S.btn, onClick: load }, "刷新"),
        ),
        h(
          "div",
          { style: S.grid },
          h("div", { style: S.stageHead }, "泳道＼阶段"),
          STAGES.map((s) => h("div", { key: s.key, style: S.stageHead }, s.label)),
          ...rows,
        ),
        ...releasedRows,
      );
    }

    return {
      name: "dsh-graph-client",
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("conversation.view", () =>
          ctx.slots.register(
            { name: "conversation.view", id: "dsh-graph-kanban", order: 80, label: "看板" },
            (props) => h(KanbanView, props),
          ),
        );
        console.log("[dsh-graph-client] client apply: kanban view registered");
      },
    };
  },
});
