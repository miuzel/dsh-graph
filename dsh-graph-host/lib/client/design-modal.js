    // ===== g-462：Graph 设计哲学弹窗（负责人规格：入口在看板标题栏与刷新/记忆并列） =====
    // 弹窗内嵌 lifecycle（状态机）+ workflow（主链流程）两张 **随包发布**的 archify 交互图，
    // 由宿主只读路由 `/api/dsh-graph/diagram/<name>` 以 `text/html; charset=utf-8` 提供
    // （白名单仅这两张；见 dsh-graph-host/index.js 的 DESIGN_DIAGRAM_FILES）。
    // 弹窗**只读展示**：不写任何数据、不向图注入任何配置 —— 这正是「暂不支持自定义」的如实体现。
    // 图名是**构建期写死**的字面量（与白名单同源），不做任何字符串拼接或用户输入派生。
    const DESIGN_DIAGRAM_TABS = [
      { key: "lifecycle", file: "design-philosophy.lifecycle.html", labelKey: "design.tab.lifecycle" },
      { key: "workflow", file: "design-philosophy.workflow.html", labelKey: "design.tab.workflow" },
    ];

    function DesignPhilosophyModal(props) {
      useLocaleRevision();
      const { onClose } = props;
      // g-181：backdrop 误关保护（与其它弹窗同一 guard）
      const backdropGuard = useBackdropClose(onClose);
      const [tab, setTab] = React.useState("lifecycle");
      const active = DESIGN_DIAGRAM_TABS.find((t) => t.key === tab) ?? DESIGN_DIAGRAM_TABS[0];
      const src = "/api/dsh-graph/diagram/" + active.file;
      return dgOverlay({ style: S.overlay, ...backdropGuard },
        h("div", {
          className: "dg-design-modal",
          style: {
            ...S.modal, width: "min(1180px, 94vw)", maxWidth: "94vw",
            height: "min(780px, 90vh)", maxHeight: "90vh",
            display: "flex", flexDirection: "column", overflow: "hidden", padding: "14px 16px",
          },
          onClick: (e) => e.stopPropagation(),
        },
          h("span", { className: "dg-close", style: S.close, onClick: onClose }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 15, flexShrink: 0 } }, dgT("design.title")),
          // 如实声明（醒目）：暂不支持自定义；后续将开放 graph 语义调整与可视化自定义。
          h("div", {
            className: "dg-design-notice",
            style: {
              marginTop: 8, padding: "6px 8px", borderRadius: 4, fontSize: 12, flexShrink: 0,
              background: "rgba(224,165,58,.14)", border: "1px solid rgba(224,165,58,.4)",
            },
          }, dgT("design.notice")),
          h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 10, flexShrink: 0 } },
            ...DESIGN_DIAGRAM_TABS.map((t) => h("button", {
              key: "design-tab-" + t.key,
              className: "dg-btn" + (t.key === active.key ? " dg-btn-active" : ""),
              style: { ...(t.key === active.key ? S.btnPrimary : S.btn), padding: "4px 12px", fontSize: 12 },
              onClick: () => setTab(t.key),
            }, dgT(t.labelKey))),
            h("a", {
              className: "dg-design-open",
              href: src,
              target: "_blank",
              rel: "noreferrer",
              style: { ...S.meta, marginLeft: "auto", whiteSpace: "nowrap" },
            }, dgT("design.openNewTab"))),
          h("div", {
            style: {
              flex: "1 1 auto", minHeight: 0, marginTop: 8, borderRadius: 6, overflow: "hidden",
              border: "1px solid rgba(128,128,128,.35)", background: "#fff",
            },
          },
            h("iframe", {
              key: "design-frame-" + active.key,
              className: "dg-design-frame",
              title: dgT("design.title") + " · " + dgT(active.labelKey),
              src,
              style: { display: "block", width: "100%", height: "100%", border: "none" },
            }))));
    }
