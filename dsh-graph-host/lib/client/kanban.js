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
      // g-352 att-005：头部 ref——「装不下就把六项工具条收进 ⋯ 工具」按**头部自身实测**判定
      //（视口宽度无关：会话页看板页签与右侧栏可用宽度都由外层容器决定）。
      const headRef = React.useRef(null);
      // g-352：窄宽度响应式——断点真源是**看板根容器实测宽度**（不是 window 宽度：
      // 右侧栏由宿主拖拽改宽时 window 宽度不变）。ResizeObserver 观测 S.wrap 的 clientWidth。
      // att-005（负责人 gate「两侧完全一致」）：会话页看板页签与右侧栏渲染同一个 KanbanView、
      // 同一份头部/工具条实现、零 host 门控 ⇒ 两侧都挂观测、都按同一套断点与折叠逻辑渲染。
      // 未测量/无 ResizeObserver 时保持 Infinity（= wide 档），默认外观与全宽路径一致。
      // 注意：根节点只在数据就绪后才渲染（loading/错误分支是裸 div、没有 ref），普通 useRef 变更
      // 又不触发 effect ⇒ 必须在依赖里带上「已挂载」与 kanbanRenderKey（换节点），否则观测会在
      // 根节点还不存在时挂上并永久失效（真机 3082 实测踩到）。
      const [boardWidth, setBoardWidth] = React.useState(Infinity);
      // g-352：窄宽度弹层（工具条折叠容器）开关
      const [showHeadOverflow, setShowHeadOverflow] = React.useState(false);
      // g-352：单版本模式选中的版本 slug——**仅会话内 React state，不落任何持久化存储**
      //（口径：无键名、作用域=KanbanView 实例；隐藏状态唯一持久真源仍是 hiddenVersionSlugs）。
      const [viewVersionSlug, setViewVersionSlug] = React.useState(null);
      // g-352：「全部版本」哨兵值（非版本 slug；不落任何持久化存储，与 viewVersionSlug 同生命周期）
      const VIEW_ALL_VERSIONS_SLUG = "__all__";
      // g-352（负责人裁决 2026-09-24，修正侦察期定策点 #4）：backlog 同样是单版本档下的一个
      // **版本备选** —— 它不是版本、而是「唯一泳道」，故与「全部版本」一样用哨兵值表示，
      // 绝不与任何版本 slug 混淆（版本 slug 就叫 "backlog" 也不会被误判）。
      const VIEW_BACKLOG_SLUG = "__backlog__";
      // g-352（负责人人工 gate 反馈 2026-09-24 → att-003 第 5 项③）：单泳道档 = {版本, backlog, 独立目标}。
      // 独立目标与 backlog 同口径：哨兵值 + **复用既有 lane 渲染路径**（真有卡片，不是只有计数）。
      const VIEW_STANDALONE_SLUG = "__standalone__";
      const [showVersionPicker, setShowVersionPicker] = React.useState(false);
      // g-352 att-003：弹层锚定（真机裁切修正）——{right, minWidth}；测量不可用时为 null（回落 right:0）
      const [popoverAnchorState, setPopoverAnchorState] = React.useState(null);
      const versionPickerRef = React.useRef(null);
      const headOverflowRef = React.useRef(null);
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
            } else if (isMoveToBacklogRejection(data.code)) {
              // g-352：带附件目标移回 backlog 被服务端拒绝 → 稳定错误码 → 本地化失败态提示
              //（旧实现用中文子串匹配服务端文案，永远匹配不上；也避免中文原文漏进英文界面）
              showToast(dgT('drag.moveToBacklogError'));
            } else {
              showToast(dgT('drag.moveToFail') + (data.error || dgT('drag.unknownError')));
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

      // g-352：根节点是否已挂载（数据就绪）——作为观测 effect 的依赖之一
      const boardMounted = !state.loading && !!state.data;
      // g-352：看板根容器实测宽度的观测（取代 g-330 的纯 CSS 最小适配）。
      // 两个宿主（会话页看板页签 / 右侧栏）都用同一份实现、都挂观测 ⇒ 两侧行为完全一致。
      React.useEffect(() => {
        const el = boardRootRef.current;
        if (!el) return undefined;
        const measure = () => {
          const w = typeof el.clientWidth === "number" && el.clientWidth > 0
            ? el.clientWidth
            : (el.getBoundingClientRect?.().width ?? Infinity);
          // 亚像素抖动不触发重渲染，避免 ResizeObserver 与 React 更新互相抖死。
          setBoardWidth((prev) => (Math.abs(prev - w) < 1 ? prev : w));
        };
        measure();
        if (typeof ResizeObserver === "undefined") return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
      }, [activeWs, boardMounted, kanbanRenderKey]);
      // 断点分档（阈值与派生集中在 narrow-width.js 纯函数模块，便于断言同一实现）
      const widthTier = boardWidthTier(boardWidth);
      // 两侧完全一致（att-005）：窄档判定不再有 host 门控——会话页看板页签同样是窄档。
      const narrowActive = widthTier !== "wide";
      const narrowSingleTier = isSingleVersionTier(boardWidth);
      // g-352 att-005：「装不下就把**六项工具条**（刷新/标签筛选/记忆/项目知识库/⚙/已归档）
      // 收进「⋯ 工具」弹层」的**实测**判定——断点档（<480）之外，头部自然宽度超过可用宽度时
      // 同样折叠，否则 S.head 单行 flex 会把按钮压成逐字竖排（负责人 1585px 截图；
      // 真机实测：英文界面下头部自然宽度 ≈1318px > 会话页 1298px 可用宽度）。
      // 状态派生全部在 narrow-width.js（headNaturalWidth / fitCollapseState），这里只做测量接线。
      const [toolbarCollapsedByFit, setToolbarCollapsedByFit] = React.useState(false);
      const headExpandedNeedRef = React.useRef(0);
      // 头部内容键：内容变化（标签筛选激活、搜索计数/反馈、已归档开关）也要重测自然宽度
      const headContentKey = [
        tagFilter.length, searchActiveQuery ? 1 : 0, searchMatches.length,
        searchFeedback ? 1 : 0, searchFullText ? 1 : 0, showArchived ? 1 : 0,
      ].join("|");
      React.useLayoutEffect(() => {
        const el = headRef.current;
        if (!el) return undefined;
        const measure = () => {
          const kids = Array.from(el.children || []);
          const natural = headNaturalWidth(kids.map((k) => k.offsetWidth), S.head.gap);
          const next = fitCollapseState({
            collapsed: toolbarCollapsedByFit,
            naturalWidth: natural,
            availableWidth: el.clientWidth,
            expandedNeed: headExpandedNeedRef.current,
          });
          if (!next) return;   // 测量不可用（vm/SSR/首帧）⇒ 保持现状，只按断点分档
          headExpandedNeedRef.current = next.expandedNeed;
          setToolbarCollapsedByFit((prev) => (prev === next.collapsed ? prev : next.collapsed));
        };
        measure();
        if (typeof ResizeObserver === "undefined") return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
      }, [boardMounted, activeWs, kanbanRenderKey, toolbarCollapsedByFit, headContentKey]);
      // 折叠与否：断点档（<480px）**强制**折叠；其余档位由头部实测决定（装不下才折叠）。
      const toolbarCollapsed = shouldCollapseToolbar(boardWidth) || toolbarCollapsedByFit;
      // g-352（负责人裁决）：单版本档的视图选择器可选 backlog —— 选中后 backlog 成为**唯一泳道**。
      // 与单版本收窄完全同口径（搜索激活时一律挂起，保证 g-233 的搜索匹配不被视图过滤藏掉）；
      // 同样是纯派生，不新增状态真源、不落任何持久化键。
      const viewBacklogOnly = !!(narrowSingleTier && !searchActiveQuery && viewVersionSlug === VIEW_BACKLOG_SLUG);
      // g-352（att-003 第 5 项③）：独立目标也可作为单泳道档的视图备选，口径与 backlog 完全一致
      //（搜索激活时一律挂起；纯派生，不新增状态真源、不落任何持久化键）。
      const viewStandaloneOnly = !!(narrowSingleTier && !searchActiveQuery && viewVersionSlug === VIEW_STANDALONE_SLUG);

      // g-352 降级：栏宽拉回全宽（或离开单版本档）时收起窄宽度专属浮层，不残留、不抛错（判据 7）。
      React.useEffect(() => {
        if (!narrowActive) setShowHeadOverflow(false);
        if (!narrowSingleTier) setShowVersionPicker(false);
      }, [narrowActive, narrowSingleTier]);

      // g-352：两个内联下拉（工具条折叠容器 / 查看版本选择器）的点击外部关闭——
      // 与排期版本选择器 card.js 完全同一套交互（document mousedown + wrapRef.contains）。
      React.useEffect(() => {
        if (!showVersionPicker && !showHeadOverflow) return undefined;
        const onDoc = (e) => {
          if (showVersionPicker && versionPickerRef.current && !versionPickerRef.current.contains(e.target)) setShowVersionPicker(false);
          if (showHeadOverflow && headOverflowRef.current && !headOverflowRef.current.contains(e.target)) setShowHeadOverflow(false);
        };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
      }, [showVersionPicker, showHeadOverflow]);

      // g-352（负责人裁决）：选中 backlog 作为「版本备选」时必须真正给出**卡片**，不能只有计数——
      // backlog 明细走既有惰性路径（b.backlog 按需拉取 + backlogRow 渲染）。这里在选中时立即调
      // 既有 loadBacklogGoals（去重防竞态已由 sectionPromisesRef 保证），不依赖 1.5s 空闲预加载
      //（否则单泳道档（g-356 起 <480px）下选中瞬间泳道只有计数、要等预加载才有卡片）。
      React.useEffect(() => {
        if (!viewBacklogOnly) return;
        const bd = state.data;
        if (bd && bd.lazy && !bd.backlog_loaded && (!bd.backlog || bd.backlog.length === 0) && bd.backlog_count !== 0) {
          loadBacklogGoals();
        }
      }, [viewBacklogOnly, state.data]);

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
      // g-352：单泳道档（g-356 起 <480px）的可见版本派生（判据 3）——**只做投影，不新增状态真源**：
      // 入参 active 已是「hiddenVersionSlugs 持久底账 + searchUnhiddenSlugs 搜索临时覆盖层」
      // 共同作用后的结果，这里仅再收窄到一个版本。
      // 持久化口径：viewVersionSlug 只存在于本组件 React state（**零持久化键**，
      // 作用域=KanbanView 实例）；隐藏状态的唯一持久真源仍是 useHiddenVersionSlugs 的
      // hiddenVersionSlugs（其键名/作用域由该 hook 唯一持有，本目标不新增任何存储读写）。
      // 与 g-233 的优先级：搜索处于激活态时**挂起**单泳道收窄，保证搜索匹配不被视图过滤藏掉。
      // 选中态四义：null=未显式选择（有可见版本→收窄到第一个可见版本；无可见版本→独立目标，见下）/
      //   slug=该版本 /
      //   VIEW_ALL_VERSIONS_SLUG=「全部版本」（显式退出收窄，回到多泳道横向档）/
      //   VIEW_BACKLOG_SLUG=backlog 唯一泳道（负责人裁决；见 viewBacklogOnly）/
      //   VIEW_STANDALONE_SLUG=独立目标唯一泳道（att-003 第 5 项③；见 viewStandaloneOnly）。
      //
      // g-358（负责人 2026-09-25 实测报障修复）：**standalone 也是常驻「版本」**——窄档（<480px）下
      // 「可见版本为空」（versions: []，或版本全被隐藏/仅剩 released）时，默认落点就是独立目标这条
      // 常驻泳道，而不再回落横向多泳道网格（横向网格在 <480 必然比面板宽、确认列被裁）。
      // 只兜「未显式选择」这一种：显式「全部版本」仍是显式退出收窄（判据 2），backlog / 独立目标
      // 显式选中由 viewBacklogOnly / viewStandaloneOnly 各自成立。纯派生：不新增状态真源、不落持久化键。
      const standaloneLaneDefault = !!(narrowSingleTier && !searchActiveQuery && !viewBacklogOnly && !viewStandaloneOnly
        && viewVersionSlug !== VIEW_ALL_VERSIONS_SLUG && active.length === 0);
      // 单泳道档里「独立目标泳道」的**实际生效态** = 显式选中 ∪ 无可见版本时的默认落点。
      // 渲染分支 / 选择器当前项 / 下拉勾选三处共用这一个布尔 ⇒ 不会出现「默认落了 standalone
      // 泳道、选择器却还显示『全部版本』」的口径分裂。
      const standaloneLaneActive = !!(viewStandaloneOnly || standaloneLaneDefault);
      const singleVersion = (narrowSingleTier && !searchActiveQuery && !viewBacklogOnly && !standaloneLaneActive && viewVersionSlug !== VIEW_ALL_VERSIONS_SLUG)
        ? pickSingleVersion(active, viewVersionSlug)
        : null;
      // 「单泳道档」= 收窄到某一个版本 **或** 收窄到 backlog / 独立目标（三者都用单列全宽纵向排布，
      // 且都只渲染一个泳道；released 在该档一律不渲染）。
      const singleLaneMode = !!(narrowSingleTier && !searchActiveQuery && (singleVersion || viewBacklogOnly || standaloneLaneActive));
      // ===== g-366（负责人 2026-09-26 裁决 (a)）：窄档搜索激活 ⇒ 单列「搜索结果」聚合泳道 =====
      // 报障形态：窄档（实测 <480px）搜索时布局档位被切换回横向多泳道全宽网格（面板比网格窄、被裁）。
      // 新口径：**收窄**不再被搜索挂起，而是换成一条**单列纵向的「搜索结果」聚合泳道**——跨分区
      //（多版本 / backlog / 独立目标 / 已隐藏版本）的全部命中都在这条泳道里纵向呈现，非命中不渲染。
      // 命中集合与顺序沿用**既有** searchMatches（含 snippet），卡片入参沿用既有
      // _searchQuery / _isSearchMatched / _isSearchCurrent / _snippet ⇒ 不改搜索语义、不改匹配集合；
      // g-233「搜索命中不得被视图过滤藏掉」因此既不回退也不需要原来的「挂起收窄」实现方式。
      // 纯派生：零新增状态真源、零新增持久化键（searchActiveQuery / searchMatches 都是既有 state）。
      // N=0（无命中）：仍进单列档（不回横向网格）但**不渲染空泳道**，既有「未找到匹配」空态在工具条上。
      const searchLaneActive = !!(narrowSingleTier && !!searchActiveQuery);
      const searchLaneMode = !!(searchLaneActive && searchMatches.length > 0);
      // 布局/行渲染的单列闸门：单泳道档（非搜索）∪ 搜索聚合泳道 —— 两者都用「minmax(0, 1fr)」单列模板。
      const singleColumnMode = !!(singleLaneMode || searchLaneActive);

      // ===== g-352：头部/泳道共用的按钮与「查看版本」选择器（样式与元素都在泳道渲染之前就位）=====
      // g-352 att-003 第 9 项：工具条按钮的尺寸口径**收敛到 narrow-width.js 的 rowBtnStyle()**
      //（唯一真源）——高度/字号/行高/内边距/圆角基准只此一处，头部、工具条、版本行、折叠弹层
      // 全部复用；图标按钮走 rowBtnStyle({ iconOnly: true })（与同行文字按钮等高的 1:1 方形）。
      // 展开后的键值与原字面量**逐字一致**（会话内 conversation.view 路径样式零变化）。
      const tbBtnStyle = { ...S.btn, ...rowBtnStyle(), marginLeft: 8 };
      // 兜底：把按钮搬进弹层并不能解决「触发按钮自身」的溢出——S.head 单行 flex 的每个子项默认
      // min-width:auto 不可收缩到内容宽度以下，文字会顶出按钮框。同时给 min-width:0 + 省略号
      //（与 constants.js 的 .dg-narrow-head-btn 同款）才真正无溢出（判据 2）。
      const narrowHeadBtnStyle = narrowActive
        ? { minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
        : null;
      const headBtnStyle = narrowHeadBtnStyle ? { ...tbBtnStyle, ...narrowHeadBtnStyle } : tbBtnStyle;
      const headBtnClass = "dg-btn" + (narrowActive ? " dg-narrow-head-btn" : "");
      // 单泳道档的泳道头部预留「选择器 + [ + ]」的横向空间（选择器在 right:40、[ + ] 在 right:6；
      // 该字面量与既有的 40px 标题预留区分开，不动既有四条标题预留）
      const singleLaneLabelPaddingRight = 136;
      // 当前视图名（选择器触发器文案；独立目标与 backlog 各按自己的泳道口径显示）。
      // g-358：无可见版本时默认落到独立目标 ⇒ 触发器也必须显示「独立目标」（判据 3），
      // 故这里吃 standaloneLaneActive（显式选中 ∪ 默认落点），不是只看显式选中。
      const viewPickerCurrentLabel = viewBacklogOnly
        ? dgT("view.backlogLane")
        : (standaloneLaneActive ? dgT("lane.standalone") : (singleVersion ? singleVersion.name : dgT("view.allVersions")));
      // g-352 att-003 第 8 项：版本选择下拉从头部移入**版本泳道头部行**（创建 goal 的 [ + ] 左侧）。
      // inLane=true ⇒ 绝对定位到泳道标题右侧、紧贴 [ + ] 左边；inLane=false ⇒ 头部行内联（「全部版本」态）。
      const renderVersionPicker = (inLane) => h("span", {
        key: inLane ? "vp-lane" : "tb-version-picker",
        ref: versionPickerRef,
        style: inLane
          ? { position: "absolute", right: 40, top: 8, display: "inline-block", minWidth: 0, maxWidth: 110, zIndex: 5 }
          : { display: "inline-block", position: "relative", verticalAlign: "middle", minWidth: 0, maxWidth: "100%", flexShrink: 0 },
      },
        h("button", {
          style: inLane ? { ...headBtnStyle, maxWidth: 110 } : headBtnStyle,
          className: headBtnClass + " dg-version-picker-trigger",
          title: dgT("view.pickVersionTooltip"),
          "aria-label": dgT("view.pickVersionTooltip"),
          "aria-expanded": showVersionPicker ? "true" : "false",
          onClick: (e) => { e.stopPropagation(); anchorPopover(versionPickerRef.current, 220); setShowVersionPicker((v) => !v); },
        }, viewPickerTriggerText(dgT("view.pickVersion", { version: viewPickerCurrentLabel }))),
        showVersionPicker
          // maxHeight + 纵向滚动：版本数量多时也必须够得到末尾的 backlog / 独立目标选项（负责人裁决
          // 要求 backlog **必须可选**，不能因菜单被裁掉而实际不可达）。
          // g-352 att-003 真机修正：向左展开（left:auto + right:0）——按 left:0 右伸会被侧栏右缘裁掉
          ? h("div", { style: { ...S.inlineMenu, left: "auto", right: popoverAnchorState?.right ?? 0,
                                 minWidth: popoverAnchorState?.minWidth ?? 220, maxHeight: "60vh", overflowY: "auto" }, onClick: (e) => e.stopPropagation() },
          h("div", { style: { fontSize: 11, opacity: 0.6, padding: "2px 10px 4px", borderBottom: "1px solid rgba(128,128,128,.2)" } },
            dgT("view.pickVersionTooltip")),
          h("div", {
            className: "dg-schedule-version-item",
            style: { padding: "5px 10px", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
            onClick: () => { setViewVersionSlug(VIEW_ALL_VERSIONS_SLUG); setShowVersionPicker(false); },
          }, viewOptionLabel("all", dgT("view.allVersions"), viewVersionSlug === VIEW_ALL_VERSIONS_SLUG)),
          ...active.map((v) => h("div", {
            key: "vp-" + v.slug,
            className: "dg-schedule-version-item",
            style: { padding: "5px 10px", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
            onClick: () => { setViewVersionSlug(v.slug); setShowVersionPicker(false); },
          }, viewOptionLabel("version", v.name || v.slug, !!(singleVersion && singleVersion.slug === v.slug)))),
          // g-352（负责人裁决）：backlog 也是单泳道档下的一个「版本备选」——选中它 backlog
          // 成为**唯一泳道**（明细走既有惰性路径，见 backlogRow 的 vertical 分支）。
          // 排期选择器**不提供**本选项（两条选择器语义不同，别混淆）。
          h("div", {
            key: "vp-backlog",
            className: "dg-schedule-version-item",
            style: { padding: "5px 10px", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
            onClick: () => { setViewVersionSlug(VIEW_BACKLOG_SLUG); setShowVersionPicker(false); },
          }, viewOptionLabel("backlog", dgT("view.backlogLane"), viewBacklogOnly)),
          // g-352 att-003 第 5 项③：独立目标同样是单泳道档的视图备选（选中 → 唯一泳道且真有卡片）。
          h("div", {
            key: "vp-standalone",
            className: "dg-schedule-version-item",
            style: { padding: "5px 10px", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
            onClick: () => { setViewVersionSlug(VIEW_STANDALONE_SLUG); setShowVersionPicker(false); },
          }, viewOptionLabel("standalone", dgT("lane.standalone"), standaloneLaneActive)),
          active.length === 0
            ? h("div", { style: { padding: "5px 10px", fontSize: 12, opacity: 0.5 } }, dgT("goal.scheduleNoVersion"))
            : null)
          : null);
      // 单泳道档（<480px：单版本 / backlog / 独立目标）：选择器就挂在这一行泳道头上 ⇒ 任何档位
      // 都能切回「全部版本」或换一个版本可见（判据 3：入口保留、出口可达）。
      const laneVersionPickerEl = singleLaneMode ? renderVersionPicker(true) : null;
      // 弹层锚定：菜单右缘对齐看板右缘（避免被侧栏裁掉；判据来自同一份纯函数，便于断言）
      const anchorPopover = (triggerEl, wantMinWidth) =>
        setPopoverAnchorState(popoverAnchor(triggerEl?.getBoundingClientRect?.(), boardRootRef.current?.getBoundingClientRect?.(), wantMinWidth));
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
      // g-352 att-003 第 6 项：确认入口的**单一实现**——宽档「确认」列列头与窄档（单泳道档）
      // 「确认」阶段块头共用这一个按钮构造器（同一 class / 同一状态派生 / 同一二次确认弹窗路径）。
      // iconized=true 只影响可见文案（补「图标 + 文字」），行为与校验路径完全不变。
      const renderBatchAcceptButton = (iconized) => {
        const ba = batchAcceptButtonState(reviewGoals.length);
        return h("button", {
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
        }, batchAcceptLoading ? dgT("common.submitting") : (iconized ? "✅ " + ba.label : ba.label));
      };
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
      const lane = (label, goals, key, version, laneIndex = 0, collapsible = true, vertical = false) => {
        goals = goals.filter(matchesTag);
        // g-352：单泳道档（g-356 起 <480px）下面板已退化为全宽单列，阶段纵向堆叠——
        // 此时交付/阻塞列不再走 36px 竖条折叠形态（竖条在纵向堆叠里不可读且无意义），
        // 一律按展开态渲染；宽档（≥480px）仍用原折叠语义。
        const deliverCollapsed = vertical ? false : deliverColumnCollapsed;
        const blockedCollapsed = vertical ? false : blockedColumnCollapsed;
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
          if (s.key === "blocked" && blockedCollapsed) {
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
          if (s.key === "deliver" && deliverCollapsed) {
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
            // g-352 att-003 第 8 项：单泳道档的选择器挂在标题右侧（[ + ] 左边）⇒ 标题预留更宽的右侧空间
            ...(vertical ? { paddingRight: singleLaneLabelPaddingRight } : {}),
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
          // g-352 att-003 第 8 项：「查看版本」下拉就挂在版本行标题里、[ + ] 左侧（单泳道档唯一一行）
          vertical ? laneVersionPickerEl : null,
          // g-129: 每个 lane 标题右下角加「+」按钮（版本 lane 预选版本，独立/backlog 进 backlog）
          h("button", {
            style: {
              ...S.btn, position: "absolute", right: 6, top: 8, bottom: "auto",
              // g-352 att-003 第 9 项：单泳道档的 [ + ] 与同行「查看版本」下拉等高（26×26 方形）
              ...(vertical ? rowBtnStyle({ iconOnly: true }) : { fontSize: 11, padding: "0 5px", lineHeight: 1.4 }),
            },
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
        if (vertical) {
          // g-352：单版本模式——阶段列由横向并排改为**纵向堆叠**（判据 3）：每个阶段先一行列头、
          // 再是全宽单元格，卡面按全宽渲染（阶段列不再各自 minmax(150px,1fr) 横向挤压）。
          // 单元格本体（cells）与宽档完全同一份实现，只改排布方向，不复制第二套渲染。
          const stacked = STAGES.map((s, sIdx) => h("div", {
            key: key + "-v-" + s.key,
            style: { minWidth: 0, display: "flex", flexDirection: "column", gap: 4 },
          },
            h("div", {
              // g-352 att-003 第 6 项：单泳道档没有横向列头（批量入口原在列头里，会随之消失）
              // ⇒ 在「确认」阶段块头补同构入口（同一个 renderBatchAcceptButton 工厂、
              //  同一二次确认弹窗、逐目标走既有单卡「接受」路径；失败项在弹窗内逐条列出）。
              // 语义边界：这是**人工在 UI 上点击**，等价于人工 verdict ⇒ 允许批量；
              //  不新增任何后端批量路径，也不为 agent/自动流程提供自动交付入口。
              style: { ...S.stageHead, textAlign: "left", padding: "4px 6px 2px", opacity: 0.8,
                       display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 },
            },
              h("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } }, s.label),
              s.key === "confirm" ? renderBatchAcceptButton(true) : null),
            cells[sIdx]));
          return [labelEl, h("div", {
            key: key + "-vstack",
            style: { gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 8, minWidth: 0 },
          }, ...stacked)];
        }
        return [labelEl, ...cells];
      };

      // g-137：backlog 行平铺展示函数；g-162: 支持独立折叠
      // g-352：第 4 参 vertical —— backlog 作为**唯一泳道**（单泳道档 <480px 的「版本备选」）时，
      // 强制展开（默认折叠态在该档等于「只有计数没有卡片」）、标题与内容各占整行（单列网格里
      // "2 / -1" 会退化为 0 跨度），并把卡片改为全宽。其余分支与宽档逐字共用同一份实现。
      const backlogRow = (label, goals, key, vertical = false) => {
        // g-162: backlog 泳道折叠状态（g-258: 默认折叠，显式展开为 false）
        const isCollapsed = vertical ? false : collapsedLanes[key] !== false;
        // 单列网格（纵向档）里没有第 2 条网格线，内容/标题必须占满整行
        const rowSpan = vertical ? "1 / -1" : "2 / -1";
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
              style: { gridColumn: rowSpan, ...S.cell, background: isOverThisCollapsed && canDropHere ? "rgba(76,141,255,.10)" : backlogBg, padding: "6px 8px", cursor: "pointer", userSelect: "none" },
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
        const labelEl = h("div", { key: key + "-label", style: { ...S.laneLabel, paddingRight: 40, position: "relative", background: backlogBg, ...(vertical ? { gridColumn: "1 / -1", paddingRight: singleLaneLabelPaddingRight } : {}) } },
          label,
          // g-352 att-003 第 8 项：backlog 作为唯一泳道时，选择器同样挂在这一行标题里（[ + ] 左侧）
          vertical ? laneVersionPickerEl : null,
          // g-162: 泳道折叠按钮
          // g-352：backlog 作为**唯一泳道**（vertical）时不提供折叠入口——它就是这个档位的全部
          // 内容，折起来等于空板（且与「必须看到卡片」的负责人裁决相悖）；其余档位保持既有按钮。
          vertical ? null : h("button", {
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
            style: {
              ...S.btn, position: "absolute", right: 6, top: 8, bottom: "auto",
              // g-352 att-003 第 9 项：单泳道档的 [ + ] 与同行「查看版本」下拉等高（26×26 方形）
              ...(vertical ? rowBtnStyle({ iconOnly: true }) : { fontSize: 11, padding: "0 5px", lineHeight: 1.4 }),
            },
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
          style: { gridColumn: rowSpan, minHeight: 40, borderTop: "1px solid rgba(128,128,128,.35)" },
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
          h("div", { className: "dg-backlog-flat" + (vertical ? " dg-backlog-flat-vertical" : "") },
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
            style: { gridColumn: rowSpan, minHeight: 40, padding: "12px 16px", color: "var(--dsw-alias-label-secondary, #999)", fontSize: 13, borderTop: "1px solid rgba(128,128,128,.35)" }
          }, dgT('kanban.loading'));
        } else if (sectionError['backlog']) {
          contentEl = h("div", {
            key: key + "-error",
            style: { gridColumn: rowSpan, minHeight: 40, padding: "12px 16px", color: "var(--dsw-alias-danger, #dd6666)", fontSize: 13, borderTop: "1px solid rgba(128,128,128,.35)" }
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
      const horizontalGridCols = ["130px",
        "minmax(150px, 1fr)",  // describe
        "minmax(150px, 1fr)",  // collect
        "minmax(150px, 1fr)",  // execute
        "minmax(150px, 1fr)",  // confirm
        deliverColumnCollapsed ? "36px" : "minmax(150px, 1fr)",  // deliver
        blockedColumnCollapsed ? "36px" : "minmax(150px, 1fr)",  // blocked
      ].join(" ");
      // g-352：单泳道档（根容器实测宽度 <480px，g-356 起）——阶段列由横向并排改为纵向堆叠（判据 3）：
      // 列模板退化为单列全宽，泳道内的阶段块依次堆叠（见 lane() 的 vertical 分支），
      // 卡面全宽可读、不需要横向滚动。宽档仍共用同一份横向模板。
      const gridCols = singleColumnMode ? "minmax(0, 1fr)" : horizontalGridCols;
      // Released lanes intentionally share the same computed template by reference.
      const releasedGridCols = gridCols;

      // g-366：搜索结果聚合泳道的命中卡**完整入参**解析——searchMatches 只带 id/title/status/snippet，
      // 卡片其余字段从 board payload 的既有分区取回（同一批对象本就喂给既有 lane / backlogRow，
      // 零新增数据源）。取不到时用命中本身兜底（id/title/status）⇒ 命中卡数与工具条计数 N 恒等，
      // 不因某分区处于惰性未加载而少渲染一张命中卡。
      const goalById = new Map();
      for (const v of (b.versions ?? [])) {
        for (const g of (v.goals ?? [])) if (g && g.id) goalById.set(g.id, g);
      }
      for (const g of (b.standalone ?? [])) if (g && g.id) goalById.set(g.id, g);
      for (const g of (b.backlog ?? [])) if (g && g.id) goalById.set(g.id, g);
      // g-366：单列「搜索结果」聚合泳道——顺序 == searchMatches 顺序，故 i/N 跳转的**次序**与纵向视觉
      // 次序一致（跳转本身仍走既有 navigateToMatch ⇒ #goal-<id> / data-goal-id 锚点，卡片同一条 Card
      // 渲染路径）。该泳道不参与跨泳道拖放（命中跨分区 ⇒ 没有唯一落点），故不传 drag。
      const searchResultsLane = () => {
        const labelEl = h("div", {
          key: "search-lane-label",
          className: "dg-lane-label dg-search-lane-label",
          style: { ...S.laneLabel, background: "rgba(128,128,128,.06)" },
        }, dgT("search.laneLabel", { count: searchMatches.length }));
        const cardEls = searchMatches.map((m) => {
          const g = goalById.get(m.id) ?? { id: m.id, title: m.title, status: m.status };
          const defExpanded = g.status !== "delivered" && g.status !== "blocked";
          const expanded = expandedGoals[g.id] ?? defExpanded;
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
            null,
            () => { forceFreshRef.current = true; load(); });
        });
        return [labelEl, h("div", {
          key: "search-lane-cards",
          className: "dg-search-lane-cards",
          // 单列网格里没有第 2 条网格线 ⇒ 内容占满整行；纵向 flex 让卡片各自成行、卡面全宽
          //（gridColumn "1 / -1" 与 g-352 纵向泳道同款；minWidth:0 保证窄容器内不横向撑破）。
          style: { ...S.cell, gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
        }, ...cardEls)];
      };

      const rows = [];
      if (searchLaneActive) {
        // g-366：窄档搜索激活 —— 只渲染这一条单列聚合泳道（N=0 时不渲染泳道，工具条给既有空态）。
        if (searchLaneMode) rows.push(...searchResultsLane());
        // 宽档（≥480px）searchLaneActive 恒为 false ⇒ 下面的分支与基线逐字一致（判据 4）。
      } else if (singleLaneMode && viewBacklogOnly) {
        // g-352（负责人裁决）：backlog 选定为「版本备选」时它是唯一泳道。**复用既有 backlogRow
        // 渲染路径**（惰性明细 / 拖动落点 / 新建目标 / 排期入口全部同一条实现，不复制第二套），
        // 第 4 参 vertical=true：单列全宽 + 强制展开（backlog 泳道默认折叠态在窄档里等于
        // 「只有计数没有卡片」，必须显式展开）；卡片全宽见 constants.js 的 .dg-backlog-flat-vertical。
        rows.push(...backlogRow("backlog", b.backlog, "backlog", true));
      } else if (singleLaneMode && standaloneLaneActive) {
        // g-352（att-003 第 5 项③）：独立目标作为唯一泳道时，**复用既有 lane 渲染路径**
        //（卡片 / 拖动 / 新建入口全部同一条实现，不复制第二套），从而「真有卡片」而非只有计数。
        // g-358：该分支现在同时承载「显式选中独立目标」与「无可见版本时的默认落点」两种进入方式
        //（两者由 standaloneLaneActive 归一）；空板（standalone 也为空）时同样走这里 ⇒ 渲染
        // 空单泳道（六个阶段块 + 泳道头的「＋」新建入口），绝不回落横向网格、不抛错（判据 4）。
        // 第 6 参 collapsible=false（负责人人工 gate 反馈④：只有一个泳道时不要折叠开关）。
        rows.push(...lane(dgT("lane.standalone"), b.standalone, "standalone", null, 0, false, true));
      } else if (singleLaneMode) {
        // 判据 3：单版本模式只渲染选中版本**一个**泳道（阶段列纵向堆叠、全宽可读）。
        // 非版本泳道（独立目标/backlog/released）在该档不渲染；「全部版本」入口在头部选择器里保留。
        // 第 6 参 collapsible=false：负责人人工 gate 反馈④——只有一个泳道时不给版本头部 ▲/▼ 折叠开关
        //（该档下折叠起来等于空板；collapsedLanes 在宽档留下的折叠记忆在此档也被忽略）。
        rows.push(...lane(`🏷️ ${singleVersion.name}`, singleVersion.goals, "v-" + singleVersion.slug, singleVersion.slug, 0, false, true));
      }
      let laneIndex = 0;
      // g-366：搜索聚合泳道激活时同样不渲染任何常规泳道（singleColumnMode = 单泳道档 ∪ 搜索档）
      for (const v of (singleColumnMode ? [] : active)) {
        rows.push(...lane(`🏷️ ${v.name}`, v.goals, "v-" + v.slug, v.slug, laneIndex));
        laneIndex++;
      }
      // g-223：如果所有版本都被隐藏（或存在 active 且 active 全部被隐藏），展示友好空状态提示行
      const totalVersionsCount = (b.versions ?? []).length;
      const visibleVersionsCount = active.length + released.length;
      if (!singleColumnMode && totalVersionsCount > 0 && (visibleVersionsCount === 0 || (allActiveVersions.length > 0 && active.length === 0))) {
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
      if (!singleColumnMode) {
        rows.push(...lane(dgT("lane.standalone"), b.standalone, "standalone", null, laneIndex));
        laneIndex++;
        rows.push(...backlogRow("backlog", b.backlog, "backlog"));
      }

      // g-352：单版本模式不渲染 released 折叠区（判据 3：DOM 中仅存在选中版本一个泳道）。
      // g-366：搜索聚合泳道档同理不渲染 released 折叠区（命中若在已发布/已隐藏版本，由聚合泳道直接呈现）。
      const releasedRows = (singleColumnMode ? [] : released).map((v, idx) => {
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

      // g-352：窄宽度适配**取代** g-330 的纯 CSS 最小适配（那条「头部放开换行」规则）。
      // 断点以看板根容器实测宽度为准（`boardWidth`，见上方 ResizeObserver）。
      // att-005（负责人 gate「两侧完全一致」）：会话页看板页签与右侧栏共用**同一份**头部/工具条
      // 实现（同一个 KanbanView，零 host 门控）——折叠逻辑因此两侧完全一致。
      //（工具条按钮样式 tbBtnStyle / 折叠态兜底 headBtnStyle 已在泳道渲染之前就位，见上方。
      //  折叠态弹层内的按钮集合 = **只收这六项**（刷新/标签筛选/[清空标签]/记忆/知识库/设置/显示已归档），
      //  排成整行、每行图标 + 文字；「版本管理 / 创建版本」不再进弹层（att-005 第 B-2 项：回到网格
      //  左上角原位置、靠左对齐）。宽档平铺保留原有的字面量渲染与动作/tooltip。
      //  标签（图标 + 文字）由 headPanelEntry 统一派生。）
      const headPanelRows = [
        { key: "refresh", label: dgT("common.refresh"), title: dgT("common.refresh"), action: load },
        { key: "tagfilter", label: tagFilter.length > 0 ? dgT("tagFilter.title") + ` (${tagFilter.length})` : dgT("tagFilter.title"), title: dgT("tagFilter.title"), action: () => setShowTagFilterModal(true) },
        tagFilter.length > 0 ? { key: "tagclear", label: dgT("tagFilter.clear"), title: dgT("tagFilter.clear"), action: () => setTagFilter([]) } : null,
        { key: "memory", label: dgT("memory.btn"), title: dgT("memory.title"), action: () => setShowMemoryModal(true) },
        { key: "shared", label: dgT("shared.title"), title: dgT("shared.title"), action: () => setShowSharedPanel(true) },
        { key: "settings", label: dgT("settings.title"), title: dgT("settings.title"), action: () => setShowSettings(true) },
      ].filter(Boolean).map((it) => {
        const entry = headPanelEntry(it.key, it.label);
        return {
          key: it.key,
          icon: entry.icon,
          text: entry.text,
          label: entry.label,
          title: it.title,
          // 点击任一动作先收起本下拉再执行（避免下拉叠浮层）
          onClick: () => { setShowHeadOverflow(false); it.action(); },
        };
      });
      const headPanelItems = headPanelRows;
      // g-110: 显示已归档目标的 checkbox（宽档位于 DEBUG 信息左侧；窄档收进弹层）
      const archivedToggle = h("label", {
        key: "tb-archived",
        style: { display: "flex", alignItems: "center", gap: 4, marginLeft: 12, cursor: "pointer", fontSize: 12, opacity: 0.8 },
      },
        h("input", {
          type: "checkbox",
          checked: showArchived,
          onChange: (e) => setShowArchived(e.target.checked),
        }),
        dgT("card.archived"));
      // g-352 att-005 第 B-2 项（负责人 gate「回到原来的位置、不要并入搜索行、靠左对齐」）：
      // 撤销 att-003 第 7 项的结构性搬家 —— 「版本管理 / 创建版本」回到**网格左上角**原位置
      //（g-174 / g-223 的落点），**两侧完全一致**（同一份定义，两处调用点共用）。
      // g-352 att-006（负责人 gate 续 chore）：「版本管理」**去掉可见文字、只留图标**⇒ 两颗按钮
      // **同一行** `[🏷️] [创建版本]`、靠左、等高 26px（图标按钮 26×26 方形），角落行高回到单行 26px
      //（此前带文字 ⇒ 纵向堆叠占两行 56px，把创建版本挤到下一行——负责人配图所指问题）。
      //  ① 图标按钮走 `rowBtnStyle({ iconOnly: true })`（与同行文字按钮同口径的唯一真源：width = height = 26）；
      //  ② 去文字但**保留可访问名称**：`title` + `aria-label` 都取既有 i18n 文案 `versionDrawer.title`
      //    （zh `🏷️ 版本管理` / en `🏷️ Version Management`，两侧对称），绝不退回「无名称裸图标」；
      //  ③ 图标本身由 headPanelEntry 的图标表派生（语言中立符号，与折叠弹层同一处），不硬编码。
      // 角落只有 130px 列宽：`minWidth:0` + 省略号兜底，绝不横向溢出压到相邻阶段列头。
      const versionManageIcon = headPanelEntry("versionmanage", dgT("versionDrawer.title")).icon;
      const versionManageBtn = h("button", {
        style: { ...S.btn, ...rowBtnStyle({ iconOnly: true }), flex: "0 0 auto" },
        className: "dg-btn dg-version-manage-btn",
        title: dgT("versionDrawer.title"),
        "aria-label": dgT("versionDrawer.title"),
        onClick: () => setShowVersionDrawer(true),
      }, versionManageIcon);
      const createVersionBtn = h("button", {
        style: { ...S.btn, ...rowBtnStyle(), maxWidth: "100%", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
        className: "dg-btn",
        title: dgT("createVersion.title"),
        onClick: () => {
          setShowCreateVersion(true);
          setNewVersionSlug("");
          setNewVersionName("");
          setCreateVersionNote(null);
        },
      }, dgT("createVersion.createBtn"));
      // 网格左上角单元格：两个按钮**同一行**、靠左、垂直居中（单行不占额外高度）。
      // 水平内边距由 S.stageHead 的 4px 收到 2px（垂直仍是 4px ⇒ 行高不变）：130px 列宽在 **en**
      // 下需要 26(图标) + 4(gap) + 93(`Create Version`) = 123px，S.stageHead 的 8px 内边距只剩 122px
      // ⇒ 会裁掉 1px。角落单元格无底纹/边框，2px 与 4px 的差别肉眼不可见，换来 en 标签**零截断**
      //（真机实测 sw<=cw；zh 本来就宽松）。不改变与阶段列头的对齐（阶段列头是居中文本）。
      const gridCornerEl = h("div", {
        key: "grid-corner",
        className: "dg-grid-corner",
        style: { ...S.stageHead, padding: "4px 2px", display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "flex-start", flexWrap: "nowrap", gap: 4, minWidth: 0, maxWidth: "100%", overflow: "hidden" },
      }, versionManageBtn, createVersionBtn);
      // g-233：标题行最右侧增加搜索框（g-352 att-005：**保持原设计**——与标题同一行、不再有同行容器包装）
      const searchBarEl = h("div", {
            // g-352：样式本体（含窄档唯一新增的 min-width:0 门控）在 narrow-width.js 的
            // searchBarWrapStyle 纯函数里——两侧共用同一实现。
            style: searchBarWrapStyle(narrowActive),
            className: "dg-search-bar",
          },
            h("div", { style: searchBarInnerStyle(narrowActive) },
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
      );
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
        // g-352 att-005：头部（标题 + 版本链接 + 更新时间 + 工具条 + DEBUG + 搜索框）是**两个宿主
        // 共用的同一份实现**（同一个 KanbanView，零 host 门控），class 与样式在两侧完全一致。
        // style 仍是 S.head 本体（不新增样式键）；布局兜底走 .dg-head（见 constants.js：
        // 放不下就换行 + 子项/按钮不压缩不折行 ⇒ 任何宽度都不会出现竖排/逐字换行）。
        // 适配是测量驱动的：<480px 六项工具条整批收进下拉容器、头部实测装不下时同样折叠、
        // 单泳道档同界 <480px（g-356）。
        h("div", { style: S.head, className: "dg-head", ref: headRef },
          // g-352：窄档下标题不内部折行（nowrap + min-width:auto ⇒ 保持自然宽度，由头部换行让位）
          h("strong", { style: narrowActive ? { whiteSpace: "nowrap", flexShrink: 0 } : undefined }, "dsh-graph"),
          // g-174：标题栏显示插件版本，点击以新标签打开插件官网
          h("a", {
            href: "https://github.com/miuzel/dsh-graph",
            target: "_blank",
            rel: "noreferrer",
            title: "dsh-graph",
            style: { ...S.meta, color: "var(--dsw-alias-state-business-primary, #8ab4ff)", cursor: "pointer", textDecoration: "underline", ...(narrowActive ? { whiteSpace: "nowrap", flexShrink: 0 } : {}) },
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
          // ===== g-352：工具条六项 —— 装得下平铺 / 装不下（或 <480px）收进「⋯ 工具」弹层 =====
          // 折叠判据 = 断点档（<480px，shouldCollapseToolbar）**或**头部实测自然宽度超过可用宽度
          //（toolbarCollapsedByFit）⇒ 头部始终单行，绝不把按钮压成竖排。
          // 折叠时只收这六项 + 显示已归档开关（headPanelItems），每行图标 + 文字。
          toolbarCollapsed ? null : h("button", { style: tbBtnStyle, className: "dg-btn", onClick: load }, dgT("common.refresh")),
          // g-187：顶部标签筛选弹层入口
          toolbarCollapsed ? null : h("button", {
            style: { ...tbBtnStyle, ...(tagFilter.length > 0 ? { borderColor: "var(--dsw-alias-state-business-primary, #4c8dff)", background: "rgba(76,141,255,.15)" } : {}) },
            className: "dg-btn" + (tagFilter.length > 0 ? " dg-btn-active" : ""),
            title: dgT("tagFilter.title"),
            onClick: () => setShowTagFilterModal(true),
          }, tagFilter.length > 0 ? dgT("tagFilter.title") + ` (${tagFilter.length})` : dgT("tagFilter.title")),
          toolbarCollapsed || tagFilter.length === 0
            ? null
            : h("button", {
                className: "dg-btn",
                // g-352 att-004 N1：这枚「清除筛选」与同行按钮**同一尺寸口径**（rowBtnStyle 是唯一真源，
                // 含 padding 0 8px / fontSize 12px / height 26px）；原先自覆盖 0 6px / 11px ⇒
                // 标签筛选激活时同行按钮「有大有小」。仅保留它特有的 4px 左间距。
                style: { ...S.btn, ...rowBtnStyle(), marginLeft: 4 },
                title: dgT("tagFilter.clear"),
                onClick: () => setTagFilter([]),
              }, dgT("tagFilter.clear")),
          // g-105: 记忆管理按钮（位于设置按钮左侧）
          toolbarCollapsed ? null : h("button", {
            style: tbBtnStyle,
            className: "dg-btn",
            title: dgT("memory.title"),
            onClick: () => setShowMemoryModal(true),
          }, dgT("memory.btn")),
          // g-183: 项目知识库面板入口
          toolbarCollapsed ? null : h("button", {
            style: tbBtnStyle,
            className: "dg-btn",
            title: dgT("shared.title"),
            onClick: () => setShowSharedPanel(true),
          }, dgT("shared.title").split("（")[0]),
          // g-352 att-003 第 9 项：右上角齿轮是**图标按钮**，与同行文字按钮等高 ⇒ 走
          // rowBtnStyle({ iconOnly: true })（26×26 方形）。
          // att-005：两侧完全一致 —— 不再按 host 分叉样式（会话页看板页签同口径）。
          toolbarCollapsed ? null : h("button", {
            style: { ...S.btn, ...rowBtnStyle({ iconOnly: true }), marginLeft: 8 },
            className: "dg-btn",
            title: dgT("settings.title"),
            onClick: () => setShowSettings(true),
          }, "⚙"),
          // g-110: 显示已归档目标的 checkbox（平铺时位于 DEBUG 信息左侧；折叠时收进弹层）
          toolbarCollapsed ? null : archivedToggle,
          toolbarCollapsed
            // g-352：工具条六项收进一个**下拉容器**（断点档 <480px **或**头部实测装不下）。
            // 容器与选项行复用既有内联下拉实现（helpers.js 的 S.inlineMenu 样式 token +
            // .dg-schedule-version-item 行样式，即 g-306 排期版本选择器 card.js:246-291 的那一套）
            // ⇒ 全仓仍只有一套下拉实现，不引入第三套；也不新增内联 S.overlay 浮层调用点
            //（g-181/g-343 的 19 处计数契约零回归）。
            // 锚点靠右（left:auto + right:0），窄容器里也不会被 S.wrap 的横向滚动裁掉。
            ? h("span", { key: "tb-overflow", ref: headOverflowRef, style: { display: "inline-flex", justifyContent: "flex-end", position: "relative", verticalAlign: "middle", minWidth: 0, flex: "1 1 auto" } },
                h("button", {
                  style: headBtnStyle,
                  className: headBtnClass + " dg-head-overflow-trigger",
                  title: dgT("toolbar.moreTooltip"),
                  "aria-label": dgT("toolbar.moreTooltip"),
                  "aria-expanded": showHeadOverflow ? "true" : "false",
                  onClick: () => { anchorPopover(headOverflowRef.current, 240); setShowHeadOverflow((v) => !v); },
                }, dgT("toolbar.more")),
                showHeadOverflow
                  ? h("div", {
                      // g-352 att-007（修复横向排布）：容器样式全部来自 headPanelMenuStyle()
                      //（flex column + white-space:normal + 视口高度兜底），详见该纯函数注释。
                      className: "dg-narrow-panel",
                      style: { ...S.inlineMenu, ...headPanelMenuStyle(popoverAnchorState) },
                      onClick: (e) => e.stopPropagation(),
                    },
                      h("div", { style: { fontSize: 11, opacity: 0.6, padding: "2px 10px 6px", borderBottom: "1px solid rgba(128,128,128,.2)" } },
                        dgT("toolbar.moreTitle")),
                      ...headPanelItems.map((it) => h("button", {
                        key: "ov-" + it.key,
                        // g-352 att-003：第 1 项要求「每一行都同时有图标与文字」，第 9 项要求
                        // 「触发按钮与被收进的下拉项风格一致」⇒ 这里去掉省略号（文字不再被吞），
                        // 且尺寸口径与触发按钮同一处（rowBtnStyle）——菜单宽度按最长一行自适应。
                        // g-352 att-007：行样式取 headPanelRowStyle()（块级 flex，覆盖 inline-flex）
                        // ⇒ 不再以行内级盒子参与容器的行内格式化上下文（横向排布的根因之一）。
                        className: "dg-btn dg-narrow-panel-btn",
                        style: { ...S.btn, ...rowBtnStyle(), ...headPanelRowStyle() },
                        title: it.title,
                        onClick: it.onClick,
                      }, it.label)),
                      // 显示已归档开关：与宽档头部复用同一个元素定义（archivedToggle）
                      h("div", { style: { minWidth: 0, marginTop: 6, padding: "0 2px" } }, archivedToggle))
                  : null)
            : null,
          // g-352 att-003 第 8 项：版本选择下拉已移入**版本泳道头部行**（[ + ] 左侧），
          // 见上方 renderVersionPicker / laneVersionPickerEl；头部只在「全部版本」态（多泳道）保留一份——
          // 该档泳道头只有 130px 宽塞不下选择器，且这样「切回单泳道」的出口在任一档位都可达。
          narrowSingleTier && !singleLaneMode ? renderVersionPicker(false) : null,
          // g-113 临时诊断（灰色低调显示，两行省略，详情在 tooltip 显示，为搜索框留出空间）：显示当前解析的 workspace 与会话 id
          // g-352 att-003 第 2 项（负责人人工 gate 反馈「窄幅条件下隐藏 debug 信息」）：
          // 窄档（<480px）整块不渲染。
          // ⚠️ g-352 att-004 B1 修正：DEBUG 必须仍是 **.dg-head 的子节点**，且次序保持
          // `已归档 → DEBUG → 搜索行`（att-003 曾把它放在头部**之外**，导致 DEBUG 之下内容整体下移）。
          // att-005：两侧完全一致 —— 门控口径两侧相同。
          narrowActive ? null : h("div", {
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
          // g-352 att-005 第 B-1 项（负责人 gate「搜索保持原设计与标题同一行、不增加 header 行高」）：
          // 搜索框/全文开关回到**头部本行**（原设计：`dsh-graph / version / 更新于 / ⟳ / [搜索目标…] / 全文`
          // 同一行，搜索框自带 marginLeft:auto 被推到右端），不再有 att-003 的 head-search-row 包装层
          // —— 既不新增行，也不把搜索挤到下一行；「版本管理 / 创建版本」已回到网格左上角（见 gridCornerEl）。
          searchBarEl),
        // g-108：顶部 supervisor 状态栏（id 由 board 端点下发，未配置则不显示）；
        // g-a92e1406：statusLine 传 supervisor 自己的 status_line（board 下发 supervisorStatus）
        b.supervisorSession
          // g-352 att-003 第 3 项：窄档（<480px，仅右侧栏实例）主管区重排为单行 + 图标按钮 + 隐藏模型 id
          ? h(SupervisorBar, { id: b.supervisorSession, statusLine: b.supervisorStatus ?? null, statusAt: b.supervisorStatusAt ?? null, narrow: narrowActive })
          : null,
        // g-127/g-156/g-164：折叠时对应列窄化为 36px（blocked 和 deliver 独立折叠），
        // 列模板统一由 gridCols 按当前折叠状态动态计算，与 released 泳道网格保持一致
        h("div", { style: { ...S.grid, gridTemplateColumns: gridCols } },
          // g-174 & g-223：看板左上角单元格放置「版本管理」入口与「＋ 新建版本」按钮。
          // g-352 att-005 第 B-2 项（负责人 gate「回到原来的位置、不要并入搜索行、靠左对齐」）：
          // 撤销 att-003 第 7 项的搬家 —— 两颗按钮**两侧、各档位都在此原位渲染**
          //（同一份定义 gridCornerEl；单泳道档同样保留 ⇒ 版本管理入口在最窄档也不丢失），
          // 靠左对齐；共享列模板（顶部表头与 released 泳道共用的那一份派生）与网格容器数量不变。
          gridCornerEl,
          // g-352：单版本模式下没有横向阶段列，阶段列头由 lane() 的纵向堆叠分支提供
          //（每个阶段块自带一行列头），故此处不再渲染表头行。
          // g-366：搜索聚合泳道档同理——单列网格里横向 6 个阶段列头会被逐行堆叠，毫无意义。
          singleColumnMode ? null : STAGES.map((s) => {
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
              return h("div", {
                key: s.key,
                style: { ...S.stageHead, display: "flex", alignItems: "center", justifyContent: "center",
                         gap: 6, overflow: "hidden" },
              },
                h("span", { style: { flexShrink: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } }, s.label),
                renderBatchAcceptButton(false));
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
          ? dgOverlay({ style: S.overlay, ...createGoalGuard },
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
          ? dgOverlay({ style: S.overlay, ...versionDetailGuard },
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
          ? dgOverlay({ style: S.overlay, ...createVersionGuard },
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
          ? dgOverlay({ style: S.overlay, ...renameVersionGuard },
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
          ? dgOverlay({ style: S.overlay, ...tagFilterGuard },
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
          ? dgOverlay({ style: S.overlay, ...deleteVersionGuard },
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
