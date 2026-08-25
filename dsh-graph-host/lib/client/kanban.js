      const [modalGoal, setModalGoal] = React.useState(null);
      const [polishGoal, setPolishGoal] = React.useState(null); // g-168：PM 润色中的看板目标
      const [drawerCard, setDrawerCard] = React.useState(null); // {goalId, cardId}
      const [openReleased, setOpenReleased] = React.useState({});
      // g-125：delivered/blocked 卡片展开完整视图的开关（默认折叠精简）
      const [expandedGoals, setExpandedGoals] = React.useState({});
      // g-129: 新建目标弹窗状态
      const [showCreateGoal, setShowCreateGoal] = React.useState(false);
      const [newGoalTitle, setNewGoalTitle] = React.useState("");
      const [newGoalVersion, setNewGoalVersion] = React.useState("");
      const [newGoalDesc, setNewGoalDesc] = React.useState("");
      const [newGoalType, setNewGoalType] = React.useState("task"); // g-158
      // g-159: 记录打开弹窗时的入口版本；null 表示普通入口，需按当前 active 默认值重置
      const [createGoalEntryVersion, setCreateGoalEntryVersion] = React.useState(null);
      const [createGoalInitialized, setCreateGoalInitialized] = React.useState(false);
      const [createNote, setCreateNote] = React.useState(null);
      const [creating, setCreating] = React.useState(false);
      // g-110: 显示已归档目标的开关
      const [showArchived, setShowArchived] = React.useState(false);
      // g-134: 版本泳道管理状态
      const [showCreateVersion, setShowCreateVersion] = React.useState(false);
      const [newVersionSlug, setNewVersionSlug] = React.useState("");
      const [newVersionName, setNewVersionName] = React.useState("");
      const [createVersionNote, setCreateVersionNote] = React.useState(null);
      const [creatingVersion, setCreatingVersion] = React.useState(false);
      // g-134: 看板渲染 key，用于强制重绘
      const [kanbanRenderKey, setKanbanRenderKey] = React.useState(0);
      const [renameVersionTarget, setRenameVersionTarget] = React.useState(null); // {slug, name}
      const [renameVersionSlug, setRenameVersionSlug] = React.useState("");
      const [renameVersionName, setRenameVersionName] = React.useState("");
      const [renameVersionNote, setRenameVersionNote] = React.useState(null);
      const [renamingVersion, setRenamingVersion] = React.useState(false);
      const [deleteVersionTarget, setDeleteVersionTarget] = React.useState(null); // {slug, name}
      const [deleteVersionNote, setDeleteVersionNote] = React.useState(null);
      const [deletingVersion, setDeletingVersion] = React.useState(false);
      // g-134: 版本详情弹窗状态
      const [versionDetailTarget, setVersionDetailTarget] = React.useState(null); // {slug, name, status, goals_count}
      // g-135: 版本详情弹窗扩展状态（摘要/范围/阻塞清单/操作结果）
      const [versionDetailData, setVersionDetailData] = React.useState(null); // fetched detail
      const [versionDetailLoading, setVersionDetailLoading] = React.useState(false);
      const [versionActionNote, setVersionActionNote] = React.useState(null);
      const [versionActionLoading, setVersionActionLoading] = React.useState(false);
      // g-127: 阻塞列默认折叠（竖向窄条汇总，点击展开）
      const [blockedColumnCollapsed, setBlockedColumnCollapsed] = React.useState(true);
      // g-156: 交付列默认展开（首次打开及刷新默认展开，折叠状态只在当前页面/会话生效）
      const [deliverColumnCollapsed, setDeliverColumnCollapsed] = React.useState(false);
      // g-162: 泳道折叠状态（active 版本泳道、独立目标泳道、backlog 泳道独立折叠，默认展开；只在当前页面生效）
      const [collapsedLanes, setCollapsedLanes] = React.useState({});
      // g-77647351：拖拽状态机
      const [drag, setDrag] = React.useState(null); // {goalId, fromStatus, overGoalId, overStageKey, overHalf, laneKey}
      const dropCommitted = React.useRef(false);
      // g-173：看板根节点 ref——自动滚动 effect 从它向上找真实垂直滚动容器
      //（比 querySelector('[style*="padding: 12px"]') 更精确：不会误命中页面其它内联 padding 元素）
      const boardRootRef = React.useRef(null);
      const [orderMap, setOrderMap] = React.useState({}); // {laneKey: {stageKey: goalId[]}}
      const [transitionNote, setTransitionNote] = React.useState(null);
      // g-132：右上角齿轮 → 看板设置弹窗
      const [showSettings, setShowSettings] = React.useState(false);
      // g-171：更新强调动画状态——goalId -> { remaining, token }（token = goalId:updated_at）
      const [updateEmphasis, setUpdateEmphasis] = React.useState({});
      const seenUpdateTokens = React.useRef(new Set()); // 当前页内存：防同一 token 重复播放
      const emphasisTimers = React.useRef({}); // goalId -> timer id
      // g-171：卸载时清理强调动画计时器
      React.useEffect(() => () => {
        for (const t of Object.values(emphasisTimers.current)) clearTimeout(t);
        emphasisTimers.current = {};
      }, []);

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

      // g-157：拖动自动滚动——指针靠近视口顶部/底部时自动滚动页面
      React.useEffect(() => {
        if (!drag) return;

        // 从看板根节点向上查找真正的垂直滚动容器；不要依赖 React style 的属性名格式。
        // g-173：锚定 boardRootRef（精确命中本看板根），不再用全局 querySelector 猜
        //「第一个 padding:12px 元素」——3082 页面里那可能不是看板根，导致回退到
        // documentElement（dsh app frame overflow:hidden，scrollTop 永远无效）。
        function findScrollContainer() {
          let el = boardRootRef.current;
          if (!el) el = document.querySelector('[style*="padding: 12px"]');
          while (el && el !== document.documentElement) {
            const style = window.getComputedStyle(el);
            if ((style.overflowY === "auto" || style.overflowY === "scroll") &&
                el.scrollHeight > el.clientHeight) return el;
            el = el.parentElement;
          }
          return document.scrollingElement || document.documentElement;
        }

        const scrollContainer = findScrollContainer();
        const THRESHOLD = 80; // 视口顶部/底部触发区域（px）
        const MAX_SPEED = 20; // 最大滚动速度（px/帧）
        let pointerY = 0;
        let pointerKnown = false;
        let rafId = null;
        let active = true;

        // 使用捕获阶段，确保拖过卡片/泳道时仍能收到原生 dragover。
        function handleDragOver(e) {
          pointerY = e.clientY;
          pointerKnown = Number.isFinite(pointerY) && pointerY >= 0 && pointerY <= window.innerHeight;
        }
        function handleDragLeave(e) {
          if (!e.relatedTarget || e.clientY < 0 || e.clientY > window.innerHeight) pointerKnown = false;
        }

        function autoScroll() {
          if (!active) return;
          if (pointerKnown) {
            const scrollTop = scrollContainer.scrollTop;
            const maxScroll = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
            const fromTop = pointerY;
            const fromBottom = window.innerHeight - pointerY;
            let delta = 0;
            if (fromTop < THRESHOLD && scrollTop > 0) {
              delta = -Math.ceil(MAX_SPEED * (1 - fromTop / THRESHOLD));
            } else if (fromBottom < THRESHOLD && scrollTop < maxScroll) {
              delta = Math.ceil(MAX_SPEED * (1 - fromBottom / THRESHOLD));
            }
            if (delta) scrollContainer.scrollTop = Math.max(0, Math.min(maxScroll, scrollTop + delta));
          }
          rafId = requestAnimationFrame(autoScroll);
        }

        window.addEventListener("dragover", handleDragOver, true);
        window.addEventListener("dragleave", handleDragLeave, true);
        rafId = requestAnimationFrame(autoScroll);

        return () => {
          active = false;
          window.removeEventListener("dragover", handleDragOver, true);
          window.removeEventListener("dragleave", handleDragLeave, true);
          if (rafId !== null) cancelAnimationFrame(rafId);
          rafId = null;
        };
      }, [drag !== null]);

      // g-135：版本详情弹窗打开时自动获取详情数据
      const loadVersionDetail = (slug) => {
        setVersionDetailLoading(true);
        setVersionDetailData(null);
        setVersionActionNote(null);
        setReactivateConfirm(false);
        fetch(graphUrl(`/api/dsh-graph/version-detail?slug=${encodeURIComponent(slug)}`))
          .then((r) => r.json())
          .then((data) => {
            setVersionDetailLoading(false);
            if (data.ok) setVersionDetailData(data);
            else setVersionActionNote("⚠️ 加载失败：" + (data.error || "未知错误"));
          })
          .catch((e) => {
            setVersionDetailLoading(false);
            setVersionActionNote("⚠️ 请求失败：" + String(e?.message ?? e));
          });
      };
      // g-160：恢复 released 版本为 active 的状态
      const [reactivatingVersion, setReactivatingVersion] = React.useState(false);
      const [reactivateConfirm, setReactivateConfirm] = React.useState(false);

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
      // g-171：更新强调动画——服务端 generated_at - updated_at 判定 10 秒窗口，
      // 按 goalId+updated_at 防当前页重复播放；整页刷新可对窗口内目标补播。
      // 只复用现有 load()（首次/手动刷新/写操作后）与 15 秒轮询，不新增任何数据通道。
      const applyUpdateEmphasis = (data) => {
        if (!data || typeof data.generated_at !== "string") return;
        const gen = Date.parse(data.generated_at);
        if (!Number.isFinite(gen)) return;
        const allGoals = [
          ...(data.versions ?? []).flatMap((v) => v.goals ?? []),
          ...(data.standalone ?? []),
          ...(data.backlog ?? []),
        ];
        for (const g of allGoals) {
          const ts = g.updated_at;
          // 旧 payload 无 updated_at → 无动画，兼容渲染
          if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
          const age = gen - ts; // 服务端时间窗口（毫秒）
          if (age < 0 || age >= 10000) continue; // 未来/已过 10 秒 → 不播放
          const token = g.id + ":" + ts;
          if (seenUpdateTokens.current.has(token)) continue; // 同一 token 不重播
          seenUpdateTokens.current.add(token);
          const remaining = Math.max(0, 10000 - age);
          setUpdateEmphasis((prev) => ({ ...prev, [g.id]: { remaining, token } }));
          if (emphasisTimers.current[g.id]) clearTimeout(emphasisTimers.current[g.id]);
          emphasisTimers.current[g.id] = setTimeout(() => {
            setUpdateEmphasis((prev) => {
              if (!prev[g.id] || prev[g.id].token !== token) return prev;
              const next = { ...prev };
              delete next[g.id];
              return next;
            });
            delete emphasisTimers.current[g.id];
          }, remaining + 100);
        }
      };
      const load = () => {
        const params = showArchived ? "?includeArchived=1" : "";
        fetch(graphUrl("/api/dsh-graph" + params))
          .then((r) => r.json())
          .then((data) => { setState({ loading: false, data }); loadOrder(); applyUpdateEmphasis(data); })
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
      // g-129/g-159: 打开新建目标弹窗；普通入口预选最新 active，泳道入口固定预选目标版本
      const openCreateGoal = (version) => {
        const entryVersion = version ?? null;
        // 关闭后重开仍保留未提交草稿；只有成功创建后才开始新一轮初始化。
        if (!createGoalInitialized) {
          const latestActive = [...b.versions].filter((v) => v.status === "active").at(-1)?.slug ?? "";
          setCreateGoalEntryVersion(entryVersion);
          setNewGoalVersion(entryVersion ?? latestActive);
          setCreateGoalInitialized(true);
        }
        setShowCreateGoal(true);
        setCreateNote(null);
      };
      // g-77647351：泳道渲染（带拖放支持，跨 lane 拖放改归属）；g-129 版本 lane 标题「＋」预选版本
      // g-137：laneIndex 用于交替背景色；g-162：阶段列横向交替深浅
      const lane = (label, goals, key, version, laneIndex = 0, collapsible = true) => {
        // g-162: 普通泳道折叠状态；released 仅复用 lane 布局，不增加折叠入口
        const isCollapsed = collapsible && !!collapsedLanes[key];
        // g-162: 统一基础背景层级（active 与 released 相同），阶段列横向轻微交替
        const baseBg = "rgba(255,255,255,.03)";
        const stageBg = (stageIdx) => stageIdx % 2 === 0 ? "rgba(255,255,255,.03)" : "rgba(0,0,0,.03)";
        // g-162: 折叠态——显示摘要行
        if (isCollapsed) {
          return [
            h("div", {
              key: key + "-label",
              style: {
                ...S.laneLabel,
                 paddingRight: 40,
                position: "relative",
                background: baseBg,
                cursor: "pointer",
              },
              title: "点击展开泳道",
              onClick: (e) => {
                e.stopPropagation();
                setCollapsedLanes((prev) => ({ ...prev, [key]: false }));
              },
            },
              h("span", null, "▸ ", label, ` · ${goals.length} 目标`),
              h("button", {
                style: { ...S.btn, position: "absolute", right: 6, top: 8, bottom: "auto", fontSize: 11, padding: "0 5px", lineHeight: 1.4 },
                className: "dg-btn",
                title: version ? `在 ${version} 新建目标` : (key === "standalone" ? "新建独立目标" : "新建目标（backlog）"),
                onClick: (e) => {
                  e.stopPropagation();
                  openCreateGoal(key === "standalone" ? "standalone" : version);
                },
              }, "＋")),
            h("div", {
              key: key + "-collapsed-summary",
              style: { gridColumn: "2 / -1", ...S.cell, background: baseBg, padding: "6px 8px", cursor: "pointer", userSelect: "none" },
              title: "点击展开泳道",
              onClick: () => setCollapsedLanes((prev) => ({ ...prev, [key]: false })),
            }, `▸ ${goals.length} 目标 · 点击展开`),
          ];
        }
        // 展开态：正常渲染各阶段列
        const cells = STAGES.map((s, sIdx) => {
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
          // g-162: 阶段列横向交替深浅背景
          const laneBg = stageBg(sIdx);
          // g-127：阻塞列折叠态——竖条汇总替代卡片列表
          if (s.key === "blocked" && blockedColumnCollapsed) {
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
              ? h(React.Fragment, null, "阻", h("br"), "塞", h("br"), `×${orderedGoals.length}`, h("br"), duration)
              : h(React.Fragment, null, "阻", h("br"), "塞", h("br"), `×${orderedGoals.length}`);
            return h("div", {
              key: key + "-" + s.key, // 使用 lane key + stage key 作为唯一 key
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
                if (!e.target.closest?.(".dg-card")) {
                  setDrag((d) => d ? { ...d, overGoalId: null, overStageKey: s.key, overLaneKey: key, overHalf: "after" } : d);
                }
              } : undefined,
              onDrop: anyDrag ? (e) => {
                e.preventDefault();
                if (!e.target.closest?.(".dg-card")) {
                  commitGoalDrag({ ...drag, overGoalId: null, overStageKey: s.key, overLaneKey: key, overHalf: "after" }, null);
                }
              } : undefined,
            }, summaryText);
          }
          // g-156: 交付列折叠态——竖条汇总替代卡片列表
          if (s.key === "deliver" && deliverColumnCollapsed) {
            const count = orderedGoals.length;
            return h("div", {
              key: key + "-" + s.key,
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
              className: "dg-deliver-collapsed" + (isOverThisCell && !orderedGoals.some((g) => g.id === drag.goalId) ? " dg-cell-drop-active" : ""),
              onClick: (e) => { e.stopPropagation(); setDeliverColumnCollapsed(false); },
              title: `点击展开交付列（${count} 项）`,
              onDragOver: anyDrag ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (!e.target.closest?.(".dg-card")) {
                  setDrag((d) => d ? { ...d, overGoalId: null, overStageKey: s.key, overLaneKey: key, overHalf: "after" } : d);
                }
              } : undefined,
              onDrop: anyDrag ? (e) => {
                e.preventDefault();
                if (!e.target.closest?.(".dg-card")) {
                  commitGoalDrag({ ...drag, overGoalId: null, overStageKey: s.key, overLaneKey: key, overHalf: "after" }, null);
                }
              } : undefined,
            }, h(React.Fragment, null, "交", h("br"), "付", h("br"), `×${count}`));
          }
          return h("div", {
            key: key + "-" + s.key, // 使用 lane key + stage key 作为唯一 key
            style: { ...S.cell, background: isOverThisCell ? "rgba(76,141,255,.10)" : laneBg },
            className: isOverThisCell && !orderedGoals.some((g) => g.id === drag.goalId) ? "dg-cell-drop-active" : "",
            onDragOver: anyDrag ? (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              // 列空白区域：容器及其非卡片子元素触发，避免覆盖卡片落点
              if (!e.target.closest?.(".dg-card")) {
                // g-137：backlog 卡拖到版本 lane 时，overStageKey 固定为 "describe"
                const effectiveStageKey = (isFromBacklog && isOverThisLane) ? "describe" : s.key;
                setDrag((d) => d ? { ...d, overGoalId: null, overStageKey: effectiveStageKey, overLaneKey: key, overHalf: "after" } : d);
              }
            } : undefined,
            onDrop: anyDrag ? (e) => {
              e.preventDefault();
              if (!e.target.closest?.(".dg-card")) {
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
              return Card({ ...g, _polishActive: polishGoal === g.id, _updateEmphasis: updateEmphasis[g.id] ?? null }, setModalGoal, (goalId, cardId) => setDrawerCard({ goalId, cardId }),
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
        // g-162: 统一基础背景层级
        const labelBg = baseBg;
        const labelEl = h("div", {
          key: key + "-label",
          style: {
            ...S.laneLabel,
                 paddingRight: 40,
            position: "relative",
            background: labelBg,
            cursor: version ? "pointer" : "default",
          },
          className: version ? "dg-version-label" : "",
          title: version ? `点击查看版本 ${version} 详情` : undefined,
          onClick: version ? (e) => {
            e.stopPropagation();
            const v = b.versions.find((ver) => ver.slug === version);
            if (v) {
              setVersionDetailTarget({
                slug: v.slug,
                name: v.name,
                status: v.status,
                goals_count: v.goals.length,
              });
              // g-135: 自动加载版本详情数据（摘要/范围/阻塞清单）
              loadVersionDetail(v.slug);
            }
          } : undefined,
        },
          label,
          // g-129: 每个 lane 标题右下角加「+」按钮（版本 lane 预选版本，独立/backlog 进 backlog）
          h("button", {
            style: { ...S.btn, position: "absolute", right: 6, top: 8, bottom: "auto", fontSize: 11, padding: "0 5px", lineHeight: 1.4 },
            className: "dg-btn",
            title: key === "standalone" ? "新建独立目标" : (version ? `在 ${version} 新建目标` : "新建目标（backlog）"),
            onClick: (e) => {
              e.stopPropagation();
              openCreateGoal(key === "standalone" ? "standalone" : version);
            },
          }, "＋"),

           collapsible ? h("button", {
             className: "dg-lane-collapse",
             title: "折叠泳道",
             "aria-label": "折叠泳道",
             onClick: (e) => {
               e.stopPropagation();
               setCollapsedLanes((prev) => ({ ...prev, [key]: true }));
             },
           }, h("span", { className: "dg-lane-collapse-triangle" })) : null);
        return [labelEl, ...cells];
      };

      // g-137：backlog 行平铺展示函数；g-162: 支持独立折叠
      const backlogRow = (label, goals, key) => {
        // g-162: backlog 泳道折叠状态
        const isCollapsed = !!collapsedLanes[key];
        const backlogBg = "rgba(0,0,0,.12)";
        // g-162: 折叠态——显示摘要行
        if (isCollapsed) {
          return [
            h("div", {
              key: key + "-label",
              style: { ...S.laneLabel, paddingRight: 40, position: "relative", background: backlogBg, cursor: "pointer" },
              title: "点击展开泳道",
              onClick: (e) => {
                e.stopPropagation();
                setCollapsedLanes((prev) => ({ ...prev, [key]: false }));
              },
            },
              h("span", null, "▸ ", label, ` · ${goals.length} 目标`),
              h("button", {
                style: { ...S.btn, position: "absolute", right: 6, top: 8, bottom: "auto", fontSize: 11, padding: "0 5px", lineHeight: 1.4 },
                className: "dg-btn",
                title: "新建目标（backlog）",
                onClick: (e) => {
                  e.stopPropagation();
                  openCreateGoal(null);
                },
              }, "＋")),
            h("div", {
              key: key + "-collapsed-summary",
              style: { gridColumn: "2 / -1", ...S.cell, background: backlogBg, padding: "6px 8px", cursor: "pointer", userSelect: "none" },
              title: "点击展开泳道",
              onClick: () => setCollapsedLanes((prev) => ({ ...prev, [key]: false })),
            }, `▸ ${goals.length} 目标 · 点击展开`),
          ];
        }
        // 展开态：正常渲染
        const isOverThisCell = drag && drag.overLaneKey === key;
        const labelEl = h("div", { key: key + "-label", style: { ...S.laneLabel, paddingRight: 40, position: "relative", background: backlogBg } },
          label,
          // g-162: 泳道折叠按钮
          h("button", {
            style: { position: "absolute", left: "50%", right: "auto", bottom: 2 },
            className: "dg-lane-collapse",
            title: "折叠泳道",
            "aria-label": "折叠泳道",
            onClick: (e) => {
              e.stopPropagation();
              setCollapsedLanes((prev) => ({ ...prev, [key]: true }));
            },
          }, h("span", { className: "dg-lane-collapse-triangle" })),
          h("button", {
            style: { ...S.btn, position: "absolute", right: 6, top: 8, bottom: "auto", fontSize: 11, padding: "0 5px", lineHeight: 1.4 },
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
            if (!e.target?.closest?.(".dg-card")) {
              setDrag((d) => d ? { ...d, overGoalId: null, overStageKey: "describe", overLaneKey: key, overHalf: "after" } : d);
            }
          } : undefined,
          onDrop: drag ? (e) => {
            e.preventDefault();
            if (!e.target?.closest?.(".dg-card")) {
              commitGoalDrag({ ...drag, overGoalId: null, overStageKey: "describe", overLaneKey: key, overHalf: "after" }, null);
            }
          } : undefined,
        },
          h("div", { className: "dg-backlog-flat" },
            orderedGoals.map((g) => {
              const defExpanded = g.status !== "delivered" && g.status !== "blocked";
              const expanded = expandedGoals[g.id] ?? defExpanded;
              const isDragTarget = isOverThisCell && drag?.overGoalId === g.id;
              return Card({ ...g, _polishActive: polishGoal === g.id, _updateEmphasis: updateEmphasis[g.id] ?? null }, setModalGoal, (goalId, cardId) => setDrawerCard({ goalId, cardId }),
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

      // g-164：动态列模板——按当前交付/阻塞折叠状态计算列宽，供顶部表头网格与 released 泳道网格共用。
      // 保证 released 泳道展开后与 active/version 泳道左侧标题宽/阶段列宽/列顺序完全一致；
      // 折叠列保留窄栏 36px，普通阶段列保持既有的 minmax(150px, 1fr) 宽。
      // STAGES 顺序: describe, collect, execute, confirm, deliver, blocked
      const gridCols = ["130px",
        "minmax(150px, 1fr)",  // describe
        "minmax(150px, 1fr)",  // collect
        "minmax(150px, 1fr)",  // execute
        "minmax(150px, 1fr)",  // confirm
        deliverColumnCollapsed ? "36px" : "minmax(150px, 1fr)",  // deliver
        blockedColumnCollapsed ? "36px" : "minmax(150px, 1fr)",  // blocked
      ].join(" ");

      const rows = [];
      let laneIndex = 0;
      for (const v of active) {
        rows.push(...lane(`🏷️ ${v.name}`, v.goals, "v-" + v.slug, v.slug, laneIndex));
        laneIndex++;
      }
      rows.push(...lane("独立目标", b.standalone, "standalone", null, laneIndex));
      laneIndex++;
      rows.push(...backlogRow("backlog", b.backlog, "backlog"));

      const releasedRows = released.map((v, idx) => {
        const open = !!openReleased[v.slug];
        return [
          h("div", {
            key: "rel-" + v.slug, style: { ...S.collapsed, cursor: "pointer" }, className: "dg-collapsed",
            title: "点击展开/收起；点击版本名称打开详情",
            onClick: () => { setOpenReleased({ ...openReleased, [v.slug]: !open }); },
          },
            h("span", {
              style: { cursor: "pointer" },
              onClick: (e) => { e.stopPropagation(); setOpenReleased({ ...openReleased, [v.slug]: !open }); },
            }, `${open ? "▾" : "▸"}`),
            " ",
            h("span", {
              style: { cursor: "pointer", textDecoration: "underline dotted" },
              onClick: (e) => {
                e.stopPropagation();
                setVersionDetailTarget({ slug: v.slug, name: v.name, status: v.status, goals_count: v.goals.length });
                loadVersionDetail(v.slug);
              },
              title: "打开版本详情",
            }, `${v.name}`),
            ` ✅ ${v.goals.length} 目标全部交付 · released · ${v.slug}`
          ),
          open ? h("div", { key: "relx-" + v.slug, style: { ...S.grid, gridTemplateColumns: gridCols } },
            ...lane(v.name, v.goals, "rellane-" + v.slug, null, laneIndex + idx, false)) : null,
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
          // g-158：新建目标类型透传（默认 task）
          body.type = normalizeGoalType(newGoalType);
          const r = await fetch(graphUrl("/api/dsh-graph/create-goal"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            setCreateNote("✅ 已创建目标：" + data.goal);
            setNewGoalTitle("");
            setNewGoalDesc("");
            setNewGoalType("task"); // g-158 重置为新目标默认类型
            const latestActive = [...b.versions].filter((v) => v.status === "active").at(-1)?.slug ?? "";
            setNewGoalVersion(createGoalEntryVersion ?? latestActive);
            setCreateGoalInitialized(false);
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

      // g-134: 创建版本泳道
      const createVersionFn = async () => {
        const s = newVersionSlug.trim();
        if (!s) { setCreateVersionNote("⚠️ 请输入版本 slug"); return; }
        setCreatingVersion(true);
        setCreateVersionNote("创建中…");
        try {
          const body = { slug: s };
          if (newVersionName.trim()) body.name = newVersionName.trim();
          const r = await fetch(graphUrl("/api/dsh-graph/create-version"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            setCreateVersionNote("✅ 已创建版本：" + data.slug);
            setNewVersionSlug("");
            setNewVersionName("");
            load(); // 刷新看板
            setTimeout(() => setShowCreateVersion(false), 1500);
          } else {
            setCreateVersionNote("⚠️ 创建失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setCreateVersionNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setCreatingVersion(false);
      };

      // g-134: 重命名版本泳道
      const renameVersionFn = async () => {
        if (!renameVersionTarget) return;
        const newSlug = renameVersionSlug.trim();
        const newName = renameVersionName.trim();
        if (!newSlug && !newName) { setRenameVersionNote("⚠️ 请输入新 slug 或新名称"); return; }
        setRenamingVersion(true);
        setRenameVersionNote("重命名中…");
        try {
          const body = { slug: renameVersionTarget.slug };
          if (newSlug) body.newSlug = newSlug;
          if (newName) body.newName = newName;
          const r = await fetch(graphUrl("/api/dsh-graph/rename-version"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            setRenameVersionNote("✅ 已重命名版本");
            setRenameVersionTarget(null);
            setRenameVersionSlug("");
            setRenameVersionName("");
            setVersionDetailTarget(null); // 清理版本详情弹窗状态
            load(); // 刷新看板数据
            setKanbanRenderKey((k) => k + 1); // 强制重绘看板
            setTimeout(() => setRenameVersionNote(null), 1500);
          } else {
            setRenameVersionNote("⚠️ 重命名失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setRenameVersionNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setRenamingVersion(false);
      };

      // g-134: 删除版本泳道
      const deleteVersionFn = async () => {
        if (!deleteVersionTarget) return;
        setDeletingVersion(true);
        setDeleteVersionNote("删除中…");
        try {
          const body = { slug: deleteVersionTarget.slug };
          const r = await fetch(graphUrl("/api/dsh-graph/delete-version"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            setDeleteVersionNote("✅ 已删除版本：" + data.slug);
            setDeleteVersionTarget(null);
            setVersionDetailTarget(null); // 清理版本详情弹窗状态
            load(); // 刷新看板数据
            setKanbanRenderKey((k) => k + 1); // 强制重绘看板
            setTimeout(() => setDeleteVersionNote(null), 1500);
          } else {
            setDeleteVersionNote("⚠️ 删除失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setDeleteVersionNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setDeletingVersion(false);
      };

      const modalGoalData = modalGoal
        ? [...active.flatMap((v) => v.goals), ...released.flatMap((v) => v.goals),
           ...b.standalone, ...b.backlog].find((g) => g.id === modalGoal)
        : null;

      return h(
        "div",
        { key: "kanban-" + kanbanRenderKey, ref: boardRootRef, style: S.wrap,
           onDragLeave: drag ? (e) => {
             // 进入子元素不清除；离开整个看板内容（如进入页面顶部/底部边缘、
             // header/composer 等视口触发区）时只清除悬停落点，不结束整个拖拽——
             // g-173：结束 drag 会让 g-157 自动滚动 effect 立即卸载，边缘自动滚动失效；
             // 保持 drag 存活，回到看板时由单元格 onDragOver 重新建立落点，
             // 真正的清理仍由 dragend/drop/取消（原生事件）路径完成。
             if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) {
               setDrag((d) => (d ? { ...d, overGoalId: null, overStageKey: null, overLaneKey: null, overHalf: null } : d));
             }
           } : undefined },
        h("style", null, HOVER_CSS),
        h("div", { style: S.head },
          h("strong", null, "dsh-graph 看板"),
          // g-174：标题栏显示插件版本，点击以新标签打开插件官网
          h("a", {
            href: "https://github.com/miuzel/dsh-graph",
            target: "_blank",
            rel: "noreferrer",
            title: "dsh-graph 插件官网",
            style: { ...S.meta, color: "#8ab4ff", cursor: "pointer", textDecoration: "underline" },
          }, "version: " + PLUGIN_VERSION),
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
          // g-132: 右上角齿轮 → 看板设置（负责人 2026-08-25 review：置于 DEBUG 信息之前，即 DEBUG 左侧）
          h("button", {
            style: { ...S.btn, marginLeft: 8, fontSize: 16, lineHeight: 1, padding: "2px 8px" },
            className: "dg-btn",
            title: "看板设置（编辑 .dsh-graph/project.yaml 安全配置）",
            onClick: () => setShowSettings(true),
          }, "⚙"),
          // g-113 临时诊断（灰色低调显示，负责人 2026-08-22 保留）：显示当前解析的 workspace 与会话 id
          h("span", { style: { ...S.meta, color: "rgba(128,128,128,.55)", marginLeft: 8, fontSize: 11 } },
            "DEBUG sessionId=" + (props?.sessionId ?? "∅") + " ws=" + (currentWorkspace() ?? "∅"))),
        // g-108：顶部 supervisor 状态栏（id 由 board 端点下发，未配置则不显示）；
        // g-a92e1406：statusLine 传 supervisor 自己的 status_line（board 下发 supervisorStatus）
        b.supervisorSession
          ? h(SupervisorBar, { id: b.supervisorSession, statusLine: b.supervisorStatus ?? null, statusAt: b.supervisorStatusAt ?? null })
          : null,
        // g-127/g-156/g-164：折叠时对应列窄化为 36px（blocked 和 deliver 独立折叠），
        // 列模板统一由 gridCols 按当前折叠状态动态计算，与 released 泳道网格保持一致
        h("div", { style: { ...S.grid, gridTemplateColumns: gridCols } },
          // g-174：新建版本入口从标题栏移至看板左上角（原「泳道＼阶段」单元格），复用 g-134 状态与弹窗逻辑
          h("div", { style: S.stageHead },
            h("button", {
              style: { ...S.btn, fontSize: 12, padding: "2px 8px" },
              className: "dg-btn",
              title: "新建版本泳道",
              onClick: () => {
                setShowCreateVersion(true);
                setNewVersionSlug("");
                setNewVersionName("");
                setCreateVersionNote(null);
              },
            }, "＋ 新建版本")),
          STAGES.map((s) => {
            // g-127：blocked 列头可点击切换折叠/展开
            // g-152：折叠态列头只显示 ▸（36px 窄条，竖条单元格已有 ⛔ 标识）
            if (s.key === "blocked") {
              return h("div", {
                key: s.key,
                style: { ...S.stageHead, cursor: "pointer", userSelect: "none",
                  ...(blockedColumnCollapsed ? { minWidth: 0, padding: "4px 0", overflow: "hidden", fontSize: 14, boxSizing: "border-box", textAlign: "center" } : {}),
                },
                onClick: () => setBlockedColumnCollapsed((p) => !p),
                title: blockedColumnCollapsed ? "点击展开阻塞列" : "点击收起阻塞列",
              }, blockedColumnCollapsed
                ? "▸"
                : s.label + " ▾");
            }
            // g-156：deliver 列头可点击切换折叠/展开（与 blocked 一致的交互）
            if (s.key === "deliver") {
              return h("div", {
                key: s.key,
                style: { ...S.stageHead, cursor: "pointer", userSelect: "none",
                  ...(deliverColumnCollapsed ? { minWidth: 0, padding: "4px 0", overflow: "hidden", fontSize: 14, boxSizing: "border-box", textAlign: "center" } : {}),
                },
                onClick: () => setDeliverColumnCollapsed((p) => !p),
                title: deliverColumnCollapsed ? "点击展开交付列" : "点击收起交付列",
              }, deliverColumnCollapsed
                ? "▸"
                : s.label + " ▾");
            }
            return h("div", { key: s.key, style: S.stageHead }, s.label);
          }),
          ...rows),
        ...releasedRows,
        modalGoal
          ? h(GoalModal, { id: modalGoal, title: modalGoalData?.title, onClose: () => { setModalGoal(null); load(); }, onPmStarted: setPolishGoal, onPmFinished: () => setPolishGoal(null), goalStatus, supervisorSession: b.supervisorSession ?? null, onRenamed: () => load(), onArchived: () => load(), onOpenCard: (goalId, cardId) => setDrawerCard({ goalId, cardId }) })
          : null,
        drawerCard
          ? h(CardDrawer, { goalId: drawerCard.goalId, cardId: drawerCard.cardId,
                            onClose: () => setDrawerCard(null),
                            onDeleted: () => { setDrawerCard(null); load(); } })
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
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, "类型（默认 task）"),
                  h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
                    ...GOAL_TYPES.map((t) =>
                      h("button", {
                        key: t,
                        style: {
                          display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11,
                          padding: "3px 8px", cursor: "pointer", borderRadius: 4,
                          border: "1px solid " + (t === newGoalType ? goalTypeColor(t) : "rgba(128,128,128,.4)"),
                          background: t === newGoalType ? goalTypeColor(t) : "rgba(128,128,128,.1)",
                          color: t === newGoalType ? "#fff" : "inherit",
                          fontWeight: t === newGoalType ? 700 : 400,
                        },
                        className: "dg-btn",
                        title: GOAL_TYPE_LABELS[t],
                        onClick: () => setNewGoalType(t),
                      }, GOAL_TYPE_ABBREV[t], h("span", null, GOAL_TYPE_LABELS[t]))))),
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
        // g-134/g-135: 版本详情弹窗（含摘要/范围/working/released 操作）
        versionDetailTarget
          ? h("div", { style: S.overlay, onClick: () => { setVersionDetailTarget(null); setVersionDetailData(null); } },
              h("div", { style: { ...S.modal, minWidth: 360, maxWidth: 480 }, onClick: (e) => e.stopPropagation() },
                h("span", { style: S.close, onClick: () => { setVersionDetailTarget(null); setVersionDetailData(null); } }, "✕"),
                h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 12 } }, `🏷️ 版本详情：${versionDetailTarget.name}`),
                // 基本信息
                h("div", { style: { marginBottom: 12, fontSize: 13, opacity: 0.8 } },
                  h("div", null, `Slug：${versionDetailTarget.slug}`),
                  h("div", null, `状态：${versionDetailTarget.status === "released" ? "🟢 released" : versionDetailTarget.status === "active" ? "🔵 active（进行中）" : `⚪ ${versionDetailTarget.status}`}`),
                  h("div", null, `目标数量：${versionDetailTarget.goals_count}`),
                ),
                // g-135: 版本摘要/范围（从 version.md 的「范围」小节读取）
                h("div", { style: { marginBottom: 12 } },
                  h("div", { style: { fontWeight: 600, fontSize: 13, marginBottom: 4 } }, "📋 版本摘要 / 主要功能范围"),
                  versionDetailLoading
                    ? h("div", { style: { fontSize: 12, opacity: 0.5 } }, "加载中…")
                    : (versionDetailData?.summary || versionDetailData?.scope)
                      ? h("div", { style: { fontSize: 12, whiteSpace: "pre-wrap", lineHeight: 1.5, padding: "6px 8px", borderRadius: 4, background: "rgba(128,128,128,.08)" } },
                          versionDetailData.summary || versionDetailData.scope)
                      : h("div", { style: { fontSize: 12, opacity: 0.45, fontStyle: "italic" } }, "（版本摘要为空——请在版本 version.md 的「范围」小节补充）"),
                ),
                // g-135: 阻塞目标清单（发布前置条件不满足时展示）
                versionDetailData && versionDetailData.blocking && versionDetailData.blocking.length > 0
                  ? h("div", { style: { marginBottom: 12, padding: "8px 10px", borderRadius: 6, background: "rgba(255,107,107,.12)", border: "1px solid rgba(255,107,107,.3)" } },
                      h("div", { style: { fontWeight: 600, fontSize: 13, marginBottom: 4, color: "#ff6b6b" } }, `⛔ 阻塞目标（${versionDetailData.blocking.length} 个未 delivered）`),
                      ...versionDetailData.blocking.map((g) =>
                        h("div", { key: g.id, style: { fontSize: 12, padding: "2px 0", opacity: 0.85 } },
                          `• ${g.id}（${g.title}）：${g.status}`)
                      ))
                  : null,
                // g-135: 操作提示
                versionActionNote
                  ? h("div", { style: { marginBottom: 8, fontSize: 12, padding: "4px 8px", borderRadius: 4, background: "rgba(128,128,128,.08)" } }, versionActionNote)
                  : null,
                // g-135: working/released 操作按钮 + 重命名/删除
                h("div", { style: { display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" } },
                  // 标记为 working（active）—— 当非 active 时显示
                  versionDetailTarget.status !== "active" && versionDetailTarget.status !== "released"
                    ? h("button", {
                        style: { ...S.btn, padding: "6px 16px", fontSize: 13, background: "rgba(76,141,255,.15)", border: "1px solid rgba(76,141,255,.4)" },
                        className: "dg-btn",
                        disabled: versionActionLoading,
                        onClick: () => {
                          if (!confirm(`确认将版本 ${versionDetailTarget.slug} 标记为 working（进行中）？`)) return;
                          setVersionActionLoading(true);
                          setVersionActionNote(null);
                          fetch(graphUrl("/api/dsh-graph/set-version-status"), {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ slug: versionDetailTarget.slug, status: "active" }),
                          }).then((r) => r.json()).then((data) => {
                            setVersionActionLoading(false);
                            if (data.ok) {
                              setVersionActionNote("✅ 已标记为 working（active）");
                              // g-135 fix #2：同步更新 target 状态，modal 按钮立刻反映
                              setVersionDetailTarget((prev) => prev ? { ...prev, status: "active" } : prev);
                              loadVersionDetail(versionDetailTarget.slug);
                              load(); // 刷新看板
                            } else {
                              setVersionActionNote("⚠️ 操作失败：" + (data.error || "未知错误"));
                            }
                          }).catch((e) => {
                            setVersionActionLoading(false);
                            setVersionActionNote("⚠️ 请求失败：" + String(e?.message ?? e));
                          });
                        },
                      }, "▶ 标记为 working")
                    : null,
                  // active 状态可切换回 planning
                  versionDetailTarget.status === "active"
                    ? h("button", {
                        style: { ...S.btn, padding: "6px 16px", fontSize: 13, opacity: 0.7 },
                        className: "dg-btn",
                        disabled: versionActionLoading,
                        onClick: () => {
                          if (!confirm(`确认将版本 ${versionDetailTarget.slug} 切回 planning？`)) return;
                          setVersionActionLoading(true);
                          setVersionActionNote(null);
                          fetch(graphUrl("/api/dsh-graph/set-version-status"), {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ slug: versionDetailTarget.slug, status: "planning" }),
                          }).then((r) => r.json()).then((data) => {
                            setVersionActionLoading(false);
                            if (data.ok) {
                              setVersionActionNote("✅ 已切回 planning");
                              // g-135 fix #2：同步更新 target 状态
                              setVersionDetailTarget((prev) => prev ? { ...prev, status: "planning" } : prev);
                              loadVersionDetail(versionDetailTarget.slug);
                              load();
                            } else {
                              setVersionActionNote("⚠️ 操作失败：" + (data.error || "未知错误"));
                            }
                          }).catch((e) => {
                            setVersionActionLoading(false);
                            setVersionActionNote("⚠️ 请求失败：" + String(e?.message ?? e));
                          });
                        },
                      }, "↩ 切回 planning")
                    : null,
                  // 标记为 released —— 仅非 released 时显示
                  versionDetailTarget.status !== "released"
                    ? h("button", {
                        style: { ...S.btn, padding: "6px 16px", fontSize: 13, color: "#4caf50", background: "rgba(76,175,80,.12)", border: "1px solid rgba(76,175,80,.4)" },
                        className: "dg-btn",
                        disabled: versionActionLoading,
                        onClick: () => {
                          // 先检查阻塞清单
                          const blocking = versionDetailData?.blocking ?? [];
                          if (blocking.length > 0) {
                            setVersionActionNote(`⛔ 无法发布：仍有 ${blocking.length} 个未 delivered 的目标`);
                            return;
                          }
                          if (!confirm(`确认发布版本 ${versionDetailTarget.slug}？\n\n此操作需要负责人确认，发布后版本状态将变为 released。`)) return;
                          setVersionActionLoading(true);
                          setVersionActionNote(null);
                          fetch(graphUrl("/api/dsh-graph/release-version"), {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ slug: versionDetailTarget.slug }),
                          }).then((r) => r.json()).then((data) => {
                            setVersionActionLoading(false);
                            if (data.ok === true) {
                              setVersionActionNote("✅ 版本已发布为 released");
                              // g-135 fix #2：同步更新 target 状态，modal 按钮立刻反映（不再显示 released 按钮）
                              setVersionDetailTarget((prev) => prev ? { ...prev, status: "released" } : prev);
                              loadVersionDetail(versionDetailTarget.slug);
                              load();
                            } else if (data.ok === false && data.blocking) {
                              setVersionActionNote(`⛔ 无法发布：${data.blocking.length} 个目标未 delivered`);
                              loadVersionDetail(versionDetailTarget.slug); // 刷新阻塞清单
                            } else {
                              setVersionActionNote("⚠️ 发布失败：" + (data.error || "未知错误"));
                            }
                          }).catch((e) => {
                            setVersionActionLoading(false);
                            setVersionActionNote("⚠️ 请求失败：" + String(e?.message ?? e));
                          });
                        },
                      }, "🚀 标记为 released")
                    : null,
                  // g-160: 恢复 released 版本为 active —— 仅 released 时显示
                  versionDetailTarget.status === "released"
                    ? reactivateConfirm
                      ? h("div", { style: { padding: "8px 12px", borderRadius: 6, background: "rgba(255,152,0,.15)", border: "1px solid rgba(255,152,0,.4)", fontSize: 12, lineHeight: 1.5 } },
                          h("div", { style: { fontWeight: 600, marginBottom: 4, color: "#ff9800" } }, "⚠️ 确认恢复版本？"),
                          h("div", { style: { marginBottom: 8, opacity: 0.85 } }, `恢复 ${versionDetailTarget.slug} 将撤销发布状态，使版本重新进入 active（进行中）。已交付的目标不受影响，再次发布仍需满足全部目标 delivered 等校验。`),
                          h("div", { style: { display: "flex", gap: 8 } },
                            h("button", {
                              style: { ...S.btn, padding: "6px 16px", fontSize: 13, color: "#ff9800", background: "rgba(255,152,0,.12)", border: "1px solid rgba(255,152,0,.4)" },
                              className: "dg-btn",
                              disabled: reactivatingVersion,
                              onClick: () => {
                                setReactivatingVersion(true);
                                setVersionActionNote(null);
                                fetch(graphUrl("/api/dsh-graph/set-version-status"), {
                                  method: "POST",
                                  headers: { "content-type": "application/json" },
                                  body: JSON.stringify({ slug: versionDetailTarget.slug, status: "active", confirmed: true }),
                                }).then((r) => r.json()).then((data) => {
                                  setReactivatingVersion(false);
                                  setReactivateConfirm(false);
                                  if (data.ok) {
                                    setVersionActionNote("✅ 版本已恢复为 active");
                                    setVersionDetailTarget((prev) => prev ? { ...prev, status: "active" } : prev);
                                    loadVersionDetail(versionDetailTarget.slug);
                                    load();
                                  } else {
                                    setVersionActionNote("⚠️ 恢复失败：" + (data.error || "未知错误"));
                                  }
                                }).catch((e) => {
                                  setReactivatingVersion(false);
                                  setReactivateConfirm(false);
                                  setVersionActionNote("⚠️ 请求失败：" + String(e?.message ?? e));
                                });
                              },
                            }, "确认恢复为 active"),
                            h("button", {
                              style: { ...S.btn, padding: "6px 16px", fontSize: 13, opacity: 0.7 },
                              className: "dg-btn",
                              disabled: reactivatingVersion,
                              onClick: () => { setReactivateConfirm(false); setVersionActionNote(null); },
                            }, "取消"),
                          )
                        )
                      : h("button", {
                          style: { ...S.btn, padding: "6px 16px", fontSize: 13, color: "#ff9800", background: "rgba(255,152,0,.08)", border: "1px solid rgba(255,152,0,.3)" },
                          className: "dg-btn",
                          disabled: versionActionLoading,
                          onClick: () => { setReactivateConfirm(true); setVersionActionNote(null); },
                        }, "♻️ 恢复为 active")
                    : null,
                  // 重命名
                  h("button", {
                    style: { ...S.btn, padding: "6px 16px", fontSize: 13, opacity: 0.7 },
                    className: "dg-btn",
                    onClick: () => {
                      setRenameVersionTarget({ slug: versionDetailTarget.slug, name: versionDetailTarget.name });
                      setRenameVersionSlug(versionDetailTarget.slug);
                      setRenameVersionName(versionDetailTarget.name);
                      setRenameVersionNote(null);
                      setVersionDetailTarget(null);
                      setVersionDetailData(null);
                    },
                  }, "✏️ 重命名"),
                  // 删除
                  h("button", {
                    style: { ...S.btn, padding: "6px 16px", fontSize: 13, color: "#ff6b6b", opacity: 0.7 },
                    className: "dg-btn",
                    onClick: () => {
                      setDeleteVersionTarget({ slug: versionDetailTarget.slug, name: versionDetailTarget.name });
                      setDeleteVersionNote(null);
                      setVersionDetailTarget(null);
                      setVersionDetailData(null);
                    },
                  }, "🗑️ 删除"),
                ),
              ))
          : null,
        // g-132: 看板设置弹窗（gear 入口）
        showSettings
          ? h(SettingsModal, { onClose: () => setShowSettings(false), onSaved: () => load() })
          : null,
        // g-134: 创建版本泳道弹窗
        showCreateVersion
          ? h("div", { style: S.overlay, onClick: () => setShowCreateVersion(false) },
              h("div", { style: S.modal, onClick: (e) => e.stopPropagation() },
                h("span", { style: S.close, onClick: () => setShowCreateVersion(false) }, "✕"),
                h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 12 } }, "＋ 新建版本泳道"),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, "版本 Slug *"),
                  h("input", {
                    style: { ...S.promptInput, width: "100%" },
                    value: newVersionSlug,
                    placeholder: "如 v0.7（不含路径分隔符）",
                    onChange: (e) => setNewVersionSlug(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") createVersionFn(); },
                  })),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, "显示名称（可选）"),
                  h("input", {
                    style: { ...S.promptInput, width: "100%" },
                    value: newVersionName,
                    placeholder: "默认与 slug 相同",
                    onChange: (e) => setNewVersionName(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") createVersionFn(); },
                  })),
                h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                  h("button", {
                    style: { ...S.btn, padding: "6px 16px", fontSize: 13 },
                    className: "dg-btn",
                    disabled: creatingVersion,
                    onClick: createVersionFn,
                  }, creatingVersion ? "创建中…" : "创建"),
                  h("button", {
                    style: { ...S.btn, padding: "6px 12px", fontSize: 12 },
                    className: "dg-btn",
                    onClick: () => setShowCreateVersion(false),
                  }, "取消")),
                createVersionNote ? h("div", { style: { ...S.meta, marginTop: 8 } }, createVersionNote) : null))
          : null,
        // g-134: 重命名版本泳道弹窗
        renameVersionTarget
          ? h("div", { style: S.overlay, onClick: () => { setRenameVersionTarget(null); setRenameVersionNote(null); } },
              h("div", { style: S.modal, onClick: (e) => e.stopPropagation() },
                h("span", { style: S.close, onClick: () => { setRenameVersionTarget(null); setRenameVersionNote(null); } }, "✕"),
                h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 12 } }, "✏️ 重命名版本泳道"),
                h("div", { style: { marginBottom: 8, fontSize: 13, opacity: 0.8 } }, `当前：${renameVersionTarget.name}（${renameVersionTarget.slug}）`),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, "新 Slug（可选）"),
                  h("input", {
                    style: { ...S.promptInput, width: "100%" },
                    value: renameVersionSlug,
                    placeholder: "留空则保持原 slug",
                    onChange: (e) => setRenameVersionSlug(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") renameVersionFn(); },
                  })),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, "新名称（可选）"),
                  h("input", {
                    style: { ...S.promptInput, width: "100%" },
                    value: renameVersionName,
                    placeholder: "留空则保持原名称",
                    onChange: (e) => setRenameVersionName(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") renameVersionFn(); },
                  })),
                h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                  h("button", {
                    style: { ...S.btn, padding: "6px 16px", fontSize: 13 },
                    className: "dg-btn",
                    disabled: renamingVersion,
                    onClick: renameVersionFn,
                  }, renamingVersion ? "重命名中…" : "重命名"),
                  h("button", {
                    style: { ...S.btn, padding: "6px 12px", fontSize: 12 },
                    className: "dg-btn",
                    onClick: () => { setRenameVersionTarget(null); setRenameVersionNote(null); },
                  }, "取消")),
                renameVersionNote ? h("div", { style: { ...S.meta, marginTop: 8 } }, renameVersionNote) : null))
          : null,
        // g-134: 删除版本泳道确认弹窗
        deleteVersionTarget
          ? h("div", { style: S.overlay, onClick: () => { setDeleteVersionTarget(null); setDeleteVersionNote(null); } },
              h("div", { style: S.modal, onClick: (e) => e.stopPropagation() },
                h("span", { style: S.close, onClick: () => { setDeleteVersionTarget(null); setDeleteVersionNote(null); } }, "✕"),
                h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 12 } }, "🗑️ 删除版本泳道"),
                h("div", { style: { marginBottom: 12, fontSize: 13, opacity: 0.8 } }, `确定删除版本 ${deleteVersionTarget.name}（${deleteVersionTarget.slug}）？`),
                h("div", { style: { marginBottom: 12, fontSize: 12, color: "#ff6b6b" } }, "⚠️ 此操作不可逆，仅删除空版本（无任何目标含归档）"),
                h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                  h("button", {
                    style: { ...S.btn, padding: "6px 16px", fontSize: 13, background: "#e74c3c", color: "#fff" },
                    className: "dg-btn",
                    disabled: deletingVersion,
                    onClick: deleteVersionFn,
                  }, deletingVersion ? "删除中…" : "确认删除"),
                  h("button", {
                    style: { ...S.btn, padding: "6px 12px", fontSize: 12 },
                    className: "dg-btn",
                    onClick: () => { setDeleteVersionTarget(null); setDeleteVersionNote(null); },
                  }, "取消")),
                deleteVersionNote ? h("div", { style: { ...S.meta, marginTop: 8 } }, deleteVersionNote) : null))
          : null,
      );
    }

    let appCtx = null;
    let sessionsRt = null;
    let connectionRt = null;
    let workspacesRt = null;
    // g-113 定点 bug：看板按「被查看会话」取 workspace——conversation.view 是 session 作用域 slot，
    // 渲染回调的 props.sessionId 就是该视图当前挂载的会话（renderer 把 info.sessionId 注入为
    // props.sessionId），不能用全局聚焦会话 list.current 代替（多窗口/子代理视图时两者可能不同）。
    // KanbanView(props) 挂载时写入，currentWorkspace() 优先按它查 cwd；找不到再回退 list.current。
    let viewedSessionId = null;
