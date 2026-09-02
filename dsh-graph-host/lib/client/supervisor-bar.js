    function SupervisorBar(props) {
      const { model, modelErr } = useSessionModel(props.id, null);
      const jump = () => {
        try {
          sessionsRt?.open?.(props.id); // supervisor 是顶层会话，直接 open
          activateChatTab();            // 已在该会话看板 tab 时切回「对话」
        } catch (e) {
          console.warn("[dsh-graph-host] 跳转主管会话失败", e);
        }
      };
      return h(
        "div",
        { style: S.supervisorBar, className: "dg-supervisor" },
        h("span", { style: { fontWeight: 600, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }, role: "img", "aria-label": "主管", title: "主管会话" },
          h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, "aria-hidden": "true", focusable: "false" },
            h("path", { d: "M12 3l2.7 5.5L21 9.4l-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.4l6.3-.9L12 3z" })),
          "主管"),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h(LiveStrip, { parentId: null, childId: props.id, statusLine: props.statusLine ?? null, statusAt: props.statusAt ?? null })),
        model
          ? h("div", { style: { ...S.meta, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.2 } },
              h("span", null, model.provider),
              h("span", null, model.model))
          : h("span", { style: { ...S.meta, flexShrink: 0 } },
              modelErr ? "模型不可用" : "模型查询中…"),
        h("button", {
          style: { ...S.btn, flexShrink: 0 }, className: "dg-btn",
          title: "跳转到主管 Agent 对话窗", onClick: jump,
        }, "↗ 主管对话"),
      );
    }

    // g-a92e1406：被复用徽章——同一 child_id 跨目标绑定时旧绑定显示「被复用→新目标」
    function ReusedBadge(props) {
      const { childId, reusedBy } = props;
      if (!childId || !reusedBy) return null;
      return h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-warn-label, #e0a53a)", marginTop: 2 } },
        `♻️ 被复用→${reusedBy}`);
    }

    // g-125：上下文摘要默认折叠到 2 行（截断+省略号），点击展开全文；
    // 短摘要（≤40 字）不折叠，直接整行显示。状态提升自 Card（无 hooks 的纯函数）外。
    function CardSummary(props) {
