// dsh-graph-client — 浏览器半边：手写 classic script，零构建。
// 二维泳道看板。视觉约定：卡片类型用「粗左边框 + 颜色 + 图标」区分；
// 依赖关系用琥珀色左边框 + 「⛓ 等待」标识；详情走 modal 弹窗；事件话术人类化。
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

    const STATUS_LABEL = {
      draft: "草稿", planning: "规划中", collecting: "收集中", ready: "就绪",
      in_progress: "执行中", review: "评审中", delivered: "已交付", blocked: "阻塞",
    };

    const EVENT_LABEL = {
      "goal.created": "创建目标", "goal.planned": "完成规划", "criteria.confirmed": "确认判据",
      "goal.transition": null, "attempt.started": "派发执行", "attempt.status_reported": null,
      "completion.claimed": "声明完成", "review.passed": "评审通过", "review.failed": "评审未通过",
      "goal.moved": "排期移动", "card.created": "创建卡片", "card.filled": "填充卡片",
      "card.reviewed": "复核卡片", "evidence.added": "登记证据", "memory.promoted": "沉淀记忆",
      "version.created": "创建版本", "version.released": "发布版本",
      "version.scope_changed": "调整版本范围", "version.integration_decided": "集成测试决策",
      "goal.deleted": "删除目标", "card.deleted": "删除卡片", "attempt.bound": "绑定子代理",
    };

    // 近期动态只保留对人有用的事件：泳道切换、修订与人工补充、判据/评审/交付关键节点
    const MEANINGFUL = new Set([
      "goal.transition", "goal.amended", "scope.note", "criteria.confirmed",
      "completion.claimed", "review.passed", "review.failed", "attempt.started",
      "goal.moved", "goal.created",
    ]);

    function humanEvent(e) {
      const d = e.details ?? {};
      let what = EVENT_LABEL[e.event];
      if (what === null || what === undefined) {
        if (e.event === "goal.transition") what = `状态流转：${STATUS_LABEL[d.from] ?? d.from} → ${STATUS_LABEL[d.to] ?? d.to}`;
        else if (e.event === "attempt.status_reported") what = `汇报：${d.status ?? ""}`;
        else if (e.event === "goal.amended") what = `修订：${d.note ?? ""}`;
        else if (e.event === "scope.note") what = `补充：${d.note ?? ""}`;
        else what = e.event;
      }
      const who = String(e.actor ?? "")
        .replace(/^human:/, "").replace(/^supervisor:.*/, "主管 Agent")
        .replace(/^agent:session-.*/, "Agent（另一会话）").replace(/^agent:/, "Agent:");
      let when = "";
      try {
        const dt = new Date(e.ts);
        when = `${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
      } catch { when = String(e.ts ?? "").slice(5, 16); }
      return `${when}  ${what}（${who}）`;
    }

    const HOVER_CSS = `
      .dg-card { transition: box-shadow .12s ease, transform .12s ease, border-color .12s ease; }
      .dg-card:hover { box-shadow: 0 0 0 2px rgba(76,141,255,.55); transform: translateY(-1px); }
      .dg-card:active { transform: translateY(0); box-shadow: 0 0 0 2px rgba(76,141,255,.8); }
      .dg-sub { transition: background .12s ease; }
      .dg-sub:hover { background: rgba(58,166,117,.22); }
      .dg-collapsed:hover { background: rgba(128,128,128,.14); }
      .dg-btn { transition: filter .12s ease; }
      .dg-btn:hover { filter: brightness(1.25); }
      .dg-card-active { box-shadow: 0 0 0 2px rgba(76,141,255,.85) !important; background: rgba(76,141,255,.12) !important; }
      .dg-sub-active { background: rgba(58,166,117,.30) !important; box-shadow: 0 0 0 1px #3aa675 !important; }
    `;

    const S = {
      wrap: { padding: 12, fontSize: 13, color: "inherit", overflowX: "auto" },
      head: { display: "flex", alignItems: "center", gap: 12, marginBottom: 8 },
      grid: { display: "grid", gridTemplateColumns: "130px repeat(6, minmax(150px, 1fr))", gap: 4 },
      laneLabel: { fontWeight: 600, padding: "8px 6px", borderTop: "1px solid rgba(128,128,128,.35)" },
      stageHead: { fontWeight: 600, textAlign: "center", padding: 4, opacity: 0.75 },
      cell: { borderTop: "1px solid rgba(128,128,128,.35)", padding: 4, minHeight: 40, verticalAlign: "top" },
      goalCard: {
        border: "1px solid rgba(128,128,128,.45)",
        borderLeft: "5px solid #4c8dff",
        borderRadius: 6, padding: "6px 8px", marginBottom: 6,
        background: "rgba(128,128,128,.08)", cursor: "pointer",
      },
      depCard: { borderLeft: "5px solid #e0a53a" },
      blockedCard: { borderLeft: "5px solid #d66" },
      subCard: {
        border: "1px solid rgba(128,128,128,.35)",
        borderLeft: "4px solid #3aa675",
        borderRadius: 5, padding: "2px 6px", margin: "4px 0 0 10px",
        fontSize: 11, opacity: 0.9,
      },
      title: { fontWeight: 600, marginBottom: 2 },
      meta: { opacity: 0.65, fontSize: 12 },
      statusLine: { fontStyle: "italic", opacity: 0.85, marginTop: 3 },
      collapsed: {
        padding: "6px", opacity: 0.75, cursor: "pointer", userSelect: "none",
        borderTop: "1px dashed rgba(128,128,128,.35)",
      },
      overlay: {
        position: "fixed", inset: 0, background: "rgba(0,0,0,.55)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
      },
      drawer: {
        position: "fixed", top: 0, right: 0, height: "100vh", width: 400,
        background: "#1e1f24", color: "#e6e6e6", zIndex: 10000,
        boxShadow: "-4px 0 16px rgba(0,0,0,.45)",
        padding: "20px 22px", overflowY: "auto", fontSize: 13, lineHeight: 1.7,
        fontFamily: "inherit",
      },
      drawerSection: { marginTop: 14 },
      drawerH: { fontWeight: 700, fontSize: 13, marginBottom: 6, opacity: 0.9 },
      modal: {
        background: "#1e1f24", color: "#e6e6e6", borderRadius: 10,
        maxWidth: 720, width: "90%", maxHeight: "80vh", overflowY: "auto",
        padding: "16px 20px", fontSize: 13, lineHeight: 1.6,
      },
      modalSection: { marginTop: 10, whiteSpace: "pre-wrap" },
      modalH: { fontWeight: 700, marginBottom: 4 },
      btn: { fontSize: 12, padding: "2px 10px", cursor: "pointer" },
      close: { float: "right", cursor: "pointer", opacity: 0.7, fontSize: 16 },
    };

    function stageOf(status) {
      for (const s of STAGES) if (s.statuses.includes(status)) return s.key;
      return "describe";
    }

    const CARD_STATUS_ICON = { empty: "○ 待收集", collecting: "◌ 收集中", filled: "● 已填充", reviewed: "✔ 已复核" };

    // 目标卡：只保留关键信息（标题/状态/状态行/徽标/依赖），子卡片扼要列出、点击开抽屉
    function Card(g, onOpen, onOpenCard, activeGoal, activeCard) {
      const blocked = g.status === "blocked";
      const hasDep = (g.depends_on ?? []).length > 0;
      const style = {
        ...S.goalCard,
        ...(hasDep ? S.depCard : {}),
        ...(blocked ? S.blockedCard : {}),
      };
      const badges = [];
      if (g.reviewer === "human") badges.push("👤人审");
      if (g.reviewer === "ai") badges.push("🤖AI审");
      if (g.pk_lanes > 1) badges.push("PK×" + g.pk_lanes);
      return h(
        "div",
        { key: g.id, style, className: "dg-card" + (activeGoal ? " dg-card-active" : ""),
          title: "点击打开详情", onClick: () => onOpen(g.id) },
        h("div", { style: S.title }, `🎯 ${g.title}`),
        h("div", { style: S.meta },
          `${g.id} ｜ ${STATUS_LABEL[g.status] ?? g.status}${badges.length ? " ｜ " + badges.join(" ") : ""}`,
          sessionLinkBtn(g.attempt_parent_session_id, g.attempt_child_id, "↗ 执行会话")),
        hasDep
          ? h("div", { style: { ...S.meta, color: "#e0a53a" } }, `⛓ 等待 ${g.depends_on.join("、")} 交付`)
          : null,
        g.status_line ? h("div", { style: S.statusLine }, "⏳ " + g.status_line) : null,
        blocked && g.blocked_reason
          ? h("div", { style: { ...S.statusLine, color: "#d66" } }, "⛔ " + g.blocked_reason)
          : null,
        (g.cards ?? []).map((c) =>
          h("div", {
            key: c.id,
            style: { ...S.subCard, cursor: "pointer" },
            className: "dg-sub" + (activeCard === c.id ? " dg-sub-active" : ""),
            title: "点击打开上下文抽屉",
            onClick: (e) => { e.stopPropagation(); onOpenCard(g.id, c.id); },
          },
            h("div", { style: { display: "flex", alignItems: "center", gap: 4 } },
              h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                `📇 ${CARD_STATUS_ICON[c.status] ?? c.status} ｜ ${c.title}`),
              sessionLinkBtn(c.parent_session_id, c.child_id, "↗")),
            c.summary ? h("div", { style: { opacity: 0.75, marginTop: 1 } }, c.summary) : null)),
      );
    }

    // 上下文抽屉：摘要 + 全文 + 子代理 id/链接
    function CardDrawer(props) {
      const [state, setState] = React.useState({ loading: true });
      React.useEffect(() => {
        let alive = true;
        fetch("/api/dsh-graph/goal?id=" + encodeURIComponent(props.goalId))
          .then((r) => r.json())
          .then((data) => alive && setState({ loading: false, data }))
          .catch((e) => alive && setState({ loading: false, error: String(e) }));
        return () => { alive = false; };
      }, [props.goalId]);

      let inner;
      if (state.loading) inner = "加载中…";
      else if (state.error) inner = "获取失败：" + state.error;
      else {
        const card = (state.data.cards ?? []).find((c) => c.id === props.cardId);
        if (!card) inner = "卡片不存在：" + props.cardId;
        else {
          const childLink = card.child_id
            ? h("div", { style: S.drawerSection, key: "child" },
                h("div", { style: { ...S.drawerH, display: "flex", alignItems: "center", justifyContent: "space-between" } },
                  "🤖 收集子代理",
                  card.parent_session_id
                    ? h("button", {
                        style: S.btn,
                        className: "dg-btn",
                        onClick: () => { openChildSession(card.parent_session_id, card.child_id); },
                      }, "↗ 在会话中打开")
                    : null),
                h("div", { style: S.meta }, `id：${card.child_id}`))
            : null;
          inner = [
            h("div", { key: "t", style: { fontWeight: 700, fontSize: 14 } },
              `📇 ${card.title}`),
            h("div", { key: "m", style: S.meta },
              `${card.id} ｜ ${card.kind} ｜ ${CARD_STATUS_ICON[card.status] ?? card.status}${card.filled_by ? " ｜ 填充：" + card.filled_by : ""}`),
            childLink,
            card.summary ? h("div", { key: "s", style: S.drawerSection },
              h("div", { style: S.drawerH }, "摘要"), card.summary) : null,
            h("div", { key: "body", style: S.drawerSection },
              h("div", { style: S.drawerH }, "全文"),
              h("div", { style: { whiteSpace: "pre-wrap" } }, card.content?.trim() || "（尚未采集内容）")),
          ];
        }
      }
      return h(
        "div",
        null,
        h("div", { style: { ...S.overlay, background: "rgba(0,0,0,.35)" }, onClick: props.onClose }),
        h("div", { style: S.drawer, onClick: (e) => e.stopPropagation() },
          h("span", { style: S.close, onClick: props.onClose }, "✕"),
          inner),
      );
    }

    // 详情 modal：扼要分区 + 人类化事件
    function GoalModal(props) {
      const [state, setState] = React.useState({ loading: true });
      React.useEffect(() => {
        let alive = true;
        fetch("/api/dsh-graph/goal?id=" + encodeURIComponent(props.id))
          .then((r) => r.json())
          .then((data) => alive && setState({ loading: false, data }))
          .catch((e) => alive && setState({ loading: false, error: String(e) }));
        return () => { alive = false; };
      }, [props.id]);

      const section = (body, name) => {
        const m = new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(body ?? "");
        return m ? m[1].trim() : null;
      };

      let content;
      if (state.loading) content = "加载详情…";
      else if (state.error) content = "详情获取失败：" + state.error;
      else if (state.data.error) content = "详情错误：" + state.data.error;
      else {
        const d = state.data;
        const desc = section(d.body, "目标描述");
        const crit = section(d.body, "质量判据");
        content = [
          desc ? h("div", { key: "d", style: S.modalSection },
            h("div", { style: S.modalH }, "📋 目标描述"), desc) : null,
          crit ? h("div", { key: "c", style: S.modalSection },
            h("div", { style: S.modalH }, "✅ 质量判据"), crit) : null,
          (d.cards ?? []).length
            ? h("div", { key: "k", style: S.modalSection },
                h("div", { style: S.modalH }, "🗂 信息收集"),
                d.cards.map((c) => h("div", { key: c.id, style: S.subCard },
                  `${CARD_STATUS_ICON[c.status] ?? c.status} ｜ ${c.title}（${c.kind}）`)))
            : null,
          (() => {
            const meaningful = (d.events ?? []).filter((e) => MEANINGFUL.has(e.event));
            return meaningful.length
              ? h("div", { key: "e", style: S.modalSection },
                  h("div", { style: S.modalH }, "🕘 近期动态"),
                  meaningful.slice(-10).map((e, i) =>
                    h("div", { key: i, style: S.meta }, humanEvent(e))))
              : null;
          })(),
        ];
      }

      return h(
        "div",
        { style: S.overlay, onClick: props.onClose },
        h("div", { style: S.modal, onClick: (e) => e.stopPropagation() },
          h("span", { style: S.close, onClick: props.onClose }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 15 } }, `🎯 ${props.title ?? props.id}`),
          h("div", { style: S.meta }, props.id),
          content),
      );
    }

    function KanbanView() {
      const [state, setState] = React.useState({ loading: true });
      const [modalGoal, setModalGoal] = React.useState(null);
      const [drawerCard, setDrawerCard] = React.useState(null); // {goalId, cardId}
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
      const lane = (label, goals, key) => {
        const cells = STAGES.map((s) =>
          h("div", { key: s.key, style: S.cell },
            goals.filter((g) => stageOf(g.status) === s.key).map((g) =>
              Card(g, setModalGoal, (goalId, cardId) => setDrawerCard({ goalId, cardId }),
                modalGoal === g.id, drawerCard?.cardId))),
        );
        return [h("div", { key: key + "-label", style: S.laneLabel }, label), ...cells];
      };

      const rows = [];
      for (const v of active) rows.push(...lane(`🏷 ${v.name}`, v.goals, "v-" + v.slug));
      rows.push(...lane("独立目标", b.standalone, "standalone"));
      rows.push(...lane("backlog", b.backlog, "backlog"));

      const releasedRows = released.map((v) => {
        const open = !!openReleased[v.slug];
        return [
          h("div", {
            key: "rel-" + v.slug, style: S.collapsed, className: "dg-collapsed", title: "点击展开/收起",
            onClick: () => setOpenReleased({ ...openReleased, [v.slug]: !open }),
          }, `${open ? "▾" : "▸"} ${v.name} ✅ ${v.goals.length} 目标全部交付 · released · ${v.slug}`),
          open ? h("div", { key: "relx-" + v.slug, style: S.grid },
            ...lane(v.name, v.goals, "rellane-" + v.slug)) : null,
        ];
      });

      const modalGoalData = modalGoal
        ? [...active.flatMap((v) => v.goals), ...released.flatMap((v) => v.goals),
           ...b.standalone, ...b.backlog].find((g) => g.id === modalGoal)
        : null;

      return h(
        "div",
        { style: S.wrap },
        h("style", null, HOVER_CSS),
        h("div", { style: S.head },
          h("strong", null, "dsh-graph 看板"),
          h("span", { style: S.meta }, "数据时间：" + (b.generated_at ?? "").replace("T", " ").slice(0, 19)),
          h("button", { style: S.btn, className: "dg-btn", onClick: load }, "刷新")),
        h("div", { style: S.grid },
          h("div", { style: S.stageHead }, "泳道＼阶段"),
          STAGES.map((s) => h("div", { key: s.key, style: S.stageHead }, s.label)),
          ...rows),
        ...releasedRows,
        modalGoal
          ? h(GoalModal, { id: modalGoal, title: modalGoalData?.title, onClose: () => setModalGoal(null) })
          : null,
        drawerCard
          ? h(CardDrawer, { goalId: drawerCard.goalId, cardId: drawerCard.cardId,
                            onClose: () => setDrawerCard(null) })
          : null,
      );
    }

    let appCtx = null;
    let sessionsRt = null;
    async function openChildSession(parentSessionId, childId) {
      const rt = sessionsRt ?? appCtx?.get?.("sessions");
      try {
        if (!rt) return;
        // 目录必须先加载，否则 selectSubagent 抛 "not a healthy catalog child"（发现#21）
        rt.setSubagentCatalogOpen?.(parentSessionId, true);
        await rt.refreshSubagents?.(parentSessionId);
        const entries = rt.list?.getSnapshot?.().subagentsByParent?.[parentSessionId]?.entries ?? [];
        const entry = entries.find((e) => e.kind === "child" && e.id === childId);
        if (entry) {
          rt.openSubagent?.({ parentSessionId, childSessionId: childId, mode: entry.mode });
        } else {
          // 目录里没有（不健康/已清理）：退化为打开父会话
          console.warn("[dsh-graph-client] child not in catalog, opening parent:", childId);
          rt.open?.(parentSessionId);
        }
      } catch (e) {
        console.warn("[dsh-graph-client] openSubagent failed", e);
        try { rt?.open?.(parentSessionId); } catch { /* 静默 */ }
      }
    }
    function sessionLinkBtn(parentSessionId, childId, label) {
      if (!childId) return null;
      return h("button", {
        style: { ...S.btn, fontSize: 11, padding: "0 6px", marginLeft: 6, flexShrink: 0 },
        className: "dg-btn",
        title: parentSessionId ? "跳转到子代理会话" : "子代理 id（父会话未知，仅展示）",
        onClick: (e) => { e.stopPropagation(); if (parentSessionId) openChildSession(parentSessionId, childId); },
      }, label ?? "↗ 会话");
    }
    return {
      name: "dsh-graph-client",
      inject: ["slots", "sessions"],
      apply(ctx) {
        appCtx = ctx;
        sessionsRt = ctx.sessions ?? null;
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
