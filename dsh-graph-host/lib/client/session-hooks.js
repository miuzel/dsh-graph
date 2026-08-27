    // 数据源：sessions.binding(childId).session（uSES 快照 subscribe/getSnapshot），
    // 流式行读 chat.legacy.partial（必须先 session.open()），token/上下文走投影
    // faceOf("tokenUsage"|"contextPressure")（无需 open），模型走 connection.api.sessions.models，
    // 发指令走 session.prompt（continuable 子代理自动路由 api.subagents.prompt，仅文本），
    // 最近记录走 connection.api.subagents.history。

    const boundSetup = new Map(); // childId -> Promise（open/地址配置只做一次）
    const boundModes = new Map(); // childId -> 'one-shot' | 'continuable'

    // 子代理地址配置（路由 prompt/history 到 subagents.*）+ 打开尾页以接收活事件。
    // 目录 entry 提供真实 mode；目录未收录时跳过地址配置（指令走 session.prompt 默认路由，错误会明示）。
    function setupBoundSession(parentId, childId, session) {
      if (boundSetup.has(childId)) return boundSetup.get(childId);
      const p = (async () => {
        if (parentId) {
          try {
            sessionsRt.setSubagentCatalogOpen?.(parentId, true);
            await sessionsRt.refreshSubagents?.(parentId);
            const entries = sessionsRt.list?.getSnapshot?.().subagentsByParent?.[parentId]?.entries ?? [];
            const entry = entries.find((e) => e.kind === "child" && e.id === childId);
            if (entry) {
              boundModes.set(childId, entry.mode);
              session.configureSubagent?.(
                { parentSessionId: parentId, childSessionId: childId, mode: entry.mode }, true);
            }
          } catch (e) {
            console.warn("[dsh-graph-host] 子代理地址配置失败", e);
          }
        }
        try { await session.open(); } catch (e) {
          console.warn("[dsh-graph-host] session.open() 失败", e);
        }
      })();
      boundSetup.set(childId, p);
      return p;
    }

    const NOOP_UNSUB = () => () => {};

    // 会话列表快照：列表刷新（含子代理会话入列）时触发重渲染，binding 随之可解析
    function useSessionsList() {
      const subscribe = React.useCallback(
        (cb) => (sessionsRt?.list ? sessionsRt.list.subscribe(cb) : NOOP_UNSUB()), []);
      const getSnapshot = React.useCallback(
        () => (sessionsRt?.list ? sessionsRt.list.getSnapshot() : null), []);
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    // 解析绑定 childId 的 Session（binding 是文档化的纯解析，渲染期安全）
    function useBoundSession(parentId, childId) {
      const listSnap = useSessionsList();
      const session = React.useMemo(() => {
        if (!sessionsRt || !childId) return null;
        try { return sessionsRt.binding(childId)?.session ?? null; }
        catch (e) { console.warn("[dsh-graph-host] binding 解析失败", e); return null; }
      }, [childId, listSnap]);
      const [mode, setMode] = React.useState(boundModes.get(childId) ?? null);
      React.useEffect(() => {
        if (!session) return;
        let alive = true;
        setupBoundSession(parentId, childId, session).then(() => {
          if (alive) setMode(boundModes.get(childId) ?? null);
        });
        return () => { alive = false; };
      }, [session, parentId, childId]);
      return { session, mode };
    }

    function useSessionSnapshot(session) {
      const subscribe = React.useCallback(
        (cb) => (session ? session.subscribe(cb) : NOOP_UNSUB()), [session]);
      const getSnapshot = React.useCallback(
        () => (session ? session.getSnapshot() : null), [session]);
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    // g-195: 子代理实时流式 peek 节流 hook（≤5fps / ≥200ms 刷新上限）
    // 仅用于 peek 展示（LiveStrip / SessionPanel 折叠态等），普通高频推送合并到 trailing flush；
    // 流结束/错误/运行态翻转等关键边界在下一合法时间槽完成最终呈现，不丢尾包，卸载时清理定时器。
    function useThrottledLiveSession(session, intervalMs = 200) {
      const [liveState, setLiveState] = React.useState(() => {
        const snap = session ? session.getSnapshot() : null;
        return {
          snap,
          line: snap && snap.chat ? lastStreamLine(snap.chat.legacy.partial) : null,
          running: !!(snap && snap.running),
        };
      });

      React.useEffect(() => {
        if (!session) {
          setLiveState({ snap: null, line: null, running: false });
          return;
        }

        let timer = null;
        let lastFlush = 0;
        let unmounted = false;

        const flush = () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          lastFlush = Date.now();
          if (unmounted) return;
          const s = session.getSnapshot();
          setLiveState({
            snap: s,
            line: s && s.chat ? lastStreamLine(s.chat.legacy.partial) : null,
            running: !!(s && s.running),
          });
        };

        const onUpdate = () => {
          const now = Date.now();
          const elapsed = now - lastFlush;
          if (elapsed >= intervalMs) {
            flush();
          } else if (!timer) {
            // Trailing edge: 在剩余时间槽排期执行 flush，保证 ≤5fps (≥200ms) 且不丢尾包
            timer = setTimeout(flush, intervalMs - elapsed);
          }
        };

        // 初始同步一次最新状态
        flush();

        const unsub = session.subscribe(onUpdate);

        return () => {
          unmounted = true;
          if (timer) clearTimeout(timer);
          if (typeof unsub === "function") unsub();
        };
      }, [session, intervalMs]);

      return liveState;
    }

    // 投影值（faceOf 返回 identity-stable 的 uSES face；投影推送不要求 open，看板常驻）
    function useProjectionValue(session, key) {
      const face = React.useMemo(
        () => (session?.projections ? session.projections.faceOf(key) : null), [session, key]);
      const subscribe = React.useCallback(
        (cb) => (face ? face.subscribe(cb) : NOOP_UNSUB()), [face]);
      const getSnapshot = React.useCallback(
        () => (face ? face.getSnapshot() : undefined), [face]);
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    // 流式快照（chat.legacy.partial）的最新一行可读输出
    function lastStreamLine(partial) {
      const blocks = partial?.blocks ?? [];
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if ((b.kind === "text" || b.kind === "reasoning") && b.text) {
          const lines = b.text.split("\n").map((s) => s.trim()).filter(Boolean);
          if (lines.length) return (b.kind === "reasoning" ? "💭 " : "") + lines[lines.length - 1];
        } else if (b.kind === "tool-call" && b.name) {
          return "🔧 调用工具 " + b.name;
        }
      }
      return null;
    }

    function fmtTok(n) {
      if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
      if (n >= 1000) return (n / 1000).toFixed(1) + "k";
      return String(n);
    }

    // 状态延续时长（statusAt 距今多久）——g-124 staleStatus 分支显示用（负责人 2026-08-22）
    function fmtElapsed(ts, now) {
      const ms = now - ts;
      if (!(ms > 0)) return "刚刚";
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + " 秒";
      const m = Math.floor(s / 60);
      if (m < 60) return m + " 分钟";
      const h = Math.floor(m / 60);
      if (h < 24) return h + " 小时" + (m % 60 ? " " + (m % 60) + " 分" : "");
      const d = Math.floor(h / 24);
      return d + " 天" + (h % 24 ? " " + (h % 24) + " 小时" : "");
    }

    // token/上下文占用的紧凑文本（LiveStrip 与 SessionPanel 折叠态共用）
    function liveMeter(usage, pressure) {
      const tokTotal = usage
        ? usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
        : null;
      const ctxPct = pressure && pressure.contextWindow
        ? Math.round((100 * (pressure.projectedTokens ?? pressure.pressureTokens ?? 0)) / pressure.contextWindow)
        : null;
      return [
        tokTotal !== null ? "tok " + fmtTok(tokTotal) : null,
        ctxPct !== null ? "ctx " + ctxPct + "%" : null,
      ].filter(Boolean).join(" ｜ ");
    }

    // 卡片内嵌实时条（g-129 负责人 2026-08-22 格式调整）：第一行 = 运行状态 + 流式内容（同行，
    // 流式时有时无不再引起高度变化）；status_line + tok/ctx 放 tooltip（悬浮查看）。
    function LiveStrip(props) {
      const { session } = useBoundSession(props.parentId, props.childId);
