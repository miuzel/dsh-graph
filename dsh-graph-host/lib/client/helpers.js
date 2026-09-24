      wrap: { padding: 12, fontSize: 13, color: "inherit", overflowX: "auto", position: "relative", zIndex: 1, minWidth: 0 },
      head: { display: "flex", alignItems: "center", gap: 12, marginBottom: 8 },
      grid: { display: "grid", gridTemplateColumns: "130px repeat(6, minmax(150px, 1fr))", gap: 4 },
      laneLabel: { fontWeight: 600, padding: "8px 6px", borderTop: "1px solid rgba(128,128,128,.35)" },
      stageHead: { fontWeight: 600, textAlign: "center", padding: 4, opacity: 0.75, whiteSpace: "nowrap" },
      cell: { borderTop: "1px solid rgba(128,128,128,.35)", padding: 4, minHeight: 40, verticalAlign: "top" },
      goalCard: {
        border: "1px solid rgba(128,128,128,.45)",
        borderLeft: "5px solid #4c8dff",
        borderRadius: 6, padding: "6px 8px", marginBottom: 6,
        background: "rgba(128,128,128,.08)", cursor: "pointer",
      },
      depCard: { borderLeft: "5px solid #e0a53a" },
      blockedCard: { borderLeft: "5px solid #d66" },
      subCard: {
        border: "1px solid rgba(128,128,128,.35)",
        borderLeft: "4px solid #3aa675",
        borderRadius: 5, padding: "2px 6px", margin: "4px 0 0 10px",
        fontSize: 11, opacity: 0.9,
      },
      title: { fontWeight: 600, marginBottom: 2 },
      meta: { opacity: 0.65, fontSize: 12 },
      statusLine: { fontStyle: "italic", opacity: 0.85, marginTop: 3 },
      collapsed: {
        padding: "6px", opacity: 0.75, cursor: "pointer", userSelect: "none",
        borderTop: "1px dashed rgba(128,128,128,.35)",
      },
      overlay: {
        position: "fixed", inset: 0, background: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,.55))",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 99998,
      },
      drawer: {
        position: "fixed", top: 0, right: 0, height: "100vh", width: 400,
        boxSizing: "border-box",
        background: "var(--dsw-alias-bg-layer-1, #1e1f24)", color: "var(--dsw-alias-label-primary, #e6e6e6)", zIndex: 99999,
        boxShadow: "-4px 0 16px rgba(0,0,0,.45)",
        padding: "20px 22px 90px 22px", overflowY: "auto", fontSize: 13, lineHeight: 1.7,
        fontFamily: "inherit",
      },
      // g-223：左侧抽屉（版本管理抽屉，从屏幕左侧展开）
      drawerLeft: {
        position: "fixed", top: 0, left: 0, height: "100vh", width: 380, maxWidth: "85vw",
        boxSizing: "border-box",
        background: "var(--dsw-alias-bg-layer-1, #1e1f24)", color: "var(--dsw-alias-label-primary, #e6e6e6)", zIndex: 99999,
        boxShadow: "4px 0 16px rgba(0,0,0,.45)",
        padding: "20px 22px 90px 22px", overflowY: "auto", fontSize: 13, lineHeight: 1.7,
        fontFamily: "inherit",
      },
      drawerSection: { marginTop: 14 },
      drawerH: { fontWeight: 700, fontSize: 13, marginBottom: 6, opacity: 0.9 },
      modal: {
        background: "var(--dsw-alias-bg-layer-1, #1e1f24)", color: "var(--dsw-alias-label-primary, #e6e6e6)", borderRadius: 10,
        maxWidth: 720, width: "90%", maxHeight: "80vh", overflowY: "auto",
        padding: "16px 20px", fontSize: 13, lineHeight: 1.6, position: "relative", zIndex: 100000,
      },
      modalSection: { marginTop: 10, whiteSpace: "pre-wrap" },
      modalH: { fontWeight: 700, marginBottom: 4 },
      // g-153：共享按钮样式 token——暗色主题下确保可读性与层级；g-176：改 DSH 主题变量并保留暗色 fallback
      btn: {
        fontSize: 12, padding: "2px 10px", cursor: "pointer",
        background: "var(--dsw-alias-interactive-bg-hover-solid, rgba(128,128,128,.15))",
        color: "var(--dsw-alias-label-primary, #e6e6e6)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.30))", borderRadius: 4,
      },
      // g-153：主要操作按钮（蓝底高亮）；g-176 follow-up：浅色下克制化——
      // tertiary 淡底 + label-primary 文字（高对比），语义由 primary 边框保留
      btnPrimary: {
        fontSize: 12, padding: "2px 10px", cursor: "pointer",
        background: "var(--dsw-alias-state-business-tertiary, rgba(76,141,255,.18))",
        color: "var(--dsw-alias-label-primary, #8ab4ff)",
        border: "1px solid var(--dsw-alias-state-business-primary, rgba(76,141,255,.40))", borderRadius: 4,
      },
      // g-153：危险操作按钮（红底红字）
      btnDanger: {
        fontSize: 12, padding: "2px 10px", cursor: "pointer",
        background: "rgba(214,102,102,.18)", color: "var(--dsw-alias-state-error-primary, #f08080)",
        border: "1px solid rgba(214,102,102,.35)", borderRadius: 4,
      },
      // g-153：接受/确认操作按钮（绿底绿字）；g-176 follow-up：浅色下对比修复——
      // tertiary 淡绿底 + label-primary 文字（≥12:1），语义由 primary 绿边与 ✅ 保留
      btnAccept: {
        fontSize: 12, padding: "2px 10px", cursor: "pointer",
        background: "var(--dsw-alias-state-success-tertiary, rgba(58,166,117,.18))",
        color: "var(--dsw-alias-label-primary, #6ee7a0)",
        border: "1px solid var(--dsw-alias-state-success-primary, rgba(58,166,117,.40))", borderRadius: 4,
      },
      // g-153：下拉菜单/选择控件样式 token
      select: {
        fontSize: 12, padding: "3px 8px", cursor: "pointer",
        background: "var(--dsw-alias-bg-layer-2, rgba(30,31,36,.92))",
        color: "var(--dsw-alias-label-primary, #e6e6e6)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))", borderRadius: 4,
      },
      selectOption: { background: "var(--dsw-alias-bg-layer-3, #222328)", color: "var(--dsw-alias-label-primary, #e6e6e6)" },
      close: {
        position: "absolute",
        top: 14,
        right: 16,
        width: 26,
        height: 26,
        borderRadius: 4,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        opacity: 0.7,
        fontSize: 16,
        zIndex: 10,
        userSelect: "none",
      },
      // g-107 会话内嵌实时区
      liveStrip: {
        marginTop: 4, padding: "3px 6px", borderRadius: 4,
        background: "rgba(76,141,255,.10)", fontSize: 11, lineHeight: 1.6,
      },
      liveLine: {
        marginTop: 2, opacity: 0.85, whiteSpace: "nowrap",
        overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%",
      },
      livePanel: {
        marginTop: 10, padding: 8, border: "1px solid rgba(76,141,255,.35)",
        borderRadius: 6, background: "rgba(76,141,255,.06)",
      },
      promptBox: { marginTop: 4 },
      promptRow: { display: "flex", gap: 4, alignItems: "center" },
      promptInput: {
        flex: 1, minWidth: 0, fontSize: 12, padding: "3px 6px",
        background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,.25))", color: "inherit",
        border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))", borderRadius: 4,
      },
      // g-108 看板顶部 supervisor 状态栏
      supervisorBar: {
        display: "flex", alignItems: "center", gap: 10, marginBottom: 8,
        padding: "4px 10px", border: "1px solid rgba(58,166,117,.45)",
        borderRadius: 6, background: "var(--dsw-alias-bg-module-platform, rgba(30,31,36,.92))", fontSize: 12,
      },
      recordItem: {
        marginTop: 3, padding: "3px 6px", borderRadius: 4,
        background: "rgba(128,128,128,.10)", whiteSpace: "pre-wrap",
        wordBreak: "break-word", fontSize: 12,
      },
    };

    // g-343：浮层统一 portal 到 document.body。
    // 看板根节点用共享样式 S.wrap（position: relative + z-index: 1）⇒ 它自成层叠上下文：
    // 遮罩(99998)/弹窗(100000)/抽屉(99999) 若渲染在子树内，就被囚禁在 z-index:1 的上下文里，
    // 与子树外的 composer（原生 sticky z-index:7）只能「整体比高低」，无法同时满足
    // 「卡片 < composer」与「composer < 遮罩」。实测（隔离实例 elementsFromPoint 命中栈）：
    // composer=0 时卡片压在 composer 之上；composer=7 时 composer 浮到遮罩之上。
    // 故把浮层挂到 body（逃出子树）后 composer 保持原生 7 即可同时成立。
    // 实参形状与 h("div", props, ...children) 一致，调用点只改函数名。
    function dgOverlay(props, ...children) {
      const node = h("div", props, ...children);
      if (typeof document === "undefined" || !document.body) return node;
      return ReactDOM.createPortal(node, document.body);
    }

    function stageOf(status) {
      for (const s of STAGES) if (s.statuses.includes(status)) return s.key;
      return "describe";
    }

    // g-77647351：拖放辅助函数
    /** Pointer-position half of a card (insert line above or below). */
    function rowHalf(e) {
      const rect = e.currentTarget.getBoundingClientRect();
      return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    }
    /** 将列 key 映射回一个代表状态（用于 transition 目标） */
    function stageDefaultStatus(stageKey) {
      const stage = STAGES.find((s) => s.key === stageKey);
      return stage ? stage.statuses[0] : null;
    }
    /** 跨列拖动时解析目标状态：from+toStageKey → 具体 to 状态 */
    function resolveTargetStatus(fromStatus, toStageKey) {
      // blocked 只能回 blocked_from（g-245：由 resolveBlockedDropTarget 按 blocked_from 解析，
      // 此处保持不猜测——无 blocked_from 信息时返回 null，服务端仍会校验）
      if (fromStatus === "blocked") return null;
      // planning→collect 二义默认 collecting
      if (toStageKey === "collect") return "collecting";
      if (toStageKey === "describe") return "planning";
      return stageDefaultStatus(toStageKey);
    }
    /** g-245：blocked 目标拖放落点解析——只允许回到 blocked_from 所在列，且返回精确原状态。
     *  返回 { ok: true, toStatus } 或 { ok: false, message }；blocked_from 缺失/非法一律不猜测。
     *  纯函数（不触发任何请求/派发），便于行为测试。 */
    function resolveBlockedDropTarget(blockedFrom, toStageKey) {
      const raw = typeof blockedFrom === "string" ? blockedFrom.trim() : "";
      // i18n-keep(category-a)：tr 的 fallback 中文仅在 dgT 未初始化（i18n 注册前）时兜底，正常路径一律走 dgT 词条。
      const tr = (key, params, fallback) => typeof dgT === "function" ? dgT(key, params) : fallback;
      if (!raw) {
        return { ok: false, message: tr('drag.blockedNoFrom', null, "⚠️ 该目标缺少 blocked_from 记录，无法自动解除阻塞；请由主管确认原状态后手动处理") };
      }
      const stage = STAGES.find((s) => s.statuses.includes(raw));
      if (!stage) {
        return { ok: false, message: tr('drag.blockedInvalidFrom', { raw }, `⚠️ blocked_from 值非法（${raw}），无法解析落点；请由主管修正后重试`) };
      }
      if (stage.key !== toStageKey) {
        return {
          ok: false,
          message: tr('drag.blockedOnlyOriginal', { status: STATUS_LABEL[raw] ?? raw, stage: typeof dgT === "function" ? stage.label : raw }, `⚠️ blocked 目标只能解除回原状态「${STATUS_LABEL[raw] ?? raw}」，请拖到「${raw}」列`),
        };
      }
      return { ok: true, toStatus: raw };
    }
    /** 判断是否为回退方向（后→前，如 delivered→execute） */
    const STAGE_ORDER = STAGES.map((s) => s.key);
    function isBackward(fromStatus, toStatus) {
      const fromStage = stageOf(fromStatus);
      const toStage = stageOf(toStatus);
      if (fromStage === toStage) return false;
      // delivered 终态特殊：任何离开 delivered 的方向都是回退（但 delivered 无出边，服务端会拒）
      return STAGE_ORDER.indexOf(toStage) < STAGE_ORDER.indexOf(fromStage);
    }

    // g-230：卡片状态图标——动态翻译
    const CARD_STATUS_ICON = {
      get empty() { return dgT('cardStatus.empty'); },
      get collecting() { return dgT('cardStatus.collecting'); },
      get filled() { return dgT('cardStatus.filled'); },
      get reviewed() { return dgT('cardStatus.reviewed'); },
    };

    // g-181：父级 overlay backdrop 误关保护。根因：pointerdown 在内容、mouseup 在 backdrop 时，
    // 浏览器把 click 派发到 overlay 自身（事件路径不经过 panel），panel 的 stopPropagation 拦不住。
    // 仅检查 e.target === e.currentTarget 无效（该场景 click 的 target 就是 overlay）。
    // 方案：onPointerDown 记录手势起点（e.target !== e.currentTarget = 起点在内容）；
    // onClick 若起点在内容则清零并吞掉本次合成 click（不关闭），否则照常 onClose?.()。
    // useRef 跨重渲染稳定（如 GoalModal 定时 load 重建内容）；pointer 事件兼容鼠标/触摸；
    // 返回的 guard 对象 spread 到 overlay 元素上（onPointerDown/onClick 成对出现）。
    function useBackdropClose(onClose) {
      const insideRef = React.useRef(false);
      return {
        onPointerDown: (e) => { insideRef.current = e.target !== e.currentTarget; },
        onClick: (e) => {
          if (insideRef.current) { insideRef.current = false; e.stopPropagation(); return; }
          onClose?.();
        },
      };
    }

    // ===== g-214：看板刷新间隔配置与自定义倒计时 =====
    const REFRESH_INTERVAL_KEY = "dsh-graph.refresh-interval";
    const DEFAULT_REFRESH_INTERVAL = 15;
    const MIN_REFRESH_INTERVAL = 5;

    function getRefreshInterval() {
      try {
        const raw = localStorage.getItem(REFRESH_INTERVAL_KEY);
        if (raw === null || raw === "") return DEFAULT_REFRESH_INTERVAL;
        const val = Number(raw);
        if (!Number.isFinite(val) || val < MIN_REFRESH_INTERVAL) return MIN_REFRESH_INTERVAL;
        return Math.floor(val);
      } catch {
        return DEFAULT_REFRESH_INTERVAL;
      }
    }

    function setRefreshInterval(val) {
      let num = Number(val);
      if (!Number.isFinite(num) || num < MIN_REFRESH_INTERVAL) {
        num = MIN_REFRESH_INTERVAL;
      } else {
        num = Math.floor(num);
      }
      try {
        localStorage.setItem(REFRESH_INTERVAL_KEY, String(num));
      } catch {}
      window.dispatchEvent(new CustomEvent("dsh-graph.refresh-interval-changed", { detail: { interval: num } }));
      return num;
    }

    // ===== g-224：实时代理输出流式显示开关（localStorage + 跨组件/跨标签页广播）=====
    // 关闭时停止「高频输出流」订阅（binding.eventSource 事件源订阅、session.open() 实时窗口、
    // 旧路径 chat.legacy 流式行读取），释放网络/内存/CPU；保留「低频状态数据」订阅
    // （session 生命周期快照 running/openState、tokenUsage/contextPressure 投影、会话列表、status_line）。
    const LIVE_DISPLAY_KEY = "dsh-graph.live-display";

    function getLiveDisplay() {
      try { return localStorage.getItem(LIVE_DISPLAY_KEY) !== "0"; } catch { return true; }
    }

    function setLiveDisplay(enabled) {
      const on = !!enabled;
      try { localStorage.setItem(LIVE_DISPLAY_KEY, on ? "1" : "0"); } catch {}
      window.dispatchEvent(new CustomEvent("dsh-graph.live-display-changed", { detail: { enabled: on } }));
      return on;
    }

    // 组件级订阅：本窗口广播事件 + 跨标签页 storage 事件（与刷新间隔同模式）
    function useLiveDisplayEnabled() {
      const [enabled, setEnabled] = React.useState(getLiveDisplay);
      React.useEffect(() => {
        const onEvent = (e) => setEnabled(e?.detail?.enabled ?? getLiveDisplay());
        const onStorage = (e) => { if (e.key === LIVE_DISPLAY_KEY) setEnabled(getLiveDisplay()); };
        window.addEventListener("dsh-graph.live-display-changed", onEvent);
        window.addEventListener("storage", onStorage);
        return () => {
          window.removeEventListener("dsh-graph.live-display-changed", onEvent);
          window.removeEventListener("storage", onStorage);
        };
      }, []);
      return enabled;
    }

    // ===== g-223：版本显隐过滤（localStorage 持久化存储 hidden_versions 条目/slug 数组）=====
    const HIDDEN_VERSIONS_KEY_PREFIX = "dsh-graph.hidden-versions.";

    function getHiddenVersionsStorageKey(workspace) {
      const ws = workspace ?? (currentWorkspace() || "default");
      return HIDDEN_VERSIONS_KEY_PREFIX + ws;
    }

    function parseHiddenVersionEntries(raw) {
      try {
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
          .map((item) => {
            if (typeof item === "string") return { slug: item, id: null };
            if (item && typeof item === "object" && typeof item.slug === "string") {
              return { slug: item.slug, id: typeof item.id === "string" ? item.id : null };
            }
            return null;
          })
          .filter(Boolean);
      } catch {
        return [];
      }
    }

    function getHiddenVersionEntries(workspace) {
      try {
        const raw = localStorage.getItem(getHiddenVersionsStorageKey(workspace));
        return parseHiddenVersionEntries(raw);
      } catch {
        return [];
      }
    }

    function getHiddenVersionSlugs(workspace) {
      try {
        const entries = getHiddenVersionEntries(workspace);
        return [...new Set(entries.map((e) => e.slug))];
      } catch {
        return [];
      }
    }

    function setHiddenVersionSlugs(slugsOrEntries, workspace, versions) {
      const ws = workspace ?? currentWorkspace();
      if (!ws) return [];
      let entries = [];
      if (Array.isArray(slugsOrEntries)) {
        const vList = Array.isArray(versions) ? versions : [];
        const idBySlug = new Map(vList.filter((v) => v?.slug && v?.id).map((v) => [v.slug, v.id]));
        entries = slugsOrEntries
          .map((item) => {
            if (typeof item === "string") {
              return { slug: item, id: idBySlug.get(item) ?? null };
            }
            if (item && typeof item === "object" && typeof item.slug === "string") {
              return { slug: item.slug, id: item.id ?? idBySlug.get(item.slug) ?? null };
            }
            return null;
          })
          .filter(Boolean);
      }
      // 按 slug 去重
      const seen = new Set();
      const deduped = [];
      for (const entry of entries) {
        if (!seen.has(entry.slug)) {
          seen.add(entry.slug);
          deduped.push(entry);
        }
      }
      const slugList = deduped.map((e) => e.slug);
      try {
        localStorage.setItem(getHiddenVersionsStorageKey(ws), JSON.stringify(deduped));
      } catch {}
      window.dispatchEvent(new CustomEvent("dsh-graph.hidden-versions-changed", { detail: { workspace: ws, hidden: slugList, entries: deduped } }));
      return slugList;
    }

    function useHiddenVersionSlugs(workspace) {
      const currentWs = workspace ?? currentWorkspace();
      const [hidden, setHidden] = React.useState(() => currentWs ? getHiddenVersionSlugs(currentWs) : []);

      React.useEffect(() => {
        setHidden(currentWs ? getHiddenVersionSlugs(currentWs) : []);
      }, [currentWs]);

      React.useEffect(() => {
        const onEvent = (e) => {
          const evWs = e?.detail?.workspace;
          if (!evWs || evWs === currentWs) {
            const rawHidden = e?.detail?.hidden;
            if (Array.isArray(rawHidden)) {
              setHidden(rawHidden.filter((s) => typeof s === "string"));
            } else {
              setHidden(getHiddenVersionSlugs(currentWs));
            }
          }
        };
        const onStorage = (e) => {
          if (e.key === getHiddenVersionsStorageKey(currentWs)) {
            setHidden(getHiddenVersionSlugs(currentWs));
          }
        };
        window.addEventListener("dsh-graph.hidden-versions-changed", onEvent);
        window.addEventListener("storage", onStorage);
        return () => {
          window.removeEventListener("dsh-graph.hidden-versions-changed", onEvent);
          window.removeEventListener("storage", onStorage);
        };
      }, [currentWs]);

      const setter = React.useCallback((slugsOrEntries, versions) => {
        return currentWs ? setHiddenVersionSlugs(slugsOrEntries, currentWs, versions) : [];
      }, [currentWs]);

      return [hidden, setter];
    }

    // g-222：跨版本打开 Host 工作区路径（优先 0.1.2+ session.openWorkspacePath，回退 0.1.1-rc host.openPath）。
    // 依赖 plugin.inject 声明 "remote.session"：session 命名空间服务由 api-gateway 在兄弟 fiber 提供，
    // 仅 inject "remote" 时 ctx.remote.session 属性访问走 fiber 向上遍历会在 root fiber 抛
    // 'cannot get property "remote.session" without inject'（g-222 根因）；inject 后本 fiber store
    // 才有实现，属性访问与调用均正常。
    // 返回 { opened: boolean, error?: string }：opened=true 表示已交给系统打开；error 携带可理解失败原因。
    async function openHostPath(path) {
      if (!path) return { opened: false, error: dgT("common.pathEmpty") };
      try {
        // g-222: Access remote.session via ctx.get() for backward compatibility
        // In 0.1.2+, remote.session is available; in 0.1.1-rc.2 it's not
        const remoteSession = appCtx?.get?.("remote.session") ?? null;
        const remote = appCtx?.get?.("remote") ?? appCtx?.remote;
        const openFn = remoteSession?.openWorkspacePath ?? remote?.session?.openWorkspacePath ?? (typeof remote?.["session/openWorkspacePath"] === "function" ? remote["session/openWorkspacePath"].bind(remote) : null);
        if (typeof openFn === "function") {
          const res = await openFn({ path });
          if (res && ("opened" in res ? res.opened : res.ok === true)) return { opened: true };
          if (res && res.ok === false && res.error && res.error.message) {
            return { opened: false, error: String(res.error.message) };
          }
        }
      } catch (e) {
        return { opened: false, error: String(e?.message ?? e) };
      }
      try {
        const conn = connectionRt ?? appCtx?.get?.("connection");
        if (typeof conn?.api?.host?.openPath === "function") {
          const result = await conn.api.host.openPath({ path });
          if (result?.opened) return { opened: true };
        }
      } catch (e) {
        return { opened: false, error: String(e?.message ?? e) };
      }
      return { opened: false };
    }
    // g-222：toast 展示用的错误文案（截断过长原始错误，保留首段）
    function openErrorText(err) {
      if (!err) return "";
      const s = String(err).replace(/^path open failed:\s*/i, "").split("\n")[0] ?? String(err);
      return s.length > 120 ? s.slice(0, 120) + "…" : s;
    }

    // g-214：局部化倒计时组件，避免每秒 tick 引起整个看板大面积重绘；
    // g-211：融合 visibilitychange 感知，页面后台时暂停倒计时，切回前台补偿触发
    function RefreshCountdown(props) {
      const { generatedAt, refreshSignal, intervalSec, onTriggerRefresh } = props;
      const [remaining, setRemaining] = React.useState(intervalSec);
      const nextTriggerAtRef = React.useRef(Date.now() + intervalSec * 1000);
      const lastRefreshTimeRef = React.useRef(Date.now());
      const onTriggerRef = React.useRef(onTriggerRefresh);
      onTriggerRef.current = onTriggerRefresh;

      // g-324：重置信号 = 一次刷新流程完成（refreshSignal 由 kanban.js 的 load() 完成汇聚点
      // 单调自增），不再依赖 generated_at 变化——304 复用 retained 载荷、watcher 缓存命中
      // 回旧 payload 时 generated_at 不变，旧实现（依赖 [generatedAt, intervalSec]）不重置，
      // 手动刷新后倒计时继续沿旧终点递减。generatedAt 仍作为「数据时间展示」来源保留。
      // 周期（intervalSec）变化同样重置为完整周期。
      React.useEffect(() => {
        lastRefreshTimeRef.current = Date.now();
        nextTriggerAtRef.current = Date.now() + intervalSec * 1000;
        setRemaining(intervalSec);
      }, [refreshSignal, generatedAt, intervalSec]);

      // 独立 1 秒 tick 驱动平滑递减，归零时触发刷新；融合后台暂停与切回补偿
      React.useEffect(() => {
        let timer = null;
        const startTimer = () => {
          if (!timer) {
            timer = setInterval(() => {
              const now = Date.now();
              const leftMs = nextTriggerAtRef.current - now;
              const leftSec = Math.max(0, Math.ceil(leftMs / 1000));
              setRemaining(leftSec);
              if (leftSec <= 0) {
                nextTriggerAtRef.current = Date.now() + intervalSec * 1000;
                lastRefreshTimeRef.current = Date.now();
                onTriggerRef.current?.();
              }
            }, 1000);
          }
        };
        const stopTimer = () => {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
        };

        const handleVisibilityChange = () => {
          if (typeof document === "undefined") return;
          if (document.visibilityState === "visible") {
            const now = Date.now();
            // 切回前台且距离上次刷新达到阈值（10 秒）立即补偿刷新
            if (now - lastRefreshTimeRef.current >= 10000) {
              nextTriggerAtRef.current = now + intervalSec * 1000;
              lastRefreshTimeRef.current = now;
              setRemaining(intervalSec);
              onTriggerRef.current?.();
            } else {
              const leftMs = nextTriggerAtRef.current - now;
              setRemaining(Math.max(0, Math.ceil(leftMs / 1000)));
            }
            startTimer();
          } else {
            // 后台/隐藏时暂停倒计时与轮询
            stopTimer();
          }
        };

        if (typeof document !== "undefined" && document.visibilityState !== "visible") {
          // 当前在后台不启动
        } else {
          startTimer();
        }

        if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
          document.addEventListener("visibilitychange", handleVisibilityChange);
        }

        return () => {
          stopTimer();
          if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
            document.removeEventListener("visibilitychange", handleVisibilityChange);
          }
        };
      }, [intervalSec]);

      const timeStr = (generatedAt ?? "").replace("T", " ").slice(0, 19);
      // 进度比例 0..1（随倒计时递减）
      const progress = intervalSec > 0 ? remaining / intervalSec : 0;
      return h("span", {
        style: { ...S.meta, display: "inline-flex", alignItems: "center", gap: 5, userSelect: "none" },
        title: dgT('kanban.autoRefreshTip', { interval: intervalSec, remaining }),
      },
        dgT('kanban.updatedAt') + timeStr,
        h("span", {
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
            opacity: 0.7,
            fontSize: 11,
            fontVariantNumeric: "tabular-nums",
            cursor: "default",
          },
        },
          h("span", {
            style: {
              display: "inline-block",
              width: 10,
              height: 10,
              borderRadius: "50%",
              border: "1.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
              borderTopColor: "var(--dsw-alias-state-business-primary, #4c8dff)",
              transform: `rotate(${Math.round((1 - progress) * 360)}deg)`,
              transition: "transform 1s linear",
              boxSizing: "border-box",
              flexShrink: 0,
            },
          }),
          h("span", { style: { minWidth: "18px", textAlign: "right", opacity: 0.85, fontSize: 10 } }, `${remaining}s`)));
    }

    // ===== g-233：搜索匹配与文字高亮辅助函数 =====
    function escapeRegExp(str) {
      return String(str ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    /**
     * 将一段文本按照关键字高亮分割渲染为 React 元素数组
     * @param {string} text - 待高亮正文
     * @param {string} query - 搜索关键字
     * @param {boolean} isCurrent - 是否为当前选中的匹配项
     */
    function renderHighlight(text, query, isCurrent = false) {
      const s = String(text ?? "");
      const q = String(query ?? "").trim();
      if (!q || !s) return s;
      const escaped = escapeRegExp(q);
      const re = new RegExp(`(${escaped})`, "gi");
      const parts = s.split(re);
      if (parts.length <= 1) return s;
      return parts.map((part, idx) => {
        if (part.toLowerCase() === q.toLowerCase()) {
          return h(
            "mark",
            {
              key: "hl-" + idx,
              className: isCurrent ? "dg-search-highlight-current" : "dg-search-highlight",
            },
            part,
          );
        }
        return part;
      });
    }

    /**
     * 从目标正文描述中提取包含关键字的简短上下文片段（周围各约 25 字符）
     */
    function extractMatchSnippet(text, query) {
      const s = String(text ?? "").replace(/\s+/g, " ");
      const q = String(query ?? "").trim();
      if (!s || !q) return "";
      const idx = s.toLowerCase().indexOf(q.toLowerCase());
      if (idx === -1) return "";
      const start = Math.max(0, idx - 15);
      const end = Math.min(s.length, idx + q.length + 25);
      let snippet = s.slice(start, end);
      if (start > 0) snippet = "…" + snippet;
      if (end < s.length) snippet = snippet + "…";
      return snippet;
    }
    // ===== g-239：运行/空闲生命周期投影与人工可读 status 区分 =====
    // 区分会话/任务真实生命周期（running / idle / blocked / error / done）与人工汇报 status_line，
    // 彻底解决结束、阻塞、失败、长任务场景长期显示失实运行态（如流动背景、虚假 ⏳/✅）的问题。
    function formatStatusWithLifecycle(statusLine, running, blocked, statusState) {
      if (!statusLine) {
        return {
          icon: "",
          text: "",
          fullText: null,
          isRunning: false,
          isBlocked: false,
          isError: false,
          isDone: false,
        };
      }
      const raw = String(statusLine).trim();
      // g-247：结构化状态优先；只有缺失/未知时才解析自由文本，避免中英文及否定句误判。
      const structured = ["working", "blocked", "done", "error"].includes(statusState) ? statusState : null;
      // i18n-keep(category-a)：以下正则匹配用户手写的遗留中文 status_line 自由文本（g-247 兜底路径），非 UI 文案。
      const isBlocked = structured ? structured === "blocked" : (!!blocked || /阻塞|blocked/i.test(raw));
      const isError = structured ? structured === "error" : (!isBlocked && /失败|错误|报错|failed|error/i.test(raw));
      const isDone = structured ? structured === "done" : (!isBlocked && !isError && /完成|已完成|空闲|待命|已交付|等待\s*review|等待复核|finished|done|idle|completed/i.test(raw));
      
      let icon = "⏳ ";
      if (isBlocked) icon = "⛔ ";
      else if (isError) icon = "❌ ";
      else if (isDone) icon = "✅ ";
      else if (!running) icon = "⏸ ";
      else icon = "⏳ ";

      // 仅当生命周期处于运行态且非阻塞/非错误/非完成终态时，才维持运行中流动指示
      const isRunning = !isBlocked && !isError && !isDone && !!running;
      return {
        icon,
        text: raw,
        fullText: icon + raw,
        isRunning,
        isBlocked,
        isError,
        isDone,
      };
    }

    // g-283：根据目标类型计算是否默认隔离 worktree 的纯函数（可单测）
    function defaultWorktreeForGoalType(rawType) {
      if (rawType === null || rawType === undefined || rawType === "") {
        return false;
      }
      const t = String(rawType).trim().toLowerCase();
      if (t === "patch" || t === "chore" || t === "task") {
        return false;
      }
      return true;
    }

    // g-289：前端计算工作树隔离决策与提示文案（纯函数，可单测）。
    // 与核心层 resolveWorktreeIsolationDecision 语义对齐：
    // - 显式参数优先级最高；
    // - 可靠确认脏（clean===false）→ 强制隔离并给出中英原因提示（复选框自动勾选的原因）；
    // - 干净（clean===true）或探测不可靠（clean===null）→ 按类型默认，不给误导性提示
    //   （探测不可靠绝不静默伪称干净，也不凭空强制勾选）。
    function resolveClientWorktreeDecision(rawType, workspaceState, explicit) {
      if (explicit !== undefined && explicit !== null) {
        return { isolate: Boolean(explicit), reason: "explicit", hint: null };
      }
      if (workspaceState && workspaceState.clean === false) {
        return {
          isolate: true,
          reason: "dirty_workspace",
          hint: dgT("exec.isolateWorktreeReasonDirty"),
        };
      }
      const byType = defaultWorktreeForGoalType(rawType);
      return { isolate: byType, reason: "type_default", hint: null };
    }

    // ===== g-321：消息排队状态检查（0.1.6 队列架构切换的安全读取） =====
    // 0.1.5-rc.2：客户端快照直接带 queue；0.1.6-alpha.2 彻底废弃该字段，改为耐久的
    // inbox 状态投影 `session.projections.faceOf('inbox')`（形如 { 'next-turn': [...], 'next-step': [...] }）。
    // 铁律：绝不直接解构 `session.getSnapshot().queue`——新版该字段为 undefined，解构即 TypeError，
    // 会让整个发送链路（判据反馈、看板直达指令、批量受理通知）在渲染期崩溃。
    // 本函数只做特性探测，两条路径都读到才返回，读不到一律返回零值（不阻断发送）。
    function sessionQueueState(session) {
      const empty = { pendingCount: 0, queued: 0, steering: 0, source: null };
      if (!session) return empty;
      // 新路径（0.1.6）：inbox 投影。faceOf 缺失或投影未 seed 时静默降级到旧路径。
      try {
        const face = session.projections?.faceOf?.("inbox");
        const value = face?.getSnapshot?.();
        if (value && typeof value === "object") {
          const nextTurn = Array.isArray(value["next-turn"]) ? value["next-turn"].length : 0;
          const nextStep = Array.isArray(value["next-step"]) ? value["next-step"].length : 0;
          return { pendingCount: nextTurn + nextStep, queued: nextTurn, steering: nextStep, source: "inbox" };
        }
      } catch { /* 投影不可用 → 回退旧路径 */ }
      // 旧路径（0.1.5）：快照 queue（可能是数组，也可能是 { items } 容器）；一律先判类型再读。
      try {
        const snap = session.getSnapshot?.();
        const q = snap && typeof snap === "object" ? snap.queue : null;
        const items = Array.isArray(q) ? q : (Array.isArray(q?.items) ? q.items : null);
        if (items) return { pendingCount: items.length, queued: items.length, steering: 0, source: "snapshot" };
      } catch { /* 静默 */ }
      return empty;
    }

    /** g-321：把 subagent 派发/投递失败码翻译为可操作文案（返回 null 表示非已知码，调用方自行回退原始 message）。 */
    function subagentDispatchErrorText(err) {
      const code = String(err?.code ?? err?.details?.reason ?? "");
      const hay = `${code} ${String(err?.message ?? "")}`;
      if (hay.includes("ACTIVATION_LIMIT_REACHED")) return dgT("live.activationLimit");
      if (hay.includes("subagent/delivery-unavailable")) return dgT("live.deliveryUnavailable");
      return null;
    }

    // ===== g-351：子代理目录的**形状/能力探测**读取（零版本号比较）=====
    // 宿主改过代，**容器与 entry 两层形状同时换代**，两层都必须探测：
    //   容器：旧 `list.getSnapshot().subagentsByParent[parentId].entries`；
    //         新 `list.getSnapshot().projectionsBySession[sid].values.subagentCatalog`
    //         （0.1.7 全参考树 `subagentsByParent` 零命中）。
    //   entry：旧 `{kind:'child'|'diagnostic', id, activity, hasChildren, mode, label?}`——**带判别字段 `kind`**
    //         （权威来源：0.1.6 `dsh-api-remotes/lib/client.js` 的 `subagents.list` 结果 schema）；
    //         新 `{id, createdAt, mode:'one-shot'|'continuable'|'unknown', label?}`——**无 `kind`**
    //         （权威来源：0.1.7 `dsh-api-remotes/lib/client.js:9055` 的 `subagentCatalog` union；
    //          0.1.7 全树 client.js 对 `kind === "child"` **零命中**）。
    // 只换容器不换 entry 形状 ⇒ 新宿主上条目能读到但谓词恒假，子会话导航**静默**退化为打开父会话。
    // 谓词一律按**形状探测**：entry 自带 `kind` 走旧判定（`kind === 'child'`），不带 `kind` 按 `id` 命中。

    /** 目录 entry 是否就是 `childId` 这个子会话（形状探测，零版本号比较）。
     *  旧形态的 `diagnostic` 行同样带 `id`，必须用 `kind` 排除，绝不能只按 `id` 认。 */
    function isCatalogChildEntry(entry, childId) {
      if (!entry || typeof entry !== "object") return false;
      if (typeof childId !== "string" || !childId) return false;
      if (typeof entry.id !== "string" || entry.id !== childId) return false;
      if (Object.prototype.hasOwnProperty.call(entry, "kind")) return entry.kind === "child";
      return true;
    }

    /** 从目录 entry 数组里取出 `childId` 的子会话 entry；未收录返回 null（调用方按未收录降级）。 */
    function catalogChildEntry(entries, childId) {
      if (!Array.isArray(entries)) return null;
      return entries.find((e) => isCatalogChildEntry(e, childId)) ?? null;
    }

    /** 子代理目录（parentId → entries）→ 子→直接父 反查表（形状探测，零版本号比较）。 */
    function catalogParentIndex(catalogsByParent) {
      const index = new Map();
      try {
        for (const [pid, entries] of catalogsByParent ?? []) {
          if (!Array.isArray(entries)) continue;
          for (const e of entries) {
            if (!isCatalogChildEntry(e, e?.id)) continue;
            if (!index.has(e.id)) index.set(e.id, pid);
          }
        }
      } catch { /* 形状不符 → 空索引，按未收录降级 */ }
      return index;
    }

    /** 目录 entry 的**具体**执行模式：只认 'one-shot' / 'continuable'；
     *  宿主的「未判定」（0.1.7 新增的 'unknown'、字段缺失或非法值）一律返回 null。
     *  调用方据此**降级**（展示层不臆断成 'one-shot'，路由层不冒充具体模式）。 */
    function catalogEntryMode(entry) {
      const m = entry && typeof entry.mode === "string" ? entry.mode : "";
      return m === "one-shot" || m === "continuable" ? m : null;
    }

    /** 目录 entry → SubagentAddress 的 `mode` 字段：具体模式不可得时下发宿主自己的
     *  「未判定」通配值 `'unknown'`（0.1.7 `SubagentAddress.mode` 合法取值之一，
     *  宿主的 history 路由对 `address.mode === 'unknown'` 跳过一致性校验并按 identity 回填）。
     *  **不得**省略该字段：0.1.7 上有 mode 缺失会被判 `subagent/unauthorized`
     *  「subagent mode does not match the supplied address」。 */
    function catalogAddressMode(entry) {
      return catalogEntryMode(entry) ?? "unknown";
    }

    /** 读取子代理目录 entry 数组：两代容器形状都读，任一处命中即返回；
     *  形状不符返回 []，调用方按「未收录」降级。 */
    function subagentCatalogEntries(rt, parentId) {
      if (!rt || !parentId) return [];
      let snap = null;
      try { snap = rt.list?.getSnapshot?.() ?? null; } catch { return []; }
      if (!snap || typeof snap !== "object") return [];
      try {
        const legacy = snap.subagentsByParent?.[parentId]?.entries;
        if (Array.isArray(legacy)) return legacy;
      } catch { /* 形状不符 → 试新形态 */ }
      try {
        const projected = snap.projectionsBySession?.[parentId]?.values?.subagentCatalog;
        if (Array.isArray(projected)) return projected;
      } catch { /* 形状不符 → 未收录 */ }
      return [];
    }

    /** 目录 entry → SubagentAddress（entry 筛选统一走 `catalogChildEntry` 形状探测；
     *  mode 经 `catalogAddressMode`：具体模式不可得时下发宿主的「未判定」通配值）。 */
    function subagentAddressOf(rt, parentId, childId) {
      if (!parentId || !childId) return null;
      try {
        const direct = rt?.subagentAddress?.(childId);
        if (direct) return direct;
      } catch { /* 地址探测不可用 → 走目录 */ }
      const entry = catalogChildEntry(subagentCatalogEntries(rt, parentId), childId);
      return entry ? { parentSessionId: parentId, childSessionId: childId, mode: catalogAddressMode(entry) } : null;
    }

    /** 按能力刷新子代理目录：新形态用 `refreshProjections()`，旧形态用
     *  `setSubagentCatalogOpen()` + `refreshSubagents()`；两者都缺失则原样返回（调用方自行降级）。 */
    function refreshSubagentCatalog(rt, parentId) {
      if (!rt || !parentId) return Promise.resolve();
      try {
        if (typeof rt.refreshProjections === "function") {
          return Promise.resolve(rt.refreshProjections(parentId)).then(() => {}, () => {});
        }
        rt.setSubagentCatalogOpen?.(parentId, true);
        const pending = rt.refreshSubagents?.(parentId);
        return pending && typeof pending.then === "function" ? pending.then(() => {}, () => {}) : Promise.resolve();
      } catch {
        return Promise.resolve();
      }
    }

    // ===== g-107 会话内嵌实时：复用 DSH 客户端会话机制，不自建数据通道 =====    // Contract marker: 看板数据自动刷新
