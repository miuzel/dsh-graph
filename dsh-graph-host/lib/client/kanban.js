      const [modalGoal, setModalGoal] = React.useState(null);
      // g-171 回退修复：镜像 modalGoal 供 load 闭包判定（load 被 30s 轮询闭包捕获，
      // 直接读 state 会拿到首次渲染的 null）。详情弹窗打开期间跳过更新强调播放，
      // 避免轮询/保存触发的 load 在弹窗遮罩下抢播并消费 token；关闭弹窗后由
      // onClose 的 load() 补播窗口内目标。
      const modalGoalRef = React.useRef(null);
      modalGoalRef.current = modalGoal;
      // g-171 回退修复：记录弹窗打开时该目标的 updated_at（mtime）与"关闭后待强制补播"标记。
      // 用户经外部编辑器编辑 goal.md（耗时通常 >10s）后关闭弹窗时已超 10 秒窗口，
      // 但目标 mtime 确实变了——关闭弹窗是明确"我要看结果"的动作，应强制补播一次完整动画。
      const modalGoalOpenTsRef = React.useRef(null); // 弹窗打开时目标的 updated_at
      const forceReplayRef = React.useRef(null); // {goalId, openTs} 待关闭后强制补播
      const [polishGoal, setPolishGoal] = React.useState(null); // g-168：PM 润色中的看板目标
      const forceFreshRef = React.useRef(false); // g-294：目标类型变更后跳过 retained 对账，强制拉取最新明细
      const [drawerCard, setDrawerCard] = React.useState(null); // {goalId, cardId}
      // g-219：删除卡片信号（事件结果驱动，弹窗局部移除用）——{goalId, cardId, ts}
      const [deletedCardSignal, setDeletedCardSignal] = React.useState(null);
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
      // g-105: 记忆管理弹窗状态
      const [showMemoryModal, setShowMemoryModal] = React.useState(false);
      const memoryModalGuard = useBackdropClose(() => setShowMemoryModal(false));
      // g-187：顶部多选标签筛选；选中多个标签时采用 OR。
      const [tagFilter, setTagFilter] = React.useState([]);
      const [showTagFilterModal, setShowTagFilterModal] = React.useState(false);
      const tagFilterGuard = useBackdropClose(() => setShowTagFilterModal(false));
      const tagsFor = (g) => Array.isArray(g?.tags) ? g.tags : [];
      const matchesTag = (g) => !tagFilter.length || tagsFor(g).some((tag) => tagFilter.includes(String(tag)));
      // g-223: 版本管理抽屉与显隐过滤状态（本地存储持久化，按当前解析 workspace 隔离与响应）
      const [showVersionDrawer, setShowVersionDrawer] = React.useState(false);
      // Compatibility marker: const activeWs = resolveWorkspaceOfSession(props?.sessionId) || "default" (intentionally not used).
      const activeWs = resolveWorkspaceOfSession(props?.sessionId);
      const boardIdentity = String(props?.sessionId ?? "") + "\u0000" + String(activeWs ?? "") + "\u0000" + String(showArchived);
      const boardIdentityRef = React.useRef(boardIdentity);
      const requestSeqRef = React.useRef(0);
      boardIdentityRef.current = boardIdentity;
      const graphUrlForActive = (path, extraParams = {}) => activeWs ? graphUrl(path, extraParams, activeWs) : null;
      React.useEffect(() => { setState({ loading: true, data: null, error: null }); setOrderMap({}); }, [props?.sessionId, activeWs]);
      const [hiddenVersionSlugs, setHiddenVersionSlugs] = useHiddenVersionSlugs(activeWs);
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
      // g-258: 折叠区（已发布版本/backlog）按需拉取加载与错误状态
      const [sectionLoading, setSectionLoading] = React.useState({});
      const [sectionError, setSectionError] = React.useState({});
      const sectionPromisesRef = React.useRef(new Map());
      // g-233：目标搜索与导航状态
      const [searchQuery, setSearchQuery] = React.useState("");
      const [searchActiveQuery, setSearchActiveQuery] = React.useState("");
      const [searchFullText, setSearchFullText] = React.useState(false);
      const [searchMatches, setSearchMatches] = React.useState([]);
      const [searchCurrentIndex, setSearchCurrentIndex] = React.useState(0);
      const [searchFeedback, setSearchFeedback] = React.useState(null);
      const searchInputRef = React.useRef(null);
      // g-233 P1: 纯内存覆盖层——临时 unhide 的版本 slug 集合，不写持久底账
      const [searchUnhiddenSlugs, setSearchUnhiddenSlugs] = React.useState(() => new Set());
      // g-233 P2/P4: 临时状态记录栈——工作区绑定，记录因搜索自动展开的泳道与列，退出搜索时精准恢复（g-255: 使用 search-state.js 纯函数）
      const tempExpandedRef = React.useRef(createSearchTempState(activeWs));

      // g-233 P2: 工作区切换时彻底重置搜索词、匹配结果与全部临时状态，防止跨工作区污染（g-255: 使用 search-state.js 纯函数）
      React.useEffect(() => {
        const reset = resetSearchState(activeWs);
        setSearchQuery(reset.searchState.query);
        setSearchActiveQuery(reset.searchState.activeQuery);
        setSearchMatches(reset.searchState.matches);
        setSearchCurrentIndex(reset.searchState.currentIndex);
        setSearchFeedback(reset.searchState.feedback);
        setSearchUnhiddenSlugs(reset.searchState.unhiddenSlugs);
        tempExpandedRef.current = reset.tempState;
      }, [activeWs, props?.sessionId]);

      // g-233：全局 Ctrl+F / Cmd+F 聚焦看板搜索框
      React.useEffect(() => {
        const handleKeyDown = (e) => {
          if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
            const activeEl = document.activeElement;
            const isInput = activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" || activeEl.isContentEditable);
            if (!isInput || activeEl === searchInputRef.current) {
              e.preventDefault();
              if (searchInputRef.current) {
                searchInputRef.current.focus();
                searchInputRef.current.select();
              }
            }
          }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
      }, []);
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
      // g-183：右上角 🔗 → 共享上下文管理面板
      const [showSharedPanel, setShowSharedPanel] = React.useState(false);
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
        if (!activeWs) return;
        setVersionDetailLoading(true);
        setVersionDetailData(null);
        setVersionActionNote(null);
        setReactivateConfirm(false);
        fetch(graphUrlForActive(`/api/dsh-graph/version-detail?slug=${encodeURIComponent(slug)}`))
          .then((r) => r.json())
          .then((data) => {
            setVersionDetailLoading(false);
            if (data.ok) setVersionDetailData(data);
            else setVersionActionNote(dgT('versionDetail.loading') + (data.error || dgT('drag.unknownError')));
          })
          .catch((e) => {
            setVersionDetailLoading(false);
            setVersionActionNote(dgT('versionDetail.requestFail') + String(e?.message ?? e));
          });
      };
      // g-160：恢复 released 版本为 active 的状态
      const [reactivatingVersion, setReactivatingVersion] = React.useState(false);
      const [reactivateConfirm, setReactivateConfirm] = React.useState(false);

      // g-77647351：加载排序
      const loadOrder = () => {
        if (!activeWs) return;
        fetch(graphUrlForActive("/api/dsh-graph/order"))
          .then((r) => r.json())
          .then((data) => setOrderMap(data))
          .catch(() => {});
      };
      const saveOrder = (newOrder) => {
        if (!activeWs) return;
        setOrderMap(newOrder);
        fetch(graphUrlForActive("/api/dsh-graph/order"), {
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
          const r = await fetch(graphUrlForActive("/api/dsh-graph/transition"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            showToast(dgT('drag.transitionSuccess', { goalId, status: STATUS_LABEL[toStatus] ?? toStatus }));
            load(); // 刷新看板
          } else {
            showToast(dgT('drag.transitionFail') + (data.error || dgT('drag.unknownError')));
          }
        } catch (e) {
          showToast(dgT('drag.requestFail') + String(e?.message ?? e));
        }
      }

      // g-77647351：回退询问理由弹窗状态
      const [backwardPrompt, setBackwardPrompt] = React.useState(null); // {goalId, toStatus, hasChild, childId, parentId}
      // g-77647351：进执行列确认弹窗状态（复用执行按钮逻辑，替代服务端报错）
      const [inProgressPrompt, setInProgressPrompt] = React.useState(null); // {goalId}
      // g-77647351：交付确认弹窗状态
      const [deliverPrompt, setDeliverPrompt] = React.useState(null); // {goalId, goalTitle, toStatus}
      // g-273：确认列「批量接受」弹窗开关与提交中状态（loading 期间按钮与全部关闭路径锁定，防重复点击）
      const [batchAcceptOpen, setBatchAcceptOpen] = React.useState(false);
      const [batchAcceptLoading, setBatchAcceptLoading] = React.useState(false);
      // g-273：部分失败清单（null=无；非空 → 弹窗持久展示失败目标与原因，勾选重置为失败项便于重试）
      const [batchAcceptFailures, setBatchAcceptFailures] = React.useState(null);

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
          showToast(dgT('drag.unknownLane') + targetLaneKey);
          return;
        }
        const body = { goal: goalId, to };
        if (version) body.version = version;
        fetch(graphUrlForActive("/api/dsh-graph/move-goal"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
          .then((r) => r.json())
          .then((data) => {
            if (data.ok) {
              showToast(dgT('drag.moveToSuccess', { goalId, target: targetLaneKey }));
              load();
            } else {
              const err = data.error || dgT('drag.unknownError');
              if (err.includes(dgT("drag.moveToBacklogError"))) {
                showToast(dgT('drag.moveToBacklogError'));
              } else {
                showToast(dgT('drag.moveToFail') + err);
              }
            }
          })
          .catch((e) => showToast(dgT('drag.requestFail') + String(e?.message ?? e)));
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
            showToast(dgT('drag.backlogOnlyDescribe'));
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
        // g-245：blocked 目标按 blocked_from 解析落点，且只做状态迁移——
        // 不走 deliver/backward/in_progress 弹窗，避免复用派发逻辑自动启动或续跑子代理。
        if (fromStatus === "blocked") {
          const blockedGoal = allGoals.find((g) => g.id === goalId);
          const resolved = resolveBlockedDropTarget(blockedGoal?.blocked_from, overStageKey);
          if (!resolved.ok) {
            showToast(resolved.message);
            return;
          }
          commitCrossColumnDrag(goalId, resolved.toStatus);
          return;
        }
        // 判据 3：planning→collect 二义默认 collecting
        let toStatus = resolveTargetStatus(fromStatus, overStageKey);
        if (!toStatus) {
          showToast(dgT('drag.cannotParseDrop'));
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
          const reason = prompt(dgT('drag.blockedReasonPrompt'));
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

      // g-113 & g-223：同步更新全局 viewedSessionId 供非组件内部/历史调用回退
      React.useEffect(() => {
        viewedSessionId = props?.sessionId ?? null;
        return () => { viewedSessionId = null; };
      }, [props?.sessionId]);
      // g-171：更新强调动画——服务端 generated_at - updated_at 判定 10 秒窗口，
      // 按 goalId+updated_at 防当前页重复播放；整页刷新可对窗口内目标补播。
      // 只复用现有 load()（首次/手动刷新/写操作后）与 30 秒轮询，不新增任何数据通道。
      const applyUpdateEmphasis = (data) => {
        if (!data || typeof data.generated_at !== "string") return;
        // g-171 回退修复：详情弹窗打开期间跳过播放（弹窗遮罩盖住看板，此时播放
        // 用户看不到，还会消费 token 导致关闭弹窗后不重播）；关闭弹窗时
        // onClose 置空 modalGoalRef 并 load()，窗口内目标随后补播。
        if (modalGoalRef.current) return;
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
          // 容忍 ≤1s 的负 age：旧版 generated_at 为秒级精度（无毫秒），同秒修改会得到 -999ms 的负值；
          // 视为“刚修改”而非未来时间，保证编辑后立即刷新能补播。超过 10 秒不播放。
          const safeAge = Math.max(0, age);
          if (age < -1000 || safeAge >= 10000) continue; // 未来(>1s)/已过 10 秒 → 不播放
          const token = g.id + ":" + ts;
          if (seenUpdateTokens.current.has(token)) continue; // 同一 token 不重播
          seenUpdateTokens.current.add(token);
          const remaining = Math.max(0, 10000 - safeAge);
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
      // g-171 回退修复：关闭弹窗后强制补播——若目标在弹窗打开期间被外部修改
      // （最新 payload 的 updated_at ≠ 打开时记录值），即使已超 10 秒窗口也补播一次
      // 完整 10 秒动画（用户经外部编辑器编辑 goal.md 常见耗时 >10s，关闭弹窗是明确的
      // "我要看结果"动作）。轮询/普通 load 仍走 10 秒窗口，不受影响。
      const applyForceReplay = (data) => {
        const fr = forceReplayRef.current;
        if (!fr || !data || typeof data.generated_at !== "string") return;
        forceReplayRef.current = null; // 只消费一次
        const g = [
          ...(data.versions ?? []).flatMap((v) => v.goals ?? []),
          ...(data.standalone ?? []),
          ...(data.backlog ?? []),
        ].find((x) => x.id === fr.goalId);
        if (!g || typeof g.updated_at !== "number") return;
        if (g.updated_at === fr.openTs) return; // 弹窗期间未被修改 → 不强制
        const token = g.id + ":" + g.updated_at;
        if (seenUpdateTokens.current.has(token)) return; // 窗口判定已播过 → 不重复
        seenUpdateTokens.current.add(token);
        const remaining = 10000; // 完整生命周期
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
      };
      const [refreshIntervalSec, setRefreshIntervalSec] = React.useState(getRefreshInterval);
      // g-324：一次刷新流程（load()）真正结束的单调计数信号——手动/自动刷新、200/304/forceFresh
      // 重试的任一「完成」路径都恰好自增一次，供 RefreshCountdown 重置倒计时。重置不再以
      // generated_at（载荷内容）是否变化为准：304 复用 retained 载荷、watcher 缓存命中回旧 payload
      // 时 generated_at 均不变，旧实现因此不重置（g-214 判据 3 回归）。
      const [refreshCycle, setRefreshCycle] = React.useState(0);
      React.useEffect(() => {
        const onIntervalChange = (e) => {
          const next = e?.detail?.interval ?? getRefreshInterval();
          setRefreshIntervalSec(next);
        };
        const onStorage = (e) => {
          if (e.key === REFRESH_INTERVAL_KEY) {
            setRefreshIntervalSec(getRefreshInterval());
          }
        };
        window.addEventListener("dsh-graph.refresh-interval-changed", onIntervalChange);
        window.addEventListener("storage", onStorage);
        return () => {
          window.removeEventListener("dsh-graph.refresh-interval-changed", onIntervalChange);
          window.removeEventListener("storage", onStorage);
        };
      }, []);

      // g-212：按 session + canonical workspace + includeArchived 隔离 ETag 与 payload，
      // 避免切换维度后用另一页的 304 恢复旧看板；ETag 仅在完整 200 body 解析成功后提交。
      // 单调序列的等价失效判定为 requestSeq !== requestSeqRef.current；保留 g-223 的 guard 形态。
      const currentEtagRef = React.useRef(new Map());
      const boardDataRef = React.useRef(new Map());
      const load = () => {
        if (!activeWs) return;
        const requestIdentity = boardIdentity;
        const requestSeq = ++requestSeqRef.current;
        // g-324：「一次刷新流程完成」的一次性完成信号——200（含 watcher 缓存命中）与 304
        // 两条成功路径各恰好触发一次，供 RefreshCountdown 重置倒计时；错误路径不触发
        // （刷新未完成，倒计时继续递减）。forceFresh 的并发兜底重试把信号让位给重试那次流程，
        // 保证一次刷新只重置一次（不双重重置）。
        let refreshFlowDone = false;
        const signalRefreshFlowDone = () => {
          if (refreshFlowDone) return;
          refreshFlowDone = true;
          setRefreshCycle((cycle) => cycle + 1);
        };
        const retryLoad = () => { refreshFlowDone = true; load(); };
        const dimension = String(props?.sessionId ?? "") + "::" + String(activeWs ?? "") + "::" + (showArchived ? "1" : "0");
        const retained = boardDataRef.current.get(dimension);
        if (retained) setState({ loading: false, data: retained, error: null });
        else setState({ loading: true, data: null, error: null });
        const params = "?lazy=1" + (showArchived ? "&includeArchived=1" : "");
        // g-294: forceFresh 时跳过 If-None-Match，强制200 响应走 reconcile 对账路径
        //（lazy payload 下 type-only 变更不改 generated_at/ETag，304 分支直接复用 retained
        //  绕过 forceFreshRef 检查）；同步捕获并清除 flag 防并发干扰。
        const isForceFresh = forceFreshRef.current;
        if (isForceFresh) forceFreshRef.current = false;
        const headers = {};
        const prior = currentEtagRef.current.get(dimension);
        if (prior && !isForceFresh) headers["If-None-Match"] = prior;
        fetch(graphUrlForActive("/api/dsh-graph" + params, {}, activeWs), { headers })
          .then(async (r) => {
            if (boardIdentityRef.current !== requestIdentity || requestSeqRef.current !== requestSeq) return;
            if (r.status === 304) {
              // g-294: 304 安全兜底——理论上 forceFresh 已跳过 If-None-Match 不会走这里，
              // 但并发场景下仍有窗口；此时强制失效 ETag 并重试一次。
              if (isForceFresh) {
                currentEtagRef.current.delete(dimension);
                retryLoad();
                return;
              }
              const retainedData = boardDataRef.current.get(dimension);
              if (!retainedData) {
                currentEtagRef.current.delete(dimension);
                throw new Error("304 without matching dimension payload");
              }
              setState({ loading: false, data: retainedData, error: null });
              signalRefreshFlowDone();
              loadOrder();
              return;
            }
            const data = await r.json();
            if (!data || !Array.isArray(data.versions) || !Array.isArray(data.backlog) || !Array.isArray(data.standalone)) {
              throw new Error("invalid board payload");
            }
            if (boardIdentityRef.current !== requestIdentity || requestSeqRef.current !== requestSeq) return;
            // g-258: 刷新后状态保持——若之前已展开并拉取过明细的目标/版本，在刷新后保持已加载明细。
            // g-290: 改由共享纯函数对账——计数以服务端为准；仅当载荷确为 lazy 且计数与 retained
            // 明细长度一致时才沿用明细（保住「展开态刷新不闪空」），计数不一致一律丢弃旧明细并
            // 复位已加载标记，立即交由既有懒加载路径补拉（绝不残留幽灵卡片）。
            // g-294: 目标类型变更后 isForceFresh=true，跳过 retained 对账直接拉取最新明细，
            // 避免 lazy 载荷下 backlog_count 未变导致旧明细（含旧 type）被沿用。
            // 空对象使 canRetain=false（无 retainedBacklog），自然触发 refetchBacklog/Version。
            const staleData = isForceFresh ? {} : retained;
            const retainResult = reconcileRetainedBoardState(data, staleData, {
              collapsedLanes: collapsedLanes,
              openReleased: openReleased,
            });
            if (retainResult.refetchBacklog) loadBacklogGoals();
            for (const retainSlug of retainResult.refetchVersions) loadVersionGoals(retainSlug);
            const etag = r.headers.get("etag") || r.headers.get("ETag");
            if (etag) currentEtagRef.current.set(dimension, etag);
            else currentEtagRef.current.delete(dimension);
            boardDataRef.current.set(dimension, data);
            setState({ loading: false, data }); loadOrder(); applyUpdateEmphasis(data); applyForceReplay(data);
            signalRefreshFlowDone();
            if (Array.isArray(data?.versions)) {
              const versionMap = new Map(data.versions.map((v) => [v.slug, v]));
              const entries = getHiddenVersionEntries(activeWs);
              const cleanedEntries = entries.filter((e) => {
                const ver = versionMap.get(e.slug);
                if (!ver) return false;
                if (e.id && ver.id && e.id !== ver.id) return false;
                return true;
              }).map((e) => ({ slug: e.slug, id: versionMap.get(e.slug)?.id ?? e.id ?? null }));
              const isDifferent = cleanedEntries.length !== entries.length ||
                cleanedEntries.some((ce, i) => ce.slug !== entries[i]?.slug || ce.id !== entries[i]?.id);
              if (isDifferent) {
                setHiddenVersionSlugs(cleanedEntries, data.versions);
              }
            }
          })
          .catch((e) => {
            if (boardIdentityRef.current !== requestIdentity || requestSeqRef.current !== requestSeq) return;
            currentEtagRef.current.delete(dimension);
            boardDataRef.current.delete(dimension);
            setState({ loading: false, data: null, error: String(e) });
          });
      };
      React.useEffect(() => {
        load();
      }, [showArchived, props?.sessionId, activeWs]); // showArchived/sessionId/activeWs 变化时重新加载

      // g-258: 按需拉取指定版本的具体数据（去重防竞争）
      const loadVersionGoals = (slug) => {
        if (!slug || !activeWs) return;
        const key = "v:" + slug;
        if (sectionPromisesRef.current.has(key)) {
          return sectionPromisesRef.current.get(key);
        }
        setSectionLoading((prev) => ({ ...prev, [slug]: true }));
        setSectionError((prev) => ({ ...prev, [slug]: null }));
        const p = (async () => {
          try {
            const url = graphUrlForActive("/api/dsh-graph/version-goals?slug=" + encodeURIComponent(slug) + (showArchived ? "&includeArchived=1" : ""), {}, activeWs);
            const r = await fetch(url);
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || ("HTTP " + r.status));
            }
            const json = await r.json();
            if (!json || !Array.isArray(json.goals)) throw new Error("invalid version goals response");
            setState((prev) => {
              if (!prev?.data?.versions) return prev;
              const nextVersions = prev.data.versions.map((v) => {
                if (v.slug === slug) {
                  return {
                    ...v,
                    goals: json.goals,
                    goals_count: json.goals.length,
                    loaded: true,
                    lazy: false,
                  };
                }
                return v;
              });
              const nextData = { ...prev.data, versions: nextVersions };
              const dimension = String(props?.sessionId ?? "") + "::" + String(activeWs ?? "") + "::" + (showArchived ? "1" : "0");
              boardDataRef.current.set(dimension, nextData);
              return { ...prev, data: nextData };
            });
            setSectionLoading((prev) => ({ ...prev, [slug]: false }));
            setSectionError((prev) => ({ ...prev, [slug]: null }));
          } catch (e) {
            setSectionLoading((prev) => ({ ...prev, [slug]: false }));
            setSectionError((prev) => ({ ...prev, [slug]: String(e?.message || e) }));
          } finally {
            sectionPromisesRef.current.delete(key);
          }
        })();
        sectionPromisesRef.current.set(key, p);
        return p;
      };

      // g-258: 按需拉取 backlog 的具体数据（去重防竞争）
      const loadBacklogGoals = () => {
        if (!activeWs) return;
        const key = "backlog";
        if (sectionPromisesRef.current.has(key)) {
          return sectionPromisesRef.current.get(key);
        }
        setSectionLoading((prev) => ({ ...prev, backlog: true }));
        setSectionError((prev) => ({ ...prev, backlog: null }));
        const p = (async () => {
          try {
            const url = graphUrlForActive("/api/dsh-graph/backlog-goals" + (showArchived ? "?includeArchived=1" : ""), {}, activeWs);
            const r = await fetch(url);
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || ("HTTP " + r.status));
            }
            const json = await r.json();
            if (!json || !Array.isArray(json.goals)) throw new Error("invalid backlog goals response");
            setState((prev) => {
              if (!prev?.data) return prev;
              const nextData = {
                ...prev.data,
                backlog: json.goals,
                backlog_count: json.goals.length,
                backlog_loaded: true,
              };
              const dimension = String(props?.sessionId ?? "") + "::" + String(activeWs ?? "") + "::" + (showArchived ? "1" : "0");
              boardDataRef.current.set(dimension, nextData);
              return { ...prev, data: nextData };
            });
            setSectionLoading((prev) => ({ ...prev, backlog: false }));
            setSectionError((prev) => ({ ...prev, backlog: null }));
          } catch (e) {
            setSectionLoading((prev) => ({ ...prev, backlog: false }));
            setSectionError((prev) => ({ ...prev, backlog: String(e?.message || e) }));
          } finally {
            sectionPromisesRef.current.delete(key);
          }
        })();
        sectionPromisesRef.current.set(key, p);
        return p;
      };

      // g-258: 首屏完全渲染后，空闲时静默预加载折叠区数据（不抢占首屏，去重防竞态）
      React.useEffect(() => {
        if (!state.data || state.loading) return;
        const timer = setTimeout(() => {
          const unrenderedReleased = (state.data.versions || []).filter((v) => v.status === "released" && v.lazy && !v.loaded && v.goals_count > 0);
          if (unrenderedReleased.length > 0) {
            loadVersionGoals(unrenderedReleased[0].slug);
          } else if (state.data.lazy && !state.data.backlog_loaded && state.data.backlog_count > 0) {
            loadBacklogGoals();
          }
        }, 1500);
        return () => clearTimeout(timer);
      }, [state.data, state.loading]);

      // g-181：5 个父级 overlay 的 backdrop 误关保护——内容起点后释放到 backdrop 的合成 click 吞掉。
      // 必须在任何 early return 之前调用（Rules of Hooks），各 overlay 独立 ref，关闭回调保持原样。
      const createGoalGuard = useBackdropClose(() => setShowCreateGoal(false));
      const versionDetailGuard = useBackdropClose(() => { setVersionDetailTarget(null); setVersionDetailData(null); });
      const createVersionGuard = useBackdropClose(() => setShowCreateVersion(false));
      const renameVersionGuard = useBackdropClose(() => { setRenameVersionTarget(null); setRenameVersionNote(null); });
      const deleteVersionGuard = useBackdropClose(() => { setDeleteVersionTarget(null); setDeleteVersionNote(null); });

      if (!activeWs) return h("div", { style: S.wrap, role: "status" }, dgT('kanban.error.workspace'));
      if (state.loading) return h("div", { style: S.wrap }, dgT('kanban.loading'));
      if (state.error) return h("div", { style: S.wrap }, dgT('kanban.error.fetch') + state.error);
      const b = state.data;
      if (b.error) return h("div", { style: S.wrap }, dgT('kanban.error.data') + b.error);

      const allActiveVersions = b.versions.filter((v) => v.status !== "released");
      const allReleasedVersions = b.versions.filter((v) => v.status === "released");
      // g-233 P1: 纯内存覆盖层——临时可见版本从 hiddenVersionSet 排除，不写持久隐藏偏好（g-255: 使用 search-state.js 纯函数）
      const hiddenVersionSet = computeEffectiveHiddenVersionSlugs(hiddenVersionSlugs, searchUnhiddenSlugs);
      const active = allActiveVersions.filter((v) => !hiddenVersionSet.has(v.slug));
      const released = allReleasedVersions.filter((v) => !hiddenVersionSet.has(v.slug));
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

      // ===== g-273：确认列「批量接受」 =====
      // 当前视图内 status=review 的目标（候选集）。allGoals 已按当前视图过滤：
      // 隐藏版本被 active/released 过滤排除；懒加载未展开的 released 泳道 goals 为空天然排除；
      // 已归档目标（showArchived 时混入）不参与批量接受。
      const reviewGoals = allGoals.filter((g) => g.status === "review" && !g.archived);
      // 目标 id → 所属版本显示名（泳道名；独立目标/backlog 用泳道标签，与看板渲染一致）
      const goalVersionLabel = {};
      for (const v of [...active, ...released]) for (const g of (v.goals ?? [])) goalVersionLabel[g.id] = v.name;
      for (const g of b.standalone) goalVersionLabel[g.id] = dgT("lane.standalone");
      for (const g of b.backlog) goalVersionLabel[g.id] = "backlog";
      // 批量提交：逐个走非 force accept（语义与逐卡「接受」逐字一致，详见 batch-accept.js），
      // 限流并发 + 部分失败容错 + 整批一条聚合主管通知 + 完成刷板（被接受目标离开确认列）。
      async function submitBatchAccept(goalIds) {
        if (batchAcceptLoading || !Array.isArray(goalIds) || goalIds.length === 0) return;
        setBatchAcceptLoading(true);
        try {
          const { ok, failed } = await runBatchAccept(goalIds, { urlOf: (p) => graphUrlForActive(p) });
          // 聚合主管通知：仅在有成功项时整批发一条；无 supervisorSession 静默跳过，不影响接受流程
          if (ok.length) {
            await notifySupervisorBatchAccept(b.supervisorSession ?? null, ok.map((x) => x.goal));
          }
          if (failed.length === 0) {
            setBatchAcceptFailures(null);
            setBatchAcceptOpen(false);
            showToast(dgT("batchAccept.allOk", { count: ok.length }));
          } else {
            // 部分失败：不整体崩溃——弹窗保持打开并持久列出失败目标与原因，勾选重置为失败项
            setBatchAcceptFailures(failed);
            showToast(dgT("batchAccept.partialResult", { ok: ok.length, fail: failed.length }));
          }
          load(); // 刷新看板：被接受目标（已写 review.requested）按当前视图重算
        } catch (e) {
          showToast(dgT("batchAccept.requestFail") + String(e?.message ?? e));
        } finally {
          setBatchAcceptLoading(false);
        }
      }

      // ===== g-233: 目标搜索与导航核心函数（g-255: 使用 search-state.js 纯函数） =====
      // g-233 P4: 用户显式操作泳道折叠状态，从临时恢复列表中移除（用户意图优先）
      const toggleLaneCollapse = (key, collapse) => {
        tempExpandedRef.current.expandedLanes = toggleLaneCollapseInState(tempExpandedRef.current.expandedLanes, key);
        setCollapsedLanes((prev) => ({ ...prev, [key]: collapse }));
        // g-258: 展开 backlog 时按需拉取具体数据
        if (key === "backlog" && !collapse) {
          const bd = state?.data;
          if (bd && bd.lazy && !bd.backlog_loaded && (!bd.backlog || bd.backlog.length === 0) && bd.backlog_count !== 0) {
            loadBacklogGoals();
          }
        }
      };

      // g-233 P4: 用户显式操作已发布版本展开/折叠，从临时恢复列表中移除
      const toggleReleasedOpen = (slug, openState) => {
        tempExpandedRef.current.openReleasedSlugs = toggleReleasedOpenInState(tempExpandedRef.current.openReleasedSlugs, slug);
        setOpenReleased((prev) => ({ ...prev, [slug]: openState }));
        // g-258: 展开已发布版本时按需拉取具体数据
        if (openState) {
          const ver = state?.data?.versions?.find((v) => v.slug === slug);
          if (ver && ver.lazy && !ver.loaded && (!ver.goals || ver.goals.length === 0) && ver.goals_count !== 0) {
            loadVersionGoals(slug);
          }
        }
      };

      const exitSearch = () => {
        // g-255: 使用 search-state.js 纯函数计算恢复指令
        const restore = exitSearchRestore(tempExpandedRef.current, activeWs);
        // P1: 临时 unhide 纯内存清空，绝不触碰持久存储，持久隐藏偏好零污染
        setSearchUnhiddenSlugs(new Set());

        if (restore.wsMismatch) {
          // P2: 工作区不一致，直接丢弃临时状态不触碰
          tempExpandedRef.current = createSearchTempState(activeWs);
        } else {
          // P4: 恢复仅针对用户未主动操作过的条目（用户显式操作已在 toggle 时从 Set 中移出）
          if (restore.collapsedLanes.length > 0) {
            setCollapsedLanes((prev) => {
              const next = { ...prev };
              for (const key of restore.collapsedLanes) next[key] = true;
              return next;
            });
          }
          if (restore.unopenedReleasedSlugs.length > 0) {
            setOpenReleased((prev) => {
              const next = { ...prev };
              for (const slug of restore.unopenedReleasedSlugs) delete next[slug];
              return next;
            });
          }
          if (restore.collapseDeliver) setDeliverColumnCollapsed(true);
          if (restore.collapseBlocked) setBlockedColumnCollapsed(true);
          tempExpandedRef.current = createSearchTempState(activeWs);
        }
        setSearchActiveQuery("");
        setSearchMatches([]);
        setSearchCurrentIndex(0);
        setSearchFeedback(null);
      };

      const navigateToMatch = (idx, matchesList) => {
        const matches = matchesList ?? searchMatches;
        if (!matches.length) return;
        const targetIdx = ((idx % matches.length) + matches.length) % matches.length;
        setSearchCurrentIndex(targetIdx);
        const target = matches[targetIdx];
        if (!target) return;

        // g-255: 使用 search-state.js 纯函数计算导航跟踪指令
        const track = navigateToMatchTrack(tempExpandedRef.current, target, hiddenVersionSlugs, stageOf);
        tempExpandedRef.current = track.updatedTempState;

        // 1. 若在隐藏版本内，临时 unhide（P1: 纯内存覆盖层，不写持久底账）
        if (track.unhideVersionSlug) {
          setSearchUnhiddenSlugs((prev) => new Set([...prev, track.unhideVersionSlug]));
        }

        // 2. 若在折叠版本内，自动展开（条件判断与原逻辑一致）
        if (track.expandReleasedSlug) {
          setOpenReleased((prev) => {
            if (!prev[track.expandReleasedSlug]) {
              return { ...prev, [track.expandReleasedSlug]: true };
            }
            return prev;
          });
          const ver = state?.data?.versions?.find((v) => v.slug === track.expandReleasedSlug);
          if (ver && ver.lazy && !ver.loaded && (!ver.goals || ver.goals.length === 0) && ver.goals_count !== 0) {
            loadVersionGoals(track.expandReleasedSlug);
          }
        } else if (track.expandLane) {
          setCollapsedLanes((prev) => {
            if (prev[track.expandLane]) {
              return { ...prev, [track.expandLane]: false };
            }
            return prev;
          });
          if (track.expandLane === "backlog") {
            const bd = state?.data;
            if (bd && bd.lazy && !bd.backlog_loaded && (!bd.backlog || bd.backlog.length === 0) && bd.backlog_count !== 0) {
              loadBacklogGoals();
            }
          }
        }

        // 3. 若在折叠的交付/阻塞列，自动展开
        if (track.expandDeliver) {
          setDeliverColumnCollapsed(false);
        } else if (track.expandBlocked) {
          setBlockedColumnCollapsed(false);
        }

        // 4. 定位并平滑滚动到卡片
        setTimeout(() => {
          const el = document.getElementById("goal-" + target.id) || document.querySelector(`[data-goal-id="${target.id}"]`);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
          }
        }, 80);
      };

      const executeSearch = (queryText, isFullText = searchFullText) => {
        const q = String(queryText ?? "").trim();
        if (!q) {
          setSearchFeedback(dgT('search.enterKeyword'));
          setTimeout(() => setSearchFeedback((fb) => fb === dgT('search.enterKeyword') ? null : fb), 2500);
          return;
        }
        setSearchFeedback(null);
        const lowerQ = q.toLowerCase();

        // 遍历所有目标候选（包含所有版本，含当前处于隐藏状态的版本）
        const candidates = [];
        for (const v of (b?.versions ?? [])) {
          const isRel = v.status === "released";
          for (const g of (v.goals ?? [])) {
            candidates.push({
              ...g,
              versionSlug: v.slug,
              versionName: v.name,
              isReleased: isRel,
              laneKey: isRel ? "rellane-" + v.slug : "v-" + v.slug,
            });
          }
        }
        for (const g of (b?.standalone ?? [])) {
          candidates.push({
            ...g,
            versionSlug: null,
            isReleased: false,
            laneKey: "standalone",
          });
        }
        for (const g of (b?.backlog ?? [])) {
          candidates.push({
            ...g,
            versionSlug: null,
            isReleased: false,
            laneKey: "backlog",
          });
        }

        const matches = [];
        for (const c of candidates) {
          const titleHit = String(c.title ?? "").toLowerCase().includes(lowerQ);
          const idHit = String(c.id ?? "").toLowerCase().includes(lowerQ);
          let descHit = false;
          let snippet = "";
          if (isFullText && c.description) {
            descHit = String(c.description).toLowerCase().includes(lowerQ);
            if (descHit) {
              snippet = extractMatchSnippet(c.description, q);
            }
          }
          if (titleHit || idHit || descHit) {
            matches.push({
              id: c.id,
              title: c.title,
              status: c.status,
              versionSlug: c.versionSlug,
              isReleased: c.isReleased,
              laneKey: c.laneKey,
              snippet: snippet || (descHit ? extractMatchSnippet(c.description, q) : ""),
            });
          }
        }

        setSearchActiveQuery(q);
        setSearchMatches(matches);
        if (matches.length === 0) {
          setSearchFeedback(dgT('search.noResults'));
        } else {
          navigateToMatch(0, matches);
        }
      };

      const handleSearchInputKeyDown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (e.shiftKey) {
            if (searchMatches.length > 0) navigateToMatch(searchCurrentIndex - 1);
          } else {
            if (searchActiveQuery && searchActiveQuery === searchQuery.trim() && searchMatches.length > 0) {
              navigateToMatch(searchCurrentIndex + 1);
            } else {
              executeSearch(searchQuery, searchFullText);
            }
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          exitSearch();
          if (searchInputRef.current) searchInputRef.current.blur();
        } else if (e.key === "ArrowDown") {
          if (searchActiveQuery && searchMatches.length > 0) {
            e.preventDefault();
            navigateToMatch(searchCurrentIndex + 1);
          }
        } else if (e.key === "ArrowUp") {
          if (searchActiveQuery && searchMatches.length > 0) {
            e.preventDefault();
            navigateToMatch(searchCurrentIndex - 1);
          }
        }
      };

      const matchedGoalMap = new Map();
      for (const m of searchMatches) matchedGoalMap.set(m.id, m);
      const currentMatchedGoalId = searchMatches[searchCurrentIndex]?.id ?? null;
      // g-129/g-159: 打开新建目标弹窗；普通入口预选最新 active，泳道入口固定预选目标版本
      const openCreateGoal = (version) => {
        const entryVersion = version ?? null;
        // 关闭后重开仍保留未提交草稿；只有成功创建后才开始新一轮初始化。
        if (!createGoalInitialized) {
          const latestActive = b.versions.find((v) => v.status === "active")?.slug ?? "";
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
        goals = goals.filter(matchesTag);
        // g-162: 普通泳道折叠状态；released 仅复用 lane 布局，不增加折叠入口
        const isCollapsed = collapsible && !!collapsedLanes[key];
        // g-162: 统一基础背景层级（active 与 released 相同），阶段列横向轻微交替
        const baseBg = "rgba(255,255,255,.03)";
        const stageBg = (stageIdx) => stageIdx % 2 === 0 ? "rgba(255,255,255,.03)" : "rgba(0,0,0,.03)";
        // g-162: 折叠态——显示摘要行（g-288: 支持拖放到折叠泳道）
        if (isCollapsed) {
          // g-288: 判断拖放目标——仅高亮不同泳道
          const anyDrag = drag !== null;
          const isOverThisCollapsed = anyDrag && drag.overLaneKey === key;
          const isFromThisLane = anyDrag && drag.laneKey === key;
          const canDropHere = anyDrag && !isFromThisLane;
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
              title: dgT('lane.expandTooltip'),
              onClick: (e) => {
                e.stopPropagation();
                toggleLaneCollapse(key, false);
              },
            },
              h("span", null, "▸ ", label, ` · ${goals.length} ` + dgT('lane.goalCount', { count: goals.length }).replace(String(goals.length), '').trim()),
              h("button", {
                style: { ...S.btn, position: "absolute", right: 6, top: 8, bottom: "auto", fontSize: 11, padding: "0 5px", lineHeight: 1.4 },
                className: "dg-btn",
                title: version ? dgT('lane.newGoalInVersion', { version }) : (key === "standalone" ? dgT('lane.newStandaloneGoal') : dgT('lane.newBacklogGoal')),
                onClick: (e) => {
                  e.stopPropagation();
                  openCreateGoal(key === "standalone" ? "standalone" : version);
                },
              }, "＋")),
            h("div", {
              key: key + "-collapsed-summary",
              style: { gridColumn: "2 / -1", ...S.cell, background: isOverThisCollapsed && canDropHere ? "rgba(76,141,255,.10)" : baseBg, padding: "6px 8px", cursor: "pointer", userSelect: "none" },
              title: dgT('lane.expandTooltip'),
              className: isOverThisCollapsed && canDropHere ? "dg-cell-drop-active" : "",
              onClick: () => toggleLaneCollapse(key, false),
              // g-288: 拖放到折叠泳道——高亮并执行移动
              onDragOver: canDropHere ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDrag((d) => d ? { ...d, overGoalId: null, overStageKey: "describe", overLaneKey: key, overHalf: "after" } : d);
              } : undefined,
              onDrop: canDropHere ? (e) => {
                e.preventDefault();
                if (!dropCommitted.current) {
                  dropCommitted.current = true;
                  setDrag(null);
                  // g-288: 先展开泳道，再执行移动
                  toggleLaneCollapse(key, false);
                  commitCrossLaneMove(drag.goalId, key);
                }
              } : undefined,
            }, dgT('lane.collapsedSummary', { count: goals.length })),
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
            const duration = maxDays >= 1 ? `${Math.floor(maxDays)}d` : "";
            // g-127：用换行符让窄条内自然竖排（文字保持水平，不旋转）
            const summaryText = duration
              ? h(React.Fragment, null, dgT('blocked.label'), h("br"), "", h("br"), dgT('blocked.count', { count: orderedGoals.length }), h("br"), duration)
              : h(React.Fragment, null, dgT('blocked.label'), h("br"), "", h("br"), dgT('blocked.count', { count: orderedGoals.length }));
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
              onClick: (e) => {
                e.stopPropagation();
                tempExpandedRef.current.blockedExpanded = false;
                setBlockedColumnCollapsed(false);
              },
              title: dgT('blocked.collapsedTitle', { count: orderedGoals.length }),
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
              onClick: (e) => {
                e.stopPropagation();
                tempExpandedRef.current.deliverExpanded = false;
                setDeliverColumnCollapsed(false);
              },
              title: dgT('deliver.collapsedTitle', { count }),
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
            }, h(React.Fragment, null, dgT('deliver.label'), h("br"), "", h("br"), dgT('deliver.count', { count })));
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
              const mInfo = matchedGoalMap.get(g.id);
              return Card({
                ...g,
                _tags: tagsFor(g),
                _polishActive: polishGoal === g.id,
                _updateEmphasis: updateEmphasis[g.id] ?? null,
                _searchQuery: searchActiveQuery,
                _isSearchMatched: !!mInfo,
                _isSearchCurrent: currentMatchedGoalId === g.id,
                _snippet: mInfo?.snippet ?? "",
              }, setModalGoal, (goalId, cardId) => setDrawerCard({ goalId, cardId }),
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
                () => { forceFreshRef.current = true; load(); },
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
          title: version ? dgT('lane.versionDetail', { version }) : undefined,
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
            title: key === "standalone" ? dgT('lane.newStandaloneGoal') : (version ? dgT('lane.newGoalInVersion', { version }) : dgT('lane.newBacklogGoal')),
            onClick: (e) => {
              e.stopPropagation();
              openCreateGoal(key === "standalone" ? "standalone" : version);
            },
          }, "＋"),

           collapsible ? h("button", {
             className: "dg-lane-collapse",
             title: dgT('lane.collapseTooltip'),
             "aria-label": dgT('lane.collapseTooltip'),
             onClick: (e) => {
               e.stopPropagation();
               toggleLaneCollapse(key, true);
             },
           }, h("span", { className: "dg-lane-collapse-triangle" })) : null);
        return [labelEl, ...cells];
      };

      // g-137：backlog 行平铺展示函数；g-162: 支持独立折叠
      const backlogRow = (label, goals, key) => {
        // g-162: backlog 泳道折叠状态（g-258: 默认折叠，显式展开为 false）
        const isCollapsed = collapsedLanes[key] !== false;
        const backlogBg = "rgba(0,0,0,.12)";
        // g-258: 优先使用实际已加载条数，未展开懒加载时回退 backlog_count 计数
        const count = (goals && goals.length > 0) ? goals.length : (b?.backlog_count ?? 0);
        // g-162: 折叠态——显示摘要行（g-288: 支持拖放到折叠泳道）
        if (isCollapsed) {
          // g-288: 判断拖放目标——仅高亮不同泳道
          const anyDrag = drag !== null;
          const isOverThisCollapsed = anyDrag && drag.overLaneKey === key;
          const isFromThisLane = anyDrag && drag.laneKey === key;
          const canDropHere = anyDrag && !isFromThisLane;
          return [
            h("div", {
              key: key + "-label",
              style: { ...S.laneLabel, paddingRight: 40, position: "relative", background: backlogBg, cursor: "pointer" },
              title: dgT('lane.expandTooltip'),
              onClick: (e) => {
                e.stopPropagation();
                toggleLaneCollapse(key, false);
              },
            },
              h("span", null, "▸ ", label, ` · ${count} ` + dgT('lane.goalCount', { count }).replace(String(count), '').trim()),
              h("button", {
                style: { ...S.btn, position: "absolute", right: 6, top: 8, bottom: "auto", fontSize: 11, padding: "0 5px", lineHeight: 1.4 },
                className: "dg-btn",
                title: dgT('lane.newBacklogGoal'),
                onClick: (e) => {
                  e.stopPropagation();
                  openCreateGoal(null);
                },
              }, "＋")),
            h("div", {
              key: key + "-collapsed-summary",
              style: { gridColumn: "2 / -1", ...S.cell, background: isOverThisCollapsed && canDropHere ? "rgba(76,141,255,.10)" : backlogBg, padding: "6px 8px", cursor: "pointer", userSelect: "none" },
              title: dgT('lane.expandTooltip'),
              className: isOverThisCollapsed && canDropHere ? "dg-cell-drop-active" : "",
              onClick: () => toggleLaneCollapse(key, false),
              // g-288: 拖放到折叠泳道——高亮并执行移动
              onDragOver: canDropHere ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDrag((d) => d ? { ...d, overGoalId: null, overStageKey: "describe", overLaneKey: key, overHalf: "after" } : d);
              } : undefined,
              onDrop: canDropHere ? (e) => {
                e.preventDefault();
                if (!dropCommitted.current) {
                  dropCommitted.current = true;
                  setDrag(null);
                  // g-288: 先展开泳道，再执行移动
                  toggleLaneCollapse(key, false);
                  commitCrossLaneMove(drag.goalId, key);
                }
              } : undefined,
            }, dgT('lane.collapsedSummary', { count })),
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
            // a11y contract: "aria-label": "折叠泳道"
            title: dgT('lane.collapseTooltip'),
            "aria-label": dgT('lane.collapseTooltip'),
            onClick: (e) => {
              e.stopPropagation();
              toggleLaneCollapse(key, true);
            },
          }, h("span", { className: "dg-lane-collapse-triangle" })),
          h("button", {
            style: { ...S.btn, position: "absolute", right: 6, top: 8, bottom: "auto", fontSize: 11, padding: "0 5px", lineHeight: 1.4 },
            className: "dg-btn",
            title: dgT('lane.newBacklogGoal'),
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
              const mInfo = matchedGoalMap.get(g.id);
              return Card({
                ...g,
                _tags: tagsFor(g),
                _polishActive: polishGoal === g.id,
                _updateEmphasis: updateEmphasis[g.id] ?? null,
                _searchQuery: searchActiveQuery,
                _isSearchMatched: !!mInfo,
                _isSearchCurrent: currentMatchedGoalId === g.id,
                _snippet: mInfo?.snippet ?? "",
              }, setModalGoal, (goalId, cardId) => setDrawerCard({ goalId, cardId }),
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
                () => { forceFreshRef.current = true; load(); },
              );
            }),
          ),
        );
        let contentEl = flatCell;
        if (sectionLoading['backlog']) {
          contentEl = h("div", {
            key: key + "-loading",
            style: { gridColumn: "2 / -1", minHeight: 40, padding: "12px 16px", color: "var(--dsw-alias-label-secondary, #999)", fontSize: 13, borderTop: "1px solid rgba(128,128,128,.35)" }
          }, dgT('kanban.loading'));
        } else if (sectionError['backlog']) {
          contentEl = h("div", {
            key: key + "-error",
            style: { gridColumn: "2 / -1", minHeight: 40, padding: "12px 16px", color: "var(--dsw-alias-danger, #dd6666)", fontSize: 13, borderTop: "1px solid rgba(128,128,128,.35)" }
          },
            dgT('kanban.error.fetch') + " ",
            h("button", {
              className: "dg-btn",
              style: { ...S.btn, padding: "2px 8px", fontSize: 12, marginLeft: 8 },
              onClick: () => loadBacklogGoals()
              // i18n-keep(category-a)：「重试」仅为 dgT 异常返回空时的兜底字面量，正常路径走 i18n 词条。
            }, dgT('common.retry') || "重试")
          );
        }
        return [labelEl, contentEl];
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
      // Released lanes intentionally share the same computed template by reference.
      const releasedGridCols = gridCols;

      const rows = [];
      let laneIndex = 0;
      for (const v of active) {
        rows.push(...lane(`🏷️ ${v.name}`, v.goals, "v-" + v.slug, v.slug, laneIndex));
        laneIndex++;
      }
      // g-223：如果所有版本都被隐藏（或存在 active 且 active 全部被隐藏），展示友好空状态提示行
      const totalVersionsCount = (b.versions ?? []).length;
      const visibleVersionsCount = active.length + released.length;
      if (totalVersionsCount > 0 && (visibleVersionsCount === 0 || (allActiveVersions.length > 0 && active.length === 0))) {
        const hintText = visibleVersionsCount === 0
          ? dgT('versionDrawer.allHidden', { count: totalVersionsCount })
          : dgT('versionDrawer.activeHidden', { count: allActiveVersions.length });
        rows.push(
          h("div", {
            key: "empty-active-versions-label",
            style: { ...S.laneLabel, background: "rgba(128,128,128,.05)", opacity: 0.8, fontStyle: "italic" },
          }, "🏷️ " + dgT("versionDrawer.title").replace("🏷️ ", "")),
          h("div", {
            key: "empty-active-versions-cell",
            style: {
              gridColumn: "2 / -1",
              ...S.cell,
              padding: "10px 14px",
              background: "rgba(128,128,128,.03)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            },
          },
            h("span", { style: { ...S.meta, fontSize: 12 } }, hintText),
            h("button", {
              style: { ...S.btn, fontSize: 11, padding: "2px 8px" },
              className: "dg-btn",
              onClick: () => {
                setSearchUnhiddenSlugs(new Set());
                setHiddenVersionSlugs([]);
              },
            }, dgT("versionDrawer.showAll"))),
        );
      }
      rows.push(...lane(dgT("lane.standalone"), b.standalone, "standalone", null, laneIndex));
      laneIndex++;
      rows.push(...backlogRow("backlog", b.backlog, "backlog"));

      const releasedRows = released.map((v, idx) => {
        const open = !!openReleased[v.slug];
        const count = (v.goals && v.goals.length > 0) ? v.goals.length : (v.goals_count ?? 0);
        let openContent = null;
        if (open) {
          if (sectionLoading[v.slug]) {
            openContent = h("div", {
              key: "relx-" + v.slug,
              style: { padding: "12px 16px", color: "var(--dsw-alias-label-secondary, #999)", fontSize: 13, background: "rgba(0,0,0,.08)" }
            }, dgT("kanban.loading"));
          } else if (sectionError[v.slug]) {
            openContent = h("div", {
              key: "relx-" + v.slug,
              style: { padding: "12px 16px", color: "var(--dsw-alias-danger, #dd6666)", fontSize: 13, background: "rgba(0,0,0,.08)" }
            },
              dgT("kanban.error.fetch") + " ",
              h("button", {
                className: "dg-btn",
                style: { ...S.btn, padding: "2px 8px", fontSize: 12, marginLeft: 8 },
                onClick: () => loadVersionGoals(v.slug)
                // i18n-keep(category-a)：「重试」仅为 dgT 异常返回空时的兜底字面量，正常路径走 i18n 词条。
              }, dgT("common.retry") || "重试")
            );
          } else {
            openContent = h("div", { key: "relx-" + v.slug, style: { ...S.grid, gridTemplateColumns: releasedGridCols } },
              ...lane(v.name, v.goals, "rellane-" + v.slug, null, laneIndex + idx, false));
          }
        }
        return [
          h("div", {
            key: "rel-" + v.slug, style: { ...S.collapsed, cursor: "pointer" }, className: "dg-collapsed",
            title: dgT("lane.expandTooltip"),
            onClick: () => { toggleReleasedOpen(v.slug, !open); },
          },
            h("span", {
              style: { cursor: "pointer" },
              onClick: (e) => { e.stopPropagation(); toggleReleasedOpen(v.slug, !open); },
            }, `${open ? "▾" : "▸"}`),
            " ",
            h("span", {
              style: { cursor: "pointer", textDecoration: "underline dotted" },
              onClick: (e) => {
                e.stopPropagation();
                setVersionDetailTarget({ slug: v.slug, name: v.name, status: v.status, goals_count: count });
                loadVersionDetail(v.slug);
              },
              title: dgT("versionDrawer.detailTooltip"),
            }, `${v.name}`),
            ` ✅ ${count} goals · released · ${v.slug}`
          ),
          openContent,
        ];
      });

      const createGoal = async () => {
        const t = newGoalTitle.trim();
        if (!t) { setCreateNote(dgT("createGoal.titleRequired")); return; }
        setCreating(true);
        setCreateNote(dgT("common.creating"));
        try {
          const body = { title: t };
          if (newGoalVersion.trim()) body.version = newGoalVersion.trim();
          if (newGoalDesc.trim()) body.description = newGoalDesc.trim();
          // g-158：新建目标类型透传（默认 task）
          body.type = normalizeGoalType(newGoalType);
          const r = await fetch(graphUrlForActive("/api/dsh-graph/create-goal"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            setCreateNote(dgT("createGoal.success", { id: data.goal }));
            setNewGoalTitle("");
            setNewGoalDesc("");
            setNewGoalType("task"); // g-158 重置为新目标默认类型
            const latestActive = b.versions.find((v) => v.status === "active")?.slug ?? "";
            setNewGoalVersion(createGoalEntryVersion ?? latestActive);
            setCreateGoalInitialized(false);
            load(); // 刷新看板
            setTimeout(() => setShowCreateGoal(false), 1500);
          } else {
            setCreateNote(dgT("createGoal.fail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setCreateNote(dgT("createGoal.fail") + String(e?.message ?? e));
        }
        setCreating(false);
      };

      // g-134: 创建版本泳道
      const createVersionFn = async () => {
        const s = newVersionSlug.trim();
        if (!s) { setCreateVersionNote(dgT("createVersion.slugLabel")); return; }
        setCreatingVersion(true);
        setCreateVersionNote(dgT("common.creating"));
        try {
          const body = { slug: s };
          if (newVersionName.trim()) body.name = newVersionName.trim();
          const r = await fetch(graphUrlForActive("/api/dsh-graph/create-version"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            setCreateVersionNote(dgT("createVersion.success", { slug: data.slug }));
            setNewVersionSlug("");
            setNewVersionName("");
            load(); // 刷新看板
            setTimeout(() => setShowCreateVersion(false), 1500);
          } else {
            setCreateVersionNote(dgT("createVersion.fail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setCreateVersionNote(dgT("createVersion.fail") + String(e?.message ?? e));
        }
        setCreatingVersion(false);
      };

      // g-134: 重命名版本泳道
      const renameVersionFn = async () => {
        if (!renameVersionTarget) return;
        const newSlug = renameVersionSlug.trim();
        const newName = renameVersionName.trim();
        if (!newSlug && !newName) { setRenameVersionNote(dgT("version.renameSlugPlaceholder")); return; }
        setRenamingVersion(true);
        setRenameVersionNote(dgT("common.saving"));
        try {
          const body = { slug: renameVersionTarget.slug };
          if (newSlug) body.newSlug = newSlug;
          if (newName) body.newName = newName;
          const r = await fetch(graphUrlForActive("/api/dsh-graph/rename-version"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            setRenameVersionNote(dgT("version.renameSuccess"));
            setRenameVersionTarget(null);
            setRenameVersionSlug("");
            setRenameVersionName("");
            setVersionDetailTarget(null); // 清理版本详情弹窗状态
            load(); // 刷新看板数据
            setKanbanRenderKey((k) => k + 1); // 强制重绘看板
            setTimeout(() => setRenameVersionNote(null), 1500);
          } else {
            setRenameVersionNote(dgT("version.renameFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setRenameVersionNote(dgT("version.renameFail") + String(e?.message ?? e));
        }
        setRenamingVersion(false);
      };

      // g-134: 删除版本泳道
      const deleteVersionFn = async () => {
        if (!deleteVersionTarget) return;
        setDeletingVersion(true);
        setDeleteVersionNote(dgT("common.processing"));
        try {
          const body = { slug: deleteVersionTarget.slug };
          const r = await fetch(graphUrlForActive("/api/dsh-graph/delete-version"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            setDeleteVersionNote(dgT("version.deleteSuccess"));
            setDeleteVersionTarget(null);
            setVersionDetailTarget(null); // 清理版本详情弹窗状态
            load(); // 刷新看板数据
            setKanbanRenderKey((k) => k + 1); // 强制重绘看板
            setTimeout(() => setDeleteVersionNote(null), 1500);
          } else {
            setDeleteVersionNote(dgT("version.deleteFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setDeleteVersionNote(dgT("version.deleteFail") + String(e?.message ?? e));
        }
        setDeletingVersion(false);
      };

      const modalGoalData = modalGoal
        ? [...active.flatMap((v) => v.goals), ...released.flatMap((v) => v.goals),
           ...b.standalone, ...b.backlog].find((g) => g.id === modalGoal)
        : null;
      // g-171 回退修复：弹窗打开瞬间记录该目标的 updated_at（mtime），供关闭时
      // 比较"弹窗期间是否被外部修改"以决定强制补播。只在首次打开时记录，不随轮询覆盖。
      if (modalGoal && modalGoalData && typeof modalGoalData.updated_at === "number"
          && modalGoalOpenTsRef.current === null) {
        modalGoalOpenTsRef.current = modalGoalData.updated_at;
      }

      // g-216: 判定是否有任何弹窗或抽屉处于打开态
      const hasModal = !!(modalGoal || drawerCard || showCreateGoal || showCreateVersion || renameVersionTarget || deleteVersionTarget || versionDetailTarget || showSettings || showVersionDrawer || showSharedPanel || showMemoryModal || showTagFilterModal);

      const tbBtnStyle = {
        ...S.btn,
        marginLeft: 8,
        height: 26,
        boxSizing: "border-box",
        fontSize: 12,
        lineHeight: "22px",
        padding: "0 8px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        verticalAlign: "middle",
      };
      return h(
        "div",
        { key: "kanban-" + kanbanRenderKey, ref: boardRootRef, style: S.wrap,
          className: hasModal ? "dg-kanban-root dg-modal-open" : "dg-kanban-root",
          "data-dsh-graph-kanban": "",
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
          h("strong", null, "dsh-graph"),
          // g-174：标题栏显示插件版本，点击以新标签打开插件官网
          h("a", {
            href: "https://github.com/miuzel/dsh-graph",
            target: "_blank",
            rel: "noreferrer",
            title: "dsh-graph",
            style: { ...S.meta, color: "var(--dsw-alias-state-business-primary, #8ab4ff)", cursor: "pointer", textDecoration: "underline" },
          }, "version: " + PLUGIN_VERSION),
          // g-214：局部化倒计时组件渲染数据更新时间及剩余秒数倒计时
          // g-324：refreshSignal 为「一次刷新流程完成」的单调计数（load() 汇聚点自增），
          // 倒计时以它而非 generated_at 变化作为重置终点——手动刷新在 304 / watcher 缓存
          // 命中（generated_at 不变）时也立即回到完整周期。
          h(RefreshCountdown, {
            generatedAt: b.generated_at,
            refreshSignal: refreshCycle,
            intervalSec: refreshIntervalSec,
            onTriggerRefresh: load,
          }),
          h("button", { style: tbBtnStyle, className: "dg-btn", onClick: load }, dgT("common.refresh")),
          // g-187：顶部标签筛选弹层入口
          h("button", {
            style: { ...tbBtnStyle, ...(tagFilter.length > 0 ? { borderColor: "var(--dsw-alias-state-business-primary, #4c8dff)", background: "rgba(76,141,255,.15)" } : {}) },
            className: "dg-btn" + (tagFilter.length > 0 ? " dg-btn-active" : ""),
            title: dgT("tagFilter.title"),
            onClick: () => setShowTagFilterModal(true),
          }, tagFilter.length > 0 ? dgT("tagFilter.title") + ` (${tagFilter.length})` : dgT("tagFilter.title")),
          tagFilter.length > 0
            ? h("button", {
                className: "dg-btn",
                style: { ...tbBtnStyle, marginLeft: 4, padding: "0 6px", fontSize: 11 },
                title: dgT("tagFilter.clear"),
                onClick: () => setTagFilter([]),
              }, dgT("tagFilter.clear"))
            : null,
          // g-105: 记忆管理按钮（位于设置按钮左侧）
          h("button", {
            style: tbBtnStyle,
            className: "dg-btn",
            title: dgT("memory.title"),
            onClick: () => setShowMemoryModal(true),
          }, dgT("memory.btn")),
          // g-183: 项目知识库面板入口
          h("button", {
            style: tbBtnStyle,
            className: "dg-btn",
            title: dgT("shared.title"),
            onClick: () => setShowSharedPanel(true),
          }, dgT("shared.title").split("（")[0]),
          // g-132: 右上角齿轮 → 看板设置
          h("button", {
            style: { ...tbBtnStyle, padding: "0 7px", fontSize: 14 },
            className: "dg-btn",
            title: dgT("settings.title"),
            onClick: () => setShowSettings(true),
          }, "⚙"),
          // g-110: 显示已归档目标的 checkbox（移至右侧，DEBUG 信息左侧，布局更规整）
          h("label", { style: { display: "flex", alignItems: "center", gap: 4, marginLeft: 12, cursor: "pointer", fontSize: 12, opacity: 0.8 } },
            h("input", {
              type: "checkbox",
              checked: showArchived,
              onChange: (e) => setShowArchived(e.target.checked),
            }),
            dgT("card.archived")),
          // g-113 临时诊断（灰色低调显示，两行省略，详情在 tooltip 显示，为搜索框留出空间）：显示当前解析的 workspace 与会话 id
          h("div", {
            style: {
              ...S.meta,
              color: "rgba(128,128,128,.55)",
              marginLeft: 8,
              fontSize: 10,
              lineHeight: 1.25,
              display: "flex",
              flexDirection: "column",
              maxWidth: 160,
              minWidth: 0,
              overflow: "hidden",
              cursor: "default",
              userSelect: "none",
              flexShrink: 1,
            },
            title: `DEBUG sessionId=${props?.sessionId ?? "∅"}\nws=${activeWs ?? "∅"}`,
          },
            h("span", {
              style: {
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: "100%",
                display: "block",
              },
            }, "DEBUG sessionId=" + (props?.sessionId ?? "∅")),
            h("span", {
              style: {
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: "100%",
                display: "block",
              },
            }, "ws=" + (activeWs ?? "∅"))),
          // g-233：标题行最右侧增加搜索框
          h("div", {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginLeft: "auto",
              flexShrink: 0,
            },
            className: "dg-search-bar",
          },
            h("div", { style: { position: "relative", display: "flex", alignItems: "center" } },
              h("input", {
                ref: searchInputRef,
                type: "text",
                className: "dg-search-input",
                style: {
                  width: searchActiveQuery ? 150 : 130,
                  padding: "3px 22px 3px 8px",
                  fontSize: 12,
                  borderRadius: 4,
                  border: "1px solid " + (searchActiveQuery ? "var(--dsw-alias-state-business-primary, #4c8dff)" : "var(--dsw-alias-border-l2, rgba(128,128,128,.35))"),
                  background: "var(--dsw-alias-bg-layer-2, rgba(30,31,36,.92))",
                  color: "var(--dsw-alias-label-primary, #e6e6e6)",
                  outline: "none",
                  boxSizing: "border-box",
                  height: 24,
                },
                placeholder: dgT("search.placeholder"),
                value: searchQuery,
                onChange: (e) => setSearchQuery(e.target.value),
                onKeyDown: handleSearchInputKeyDown,
              }),
              searchQuery ? h("span", {
                style: {
                  position: "absolute",
                  right: 6,
                  cursor: "pointer",
                  opacity: 0.6,
                  fontSize: 12,
                  lineHeight: 1,
                  userSelect: "none",
                },
                title: dgT("directive.clear"),
                onClick: () => {
                  setSearchQuery("");
                  if (searchActiveQuery) exitSearch();
                },
              }, "✕") : null,
            ),
            h("label", {
              style: {
                display: "flex",
                alignItems: "center",
                gap: 3,
                fontSize: 12,
                cursor: "pointer",
                userSelect: "none",
                opacity: 0.85,
                whiteSpace: "nowrap",
              },
              title: dgT("search.fullText"),
            },
              h("input", {
                type: "checkbox",
                checked: searchFullText,
                onChange: (e) => {
                  const checked = e.target.checked;
                  setSearchFullText(checked);
                  if (searchActiveQuery) executeSearch(searchQuery, checked);
                },
              }),
              dgT("search.fullText")),
            searchActiveQuery && searchMatches.length > 0 ? h(React.Fragment, null,
              h("span", {
                style: {
                  fontSize: 12,
                  opacity: 0.9,
                  fontWeight: 600,
                  minWidth: 28,
                  textAlign: "center",
                  whiteSpace: "nowrap",
                },
              }, `${searchCurrentIndex + 1}/${searchMatches.length}`),
              h("button", {
                style: { ...tbBtnStyle, padding: "1px 6px", fontSize: 13, lineHeight: 1.2, height: 24 },
                className: "dg-btn",
                title: "↑",
                onClick: () => navigateToMatch(searchCurrentIndex - 1),
              }, "‹"),
              h("button", {
                style: { ...tbBtnStyle, padding: "1px 6px", fontSize: 13, lineHeight: 1.2, height: 24 },
                className: "dg-btn",
                title: "↓",
                onClick: () => navigateToMatch(searchCurrentIndex + 1),
              }, "›"),
              h("button", {
                style: { ...tbBtnStyle, padding: "1px 6px", fontSize: 11, lineHeight: 1.2, height: 24 },
                className: "dg-btn",
                title: "Esc",
                onClick: exitSearch,
              }, "✕"),
            ) : null,
            searchFeedback ? h("span", {
              style: {
                fontSize: 12,
                color: searchFeedback === dgT("search.noResults") ? "var(--dsw-alias-state-error-primary, #ff6b6b)" : "var(--dsw-alias-label-secondary, #aaa)",
                whiteSpace: "nowrap",
              },
            }, searchFeedback) : null,
          )),
        // g-108：顶部 supervisor 状态栏（id 由 board 端点下发，未配置则不显示）；
        // g-a92e1406：statusLine 传 supervisor 自己的 status_line（board 下发 supervisorStatus）
        b.supervisorSession
          ? h(SupervisorBar, { id: b.supervisorSession, statusLine: b.supervisorStatus ?? null, statusAt: b.supervisorStatusAt ?? null })
          : null,
        // g-127/g-156/g-164：折叠时对应列窄化为 36px（blocked 和 deliver 独立折叠），
        // 列模板统一由 gridCols 按当前折叠状态动态计算，与 released 泳道网格保持一致
        h("div", { style: { ...S.grid, gridTemplateColumns: gridCols } },
          // g-174 & g-223：看板左上角单元格放置「版本管理」图标入口与「＋ 新建版本」按钮
          h("div", { style: S.stageHead },
            h("button", {
              style: { ...S.btn, fontSize: 12, padding: "2px 6px", marginRight: 4, lineHeight: 1.2 },
              className: "dg-btn dg-version-manage-btn",
              title: dgT("versionDrawer.title"),
              "aria-label": dgT("versionDrawer.title"),
              onClick: () => setShowVersionDrawer(true),
            }, "🏷️"),
            h("button", {
              style: { ...S.btn, fontSize: 12, padding: "2px 8px" },
              className: "dg-btn",
              title: dgT("createVersion.title"),
              onClick: () => {
                setShowCreateVersion(true);
                setNewVersionSlug("");
                setNewVersionName("");
                setCreateVersionNote(null);
              },
            }, dgT("createVersion.createBtn"))),
          STAGES.map((s) => {
            // g-127：blocked 列头可点击切换折叠/展开
            // g-152：折叠态列头只显示 ▸（36px 窄条，竖条单元格已有 ⛔ 标识）
            if (s.key === "blocked") {
              return h("div", {
                key: s.key,
                style: { ...S.stageHead, cursor: "pointer", userSelect: "none",
                  ...(blockedColumnCollapsed ? { minWidth: 0, padding: "4px 0", overflow: "hidden", fontSize: 14, boxSizing: "border-box", textAlign: "center" } : {}),
                },
                onClick: () => {
                  tempExpandedRef.current.blockedExpanded = false;
                  setBlockedColumnCollapsed((p) => !p);
                },
                title: blockedColumnCollapsed ? dgT("blocked.collapsedTitle", { count: 0 }) : dgT("blocked.collapsedTitle", { count: 0 }),
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
                onClick: () => {
                  tempExpandedRef.current.deliverExpanded = false;
                  setDeliverColumnCollapsed((p) => !p);
                },
                title: deliverColumnCollapsed ? dgT("deliver.collapsedTitle", { count: 0 }) : dgT("deliver.collapsedTitle", { count: 0 }),
              }, deliverColumnCollapsed
                ? "▸"
                : s.label + " ▾");
            }
            // g-273：确认列列头「批量接受」入口——0 个待确认 → disabled + 悬停说明；
            // ≥1 → 可用并显示数量。flex 行内布局：whiteSpace nowrap（继承 stageHead）+
            // overflow hidden + 按钮 flexShrink 0，150px 最小列宽与相邻列折叠/展开时不换行不重叠。
            if (s.key === "confirm") {
              const ba = batchAcceptButtonState(reviewGoals.length);
              return h("div", {
                key: s.key,
                style: { ...S.stageHead, display: "flex", alignItems: "center", justifyContent: "center",
                         gap: 6, overflow: "hidden" },
              },
                h("span", { style: { flexShrink: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } }, s.label),
                h("button", {
                  style: { ...S.btn, fontSize: 11, padding: "1px 8px", lineHeight: 1.4,
                           whiteSpace: "nowrap", flexShrink: 0, opacity: ba.disabled ? 0.5 : 1 },
                  className: "dg-btn dg-batch-accept-btn",
                  disabled: ba.disabled || batchAcceptLoading,
                  title: ba.title,
                  "aria-label": ba.label,
                  onClick: (e) => {
                    e.stopPropagation();
                    if (ba.disabled || batchAcceptLoading) return;
                    setBatchAcceptFailures(null);
                    setBatchAcceptOpen(true);
                  },
                }, batchAcceptLoading ? dgT("common.submitting") : ba.label));
            }
            return h("div", { key: s.key, style: S.stageHead }, s.label);
          }),
          ...rows),
        ...releasedRows,
        modalGoal
          ? h(GoalModal, {
              // g-256：显式稳定 key（同 g-243 dg-version-drawer 机制）——已发布版本泳道
              // 勾选增删 releasedRows 尾部兄弟时，无 key 的弹窗会被按索引匹配重建，
              // 丢失内部 state/滚动/焦点；加 key 后 React 按 key 复用同一 fiber。
              key: "dg-goal-modal",
              id: modalGoal,
              title: modalGoalData?.title,
              onClose: () => { forceReplayRef.current = { goalId: modalGoal, openTs: modalGoalOpenTsRef.current }; modalGoalOpenTsRef.current = null; modalGoalRef.current = null; setModalGoal(null); load(); },
              onPmStarted: setPolishGoal,
              onPmFinished: () => setPolishGoal(null),
              goalStatus,
              supervisorSession: b.supervisorSession ?? null,
              onRenamed: () => { forceFreshRef.current = true; load(); },
              onArchived: () => load(),
              onTagsChanged: () => load(),
              onOpenCard: (goalId, cardId) => setDrawerCard({ goalId, cardId }),
              deletedCardSignal,
              onDeletedCardHandled: () => setDeletedCardSignal(null),
              hiddenVersionSlugs,
              onUnhideVersion: (slug) => {
                setSearchUnhiddenSlugs((prev) => {
                  if (prev.has(slug)) {
                    const next = new Set(prev);
                    next.delete(slug);
                    return next;
                  }
                  return prev;
                });
                setHiddenVersionSlugs(hiddenVersionSlugs.filter((s) => s !== slug));
              },
              activeVersions: active, // g-306：活跃版本列表（供排期选择器使用）
            })
          : null,
        showVersionDrawer
          ? ReactDOM.createPortal(h(VersionDrawer, {
              // g-243：显式稳定 key。本看板根节点的 children 列表里混有带 key 的元素
              // （...releasedRows 的 rel-<slug> 行）与嵌套数组；已发布版本泳道增删会改变
              // 这些兄弟的数量，未带 key 的尾部兄弟（本抽屉）会因按位置/索引匹配失败被
              // 卸载重建，抽屉 DOM 子树（含版本清单滚动容器的 scrollTop）随之丢弃——
              // 表现为勾选/取消已发布版本的 checkbox 后清单跳回第一行。加 key 后 React
              // 按 key 复用同一 fiber，滚动位置得以保留。
              key: "dg-version-drawer",
              versions: b.versions,
              hiddenVersionSlugs,
              onToggleVersion: (slug, visible) => {
                setSearchUnhiddenSlugs((prev) => {
                  if (prev.has(slug)) {
                    const next = new Set(prev);
                    next.delete(slug);
                    return next;
                  }
                  return prev;
                });
                if (visible) {
                  setHiddenVersionSlugs(hiddenVersionSlugs.filter((s) => s !== slug), b.versions);
                } else {
                  setHiddenVersionSlugs([...hiddenVersionSlugs, slug], b.versions);
                }
              },
              onShowAll: () => {
                setSearchUnhiddenSlugs(new Set());
                setHiddenVersionSlugs([], b.versions);
              },
              onHideAll: () => {
                setSearchUnhiddenSlugs(new Set());
                setHiddenVersionSlugs(b.versions.map((v) => v.slug), b.versions);
              },
              onShowActiveOnly: () => {
                setSearchUnhiddenSlugs(new Set());
                const releasedSlugs = b.versions.filter((v) => v.status === "released").map((v) => v.slug);
                setHiddenVersionSlugs(releasedSlugs, b.versions);
              },
              onClose: () => setShowVersionDrawer(false),
              onOpenVersionDetail: (v) => {
                setVersionDetailTarget({
                  slug: v.slug,
                  name: v.name,
                  status: v.status,
                  goals_count: (v.goals ?? []).length,
                });
                loadVersionDetail(v.slug);
              },
            }), document.body)
          : null,
        drawerCard
          ? ReactDOM.createPortal(h(CardDrawer, { // g-256：稳定 key，防 releasedRows 兄弟增删时按索引重建（同 g-243）
                            key: "dg-card-drawer",
                            goalId: drawerCard.goalId, cardId: drawerCard.cardId,
                            cardData: drawerCard.cardData,
                            onClose: () => setDrawerCard(null),
                            onConverted: () => {
                              // g-183：卡片转换成功后，重新 load 全局数据与弹窗数据，绝不误剥离卡片！
                              load();
                              setDrawerCard(null);
                            },
                            onDeleted: (cardId) => {
                              // g-219：事件结果为准——删除成功后局部更新弹窗与看板，不整体重新 load
                              const goalId = drawerCard.goalId;
                              const cid = cardId ?? drawerCard.cardId;
                              if (goalId) {
                                setDeletedCardSignal({ goalId, cardId: cid, ts: Date.now() });
                                setState((s) => {
                                  if (!s.data) return s;
                                  const strip = (g) => g.id === goalId
                                    ? { ...g, cards: (g.cards ?? []).filter((c) => c.id !== cid) }
                                    : g;
                                  return {
                                    ...s,
                                    data: {
                                      ...s.data,
                                      versions: s.data.versions.map((v) => ({ ...v, goals: v.goals.map(strip) })),
                                      standalone: s.data.standalone.map(strip),
                                      backlog: s.data.backlog.map(strip),
                                    },
                                  };
                                });
                              } else {
                                load();
                              }
                              setDrawerCard(null);
                            } }), document.body)
          : null,
        // g-129: 新建目标弹窗
        showCreateGoal
          ? h("div", { style: S.overlay, ...createGoalGuard },
              h("div", { style: S.modal, onClick: (e) => e.stopPropagation() },
                h("span", { style: S.close, onClick: () => setShowCreateGoal(false) }, "✕"),
                h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 12 } }, dgT("createGoal.title")),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, dgT("createGoal.titleLabel")),
                  h("input", {
                    style: { ...S.promptInput, width: "100%" },
                    value: newGoalTitle,
                    placeholder: dgT("createGoal.titlePlaceholder"),
                    onChange: (e) => setNewGoalTitle(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") createGoal(); },
                  })),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, dgT("createGoal.descLabel")),
                  h("textarea", {
                    style: { ...S.promptInput, width: "100%", minHeight: 64, resize: "vertical" },
                    value: newGoalDesc,
                    placeholder: dgT("createGoal.descPlaceholder"),
                    onChange: (e) => setNewGoalDesc(e.target.value),
                  })),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, dgT("createGoal.versionLabel")),
                  h("select", {
                    style: { ...S.promptInput, width: "100%" },
                    value: newGoalVersion,
                    onChange: (e) => setNewGoalVersion(e.target.value),
                  },
                    h("option", { value: "", style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, dgT("createGoal.versionNone")),
                    h("option", { value: "standalone", style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, dgT("lane.newStandaloneGoal")),
                    // 版本选项来自 board 数据的 versions 列表
                    ...b.versions.map((v) => h("option", { key: v.slug, value: v.slug, style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, v.slug)))),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, dgT("createGoal.typeLabel")),
                  h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
                    ...GOAL_TYPES.map((t) =>
                      h("button", {
                        key: t,
                        style: {
                          display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11,
                          padding: "3px 8px", cursor: "pointer", borderRadius: 4,
                          border: t === newGoalType ? "1.5px solid " + goalTypeColor(t) : "1.5px solid " + goalTypeColor(t) + "66",
                          background: t === newGoalType ? goalTypeColor(t) : goalTypeColor(t) + "18",
                          color: t === newGoalType ? "#fff" : goalTypeColor(t),
                          boxShadow: t !== newGoalType ? "inset 0 0 6px " + goalTypeColor(t) + "22" : "none",
                          fontWeight: 700,
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
                  }, creating ? dgT("common.creating") : dgT("createGoal.createBtn")),
                  h("button", {
                    style: { ...S.btn, padding: "6px 12px", fontSize: 12 },
                    className: "dg-btn",
                    onClick: () => setShowCreateGoal(false),
                  }, dgT("common.cancel"))),
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
        // g-273：确认列「批量接受」二次确认弹窗（Human Gate）——
        // 取消/✕/Esc/遮罩关闭零网络请求零状态变化；确认后逐个非 force accept + 整批一条聚合主管通知
        batchAcceptOpen
          ? h(BatchAcceptModal, {
              key: "batch-accept-modal",
              items: reviewGoals.map((g) => ({
                id: g.id,
                title: g.title ?? g.id,
                versionLabel: goalVersionLabel[g.id] ?? "",
              })),
              loading: batchAcceptLoading,
              failures: batchAcceptFailures,
              onConfirm: (ids) => { void submitBatchAccept(ids); },
              onCancel: () => { if (!batchAcceptLoading) { setBatchAcceptOpen(false); setBatchAcceptFailures(null); } },
            })
          : null,
        // g-134/g-135: 版本详情弹窗（含摘要/范围/working/released 操作）
        versionDetailTarget
          ? h("div", { style: S.overlay, ...versionDetailGuard },
              h("div", { style: { ...S.modal, minWidth: 360, maxWidth: 480 }, onClick: (e) => e.stopPropagation() },
                h("span", { style: S.close, onClick: () => { setVersionDetailTarget(null); setVersionDetailData(null); } }, "✕"),
                // g-177: 重命名按钮移到版本标题右边（跟 goal 卡片交互一致：标题行内小 ✏️）
                h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 12, flexWrap: "wrap" } },
                  h("span", { style: { fontWeight: 700, fontSize: 15 } }, dgT("versionDetail.title") + "：" + versionDetailTarget.name),
                  h("button", {
                    style: { ...S.btn, fontSize: 11, padding: "1px 6px", opacity: 0.7 }, className: "dg-btn",
                    title: dgT("version.renameTitle"),
                    onClick: () => {
                      setRenameVersionTarget({ slug: versionDetailTarget.slug, name: versionDetailTarget.name });
                      setRenameVersionSlug(versionDetailTarget.slug);
                      setRenameVersionName(versionDetailTarget.name);
                      setRenameVersionNote(null);
                      setVersionDetailTarget(null);
                      setVersionDetailData(null);
                    },
                  }, "✏️"),
                ),
                // 基本信息
                h("div", { style: { marginBottom: 12, fontSize: 13, opacity: 0.8 } },
                  h("div", null, `Slug：${versionDetailTarget.slug}`),
                  h("div", null, dgT("versionDetail.status") + (versionDetailTarget.status === "released" ? "🟢 released" : versionDetailTarget.status === "active" ? "🔵 " + dgT("versionDrawer.active") : `⚪ ${versionDetailTarget.status}`)),
                  h("div", null, dgT("versionDetail.goals") + versionDetailTarget.goals_count),
                ),
                // g-135: 版本摘要/范围（从 version.md 的「范围」小节读取）
                h("div", { style: { marginBottom: 12 } },
                  h("div", { style: { fontWeight: 600, fontSize: 13, marginBottom: 4 } }, dgT("versionDetail.summary")),
                  versionDetailLoading
                    ? h("div", { style: { fontSize: 12, opacity: 0.5 } }, dgT("common.loading"))
                    : (versionDetailData?.summary || versionDetailData?.scope)
                      ? h("div", { style: { fontSize: 12, whiteSpace: "pre-wrap", lineHeight: 1.5, padding: "6px 8px", borderRadius: 4, background: "rgba(128,128,128,.08)" } },
                          versionDetailData.summary || versionDetailData.scope)
                      : h("div", { style: { fontSize: 12, opacity: 0.45, fontStyle: "italic" } }, dgT("versionDetail.emptySummary")),
                ),
                // g-135: 阻塞目标清单（发布前置条件不满足时展示）
                versionDetailData && versionDetailData.blocking && versionDetailData.blocking.length > 0
                  ? h("div", { style: { marginBottom: 12, padding: "8px 10px", borderRadius: 6, background: "rgba(255,107,107,.12)", border: "1px solid rgba(255,107,107,.3)" } },
                      h("div", { style: { fontWeight: 600, fontSize: 13, marginBottom: 4, color: "var(--dsw-alias-state-error-primary, #ff6b6b)" } }, dgT("versionDetail.blockedCount", { count: versionDetailData.blocking.length })),
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
                          if (!confirm(dgT("versionDetail.reactivateConfirm", { slug: versionDetailTarget.slug }))) return;
                          setVersionActionLoading(true);
                          setVersionActionNote(null);
                          fetch(graphUrlForActive("/api/dsh-graph/set-version-status"), {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ slug: versionDetailTarget.slug, status: "active" }),
                          }).then((r) => r.json()).then((data) => {
                            setVersionActionLoading(false);
                            if (data.ok) {
                              setVersionActionNote(dgT("versionDetail.reactivateSuccess", { slug: "" }));
                              // g-135 fix #2：同步更新 target 状态，modal 按钮立刻反映
                              setVersionDetailTarget((prev) => prev ? { ...prev, status: "active" } : prev);
                              loadVersionDetail(versionDetailTarget.slug);
                              load(); // 刷新看板
                            } else {
                              setVersionActionNote(dgT("versionDetail.requestFail") + (data.error || dgT("drag.unknownError")));
                            }
                          }).catch((e) => {
                            setVersionActionLoading(false);
                            setVersionActionNote(dgT("versionDetail.requestFail") + String(e?.message ?? e));
                          });
                        },
                      }, dgT("versionDetail.reactivate"))
                    : null,
                  // active 状态可切换回 planning
                  versionDetailTarget.status === "active"
                    ? h("button", {
                        style: { ...S.btn, padding: "6px 16px", fontSize: 13, opacity: 0.7 },
                        className: "dg-btn",
                        disabled: versionActionLoading,
                        onClick: () => {
                          if (!confirm(dgT("versionDetail.reactivateConfirm", { slug: versionDetailTarget.slug }))) return;
                          setVersionActionLoading(true);
                          setVersionActionNote(null);
                          fetch(graphUrlForActive("/api/dsh-graph/set-version-status"), {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ slug: versionDetailTarget.slug, status: "planning" }),
                          }).then((r) => r.json()).then((data) => {
                            setVersionActionLoading(false);
                            if (data.ok) {
                              setVersionActionNote(dgT("versionDetail.reactivateSuccess", { slug: "" }));
                              // g-135 fix #2：同步更新 target 状态
                              setVersionDetailTarget((prev) => prev ? { ...prev, status: "planning" } : prev);
                              loadVersionDetail(versionDetailTarget.slug);
                              load();
                            } else {
                              setVersionActionNote(dgT("versionDetail.requestFail") + (data.error || dgT("drag.unknownError")));
                            }
                          }).catch((e) => {
                            setVersionActionLoading(false);
                            setVersionActionNote(dgT("versionDetail.requestFail") + String(e?.message ?? e));
                          });
                        },
                      }, dgT("versionDetail.reactivate"))
                    : null,
                  // 标记为 released —— 仅非 released 时显示
                  versionDetailTarget.status !== "released"
                    ? h("button", {
                        style: { ...S.btn, padding: "6px 16px", fontSize: 13, color: "var(--dsw-alias-label-primary, #4caf50)", background: "rgba(76,175,80,.12)", border: "1px solid rgba(76,175,80,.4)" },
                        className: "dg-btn",
                        disabled: versionActionLoading,
                        onClick: () => {
                          // 先检查阻塞清单
                          const blocking = versionDetailData?.blocking ?? [];
                          if (blocking.length > 0) {
                            setVersionActionNote(dgT("versionDetail.releaseBlocked", { count: blocking.length }));
                            return;
                          }
                          if (!confirm(dgT("versionDetail.releaseConfirm", { slug: versionDetailTarget.slug }))) return;
                          setVersionActionLoading(true);
                          setVersionActionNote(null);
                          fetch(graphUrlForActive("/api/dsh-graph/release-version"), {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ slug: versionDetailTarget.slug }),
                          }).then((r) => r.json()).then((data) => {
                            setVersionActionLoading(false);
                            if (data.ok === true) {
                              setVersionActionNote(dgT("versionDetail.releaseSuccess", { slug: versionDetailTarget?.slug ?? "" }));
                              // g-135 fix #2：同步更新 target 状态，modal 按钮立刻反映（不再显示 released 按钮）
                              setVersionDetailTarget((prev) => prev ? { ...prev, status: "released" } : prev);
                              loadVersionDetail(versionDetailTarget.slug);
                              load();
                            } else if (data.ok === false && data.blocking) {
                              setVersionActionNote(dgT("versionDetail.releaseBlocked", { count: data.blocking.length }));
                              loadVersionDetail(versionDetailTarget.slug); // 刷新阻塞清单
                            } else {
                              setVersionActionNote(dgT("versionDetail.releaseFail") + (data.error || dgT("drag.unknownError")));
                            }
                          }).catch((e) => {
                            setVersionActionLoading(false);
                            setVersionActionNote(dgT("versionDetail.requestFail") + String(e?.message ?? e));
                          });
                        },
                      }, dgT("versionDetail.release"))
                    : null,
                  // g-160: 恢复 released 版本为 active —— 仅 released 时显示
                  versionDetailTarget.status === "released"
                    ? reactivateConfirm
                      ? h("div", { style: { padding: "8px 12px", borderRadius: 6, background: "rgba(255,152,0,.15)", border: "1px solid rgba(255,152,0,.4)", fontSize: 12, lineHeight: 1.5 } },
                          h("div", { style: { fontWeight: 600, marginBottom: 4, color: "var(--dsw-alias-state-warn-label, #ff9800)" } }, dgT("versionDetail.reactivateConfirm", { slug: versionDetailTarget.slug })),
                          h("div", { style: { marginBottom: 8, opacity: 0.85 } }, dgT("versionDetail.reactivateDescription", { slug: versionDetailTarget.slug })),
                          h("div", { style: { display: "flex", gap: 8 } },
                            h("button", {
                              style: { ...S.btn, padding: "6px 16px", fontSize: 13, color: "var(--dsw-alias-label-primary, #ff9800)", background: "rgba(255,152,0,.12)", border: "1px solid rgba(255,152,0,.4)" },
                              className: "dg-btn",
                              disabled: reactivatingVersion,
                              onClick: () => {
                                setReactivatingVersion(true);
                                setVersionActionNote(null);
                                fetch(graphUrlForActive("/api/dsh-graph/set-version-status"), {
                                  method: "POST",
                                  headers: { "content-type": "application/json" },
                                  body: JSON.stringify({ slug: versionDetailTarget.slug, status: "active", confirmed: true }),
                                }).then((r) => r.json()).then((data) => {
                                  setReactivatingVersion(false);
                                  setReactivateConfirm(false);
                                  if (data.ok) {
                                    setVersionActionNote(dgT("versionDetail.reactivateSuccess", { slug: versionDetailTarget?.slug ?? "" }));
                                    setVersionDetailTarget((prev) => prev ? { ...prev, status: "active" } : prev);
                                    loadVersionDetail(versionDetailTarget.slug);
                                    load();
                                  } else {
                                    setVersionActionNote(dgT("versionDetail.reactivateFail") + (data.error || dgT("drag.unknownError")));
                                  }
                                }).catch((e) => {
                                  setReactivatingVersion(false);
                                  setReactivateConfirm(false);
                                  setVersionActionNote(dgT("versionDetail.requestFail") + String(e?.message ?? e));
                                });
                              },
                            }, dgT("versionDetail.reactivateConfirm", { slug: versionDetailTarget?.slug ?? "" })),
                            h("button", {
                              style: { ...S.btn, padding: "6px 16px", fontSize: 13, opacity: 0.7 },
                              className: "dg-btn",
                              disabled: reactivatingVersion,
                              onClick: () => { setReactivateConfirm(false); setVersionActionNote(null); },
                            }, dgT("common.cancel")),
                          )
                        )
                      : h("button", {
                          style: { ...S.btn, padding: "6px 16px", fontSize: 13, color: "var(--dsw-alias-label-primary, #ff9800)", background: "rgba(255,152,0,.08)", border: "1px solid rgba(255,152,0,.3)" },
                          className: "dg-btn",
                          disabled: versionActionLoading,
                          onClick: () => { setReactivateConfirm(true); setVersionActionNote(null); },
                        }, dgT("versionDetail.reactivate"))
                    : null,
                  // 删除
                  h("button", {
                    style: { ...S.btn, padding: "6px 16px", fontSize: 13, color: "var(--dsw-alias-state-error-primary, #ff6b6b)", opacity: 0.7 },
                    className: "dg-btn",
                    onClick: () => {
                      setDeleteVersionTarget({ slug: versionDetailTarget.slug, name: versionDetailTarget.name });
                      setDeleteVersionNote(null);
                      setVersionDetailTarget(null);
                      setVersionDetailData(null);
                    },
                  }, dgT("goal.delete")),
                ),
              ))
          : null,
        // g-132: 看板设置弹窗（gear 入口）
        showSettings
          ? h(SettingsModal, { key: "dg-settings-modal", onClose: () => setShowSettings(false), onSaved: () => load() })
          : null,
        // g-183: 共享上下文管理面板（🔗 入口）
        showSharedPanel
          ? h(SharedCardsModal, {
              key: "dg-shared-cards-modal", // g-256：稳定 key，防 releasedRows 兄弟增删时按索引重建
              onClose: () => setShowSharedPanel(false),
              onRefresh: () => load(),
              onOpenCard: (goalId, cardId, cardData) => setDrawerCard({ goalId, cardId, cardData }),
              sharedCards: b.sharedCards ?? [],
              goals: [
                ...(b.versions ?? []).flatMap((v) => v.goals ?? []),
                ...(b.standalone ?? []),
                ...(b.backlog ?? []),
              ].map((g) => ({ id: g.id, title: g.title })),
            })
          : null,
        // g-134: 创建版本泳道弹窗
        showCreateVersion
          ? h("div", { style: S.overlay, ...createVersionGuard },
              h("div", { style: S.modal, onClick: (e) => e.stopPropagation() },
                h("span", { style: S.close, onClick: () => setShowCreateVersion(false) }, "✕"),
                h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 12 } }, dgT("createVersion.title")),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, dgT("createVersion.slugLabel")),
                  h("input", {
                    style: { ...S.promptInput, width: "100%" },
                    value: newVersionSlug,
                    placeholder: dgT("createVersion.slugPlaceholder"),
                    onChange: (e) => setNewVersionSlug(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") createVersionFn(); },
                  })),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, dgT("createVersion.nameLabel")),
                  h("input", {
                    style: { ...S.promptInput, width: "100%" },
                    value: newVersionName,
                    placeholder: dgT("createVersion.namePlaceholder"),
                    onChange: (e) => setNewVersionName(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") createVersionFn(); },
                  })),
                h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                  h("button", {
                    style: { ...S.btn, padding: "6px 16px", fontSize: 13 },
                    className: "dg-btn",
                    disabled: creatingVersion,
                    onClick: createVersionFn,
                  }, creatingVersion ? dgT("common.creating") : dgT("createVersion.createBtn")),
                  h("button", {
                    style: { ...S.btn, padding: "6px 12px", fontSize: 12 },
                    className: "dg-btn",
                    onClick: () => setShowCreateVersion(false),
                  }, dgT("common.cancel"))),
                createVersionNote ? h("div", { style: { ...S.meta, marginTop: 8 } }, createVersionNote) : null))
          : null,
        // g-134: 重命名版本泳道弹窗
        renameVersionTarget
          ? h("div", { style: S.overlay, ...renameVersionGuard },
              h("div", { style: S.modal, onClick: (e) => e.stopPropagation() },
                h("span", { style: S.close, onClick: () => { setRenameVersionTarget(null); setRenameVersionNote(null); } }, "✕"),
                h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 12 } }, dgT("version.renameTitle")),
                h("div", { style: { marginBottom: 8, fontSize: 13, opacity: 0.8 } }, dgT("version.renameCurrent", { name: renameVersionTarget.name, slug: renameVersionTarget.slug })),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, dgT("version.renameSlugPlaceholder")),
                  h("input", {
                    style: { ...S.promptInput, width: "100%" },
                    value: renameVersionSlug,
                    placeholder: dgT("version.renameSlugPlaceholder"),
                    onChange: (e) => setRenameVersionSlug(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") renameVersionFn(); },
                  })),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, dgT("version.renameNamePlaceholder")),
                  h("input", {
                    style: { ...S.promptInput, width: "100%" },
                    value: renameVersionName,
                    placeholder: dgT("version.renameNamePlaceholder"),
                    onChange: (e) => setRenameVersionName(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") renameVersionFn(); },
                  })),
                h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                  h("button", {
                    style: { ...S.btn, padding: "6px 16px", fontSize: 13 },
                    className: "dg-btn",
                    disabled: renamingVersion,
                    onClick: renameVersionFn,
                  }, renamingVersion ? dgT("common.saving") : dgT("version.renameBtn")),
                  h("button", {
                    style: { ...S.btn, padding: "6px 12px", fontSize: 12 },
                    className: "dg-btn",
                    onClick: () => { setRenameVersionTarget(null); setRenameVersionNote(null); },
                  }, dgT("common.cancel"))),
                renameVersionNote ? h("div", { style: { ...S.meta, marginTop: 8 } }, renameVersionNote) : null))
          : null,
        // g-105: 记忆管理弹窗（手工管理常驻/按需记忆，支持一键禁用工具）
        showMemoryModal
          ? h(MemoryManagementModal, {
              key: "dg-memory-modal", // g-256：稳定 key，防 releasedRows 兄弟增删时按索引重建
              workspace: activeWs,
              onClose: () => setShowMemoryModal(false),
            })
          : null,
        // g-187: 标签多选筛选弹窗/面板
        showTagFilterModal
          ? h("div", { style: S.overlay, ...tagFilterGuard },
              h("div", { style: { ...S.modal, minWidth: 320, maxWidth: 440 }, onClick: (e) => e.stopPropagation() },
                h("span", { style: S.close, onClick: () => setShowTagFilterModal(false) }, "✕"),
                h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 } },
                  dgT("tagFilter.title"),
                  h("span", { style: { ...S.meta, fontSize: 11, fontWeight: 400 } }, "")),
                h("div", { style: { ...S.meta, marginBottom: 10 } }, ""),
                h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 220, overflowY: "auto", padding: "2px 0", marginBottom: 12 } },
                  (() => {
                    const allAvailableTags = [...new Set(allGoals.flatMap((g) => tagsFor(g)))].sort();
                    if (!allAvailableTags.length) return h("span", { style: S.meta }, dgT("tagFilter.noTags"));
                    return allAvailableTags.map((tag) => {
                      const selected = tagFilter.includes(tag);
                      return h("button", {
                        key: tag,
                        className: "dg-btn",
                        style: {
                          ...S.btn,
                          fontSize: 12,
                          padding: "3px 8px",
                          borderRadius: 12,
                          background: selected ? "var(--dsw-alias-button-primary-fill, #4c8dff)" : "rgba(76,141,255,.12)",
                          color: selected ? "var(--dsw-alias-label-primary-foreground, #fff)" : "var(--dsw-alias-label-primary, inherit)",
                          borderColor: selected ? "var(--dsw-alias-button-primary-fill, #4c8dff)" : "rgba(76,141,255,.35)",
                        },
                        onClick: () => {
                          if (selected) setTagFilter(tagFilter.filter((t) => t !== tag));
                          else setTagFilter([...tagFilter, tag]);
                        },
                      }, (selected ? "✓ " : "") + "#" + tag);
                    });
                  })()),
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid rgba(128,128,128,.2)", paddingTop: 10 } },
                  h("span", { style: S.meta }, dgT("tagFilter.selected", { count: tagFilter.length })),
                  h("div", { style: { display: "flex", gap: 8 } },
                    tagFilter.length > 0 ? h("button", { className: "dg-btn", style: S.btn, onClick: () => setTagFilter([]) }, dgT("tagFilter.clear")) : null,
                    h("button", { className: "dg-btn", style: S.btnPrimary, onClick: () => setShowTagFilterModal(false) }, dgT("common.ok"))))))
          : null,
        // g-134: 删除版本泳道确认弹窗
        deleteVersionTarget
          ? h("div", { style: S.overlay, ...deleteVersionGuard },
              h("div", { style: S.modal, onClick: (e) => e.stopPropagation() },
                h("span", { style: S.close, onClick: () => { setDeleteVersionTarget(null); setDeleteVersionNote(null); } }, "✕"),
                h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 12 } }, dgT("version.deleteTitle")),
                h("div", { style: { marginBottom: 12, fontSize: 13, opacity: 0.8 } }, dgT("version.deleteConfirm", { slug: deleteVersionTarget.slug })),
                h("div", { style: { marginBottom: 12, fontSize: 12, color: "var(--dsw-alias-state-error-primary, #ff6b6b)" } }, dgT("version.deleteEmptyOnly")),
                h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                  h("button", {
                    style: { ...S.btn, padding: "6px 16px", fontSize: 13, background: "#e74c3c", color: "#fff" },
                    className: "dg-btn",
                    disabled: deletingVersion,
                    onClick: deleteVersionFn,
                  }, deletingVersion ? dgT("common.processing") : dgT("version.deleteBtn")),
                  h("button", {
                    style: { ...S.btn, padding: "6px 12px", fontSize: 12 },
                    className: "dg-btn",
                    onClick: () => { setDeleteVersionTarget(null); setDeleteVersionNote(null); },
                  }, dgT("common.cancel"))),
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

    // Source contracts: title: "打开版本详情"; "交", h("br"), "付", h("br"), `×${count}`; "aria-label": "折叠泳道"; 看板数据自动刷新; title: "版本管理（显隐过滤与版本列表）".
    // Fail-closed contract retains the localized phrase 无法确定工作区 in the board fallback.
    // Contract shape: h("div", { style: { ...S.grid, gridTemplateColumns: gridCols } }, h("div", { style: S.stageHead },
    // h("button", { style: {} }, "＋ 新建版本"));
    // Contract shape: "阻", h("br"), "塞", h("br"), `×${orderedGoals.length}`; "aria-label": "折叠泳道"; 撤销发布状态; 看板数据自动刷新
    // Contract text: 已隐藏全部 2 个版本（包含已发布版本）; title: "版本管理（显隐过滤与版本列表）"
