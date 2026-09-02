    // 数据源：sessions.binding(childId).session（uSES 快照 subscribe/getSnapshot），
    // 流式行读 chat.legacy.partial（必须先 session.open()），token/上下文走投影
    // faceOf("tokenUsage"|"contextPressure")（无需 open），模型走 connection.api.sessions.models，
    // 发指令走 session.prompt（continuable 子代理自动路由 api.subagents.prompt，仅文本），
    // 最近记录走 connection.api.subagents.history。

    const boundSetup = new Map(); // childId -> Promise（地址配置只做一次）
    const boundModes = new Map(); // childId -> 'one-shot' | 'continuable'

    // 子代理地址配置（路由 prompt/history 到 subagents.*）。
    // 目录 entry 提供真实 mode；目录未收录时跳过地址配置（指令走 session.prompt 默认路由，错误会明示）。
    // 实时窗口（session.open()）由 openBoundSessionStream 按 g-224 实时显示开关门控，不在此处打开。
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
              // g-217：0.1.2-alpha.2 权威签名 configureSubagent(address, parentAvailable?)——
              // 按指南单参调用（address 含 parentSessionId/childSessionId/mode），parentAvailable 缺省 undefined
              session.configureSubagent?.(
                { parentSessionId: parentId, childSessionId: childId, mode: entry.mode });
            }
          } catch (e) {
            console.warn("[dsh-graph-host] 子代理地址配置失败", e);
          }
        }
      })();
      boundSetup.set(childId, p);
      return p;
    }

    // g-224：打开会话实时窗口（输出流数据源）。受实时显示开关门控——
    // 关闭时完全不打开发送窗口：eventSource 窗口不填充、无实时事件流动（网络/内存/CPU 释放）；
    // 重开时重新 open（成功后幂等缓存，避免开关切换反复触发；open() 本身幂等安全，指南 §7.6）。
    const boundOpened = new Map(); // childId -> Promise<boolean>（成功后缓存）
    function openBoundSessionStream(childId, session) {
      if (!session) return Promise.resolve(false);
      if (!getLiveDisplay()) return Promise.resolve(false);
      const cached = boundOpened.get(childId);
      if (cached) return cached;
      const p = (async () => {
        try {
          await session.open();
          boundOpened.set(childId, p);
          return true;
        } catch (e) {
          console.warn("[dsh-graph-host] session.open() 失败", e);
          return false;
        }
      })();
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

    // 解析绑定 childId 的 Session / eventSource（binding 是文档化的纯解析，渲染期安全）
    // g-217：0.1.2-alpha.2 实时输出新家在 binding.eventSource（不在 session 上）；
    // binding 解析失败 → session/eventSource 均为 null，LiveStrip 保留'⚠️ 会话未接入'占位。
    function useBoundSession(parentId, childId) {
      const listSnap = useSessionsList();
      const binding = React.useMemo(() => {
        if (!sessionsRt || !childId) return null;
        try { return sessionsRt.binding(childId) ?? null; }
        catch (e) { console.warn("[dsh-graph-host] binding 解析失败", e); return null; }
      }, [childId, listSnap]);
      const session = binding?.session ?? null;
      const eventSource = binding?.eventSource ?? null;
      const [mode, setMode] = React.useState(boundModes.get(childId) ?? null);
      // g-224：实时显示开关——关闭时跳过 session.open()（不激活输出流窗口），重开时恢复
      const liveEnabled = useLiveDisplayEnabled();
      React.useEffect(() => {
        if (!session) return;
        let alive = true;
        setupBoundSession(parentId, childId, session).then(() => {
          if (alive) setMode(boundModes.get(childId) ?? null);
        });
        // g-224：输出流窗口打开受开关门控（内部再判断 getLiveDisplay()，切换即触发重评估）
        openBoundSessionStream(childId, session);
        return () => { alive = false; };
      }, [session, parentId, childId, liveEnabled]);
      return { session, mode, eventSource };
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
    function useThrottledLiveSession(session, intervalMs = 200, liveEnabled = true) {
      // g-224：实时显示开关（由 useLiveStripState 传入）——关闭时不再读取流式行
      // （旧路径 chat.legacy 流式内容停止消费；新 harness 快照本无 chat，此门控主要作用于
      // 旧 harness 回退路径），仅保留生命周期状态（running 等）。
      const [liveState, setLiveState] = React.useState(() => {
        const snap = session ? session.getSnapshot() : null;
        return {
          snap,
          line: liveEnabled && snap && snap.chat ? lastStreamLine(snap.chat.legacy.partial) : null,
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
            line: liveEnabled && s && s.chat ? lastStreamLine(s.chat.legacy.partial) : null,
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
      }, [session, intervalMs, liveEnabled]);

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

    // ===== g-217：0.1.2-alpha.2 实时输出新路径（binding.eventSource）=====
    // 能力探测：有 binding.eventSource 走新路径；否则回退旧 chat.legacy.partial（C1/C5）。
    // 归一化形状 {pendingCount, activity, streamText, finalText}，UI 只消费该形状（指南 §5.2）。
    // 窗口语义（C4）：每次 flush 全量重扫 getSnapshot().entries——append 增量自然含尾部，
    // replace/prepend 全量重扫，无需按 change.kind 分叉。

    // 工具参数 → 一句话说明/文件名（C8）：优先 description → command → file_path → path → prompt；
    // 残缺 JSON 解析失败回退原始字符串（渲染与否由调用方 complete 门控决定，避免残缺 JSON 入 UI）。
    function toolDetail(argsRaw) {
      if (argsRaw == null || argsRaw === "") return "";
      let obj = null;
      try { obj = JSON.parse(argsRaw); } catch (e) { /* 残缺 JSON，保持 null */ }
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const k of ["description", "command", "file_path", "path", "prompt"]) {
          const v = obj[k];
          if (typeof v === "string" && v.trim()) {
            const t = v.trim();
            return t.length > 60 ? t.slice(0, 57) + "…" : t;
          }
        }
      }
      const s = String(argsRaw).trim();
      return s ? (s.length > 40 ? s.slice(0, 37) + "…" : s) : "";
    }

    // 事件窗口 → 归一化形状（指南 §5.2 参考实现）。
    // 按 callId 去重（tool/call 与 tool-call-delta 可能产生同一调用记录）；
    // 工具详情仅当 complete（block-end / tool/call 提供完整 arguments）才渲染。
    function deriveLive(entries, running, toolDetailFn) {
      const tail = (s) => {
        const lines = String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);
        return lines.length ? lines.slice(-2).join("\n") : "";
      };
      const finalOf = (blocks) => {
        const list = Array.isArray(blocks) ? blocks : [];
        for (let i = list.length - 1; i >= 0; i--) {
          const b = list[i];
          if (b?.type === "text" || b?.type === "reasoning") {
            const t = tail(b.text);
            if (t) return (b.type === "reasoning" ? "💭 " : "") + t;
          }
          if (b?.type === "tool-call" && b.name) return "⚙ 调用工具 " + b.name;
        }
        return "";
      };
      const upsert = (map, arr, id, init) => {
        let rec = map.get(id);
        if (!rec) {
          rec = Object.assign({ complete: false, running: true }, init);
          map.set(id, rec);
          arr.push(rec);
        }
        return rec;
      };

      let text = "", reasoning = "", finalText = "", hasStream = false, lastKind = "text";
      const pending = [], done = [], byCall = new Map();

      for (const entry of entries) {
        if (!entry || entry.type !== "event") continue;   // chunkrow 压缩历史跳过
        const e = entry.event;
        if (!e || typeof e.type !== "string") continue;
        switch (e.type) {
          case "assistant/chunk": {
            const c = e.data?.chunk; if (!c) break;
            if (c.type === "text-delta") { text += c.text || ""; hasStream = true; lastKind = "text"; }
            else if (c.type === "reasoning-delta") { reasoning += c.text || ""; hasStream = true; lastKind = "reasoning"; }
            else if (c.type === "tool-call-delta" && c.id) {
              const rec = upsert(byCall, pending, c.id, { name: c.name || "工具调用", args: "" });
              if (c.name) rec.name = c.name;
              rec.args += c.argumentsDelta || "";        // 累积，勿覆盖（§7.1）
            } else if (c.type === "block-end" && c.block?.type === "tool-call") {
              const rec = upsert(byCall, pending, c.block.id, { name: c.block.name || "工具调用", args: "" });
              if (c.block.name) rec.name = c.block.name;
              rec.args = c.block.arguments || rec.args;   // 完整参数覆盖增量
              rec.complete = true;
            }
            break;
          }
          case "assistant/message": {
            finalText = finalOf(e.data?.message?.content);
            text = ""; reasoning = ""; hasStream = false;
            break;
          }
          case "tool/call": {
            const rec = upsert(byCall, pending, e.data?.callId, { name: e.data?.name || "工具调用", args: "" });
            if (e.data?.name) rec.name = e.data?.name;
            if (e.data?.arguments != null) { rec.args = e.data.arguments; rec.complete = true; }
            rec.running = true;
            break;
          }
          case "tool/result": {
            const rec = byCall.get(e.data?.message?.source?.callId);
            const block = e.data?.message?.content?.[0];
            if (rec) {
              rec.running = false;
              done.push({ name: rec.name, args: rec.args, complete: rec.complete, isError: block?.isError });
            }
            break;
          }
          default: break;
        }
      }

      const open = pending.filter((r) => r.running !== false);
      const fmtAct = (r, icon) =>
        `${icon} ${r.name || "工具调用"}${r.complete && r.args ? ` · ${toolDetailFn(r.args)}` : ""}`;
      return {
        pendingCount: open.length,
        activity: [
          ...open.slice(-2).map((r) => fmtAct(r, "▶")),
          ...done.slice(-2).map((r) => fmtAct(r, r.isError ? "✖" : "✓")),
        ],
        streamText: hasStream ? ((lastKind === "reasoning" ? "💭 " : "") + tail(lastKind === "reasoning" ? reasoning : text)) : "",
        finalText,
      };
    }

    // 展示优先级（指南 §5.3）：pending>0 → 活动行；running+流式 → 流式文本；活动行 → 定稿文本
    function pickLiveLine(live, running) {
      if (live.pendingCount > 0) return live.activity.join(" ｜ ") || null;
      if (running && live.streamText) return live.streamText;
      if (live.activity.length) return live.activity.join(" ｜ ");
      return live.finalText || null;
    }

    // g-217：LiveStrip 数据源 hook——事件源新路径（能力探测）+ 旧 chat.legacy 回退（C1/C5）。
    // 复用 g-195 节流语义（≤5fps / ≥200ms trailing flush，不丢尾包，卸载清理定时器与订阅 C3）。
    function useLiveStripState(session, eventSource, intervalMs = 200) {
      // g-224：实时显示开关门控——关闭时断开事件源（输出流订阅完全停止），仅保留状态数据
      const liveEnabled = useLiveDisplayEnabled();
      // 旧路径状态（chat.legacy.partial）：能力探测缺失时回退，代码原样保留；
      // g-224：实时显示关闭时同样停止旧路径流式行读取（liveEnabled=false）
      const legacy = useThrottledLiveSession(session, intervalMs, liveEnabled);
      const feed = liveEnabled ? (eventSource ?? null) : null;
      const [live, setLive] = React.useState(() => {
        if (!feed || !session) return { pendingCount: 0, activity: [], streamText: null, finalText: null };
        return deriveLive(feed.getSnapshot()?.entries ?? [], !!session.getSnapshot()?.running, toolDetail);
      });
      React.useEffect(() => {
        if (!feed || !session) {
          // g-224：关闭实时显示 → 清空流式状态（无流式文字残留）；订阅在 cleanup 中释放
          setLive({ pendingCount: 0, activity: [], streamText: null, finalText: null });
          return;
        }
        let timer = null;
        let lastFlush = 0;
        let unmounted = false;
        const flush = () => {
          if (timer) { clearTimeout(timer); timer = null; }
          lastFlush = Date.now();
          if (unmounted) return;
          const entries = feed.getSnapshot()?.entries ?? [];
          const running = !!session.getSnapshot()?.running;
          setLive(deriveLive(entries, running, toolDetail));
        };
        const onUpdate = () => {
          const now = Date.now();
          const elapsed = now - lastFlush;
          if (elapsed >= intervalMs) flush();
          else if (!timer) timer = setTimeout(flush, intervalMs - elapsed);
        };
        flush();
        const unsub = feed.subscribe(onUpdate);
        return () => {
          unmounted = true;
          if (timer) clearTimeout(timer);
          if (typeof unsub === "function") unsub();
        };
      }, [feed, session, intervalMs, liveEnabled]);

      if (feed) {
        // 新路径：running 取会话快照（§7.9 更直接）；line 按展示优先级从归一化形状推导
        const running = !!(session?.getSnapshot?.().running);
        return { snap: null, line: pickLiveLine(live, running), running };
      }
      return legacy;
    }

    // 卡片内嵌实时条（g-129 负责人 2026-08-22 格式调整）：第一行 = 运行状态 + 流式内容（同行，
    // 流式时有时无不再引起高度变化）；status_line + tok/ctx 放 tooltip（悬浮查看）。
    // g-217：数据源接入 binding.eventSource 新路径（能力探测），旧 chat.legacy 回退，UI 形状不变。
    function LiveStrip(props) {
      const { session, eventSource } = useBoundSession(props.parentId, props.childId);
      // g-195: 使用 useLiveStripState 限制 peek 流式刷新为 ≤5fps (≥200ms)；新路径事件源 / 旧路径会话快照
      const { snap, line, running } = useLiveStripState(session, eventSource, 200);
      const usage = useProjectionValue(session, "tokenUsage");
      const pressure = useProjectionValue(session, "contextPressure");
      if (!props.childId) return null;
      if (!session) {
        return h("div", { style: S.liveStrip, title: props.childId },
          "⚠️ 会话未接入（不在会话列表）：" + props.childId.slice(0, 8));
      }
      // g-a92e1406 追加（负责人指示）：新一轮开始（running false→true）时清空上次 status，
      // 等 supervisor 快速替换成最新——记录 running 翻转时刻，旧于它的状态视为过期清空。
      const runningSinceRef = React.useRef(null);
      React.useEffect(() => {
        if (running && runningSinceRef.current == null) runningSinceRef.current = Date.now();
        if (!running) runningSinceRef.current = null;
      }, [running]);
      const staleStatus =
        running && props.statusAt != null && runningSinceRef.current != null &&
        props.statusAt < runningSinceRef.current;
      // g-124（负责人 2026-08-22）：staleStatus 不再用等待占位文案——
      // 改为显示当前状态延续时长（statusAt 距今多久，行内 + tooltip）；30s 时钟驱动刷新。
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        if (!staleStatus) return;
        const t = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(t);
      }, [staleStatus]);
      const staleDur = staleStatus && props.statusAt != null ? fmtElapsed(props.statusAt, now) : null;
      const meter = liveMeter(usage, pressure);
      // g-129 负责人 2026-08-22 格式：第一行 = 状态 + 流式内容（同行，流式时有时无不引起高度变化），
      // 右侧有足够宽度时显示 tok/ctx；第二行 = status_line 固定显示。
      const statusLabel = running ? "🟢 运行中" : "⚪ 空闲";
      const statusFull = running ? "运行中" : "空闲";
      // 第二行 status_line 内容（stale 时也显示全文，tooltip 补延续时长——g-124）
      const statusRowText = props.statusLine
        ? (running ? "⏳ " : "✅ ") + props.statusLine
        : (staleStatus ? "⏳ 状态延续 " + staleDur : null);
      // g-129: 空闲时 status_line 背景不带动画
      const statusRowClass = running && props.statusLine ? "dg-running-flow" : "";
      const lineEl = line
        ? h("span", { style: { ...S.meta, fontSize: 10, overflow: "hidden",
                                textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 } },
            "⏵ " + line)
        : h("span", { style: { ...S.meta, fontSize: 10, flex: 1, overflow: "hidden",
                               textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "…");
      const modelTitle = props.model ? `模型：${props.provider ? props.provider + "/" : ""}${props.model}` : null;
      return h(
        "div",
        { style: S.liveStrip, title: [statusFull, props.statusLine ? "状态：" + props.statusLine : null, modelTitle, meter ? "资源：" + meter : null, line ? "流式：" + line : null].filter(Boolean).join("\n") },
        // 第一行：状态 + 流式内容（同行）；右侧有空间时显示 tok/ctx（flex 布局自动压缩）
        h("div", { style: { display: "flex", alignItems: "center", gap: 5 } },
          h("span", { style: { color: running ? "var(--dsw-alias-state-success-primary, #3aa675)" : "var(--dsw-alias-label-tertiary, rgba(128,128,128,.9))", flexShrink: 0 } },
            statusLabel),
          lineEl,
          props.model
            ? h("span", { style: { ...S.meta, fontSize: 9, flexShrink: 0, opacity: 0.85, padding: "0 2px" }, title: modelTitle }, props.model)
            : null,
          meter
            ? h("span", { style: { ...S.meta, fontSize: 10, flexShrink: 0, marginLeft: 4 } }, meter)
            : null),
        // 第二行：status_line 固定显示（stale 时也显示全文）
        statusRowText
          ? h("div", {
              className: statusRowClass,
              style: { ...S.liveLine, marginTop: 1, fontSize: 10, overflow: "hidden",
                       textOverflow: "ellipsis", whiteSpace: "nowrap" },
              title: props.statusLine ? props.statusLine + (staleDur ? "（状态已延续 " + staleDur + "）" : "") : undefined,
            }, statusRowText)
          : null,
      );
    }
