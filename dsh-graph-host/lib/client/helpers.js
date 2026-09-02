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
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000,
      },
      drawer: {
        position: "fixed", top: 0, right: 0, height: "100vh", width: 400,
        background: "var(--dsw-alias-bg-layer-1, #1e1f24)", color: "var(--dsw-alias-label-primary, #e6e6e6)", zIndex: 10001,
        boxShadow: "-4px 0 16px rgba(0,0,0,.45)",
        padding: "20px 22px", overflowY: "auto", fontSize: 13, lineHeight: 1.7,
        fontFamily: "inherit",
      },
      // g-223：左侧抽屉（版本管理抽屉，从屏幕左侧展开）
      drawerLeft: {
        position: "fixed", top: 0, left: 0, height: "100vh", width: 380, maxWidth: "85vw",
        background: "var(--dsw-alias-bg-layer-1, #1e1f24)", color: "var(--dsw-alias-label-primary, #e6e6e6)", zIndex: 10001,
        boxShadow: "4px 0 16px rgba(0,0,0,.45)",
        padding: "20px 22px", overflowY: "auto", fontSize: 13, lineHeight: 1.7,
        fontFamily: "inherit",
      },
      drawerSection: { marginTop: 14 },
      drawerH: { fontWeight: 700, fontSize: 13, marginBottom: 6, opacity: 0.9 },
      modal: {
        background: "var(--dsw-alias-bg-layer-1, #1e1f24)", color: "var(--dsw-alias-label-primary, #e6e6e6)", borderRadius: 10,
        maxWidth: 720, width: "90%", maxHeight: "80vh", overflowY: "auto",
        padding: "16px 20px", fontSize: 13, lineHeight: 1.6, position: "relative", zIndex: 10002,
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
      close: { float: "right", cursor: "pointer", opacity: 0.7, fontSize: 16 },
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
      // blocked 只能回 blocked_from（由服务端强制，前端预判提示）
      if (fromStatus === "blocked") return null; // 前端不预设，服务端校验
      // planning→collect 二义默认 collecting
      if (toStageKey === "collect") return "collecting";
      if (toStageKey === "describe") return "planning";
      return stageDefaultStatus(toStageKey);
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

    const CARD_STATUS_ICON = { empty: "○ 待收集", collecting: "◌ 收集中", filled: "● 已填充", reviewed: "✔ 已复核" };

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

    // ===== g-223：版本显隐过滤（localStorage 持久化存储 hidden_version_slugs 数组）=====
    const HIDDEN_VERSIONS_KEY_PREFIX = "dsh-graph.hidden-versions.";

    function getHiddenVersionsStorageKey(workspace) {
      const ws = workspace ?? (currentWorkspace() || "default");
      return HIDDEN_VERSIONS_KEY_PREFIX + ws;
    }

    function getHiddenVersionSlugs(workspace) {
      try {
        const raw = localStorage.getItem(getHiddenVersionsStorageKey(workspace));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
      } catch {
        return [];
      }
    }

    function setHiddenVersionSlugs(slugs, workspace) {
      const ws = workspace ?? (currentWorkspace() || "default");
      const list = Array.isArray(slugs) ? [...new Set(slugs.filter((s) => typeof s === "string"))] : [];
      try {
        localStorage.setItem(getHiddenVersionsStorageKey(ws), JSON.stringify(list));
      } catch {}
      window.dispatchEvent(new CustomEvent("dsh-graph.hidden-versions-changed", { detail: { workspace: ws, hidden: list } }));
      return list;
    }

    function useHiddenVersionSlugs(workspace) {
      const currentWs = workspace ?? (currentWorkspace() || "default");
      const [hidden, setHidden] = React.useState(() => getHiddenVersionSlugs(currentWs));

      React.useEffect(() => {
        setHidden(getHiddenVersionSlugs(currentWs));
      }, [currentWs]);

      React.useEffect(() => {
        const onEvent = (e) => {
          const evWs = e?.detail?.workspace;
          if (!evWs || evWs === currentWs) {
            setHidden(e?.detail?.hidden ?? getHiddenVersionSlugs(currentWs));
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

      const setter = React.useCallback((slugs) => {
        return setHiddenVersionSlugs(slugs, currentWs);
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
      if (!path) return { opened: false, error: "路径为空" };
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
      const { generatedAt, intervalSec, onTriggerRefresh } = props;
      const [remaining, setRemaining] = React.useState(intervalSec);
      const nextTriggerAtRef = React.useRef(Date.now() + intervalSec * 1000);
      const lastRefreshTimeRef = React.useRef(Date.now());
      const onTriggerRef = React.useRef(onTriggerRefresh);
      onTriggerRef.current = onTriggerRefresh;

      // 周期或数据时间（手动/自动刷新完成）更新时重置倒计时终点
      React.useEffect(() => {
        lastRefreshTimeRef.current = Date.now();
        nextTriggerAtRef.current = Date.now() + intervalSec * 1000;
        setRemaining(intervalSec);
      }, [generatedAt, intervalSec]);

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
        title: `已配置自动刷新周期：${intervalSec}s（距离下次自动刷新约 ${remaining}s）`,
      },
        `更新于 ${timeStr}`,
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

    // ===== g-107 会话内嵌实时：复用 DSH 客户端会话机制，不自建数据通道 =====