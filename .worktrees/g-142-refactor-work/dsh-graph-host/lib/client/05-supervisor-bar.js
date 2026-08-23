
    // g-108 看板顶部 supervisor 状态栏：复用 LiveStrip（运行/空闲、最新流式行、tok/ctx）
    // + 模型名（useSessionModel，顶层会话直接查）+ 一键跳转主管对话。
    // 会话 id 来自 board 端点下发的 supervisorSession（project.yaml），不硬编码。
    // g-a92e1406 判据 3① 扩展：statusLine 传 supervisor 自己的 status_line（事件流最新一条），
    // 运行中由 LiveStrip 走 StatusLine 带动画（流动背景 + 图标 pulse）。
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
        h("span", { style: { fontWeight: 600, flexShrink: 0 } }, "🧭 主管"),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h(LiveStrip, { parentId: null, childId: props.id, statusLine: props.statusLine ?? null, statusAt: props.statusAt ?? null })),
        h("span", { style: { ...S.meta, flexShrink: 0 } },
          model ? `${model.provider}/${model.model}` : modelErr ? "模型不可用" : "模型查询中…"),
        h("button", {
          style: { ...S.btn, flexShrink: 0 }, className: "dg-btn",
          title: "跳转到主管 Agent 对话窗", onClick: jump,
        }, "↗ 主管对话"),
      );
    }
