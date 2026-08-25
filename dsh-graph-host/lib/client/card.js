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

    const CRITERIA_PLACEHOLDERS = new Set([
      "（待登记）",
      "（待登记；进入 in_progress 前必须非空且已确认）",
      "（待填写）",
    ]);

    // g-163：按当前判据有序 key 渲染方块，不用完成数量推断前缀。
    function CriteriaProgress(props) {
      // criteria_count 是零态的权威信号；即使旧 payload 误带一条占位项也不显示方块。
      const reportedCount = props.count ?? props.criteria_count ?? props.criteriaCount;
      if (reportedCount != null && Number(reportedCount) === 0) return null;
      // BoardGoal 的 snake_case 字段是唯一正式契约；兼容旧/第三方 payload
      // 的 camelCase 别名，避免字段契约不一致时整行被误判为 0 条。
      const rawItems = props.items ?? props.criteria_items ?? props.criteriaItems;
      const keys = Array.isArray(rawItems)
        ? [...new Set(rawItems.map(String).map((key) => key.trim()).filter((key) => key && !CRITERIA_PLACEHOLDERS.has(key)))]
        : [];
      const storeKey = "dsh-graph.crit." + props.goalId;
      const readChecked = () => {
        try { const value = JSON.parse(localStorage.getItem(storeKey) ?? "[]"); return Array.isArray(value) ? value : []; }
        catch { return []; }
      };
      const [checked, setChecked] = React.useState(readChecked);
      React.useEffect(() => {
        const refresh = () => setChecked(readChecked());
        window.addEventListener("storage", refresh);
        window.addEventListener("dsh-graph.criteria-changed", refresh);
        return () => {
          window.removeEventListener("storage", refresh);
          window.removeEventListener("dsh-graph.criteria-changed", refresh);
        };
      }, [storeKey]);
      if (!keys.length) return null;
      // 仅精确匹配当前有序 key；未知、过期及重复 checked 自然不会计数。
      const checkedSet = new Set(Array.isArray(checked) ? checked.map(String) : []);
      const done = keys.filter((key) => checkedSet.has(key)).length;
      const total = keys.length;
      const label = `质量判据：已完成 ${done}/${total}`;
      // emoji 是双宽字形：每格固定窄宽并 scaleX 收窄，最多保留 10 格，避免长列表撑宽卡片。
      const shown = keys.slice(0, 10);
      const blocks = shown.map((key) => h("span", {
        key, className: "dg-criteria-block", "aria-hidden": "true",
        style: { display: "inline-block", width: 5, transform: "scaleX(.2)", transformOrigin: "right center" },
      }, checkedSet.has(key) ? "🟩" : "◽"));
      if (total > shown.length) {
        blocks.push(h("span", { key: "count", style: { letterSpacing: "normal", marginLeft: -2 } }, `${done}/${total}`));
      }
      return h("span", {
        className: "dg-criteria-progress", role: "img", title: label, "aria-label": label,
        style: { display: "inline-block", maxWidth: "100%", height: 16, lineHeight: "16px",
          whiteSpace: "nowrap", overflow: "hidden", verticalAlign: "middle", fontSize: 11,
          letterSpacing: "-3px", marginLeft: 0, paddingRight: 2 },
      }, blocks);
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
        /* g-168 polish border */ borderLeft: `5px solid ${borderColor}`,
      };
      // g-168：PM 润色仅通过透明遮罩覆盖卡片边框，卡片本体保持可见。
      // g-171：更新强调浮层（left:-5px 覆盖 5px 类型色边框）同样需要卡片定位锚点。
       const cardStyle = g._polishActive ? { ...style, position: "relative", animation: "none" } : g._updateEmphasis ? { ...style, position: "relative" } : style;

      // g-171：更新强调——左侧类型色边框上的金属光泽浮层（10 秒生命周期内循环扫光并淡出）。
      // 折叠/展开两条路径都挂载同一浮层；pointer-events:none + aria-hidden，不改变布局/点击/拖拽。
      const updateSheen = g._updateEmphasis ? h("div", {
        key: "update-sheen-" + g._updateEmphasis.token,
        className: "dg-update-sheen",
        "aria-hidden": "true",
        style: { animationDuration: g._updateEmphasis.remaining + "ms" },
      }, h("div", { className: "dg-update-sheen-bar" })) : null;



       const polishOverlay = g._polishActive ? h("div", {
         key: "polish-overlay", "aria-hidden": "true",
         style: {
           position: "absolute", inset: 0, pointerEvents: "none", borderRadius: 6,
           border: "2px solid rgba(76,141,255,.82)",
           background: "linear-gradient(90deg, rgba(76,141,255,.08), rgba(58,166,117,.22), rgba(76,141,255,.08))",
           backgroundSize: "200% 100%", boxShadow: "0 0 0 2px rgba(76,141,255,.28), 0 0 12px rgba(58,166,117,.26)",
           animation: "dg-polish-flow 2.5s ease 1 forwards",
         },
       }) : null;
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
      if (g.reviewer === "human") badges.push("👤");
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
        g._polishActive ? " dg-running-flow" : "",
      ].filter(Boolean).join(" ");
      // g-77647351：拖放事件 props
      const dragProps = drag ? {
        draggable: true,
        onDragStart: (e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", g.id);
          // g-173 follow-up：backlog 卡片默认拖拽虚影会渲染整个 .dg-backlog-flat 行
          // （flex-wrap 容器内多卡同行）。显式把当前卡片克隆节点作为 setDragImage，
          // 虚影只显示当前这一张卡；克隆节点置于视口外并同步宽度，避免布局塌缩。
          try {
            const src = e.currentTarget;
            const ghost = src.cloneNode(true);
            ghost.classList.remove("dg-dragging", "dg-running-flow", "dg-drop-before", "dg-drop-after");
            const rect = src.getBoundingClientRect();
            ghost.style.position = "fixed";
            ghost.style.left = "-9999px";
            ghost.style.top = "0";
            ghost.style.width = rect.width + "px";
            ghost.style.margin = "0";
            ghost.style.pointerEvents = "none";
            ghost.style.zIndex = "99999";
            document.body.appendChild(ghost);
            e.dataTransfer.setDragImage(ghost, 16, 10);
            setTimeout(() => { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 0);
          } catch { /* setDragImage 不可用时保持浏览器默认虚影 */ }
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
          { key: g.id, style: cardStyle, className: dragClass,
            title: "点击打开详情", onClick: () => onOpen(g.id), ...dragProps, ...dropProps },
          polishOverlay,
          updateSheen,
           titleRow,
          h("div", { style: S.meta },
            `${g.id} ｜ ${STATUS_LABEL[g.status] ?? g.status}${badges.length ? " ｜ " + badges.join(" ") : ""}`,
             h(CriteriaProgress, {
               goalId: g.id,
               items: g.criteria_items ?? g.criteriaItems,
               count: g.criteria_count ?? g.criteriaCount,
             })),
        );
      }
      return h(
        "div",
        { key: g.id, style: cardStyle, className: dragClass,
          title: "点击打开详情", onClick: () => onOpen(g.id), ...dragProps, ...dropProps },
        polishOverlay,
        updateSheen,
           titleRow,
        h("div", { style: S.meta },
          `${g.id} ｜ ${STATUS_LABEL[g.status] ?? g.status}${badges.length ? " ｜ " + badges.join(" ") : ""}`,
          h(CriteriaProgress, {
            goalId: g.id,
            items: g.criteria_items ?? g.criteriaItems,
            count: g.criteria_count ?? g.criteriaCount,
          }),
          sessionLinkBtn(g.attempt_parent_session_id, g.attempt_child_id, "↗ 转到对话")),
        hasDep
          ? h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-warn-label, #e0a53a)" } }, `⛓ 等待 ${pendingDeps.join("、")} 交付`)
          : null,
        metDeps.length
          ? h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-success-primary, #3aa675)" } }, `✅ 依赖满足：${metDeps.join("、")} 已交付`)
          : null,
        blocked && g.blocked_reason
          ? h("div", { style: { ...S.statusLine, color: "var(--dsw-alias-state-error-primary, #d66)" } }, "⛔ " + g.blocked_reason)
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
