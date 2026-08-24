      const [open, setOpen] = React.useState(false);
      const { summary } = props;
      if (!summary) return null;
      if (summary.length <= 40) {
        return h("div", { style: { opacity: 0.75, marginTop: 1 } }, summary);
      }
      return h("div", {
        style: { opacity: 0.75, marginTop: 1, cursor: "pointer" },
        className: open ? "dg-summary-open" : "dg-summary-clamp",
        title: open ? "点击收起摘要" : "点击展开摘要全文",
        onClick: (e) => { e.stopPropagation(); setOpen(!open); },
      }, summary);
    }

    // 目标卡：只保留关键信息（标题/状态/状态行/徽标/依赖），子卡片扼要列出、点击开抽屉
    // 依赖徽章状态化（发现#23）：已交付依赖显示「依赖满足」，仅未交付依赖显示「等待」并触发琥珀边框
    // 被复用徽章（g-a92e1406）：reused_by 由 boardProjection 派生（attempt.reused 事件 + 绑定记录双源），
    // 客户端直接消费 g.reused_by，不再用数组顺序猜测旧/新绑定。
    // g-125：所有卡片统一用标题左侧小三角展开/收起；delivered/blocked 默认折叠精简
    //（折叠态只留标题+状态行，隐藏依赖/livestrip/执行按钮/上下文卡片），可展开查看完整。
    // expanded 默认值由 KanbanView 决定（delivered/blocked 默认 false，其余默认 true），
    // 用户手动切换后记录到 expandedGoals；Card 保持纯函数（无 hooks）。
    // g-77647351：drag 参数——可选拖放对象 {active, marker, start, hover, drop, end}
    function Card(g, onOpen, onOpenCard, activeGoal, activeCard, goalStatus, expanded, onToggleExpand, drag) {
      const blocked = g.status === "blocked";
      const collapsed = !expanded;
      const deps = g.depends_on ?? [];
      const pendingDeps = deps.filter((d) => goalStatus?.[d] !== "delivered");
      const metDeps = deps.filter((d) => goalStatus?.[d] === "delivered");
      const hasDep = pendingDeps.length > 0;
      // g-158：类型色覆盖默认左侧色条（blocked/dep 语义用状态文本/标记表达，左栏始终类型色）
      const tColor = goalTypeColor(g.type);
      const borderColor = tColor;
      const style = {
        ...S.goalCard,
        ...(hasDep ? S.depCard : {}),
        ...(blocked ? S.blockedCard : {}),
        borderLeft: `5px solid ${borderColor}`,
      };
      const badges = [];
      // g-158：类型标记 badge（F/B/T/I + tooltip）——标题左侧，颜色与左栏/弹窗同源
      const aType = normalizeGoalType(g.type);
      const tBadge = h("span", {
        key: "type-badge",
        style: {
          display: "inline-block", width: 16, height: 16, lineHeight: "16px",
          textAlign: "center", borderRadius: 3, fontSize: 10, fontWeight: 700,
          background: goalTypeColor(aType), color: "#fff",
          verticalAlign: "middle", marginRight: 2,
        },
        title: GOAL_TYPE_LABELS[aType] ?? aType,
      }, GOAL_TYPE_ABBREV[aType] ?? aType[0]?.toUpperCase());
      if (g.reviewer === "human") badges.push("👤人审");
      if (g.reviewer === "ai") badges.push("🤖AI审");
      if (g.pk_lanes > 1) badges.push("PK×" + g.pk_lanes);
      if (g.archived) badges.push("📦已归档");
      const reusedBy = g.reused_by ?? null;
      // g-125：标题左侧小三角（▸ 折叠 / ▾ 展开），所有卡片统一；点击卡片其余区域打开详情
      // fb3：独立 .dg-chevron 样式——暗底纹、窄宽度（不用 S.btn/dg-btn，避免播放按钮观感）
      // fb4：按钮与标题 inline 同行（非 flex 列）——标题换行时第二行从行首开始，不被按钮占去宽度
      const chevron = h("button", {
        style: { marginRight: 4, verticalAlign: "middle", display: "inline-block" },
        className: "dg-chevron",
        title: collapsed ? "展开查看依赖/实时会话/上下文卡片等完整信息" : "收起为精简视图",
        onClick: (e) => { e.stopPropagation(); onToggleExpand(g.id); },
      }, collapsed ? "▸" : "▾");
      const titleRow = h("div", { style: { lineHeight: 1.5 } },
        chevron,
        tBadge,
        h("span", { style: { ...S.title, display: "inline", verticalAlign: "middle" } }, `🎯 ${g.title}`));
      // g-77647351：拖放 class 合并
      const dragClass = [
        "dg-card",
        activeGoal ? " dg-card-active" : "",
        drag?.active ? " dg-dragging" : "",
        drag?.marker === "before" ? " dg-drop-before" : "",
        drag?.marker === "after" ? " dg-drop-after" : "",
      ].filter(Boolean).join(" ");
      // g-77647351：拖放事件 props
      const dragProps = drag ? {
        draggable: true,
        onDragStart: (e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", g.id);
          drag.start();
        },
        onDragEnd: () => {
          if (drag?.over) drag.drop(drag.over);
          else drag.end();
        },
      } : {};
      const dropProps = drag ? {
        onDragOver: (e) => {
          // 修复（负责人 2026-08-22）：拖过任意卡片（非源）都应响应并显示 marker 占位——
          // 原守卫 !drag.active 只对源卡片 true，导致目标位置不为空时无 drop 指示。
          if (drag.goalId === g.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          drag.hover(rowHalf(e));
        },
        onDrop: (e) => {
          if (drag.goalId === g.id) return;
          e.preventDefault();
          drag.drop(rowHalf(e));
        },
      } : {};
      if (collapsed) {
        // g-125 折叠态：仅核心——标题（≤2 行）+ 状态一行；不显示状态摘要、依赖、livestrip、执行按钮、上下文卡片
        return h(
          "div",
          { key: g.id, style, className: dragClass,
            title: "点击打开详情", onClick: () => onOpen(g.id), ...dragProps, ...dropProps },
          titleRow,
          h("div", { style: S.meta },
            `${g.id} ｜ ${STATUS_LABEL[g.status] ?? g.status}${badges.length ? " ｜ " + badges.join(" ") : ""}`),
        );
      }
      return h(
        "div",
        { key: g.id, style, className: dragClass,
          title: "点击打开详情", onClick: () => onOpen(g.id), ...dragProps, ...dropProps },
        titleRow,
        h("div", { style: S.meta },
          `${g.id} ｜ ${STATUS_LABEL[g.status] ?? g.status}${badges.length ? " ｜ " + badges.join(" ") : ""}`,
          sessionLinkBtn(g.attempt_parent_session_id, g.attempt_child_id, "↗ 转到对话")),
        hasDep
          ? h("div", { style: { ...S.meta, color: "#e0a53a" } }, `⛓ 等待 ${pendingDeps.join("、")} 交付`)
          : null,
        metDeps.length
          ? h("div", { style: { ...S.meta, color: "#3aa675" } }, `✅ 依赖满足：${metDeps.join("、")} 已交付`)
          : null,
        blocked && g.blocked_reason
          ? h("div", { style: { ...S.statusLine, color: "#d66" } }, "⛔ " + g.blocked_reason)
          : null,
        // g-a92e1406：执行会话内嵌实时条——status_line 摘要并入状态小窗
        //（运行中 ⏳ / 空闲刚执行完 ✅）；无执行会话时退化为独立状态行（带动画）
        g.attempt_child_id
          ? h("div", { key: "live" },
              h(LiveStrip, { parentId: g.attempt_parent_session_id, childId: g.attempt_child_id,
                             statusLine: g.status_line }))
          : g.status_line
            ? h(StatusLine, { text: g.status_line, blocked: g.status === "blocked", running: g.status === "in_progress" })
            : null,
        reusedBy ? h(ReusedBadge, { childId: g.attempt_child_id, reusedBy }) : null,
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
            h(CardSummary, { summary: c.summary }),
            c.child_id && c.status !== "filled" && c.status !== "reviewed"
              ? h("div", { onClick: (e) => e.stopPropagation() },
                  h(LiveStrip, { parentId: c.parent_session_id, childId: c.child_id }))
              : null)),
      );
    }

    // g-a92e1406：状态摘要行——运行中带流动背景+图标动画，阻塞行静态
    function StatusLine(props) {
      const { text, blocked, running } = props;
      if (!text) return null;
