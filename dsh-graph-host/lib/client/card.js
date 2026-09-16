      const [open, setOpen] = React.useState(false);
      const { summary } = props;
      if (!summary) return null;
      if (summary.length <= 40) {
        return h("div", { style: { opacity: 0.75, marginTop: 1 } }, summary);
      }
      return h("div", {
        style: { opacity: 0.75, marginTop: 1, cursor: "pointer" },
        className: open ? "dg-summary-open" : "dg-summary-clamp",
        title: open ? dgT('card.clickSummaryCollapse') : dgT('card.clickSummaryExpand'),
        onClick: (e) => { e.stopPropagation(); setOpen(!open); },
      }, summary);
    }

    // g-230：判据占位符——使用动态翻译函数
    const getCriteriaPlaceholders = () => new Set([
      dgT('criteria.pending'),
      dgT('criteria.pendingDetail'),
      dgT('criteria.toBeFilled'),
    ]);
    // Compatibility alias retained for source consumers; lookup remains dynamic per render.
    const CRITERIA_PLACEHOLDERS = { has: (key) => getCriteriaPlaceholders().has(key) };

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
      const label = dgT('card.criteriaProgress', { done, total });
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

    // g-200：判断 Goal 是否有正在活跃的执行 attempt（排除收集子代理）
    function hasActiveGoalExecutionAttempt(attempts) {
      return (attempts ?? []).some((a) => {
        if (a?.executor === "agent:collect" || a?.result !== "pending") return false;
        const structured = ["working", "blocked", "done", "error"].includes(a?.status_state) ? a.status_state : null;
        if (structured) return structured === "working";
        const line = String(a?.status_line ?? "").trim();
        // i18n-keep(category-a)：匹配用户/子代理手写的遗留中文 status_line 终态词，非 UI 文案，必须保留中文模式。
        return line !== "" && !/空闲|完成|待命|已交付|结束|等待|finished|done|idle|completed/i.test(line);
      });
    }

    // g-187：标签徽章（标签由看板本地编辑器维护，也兼容服务端 tags 字段）
    function GoalTags(props) {
      const tags = Array.isArray(props.tags) ? props.tags : [];
      if (!tags.length) return null;
      return h("div", { style: { display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4, minWidth: 0, maxWidth: "100%", overflow: "hidden" }, "aria-label": dgT("tags.title") },
        tags.map((tag) => h("span", {
          key: tag, style: { fontSize: 10, lineHeight: "16px", padding: "0 5px", borderRadius: 8,
            background: "rgba(76,141,255,.16)", border: "1px solid rgba(76,141,255,.35)",
            color: "var(--dsw-alias-label-primary, #b8d1ff)", maxWidth: "100%", minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" },
        }, "#" + tag)));
    }

    // g-294：可交互类型 badge——点击展开内联类型切换器，直接在看板卡片上修改 goal.type。
    // 不引入类型筛选器；只做切换+API 调用+onTypeChanged 回调。
    function TypeBadgeWithSelector(props) {
      const { goalId, type, onTypeChanged } = props;
      const [open, setOpen] = React.useState(false);
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState(null);
      const wrapRef = React.useRef(null);
      const aType = normalizeGoalType(type);

      React.useEffect(() => {
        if (!open) return;
        const onDoc = (e) => {
          if (wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setError(null); }
        };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
      }, [open]);

      const switchType = async (t) => {
        if (t === aType || loading) return;
        setLoading(true); setError(null);
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/set-goal-type"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: goalId, type: t }),
          });
          const data = await r.json();
          if (data.ok) {
            setOpen(false);
            onTypeChanged?.();
          } else {
            setError(data.error || "failed");
          }
        } catch (e) {
          setError(String(e?.message ?? e));
        }
        setLoading(false);
      };

      const badge = h("span", {
        key: "type-badge",
        style: {
          display: "inline-block", width: 16, height: 16, lineHeight: "16px",
          textAlign: "center", borderRadius: 3, fontSize: 10, fontWeight: 700,
          background: goalTypeColor(aType), color: "#fff",
          verticalAlign: "middle", marginRight: 2, cursor: "pointer", flexShrink: 0,
        },
        title: dgT("goal.typeLabel", { type: GOAL_TYPE_LABELS[aType] ?? aType }),
        onClick: (e) => { e.stopPropagation(); setOpen(!open); setError(null); },
      }, GOAL_TYPE_ABBREV[aType] ?? aType[0]?.toUpperCase());

      if (!open) return badge;

      return h("span", { ref: wrapRef, style: { display: "inline-flex", alignItems: "center", gap: 2, marginRight: 2, verticalAlign: "middle", flexShrink: 0 } },
        badge,
        ...GOAL_TYPES.map((t) =>
          h("button", {
            key: t,
            style: {
              width: 16, height: 16, padding: 0, display: "inline-flex",
              alignItems: "center", justifyContent: "center", cursor: loading ? "wait" : "pointer",
              fontSize: 10, fontWeight: 700, lineHeight: 1, borderRadius: 3,
              border: "1px solid " + (t === aType ? goalTypeColor(t) : goalTypeColor(t) + "66"),
              background: t === aType ? goalTypeColor(t) : goalTypeColor(t) + "18",
              color: t === aType ? "#fff" : goalTypeColor(t),
              opacity: loading ? 0.6 : 1,
              flexShrink: 0,
            },
            title: GOAL_TYPE_LABELS[t],
            onClick: (e) => { e.stopPropagation(); switchType(t); },
          }, GOAL_TYPE_ABBREV[t])),
        h("button", {
          style: {
            width: 16, height: 16, padding: 0, display: "inline-flex",
            alignItems: "center", justifyContent: "center", cursor: "pointer",
            fontSize: 9, lineHeight: 1, borderRadius: 3,
            border: "1px solid rgba(128,128,128,.35)", background: "rgba(128,128,128,.15)",
            color: "inherit", opacity: 0.7, flexShrink: 0,
          },
          onClick: (e) => { e.stopPropagation(); setOpen(false); setError(null); },
        }, "✕"),
        error ? h("span", { style: { fontSize: 9, color: "var(--dsw-alias-state-error-primary, #d66)", marginLeft: 2 } }, "⚠") : null
      );
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
    // g-294：onTypeChanged 参数——类型切换后回调（触发看板数据刷新）
    function Card(g, onOpen, onOpenCard, activeGoal, activeCard, goalStatus, expanded, onToggleExpand, drag, onTypeChanged) {
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
      // 实现采用内联 animation（不依赖 .dg-update-sheen class 的 opacity），避免
      // prefers-reduced-motion 把浮层整体 opacity:0 隐藏——"哪个目标被更新"是功能性信息，
      // 降级为静态可见而非完全消失（g-171 回退修复：用户系统开减少动态效果导致动画不可见）。
      const updateSheen = g._updateEmphasis ? h("div", {
        key: "update-sheen-" + g._updateEmphasis.token,
        className: "dg-update-sheen",
        "aria-hidden": "true",
        style: { animation: "dg-update-fade " + g._updateEmphasis.remaining + "ms linear forwards" },
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
      // g-158/g-294：可交互类型标记 badge（点击展开内联类型切换器）——标题左侧，颜色与左栏/弹窗同源
      const tBadge = h(TypeBadgeWithSelector, { goalId: g.id, type: g.type, onTypeChanged });
      if (g.reviewer === "human") badges.push("👤");
      if (g.reviewer === "ai") badges.push(dgT('review.aiBadge'));
      if (g.pk_lanes > 1) badges.push("PK×" + g.pk_lanes);
      if (g.archived) badges.push(dgT('card.archived'));
      const reusedBy = g.reused_by ?? null;
      // g-125：标题左侧小三角（▸ 折叠 / ▾ 展开），所有卡片统一；点击卡片其余区域打开详情
      // fb3：独立 .dg-chevron 样式——暗底纹、窄宽度（不用 S.btn/dg-btn，避免播放按钮观感）
      // fb4：按钮与标题 inline 同行（非 flex 列）——标题换行时第二行从行首开始，不被按钮占去宽度
      const chevron = h("button", {
        style: { marginRight: 4, verticalAlign: "middle", display: "inline-block" },
        className: "dg-chevron",
        title: collapsed ? dgT('card.expandFull') : dgT('card.collapseBrief'),
        onClick: (e) => { e.stopPropagation(); onToggleExpand(g.id); },
      }, collapsed ? "▸" : "▾");
      const highlight = typeof renderHighlight === "function" ? renderHighlight : (text) => text;
      const titleRow = h("div", { style: { lineHeight: 1.5 } },
        chevron,
        tBadge,
        h("span", { style: { ...S.title, display: "inline", verticalAlign: "middle" } }, highlight(g.title, g._searchQuery, g._isSearchCurrent)));
      // g-77647351：拖放 class 合并
      const dragClass = [
        "dg-card",
        activeGoal ? " dg-card-active" : "",
        g._isSearchCurrent ? " dg-card-search-current" : (g._isSearchMatched ? " dg-card-matched" : ""),
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
            ghost.style.zIndex = "100000";
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
          { key: g.id, id: "goal-" + g.id, "data-goal-id": g.id, style: cardStyle, className: dragClass,
            title: dgT('card.clickToOpen'), onClick: () => onOpen(g.id), ...dragProps, ...dropProps },
          polishOverlay,
          updateSheen,
           titleRow,
          h(GoalTags, { tags: g._tags ?? g.tags }),
          h("div", { style: S.meta },
            highlight(g.id, g._searchQuery, g._isSearchCurrent),
            ` ｜ ${STATUS_LABEL[g.status] ?? g.status}${badges.length ? " ｜ " + badges.join(" ") : ""}`,
             h(CriteriaProgress, {
               goalId: g.id,
               items: g.criteria_items ?? g.criteriaItems,
               count: g.criteria_count ?? g.criteriaCount,
             }),
            sessionLinkBtn(g.attempt_parent_session_id, g.attempt_child_id, dgT('card.goToSession'))),
          g._snippet ? h("div", {
            style: { fontSize: 11, opacity: 0.85, marginTop: 2, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" },
            title: "📝",
          }, "📝 ", highlight(g._snippet, g._searchQuery, g._isSearchCurrent)) : null,
        );
      }
      return h(
        "div",
        { key: g.id, id: "goal-" + g.id, "data-goal-id": g.id, style: cardStyle, className: dragClass,
          title: dgT('card.clickToOpen'), onClick: () => onOpen(g.id), ...dragProps, ...dropProps },
        polishOverlay,
        updateSheen,
           titleRow,
        h(GoalTags, { tags: g._tags ?? g.tags }),
        h("div", { style: S.meta },
          highlight(g.id, g._searchQuery, g._isSearchCurrent),
          ` ｜ ${STATUS_LABEL[g.status] ?? g.status}${badges.length ? " ｜ " + badges.join(" ") : ""}`,
          h(CriteriaProgress, {
            goalId: g.id,
            items: g.criteria_items ?? g.criteriaItems,
            count: g.criteria_count ?? g.criteriaCount,
          }),
          sessionLinkBtn(g.attempt_parent_session_id, g.attempt_child_id, dgT('card.goToSession'))),
        g._snippet ? h("div", {
          style: { fontSize: 11, opacity: 0.85, marginTop: 2, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" },
          title: "📝",
        }, "📝 ", highlight(g._snippet, g._searchQuery, g._isSearchCurrent)) : null,
        hasDep
          ? h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-warn-label, #e0a53a)" } }, dgT('card.waitingDep', { deps: pendingDeps.join(", ") }))
          : null,
        metDeps.length
          ? h("div", { style: { ...S.meta, color: "var(--dsw-alias-label-primary, #3aa675)" } }, dgT('card.depsSatisfied', { deps: metDeps.join(", ") }))
          : null,
        blocked && g.blocked_reason
          ? h("div", { style: { ...S.statusLine, color: "var(--dsw-alias-state-error-primary, #d66)" } }, "⛔ " + g.blocked_reason)
          : null,
        // g-a92e1406 & g-200：执行会话内嵌实时条——status_line 摘要并入状态小窗
        //（运行中 ⏳ / 空闲刚执行完 ✅）；当且仅当 Goal 处于执行态（in_progress）或有明确活跃执行 attempt 时展示 Goal LiveStrip；
        // 仅有上下文卡片处于 collecting 时隐藏 Goal LiveStrip，避免在 Goal 与子卡片重复展示；
        // 无执行会话但有 status_line 时退化为独立状态行（带动画）
        g.attempt_child_id && (g.status === "in_progress" || hasActiveGoalExecutionAttempt(g.attempts))
          ? h("div", { key: "live" },
              h(LiveStrip, { parentId: g.attempt_parent_session_id, childId: g.attempt_child_id,
                             provider: g.attempt_provider, model: g.attempt_model,
                             statusLine: g.status_line, statusState: g.status_state }))
          : g.status_line
            ? h(StatusLine, { text: g.status_line, statusState: g.status_state, blocked: g.status === "blocked", running: g.status === "in_progress" })
            : null,
        reusedBy ? h(ReusedBadge, { childId: g.attempt_child_id, reusedBy }) : null,
        (g.cards ?? []).map((c) =>
          h("div", {
            key: c.id,
            style: { ...S.subCard, cursor: "pointer" },
            className: "dg-sub" + (activeCard === c.id ? " dg-sub-active" : ""),
            title: dgT('card.clickToOpenDrawer'),
            onClick: (e) => { e.stopPropagation(); onOpenCard(g.id, c.id); },
          },
            h("div", { style: { display: "flex", alignItems: "center", gap: 4 } },
              h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                `📇 ${CARD_STATUS_ICON[c.status] ?? c.status} ｜ ${c.title}`),
              c.scope === "shared"
                ? h("span", { style: { flexShrink: 0, fontSize: 10, padding: "0 4px", borderRadius: 3, background: "rgba(58,166,117,.18)", color: "var(--dsw-alias-state-success-label, #3aa675)" } },
                    dgT('card.sharedBadge'))
                : null,
              sessionLinkBtn(c.parent_session_id, c.child_id, "↗")),
            h(CardSummary, { summary: c.summary }),
            c.child_id && c.status !== "filled" && c.status !== "reviewed"
              ? h("div", { onClick: (e) => e.stopPropagation() },
                  h(LiveStrip, { parentId: c.parent_session_id, childId: c.child_id,
                                 provider: c.provider, model: c.model }))
              : null)),
      );
    }

    // g-a92e1406：状态摘要行——运行中带流动背景+图标动画，阻塞行静态
    // g-239：使用 formatStatusWithLifecycle 区分真实生命周期状态
    function StatusLine(props) {
      const { text, statusState, blocked, running } = props;
      if (!text) return null;
      const formatted = formatStatusWithLifecycle(text, running, blocked, statusState);
      if (formatted.isBlocked) {
        return h("div", { style: { ...S.statusLine, color: "var(--dsw-alias-state-error-primary, #d66)" } }, "⛔ " + formatted.text);
      }
      if (formatted.isError) {
        return h("div", { style: { ...S.statusLine, color: "var(--dsw-alias-state-error-primary, #d66)" } }, "❌ " + formatted.text);
      }
      const animClass = formatted.isRunning ? "dg-running-flow" : "";
      return h(
        "div", { className: animClass, style: { ...S.statusLine, marginTop: 3 } },
        h("span", { className: formatted.isRunning ? "dg-icon-pulse" : "" }, formatted.icon),
        formatted.text,
      );
    }

    // Contract names retained: CRITERIA_PLACEHOLDERS; !CRITERIA_PLACEHOLDERS.has(key); checkedSet.has(key) ? "🟩" : "◽".
