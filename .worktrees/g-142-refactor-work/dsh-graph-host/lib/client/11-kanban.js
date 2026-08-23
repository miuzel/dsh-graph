
    function KanbanView(props) {
      const [state, setState] = React.useState({ loading: true });
      const [modalGoal, setModalGoal] = React.useState(null);
      const [drawerCard, setDrawerCard] = React.useState(null); // {goalId, cardId}
      const [openReleased, setOpenReleased] = React.useState({});
      // g-125：delivered/blocked 卡片展开完整视图的开关（默认折叠精简）
      const [expandedGoals, setExpandedGoals] = React.useState({});
      // g-129: 新建目标弹窗状态
      const [showCreateGoal, setShowCreateGoal] = React.useState(false);
      const [newGoalTitle, setNewGoalTitle] = React.useState("");
      const [newGoalVersion, setNewGoalVersion] = React.useState("");
      const [newGoalDesc, setNewGoalDesc] = React.useState("");
      const [createNote, setCreateNote] = React.useState(null);
      const [creating, setCreating] = React.useState(false);
      // g-110: 显示已归档目标的开关
      const [showArchived, setShowArchived] = React.useState(false);
      // g-127: 阻塞列默认折叠（竖向窄条汇总，点击展开）
      const [blockedColumnCollapsed, setBlockedColumnCollapsed] = React.useState(true);
      // g-77647351：拖拽状态机
      const [drag, setDrag] = React.useState(null); // {goalId, fromStatus, overGoalId, overStageKey, overHalf, laneKey}
      const dropCommitted = React.useRef(false);
      const [orderMap, setOrderMap] = React.useState({}); // {laneKey: {stageKey: goalId[]}}
      const [transitionNote, setTransitionNote] = React.useState(null);

      // g-77647351：document 级兜底（拖到列表外不显示 rejected）
      React.useEffect(() => {
        if (!drag) return;
        const acceptDrag = (e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        };
        const acceptDrop = (e) => { e.preventDefault(); };
        document.addEventListener("dragover", acceptDrag);
        document.addEventListener("drop", acceptDrop);
        return () => {
          document.removeEventListener("dragover", acceptDrag);
          document.removeEventListener("drop", acceptDrop);
        };
      }, [drag !== null]);

      // g-77647351：加载排序
      const loadOrder = () => {
        fetch(graphUrl("/api/dsh-graph/order"))
          .then((r) => r.json())
          .then((data) => setOrderMap(data))
          .catch(() => {});
      };
      const saveOrder = (newOrder) => {
        setOrderMap(newOrder);
        fetch(graphUrl("/api/dsh-graph/order"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(newOrder),
        }).catch(() => {});
      };

      // g-77647351：对账排序（reconciledSessionOrder 模式）
      function reconciledGoalOrder(goalIds, stored) {
        if (!stored || !stored.length) return [...goalIds];
        const byId = new Map(goalIds.map((id) => [id, id]));
        const ordered = [];
        const included = new Set();
        for (const key of stored) {
          const id = byId.get(key);
          if (id === undefined || included.has(key)) continue;
          ordered.push(id);
          included.add(key);
        }
        for (const id of goalIds) {
          if (included.has(id)) continue;
          ordered.push(id);
        }
        return ordered;
      }

      // g-77647351：跨列拖动提交（transition API 调用）
      async function commitCrossColumnDrag(goalId, toStatus, reason) {
        try {
          const body = { goal: goalId, to: toStatus };
          if (reason) body.reason = reason;
          const r = await fetch(graphUrl("/api/dsh-graph/transition"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            showToast(`✅ ${goalId} → ${STATUS_LABEL[toStatus] ?? toStatus}`);
            load(); // 刷新看板
          } else {
            showToast("⚠️ 迁移失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          showToast("⚠️ 请求失败：" + String(e?.message ?? e));
        }
      }

      // g-77647351：回退询问理由弹窗状态
      const [backwardPrompt, setBackwardPrompt] = React.useState(null); // {goalId, toStatus, hasChild, childId, parentId}
      // g-77647351：进执行列确认弹窗状态（复用执行按钮逻辑，替代服务端报错）
      const [inProgressPrompt, setInProgressPrompt] = React.useState(null); // {goalId}
      // g-77647351：交付确认弹窗状态
      const [deliverPrompt, setDeliverPrompt] = React.useState(null); // {goalId, goalTitle, toStatus}

      // g-77647351：同列重排提交（照抄 commitSessionDrag）
      function commitSameColumnDrag(activeDrag, over) {
        if (dropCommitted.current) return;
        dropCommitted.current = true;
        setDrag(null);
        const { goalId, laneKey, overGoalId, overHalf } = activeDrag;
        const stageKey = STAGES.find((s) => s.statuses.includes(activeDrag.fromStatus))?.key;
        if (!stageKey) return;
        const currentOrderKey = `${laneKey}|${stageKey}`;
        const stored = orderMap[currentOrderKey] ?? [];
        const laneGoals = allGoals.filter((g) => {
          const gStage = stageOf(g.status);
          if (gStage !== stageKey) return false;
          // 同一泳道
          const gLane = goalLane(g);
          return gLane === laneKey;
        });
        const goalIds = laneGoals.map((g) => g.id);
        const reconciled = reconciledGoalOrder(goalIds, stored);
        // 计算新位置
        const filtered = reconciled.filter((id) => id !== goalId);
        const anchorIdx = overHalf === "before" ? filtered.indexOf(overGoalId) : filtered.indexOf(overGoalId) + 1;
        if (anchorIdx < 0) return;
        filtered.splice(anchorIdx, 0, goalId);
        // 检查是否真的变了
        if (filtered.join(",") === reconciled.join(",")) return;
        const newOrder = { ...orderMap, [currentOrderKey]: filtered };
        saveOrder(newOrder);
      }

      // g-77647351：跨 lane 拖放提交（moveGoal 归属变更，状态保持）
      function commitCrossLaneMove(goalId, targetLaneKey) {
        let to, version;
        if (targetLaneKey === "standalone") {
          to = "standalone";
        } else if (targetLaneKey === "backlog") {
          to = "backlog";
        } else if (targetLaneKey.startsWith("v-")) {
          to = "version";
          version = targetLaneKey.slice(2);
        } else {
          showToast("⚠️ 未知目标泳道：" + targetLaneKey);
          return;
        }
        const body = { goal: goalId, to };
        if (version) body.version = version;
        fetch(graphUrl("/api/dsh-graph/move-goal"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
          .then((r) => r.json())
          .then((data) => {
            if (data.ok) {
              showToast(`✅ ${goalId} 已移动到 ${targetLaneKey}`);
              load();
            } else {
              const err = data.error || "未知错误";
              if (err.includes("不能移回 backlog 平铺")) {
                showToast("⚠️ 目标有附件（cards/attempts），不能移回 backlog。可移到独立目标或版本中。");
              } else {
                showToast("⚠️ 移动失败：" + err);
              }
            }
          })
          .catch((e) => showToast("⚠️ 请求失败：" + String(e?.message ?? e)));
      }

      // g-77647351：提交拖放（入口）
      function commitGoalDrag(activeDrag, over) {
        if (dropCommitted.current) return;
        dropCommitted.current = true;
        setDrag(null);
        const { goalId, fromStatus, overGoalId, overStageKey, overHalf, laneKey } = activeDrag;
        const overLaneKey = activeDrag.overLaneKey ?? laneKey;
        const fromStage = stageOf(fromStatus);
        // 跨 lane 拖放 → moveGoal 归属变更（状态保持，不涉及 transition）
        if (overLaneKey !== laneKey) {
          // g-137：backlog 卡拖入版本 lane 的落点限定
          // 从 backlog 拖到版本 lane 时，只能落到「描述」列（overStageKey === "describe"）
          if (laneKey === "backlog" && overLaneKey.startsWith("v-") && overStageKey !== "describe") {
            showToast("⚠️ backlog 卡片只能拖到版本的「描述」列，不能直接到收集/执行/确认/交付/阻塞列");
            return;
          }
          commitCrossLaneMove(goalId, overLaneKey);
          return;
        }
        if (fromStage === overStageKey) {
          // 同列重排
          if (overGoalId) {
            const currentOrderKey = `${laneKey}|${fromStage}`;
            const stored = orderMap[currentOrderKey] ?? [];
            const laneGoals = allGoals.filter((g) => stageOf(g.status) === fromStage && goalLane(g) === laneKey);
            const goalIds = laneGoals.map((g) => g.id);
            const reconciled = reconciledGoalOrder(goalIds, stored);
            const filtered = reconciled.filter((id) => id !== goalId);
            const anchorIdx = overHalf === "before" ? filtered.indexOf(overGoalId) : filtered.indexOf(overGoalId) + 1;
            if (anchorIdx >= 0) {
              filtered.splice(anchorIdx, 0, goalId);
              if (filtered.join(",") !== reconciled.join(",")) {
                saveOrder({ ...orderMap, [`${laneKey}|${fromStage}`]: filtered });
              }
            }
          }
          return;
        }
        // 跨列 → transition
        // 判据 3：planning→collect 二义默认 collecting
        let toStatus = resolveTargetStatus(fromStatus, overStageKey);
        if (!toStatus) {
          // blocked 只能回 blocked_from，前端无法预判，提示用户
          showToast("⚠️ blocked 状态只能解除回原状态（由服务端校验）");
          return;
        }
        // 判据 3：delivered 终态 → 弹窗告知主管需做交付工作
        if (overStageKey === "deliver") {
          const goalData = allGoals.find((g) => g.id === goalId);
          setDeliverPrompt({ goalId, goalTitle: goalData?.title ?? goalId, toStatus });
          return;
        }
        // 判据 4：回退方向询问理由
        if (isBackward(fromStatus, toStatus)) {
          // 查找该目标的执行子代理信息
          const goalData = allGoals.find((g) => g.id === goalId);
          const hasChild = !!(goalData?.attempt_child_id);
          setBackwardPrompt({
            goalId,
            toStatus,
            hasChild,
            childId: goalData?.attempt_child_id ?? null,
            parentId: goalData?.attempt_parent_session_id ?? null,
          });
          return;
        }
        // 判据 3+4：进执行列 → 弹窗确认（复用执行按钮逻辑，替代服务端报错兜底）
        if (overStageKey === "execute") {
          setInProgressPrompt({ goalId });
          return;
        }
        if (toStatus === "blocked") {
          const reason = prompt("请输入阻塞原因：");
          if (!reason || !reason.trim()) return;
          commitCrossColumnDrag(goalId, toStatus, reason.trim());
          return;
        }
        commitCrossColumnDrag(goalId, toStatus);
      }

      // g-77647351：辅助——确定目标属于哪个泳道
      function goalLane(g) {
        for (const v of active) if (v.goals.some((vg) => vg.id === g.id)) return "v-" + v.slug;
        if (b.standalone.some((sg) => sg.id === g.id)) return "standalone";
        if (b.backlog.some((bg) => bg.id === g.id)) return "backlog";
        return "backlog";
      }

      // g-113 定点 bug：从 slot props 取「被查看会话」id（conversation.view 渲染回调注入的
      // session 作用域字段，字段名 props.sessionId——renderer 的 standardProps 里
      // standard["sessionId"] = info.sessionId）。必须先于 load effect 声明，挂载即生效。
      React.useEffect(() => {
        viewedSessionId = props?.sessionId ?? null;
        return () => { viewedSessionId = null; };
      }, [props?.sessionId]);
      const load = () => {
        const params = showArchived ? "?includeArchived=1" : "";
        fetch(graphUrl("/api/dsh-graph" + params))
          .then((r) => r.json())
          .then((data) => { setState({ loading: false, data }); loadOrder(); })
          .catch((e) => setState({ loading: false, error: String(e) }));
      };
      React.useEffect(() => {
        load();
        const t = setInterval(load, 15000);
        return () => clearInterval(t);
      }, [showArchived]); // showArchived 变化时重新加载

      if (state.loading) return h("div", { style: S.wrap }, "dsh-graph 看板加载中…");
      if (state.error) return h("div", { style: S.wrap }, "看板数据获取失败：" + state.error);
      const b = state.data;
      if (b.error) return h("div", { style: S.wrap }, "看板数据错误：" + b.error);

      const active = b.versions.filter((v) => v.status !== "released");
      const released = b.versions.filter((v) => v.status === "released");
      // 全量目标 id→status 映射（依赖徽章状态化，发现#23：已交付依赖算「依赖满足」）
      const goalStatus = {};
      for (const v of b.versions) for (const g of v.goals) goalStatus[g.id] = g.status;
      for (const g of b.standalone) goalStatus[g.id] = g.status;
      for (const g of b.backlog) goalStatus[g.id] = g.status;
      // g-a92e1406：被复用徽章派生已移交 boardProjection（attempt.reused 事件 + 绑定记录双源），
      // 客户端直接消费 g.reused_by，不再用数组顺序猜测旧/新绑定。
      const allGoals = [
        ...active.flatMap((v) => v.goals),
        ...released.flatMap((v) => v.goals),
        ...b.standalone,
        ...b.backlog,
      ];
      // g-129: 打开新建目标弹窗，预选版本
      const openCreateGoal = (version) => {
        setNewGoalVersion(version || "");
        setShowCreateGoal(true);
        setCreateNote(null);
      };
      // g-77647351：泳道渲染（带拖放支持，跨 lane 拖放改归属）；g-129 版本 lane 标题「＋」预选版本
      // g-137：laneIndex 用于交替背景色
      const lane = (label, goals, key, version, laneIndex = 0) => {
        const cells = STAGES.map((s) => {
          const cellGoals = goals.filter((g) => stageOf(g.status) === s.key);
          // 排序对账
          const orderKey = `${key}|${s.key}`;
          const stored = orderMap[orderKey] ?? [];
          const goalIds = cellGoals.map((g) => g.id);
          const reconciled = reconciledGoalOrder(goalIds, stored);
          const orderedGoals = reconciled.map((id) => cellGoals.find((g) => g.id === id)).filter(Boolean);
          // g-77647351：anyDrag = 有拖动进行中（不限同 lane，允许跨 lane 拖放）
          const anyDrag = drag !== null;
          // g-137：backlog 卡拖到版本 lane 时，无论悬停在哪一列，都高亮「描述」列
          const isFromBacklog = anyDrag && drag.laneKey === "backlog";
          const isOverThisLane = anyDrag && drag.overLaneKey === key;
          const isOverThisCell = anyDrag && (
            (isFromBacklog && isOverThisLane && s.key === "describe") || // backlog→版本：只高亮描述列
            (!isFromBacklog && drag.overStageKey === s.key && drag.overLaneKey === key) // 其他情况：正常高亮
          );
          // g-137：交替背景色
          const laneBg = laneIndex % 2 === 0 ? "rgba(255,255,255,.03)" : "rgba(0,0,0,.08)";
          // g-127：阻塞列折叠态——竖条汇总替代卡片列表
          if (s.key === "blocked" && blockedColumnCollapsed && orderedGoals.length) {
            // 计算最长阻塞时间（从 created_at 到现在）
            let maxDays = 0;
            for (const g of orderedGoals) {
              if (g.created_at) {
                const d = (Date.now() - new Date(g.created_at).getTime()) / 86400000;
                if (d > maxDays) maxDays = d;
              }
            }
            const duration = maxDays >= 1 ? `${Math.floor(maxDays)}天` : "";
            // g-127：用换行符让窄条内自然竖排（文字保持水平，不旋转）
            const summaryText = duration
              ? h(React.Fragment, null, "⛔", h("br"), `×${orderedGoals.length}`, h("br"), duration)
              : h(React.Fragment, null, "⛔", h("br"), `×${orderedGoals.length}`);
            return h("div", {
              key: s.key,
              style: {
                ...S.cell,
                background: isOverThisCell ? "rgba(76,141,255,.10)" : laneBg,
                textAlign: "center",
                padding: "10px 2px",
                minWidth: 0,
                width: 36,
                cursor: "pointer",
                userSelect: "none",
                fontSize: 11,
                opacity: 0.85,
                lineHeight: 1.3,
                wordBreak: "break-all",
                overflow: "hidden",
              },
              className: "dg-blocked-collapsed" + (isOverThisCell && !orderedGoals.some((g) => g.id === drag.goalId) ? " dg-cell-drop-active" : ""),
              onClick: (e) => { e.stopPropagation(); setBlockedColumnCollapsed(false); },
              title: `点击展开阻塞列（${orderedGoals.length} 项）`,
              // g-127：折叠态仍支持拖放（拖入阻塞列）
              onDragOver: anyDrag ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (!orderedGoals.length) {
                  setDrag((d) => d ? { ...d, overGoalId: null, overStageKey: s.key, overLaneKey: key, overHalf: "after" } : d);
                }
              } : undefined,
              onDrop: anyDrag ? (e) => {
                e.preventDefault();
                if (!orderedGoals.length) {
                  commitGoalDrag({ ...drag, overGoalId: null, overStageKey: s.key, overLaneKey: key, overHalf: "after" }, null);
                }
              } : undefined,
            }, summaryText);
          }
          return h("div", {
            key: s.key,
            style: { ...S.cell, background: isOverThisCell ? "rgba(76,141,255,.10)" : laneBg },
            className: isOverThisCell && !orderedGoals.some((g) => g.id === drag.goalId) ? "dg-cell-drop-active" : "",
            onDragOver: anyDrag ? (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              // 列空白区域：设 overStageKey + overLaneKey 但无 overGoalId
              if (!orderedGoals.length) {
                // g-137：backlog 卡拖到版本 lane 时，overStageKey 固定为 "describe"
                const effectiveStageKey = (isFromBacklog && isOverThisLane) ? "describe" : s.key;
                setDrag((d) => d ? { ...d, overGoalId: null, overStageKey: effectiveStageKey, overLaneKey: key, overHalf: "after" } : d);
              }
            } : undefined,
            onDrop: anyDrag ? (e) => {
              e.preventDefault();
              if (!orderedGoals.length) {
                // g-137：backlog 卡拖到版本 lane 时，落点固定为 "describe"（其它列放手也落描述列）
                const effectiveStageKey = (isFromBacklog && isOverThisLane) ? "describe" : s.key;
                commitGoalDrag({ ...drag, overGoalId: null, overStageKey: effectiveStageKey, overLaneKey: key, overHalf: "after" }, null);
              }
            } : undefined,
          },
            orderedGoals.map((g) => {
              const defExpanded = g.status !== "delivered" && g.status !== "blocked";
              const expanded = expandedGoals[g.id] ?? defExpanded;
              const isDragTarget = isOverThisCell && drag.overGoalId === g.id;
              return Card(g, setModalGoal, (goalId, cardId) => setDrawerCard({ goalId, cardId }),
                modalGoal === g.id, drawerCard?.cardId, goalStatus,
                expanded,
                (id) => setExpandedGoals((p) => ({ ...p, [id]: !expanded })),
                // g-77647351：drag props（active 仍限同 lane 卡片，marker/over 不限）
                {
                  active: drag && drag.goalId === g.id,
                  marker: isDragTarget ? drag.overHalf : null,
                  start: () => {
                    dropCommitted.current = false;
                    setDrag({
                      goalId: g.id,
                      fromStatus: g.status,
                      overGoalId: null,
                      overStageKey: s.key,
                      overLaneKey: key,
                      overHalf: null,
                      laneKey: key,
                    });
                  },
                  over: isDragTarget ? { id: g.id, half: drag.overHalf } : null,
                  hover: (half) => {
                    // g-137：backlog 卡拖到版本 lane 时，overStageKey 固定为 "describe"
                    const effectiveStageKey = (isFromBacklog && isOverThisLane) ? "describe" : s.key;
                    setDrag((d) => d ? { ...d, overGoalId: g.id, overStageKey: effectiveStageKey, overLaneKey: key, overHalf: half } : d);
                  },
                  drop: (half) => {
                    if (!drag) return;
                    // g-137：backlog 卡拖到版本 lane 时，overStageKey 固定为 "describe"
                    const effectiveStageKey = (isFromBacklog && isOverThisLane) ? "describe" : s.key;
                    commitGoalDrag({ ...drag, overGoalId: g.id, overStageKey: effectiveStageKey, overLaneKey: key, overHalf: half }, { id: g.id, half });
                  },
                  end: () => {
                    if (drag?.overGoalId) {
                      commitGoalDrag(drag, { id: drag.overGoalId, half: drag.overHalf });
                    } else {
                      setDrag(null);
                    }
                    dropCommitted.current = false;
                  },
                },
              );
            }),
          );
        });
        // g-137：labelEl 交替背景色
        const labelBg = laneIndex % 2 === 0 ? "rgba(255,255,255,.03)" : "rgba(0,0,0,.08)";
        const labelEl = h("div", { key: key + "-label", style: { ...S.laneLabel, position: "relative", background: labelBg } },
          label,
          // g-129: 每个 lane 标题右下角加「+」按钮（版本 lane 预选版本，独立/backlog 进 backlog）
          h("button", {
            style: { ...S.btn, position: "absolute", right: 4, bottom: 2, fontSize: 11, padding: "0 5px", lineHeight: 1.4 },
            className: "dg-btn",
            title: key === "standalone" ? "新建独立目标" : (version ? `在 ${version} 新建目标` : "新建目标（backlog）"),
            onClick: () => openCreateGoal(key === "standalone" ? "standalone" : version),
          }, "＋"));
        return [labelEl, ...cells];
      };

      // g-137：backlog 行平铺展示函数
      const backlogRow = (label, goals, key) => {
        const isOverThisCell = drag && drag.overLaneKey === key;
        const labelEl = h("div", { key: key + "-label", style: { ...S.laneLabel, position: "relative", background: "rgba(0,0,0,.12)" } },
          label,
          h("button", {
            style: { ...S.btn, position: "absolute", right: 4, bottom: 2, fontSize: 11, padding: "0 5px", lineHeight: 1.4 },
            className: "dg-btn",
            title: "新建目标（backlog）",
            onClick: () => openCreateGoal(null),
          }, "＋"));
        // g-137 修复：backlog 平铺也按 order.json 对账排序（否则拖放重排保存了却不生效）
        const backStored = orderMap[`${key}|describe`] ?? [];
        const orderedGoals = reconciledGoalOrder(goals.map((g) => g.id), backStored)
          .map((id) => goals.find((g) => g.id === id))
          .filter(Boolean);
        const flatCell = h("div", {
          key: key + "-flat",
          style: { gridColumn: "2 / -1", minHeight: 40, borderTop: "1px solid rgba(128,128,128,.35)" },
          className: "dg-backlog-lane" + (isOverThisCell ? " dg-cell-drop-active" : ""),
          onDragOver: drag ? (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (!goals.length) {
              setDrag((d) => d ? { ...d, overGoalId: null, overStageKey: "describe", overLaneKey: key, overHalf: "after" } : d);
            }
          } : undefined,
          onDrop: drag ? (e) => {
            e.preventDefault();
            if (!goals.length) {
              commitGoalDrag({ ...drag, overGoalId: null, overStageKey: "describe", overLaneKey: key, overHalf: "after" }, null);
            }
          } : undefined,
        },
          h("div", { className: "dg-backlog-flat" },
            orderedGoals.map((g) => {
              const defExpanded = g.status !== "delivered" && g.status !== "blocked";
              const expanded = expandedGoals[g.id] ?? defExpanded;
              const isDragTarget = isOverThisCell && drag?.overGoalId === g.id;
              return Card(g, setModalGoal, (goalId, cardId) => setDrawerCard({ goalId, cardId }),
                modalGoal === g.id, drawerCard?.cardId, goalStatus,
                expanded,
                (id) => setExpandedGoals((p) => ({ ...p, [id]: !expanded })),
                {
                  active: drag && drag.goalId === g.id,
                  marker: isDragTarget ? drag.overHalf : null,
                  start: () => {
                    dropCommitted.current = false;
                    setDrag({
                      goalId: g.id,
                      fromStatus: g.status,
                      overGoalId: null,
                      overStageKey: "describe",
                      overLaneKey: key,
                      overHalf: null,
                      laneKey: key,
                    });
                  },
                  over: isDragTarget ? { id: g.id, half: drag.overHalf } : null,
                  hover: (half) => {
                    setDrag((d) => d ? { ...d, overGoalId: g.id, overStageKey: "describe", overLaneKey: key, overHalf: half } : d);
                  },
                  drop: (half) => {
                    if (!drag) return;
                    commitGoalDrag({ ...drag, overGoalId: g.id, overStageKey: "describe", overLaneKey: key, overHalf: half }, { id: g.id, half });
                  },
                  end: () => {
                    if (drag?.overGoalId) {
                      commitGoalDrag(drag, { id: drag.overGoalId, half: drag.overHalf });
                    } else {
                      setDrag(null);
                    }
                    dropCommitted.current = false;
                  },
                },
              );
            }),
          ),
        );
        return [labelEl, flatCell];
      };

      const rows = [];
      let laneIndex = 0;
      for (const v of active) {
        rows.push(...lane(`🏷 ${v.name}`, v.goals, "v-" + v.slug, v.slug, laneIndex));
        laneIndex++;
      }
      rows.push(...lane("独立目标", b.standalone, "standalone", null, laneIndex));
      laneIndex++;
      rows.push(...backlogRow("backlog", b.backlog, "backlog"));

      const releasedRows = released.map((v, idx) => {
        const open = !!openReleased[v.slug];
        return [
          h("div", {
            key: "rel-" + v.slug, style: S.collapsed, className: "dg-collapsed", title: "点击展开/收起",
            onClick: () => setOpenReleased({ ...openReleased, [v.slug]: !open }),
          }, `${open ? "▾" : "▸"} ${v.name} ✅ ${v.goals.length} 目标全部交付 · released · ${v.slug}`),
          open ? h("div", { key: "relx-" + v.slug, style: S.grid },
            ...lane(v.name, v.goals, "rellane-" + v.slug, null, laneIndex + idx)) : null,
        ];
      });

      const createGoal = async () => {
        const t = newGoalTitle.trim();
        if (!t) { setCreateNote("⚠️ 请输入目标标题"); return; }
        setCreating(true);
        setCreateNote("创建中…");
        try {
          const body = { title: t };
          if (newGoalVersion.trim()) body.version = newGoalVersion.trim();
          if (newGoalDesc.trim()) body.description = newGoalDesc.trim();
          const r = await fetch(graphUrl("/api/dsh-graph/create-goal"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            setCreateNote("✅ 已创建目标：" + data.goal);
            setNewGoalTitle("");
            setNewGoalVersion("");
            load(); // 刷新看板
            setTimeout(() => setShowCreateGoal(false), 1500);
          } else {
            setCreateNote("⚠️ 创建失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setCreateNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setCreating(false);
      };

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
          h("button", { style: { ...S.btn, marginLeft: 8 }, className: "dg-btn", onClick: load }, "刷新"),
          // g-110: 显示已归档目标的 checkbox
          h("label", { style: { display: "flex", alignItems: "center", gap: 4, marginLeft: 12, cursor: "pointer", fontSize: 12, opacity: 0.8 } },
            h("input", {
              type: "checkbox",
              checked: showArchived,
              onChange: (e) => setShowArchived(e.target.checked),
            }),
            "显示已归档"),
          // g-113 临时诊断（灰色低调显示，负责人 2026-08-22 保留）：显示当前解析的 workspace 与会话 id
          h("span", { style: { ...S.meta, color: "rgba(128,128,128,.55)", marginLeft: 8, fontSize: 11 } },
            "DEBUG sessionId=" + (props?.sessionId ?? "∅") + " ws=" + (currentWorkspace() ?? "∅"))),
        // g-108：顶部 supervisor 状态栏（id 由 board 端点下发，未配置则不显示）；
        // g-a92e1406：statusLine 传 supervisor 自己的 status_line（board 下发 supervisorStatus）
        b.supervisorSession
          ? h(SupervisorBar, { id: b.supervisorSession, statusLine: b.supervisorStatus ?? null, statusAt: b.supervisorStatusAt ?? null })
          : null,
        // g-127：折叠时最后一列窄化为 36px
        h("div", { style: { ...S.grid, gridTemplateColumns: blockedColumnCollapsed
            ? "130px repeat(5, minmax(150px, 1fr)) 36px"
            : "130px repeat(6, minmax(150px, 1fr))" } },
          h("div", { style: S.stageHead }, "泳道＼阶段"),
          STAGES.map((s) => {
            // g-127：blocked 列头可点击切换折叠/展开
            if (s.key === "blocked") {
              return h("div", {
                key: s.key,
                style: { ...S.stageHead, cursor: "pointer", userSelect: "none" },
                onClick: () => setBlockedColumnCollapsed((p) => !p),
                title: blockedColumnCollapsed ? "点击展开阻塞列" : "点击收起阻塞列",
              }, s.label + (blockedColumnCollapsed ? " ▸" : " ▾"));
            }
            return h("div", { key: s.key, style: S.stageHead }, s.label);
          }),
          ...rows),
        ...releasedRows,
        modalGoal
          ? h(GoalModal, { id: modalGoal, title: modalGoalData?.title, onClose: () => setModalGoal(null), goalStatus, supervisorSession: b.supervisorSession ?? null, onRenamed: () => load(), onArchived: () => load() })
          : null,
        drawerCard
          ? h(CardDrawer, { goalId: drawerCard.goalId, cardId: drawerCard.cardId,
                            onClose: () => setDrawerCard(null) })
          : null,
        // g-129: 新建目标弹窗
        showCreateGoal
          ? h("div", { style: S.overlay, onClick: () => setShowCreateGoal(false) },
              h("div", { style: S.modal, onClick: (e) => e.stopPropagation() },
                h("span", { style: S.close, onClick: () => setShowCreateGoal(false) }, "✕"),
                h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 12 } }, "＋ 新建目标"),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, "标题 *"),
                  h("input", {
                    style: { ...S.promptInput, width: "100%" },
                    value: newGoalTitle,
                    placeholder: "输入目标标题…",
                    onChange: (e) => setNewGoalTitle(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") createGoal(); },
                  })),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, "正文（可选）"),
                  h("textarea", {
                    style: { ...S.promptInput, width: "100%", minHeight: 64, resize: "vertical" },
                    value: newGoalDesc,
                    placeholder: "目标描述（可选）…",
                    onChange: (e) => setNewGoalDesc(e.target.value),
                  })),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, "版本（可选）"),
                  h("select", {
                    style: { ...S.promptInput, width: "100%" },
                    value: newGoalVersion,
                    onChange: (e) => setNewGoalVersion(e.target.value),
                  },
                    h("option", { value: "", style: { background: "#2a2b31", color: "#e6e6e6" } }, "backlog（默认）"),
                    h("option", { value: "standalone", style: { background: "#2a2b31", color: "#e6e6e6" } }, "独立目标"),
                    // 版本选项来自 board 数据的 versions 列表
                    ...b.versions.map((v) => h("option", { key: v.slug, value: v.slug, style: { background: "#2a2b31", color: "#e6e6e6" } }, v.slug)))),
                h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                  h("button", {
                    style: { ...S.btn, padding: "6px 16px", fontSize: 13 },
                    className: "dg-btn",
                    disabled: creating,
                    onClick: createGoal,
                  }, creating ? "创建中…" : "创建"),
                  h("button", {
                    style: { ...S.btn, padding: "6px 12px", fontSize: 12 },
                    className: "dg-btn",
                    onClick: () => setShowCreateGoal(false),
                  }, "取消")),
                createNote ? h("div", { style: { ...S.meta, marginTop: 8 } }, createNote) : null))
          : null,
        // g-77647351：回退询问理由弹窗
        backwardPrompt
          ? h(BackwardReasonPrompt, {
              key: "backward-prompt",
              goalId: backwardPrompt.goalId,
              toStatus: backwardPrompt.toStatus,
              hasChild: backwardPrompt.hasChild,
              childId: backwardPrompt.childId,
              parentId: backwardPrompt.parentId,
              onConfirm: (reason) => {
                commitCrossColumnDrag(backwardPrompt.goalId, backwardPrompt.toStatus, reason || undefined);
                setBackwardPrompt(null);
              },
              onCancel: () => setBackwardPrompt(null),
            })
          : null,
        // g-77647351：进执行列确认弹窗
        inProgressPrompt
          ? h(InProgressPrompt, {
              key: "in-progress-prompt",
              goalId: inProgressPrompt.goalId,
              goalData: allGoals.find((g) => g.id === inProgressPrompt.goalId) ?? null,
              supervisorSession: b.supervisorSession ?? null,
              onConfirm: () => { setInProgressPrompt(null); load(); },
              onCancel: () => setInProgressPrompt(null),
            })
          : null,
        // g-77647351：交付确认弹窗
        deliverPrompt
          ? h(DeliverPrompt, {
              key: "deliver-prompt",
              goalId: deliverPrompt.goalId,
              goalTitle: deliverPrompt.goalTitle,
              supervisorSession: b.supervisorSession ?? null,
              onConfirm: () => {
                setDeliverPrompt(null);
                commitCrossColumnDrag(deliverPrompt.goalId, deliverPrompt.toStatus);
              },
              onCancel: () => setDeliverPrompt(null),
            })
          : null,
      );
    }
