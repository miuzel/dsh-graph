    // 数据源：sessions.binding(childId).session（uSES 快照 subscribe/getSnapshot），
    // 流式行读 chat.legacy.partial（必须先 session.open()），token/上下文走投影
    // faceOf("tokenUsage"|"contextPressure")（无需 open），模型走 connection.api.sessions.models，
    // 发指令走 session.prompt（continuable 子代理自动路由 api.subagents.prompt，仅文本），
    // 最近记录走 connection.api.subagents.history。

    const boundSetup = new Map(); // childId -> Promise（地址配置只做一次）
    // g-351：值为**具体**模式 'one-shot' | 'continuable'；宿主给「未判定」（0.1.7 'unknown'）时为 null
    //（展示层据此省略会话模式，不把未判定冒充成「一次性」）。
    const boundModes = new Map(); // childId -> 'one-shot' | 'continuable' | null

    // ===== g-323：一次性「向某个会话投递一条 queue 消息」的**共享**能力探测入口 =====
    // 与 g-321 的渲染期保留生命周期（useSessionBinding / canRetain）是两件事：本函数服务
    // **事件回调**（批量接受 / 单卡接受的主管通知），只做一次短事务，绝不进入 render。
    //
    // 0.1.6-alpha.2 起 ClientSessions.binding(id) 只借用**已存在**的保留代际
    // （scopes.get(id)?.binding），不再按需 materialize，且类中已无 get(id)：未被任何组件
    // retain 过的会话（典型：主管会话未被看板任何面板绑定）恒取不到。0.1.5 的
    // binding(id) 是 resolve(id)?.binding（按需 materialize）且仍有 get(id)，被动借用即可用。
    // 故按**能力探测**分流，绝不写版本号分支；判定收敛为这一处，两个调用点共用
    // （batch-accept.js 的 notifySupervisorBatchAccept 与 goal-actions.js 的单卡接受通知）：
    //   - 有 using  → 用其 try/finally 语义（release 由 using 内部配平）；
    //   - 无 using 有 retain → 自行 retain + finally release（ready 被拒 / prompt 抛错都不漏代际）；
    //   - 两者皆无（0.1.5）→ 原样保留 binding ?? get 被动回退，行为一字不改。
    // 契约：成功发出恰好一条 queue 消息返回 true；取不到会话 / 无 prompt / 任意异常返回 false，
    // **绝不抛异常、绝不漏 release、绝不虚报成功**。warnLabel 可选：给出时沿用调用点既有的
    // console.warn 形态回报异常（保持既有可诊断性，不新增报错风暴）。
    async function promptSessionQueue(rt, target, parts, warnLabel) {
      if (!target) return false;
      try {
        // 优先 using：其内部 try/finally 已保证 release 配平（含 ready 被拒 / prompt 抛错）。
        if (typeof rt?.using === "function") {
          let sent = false;
          await rt.using(target, { source: "dsh-graph" }, async (reference) => {
            await reference.ready;
            const session = reference.binding?.session;
            if (!session?.prompt) return;
            await session.prompt(parts, "queue");
            sent = true;
          });
          return sent;
        }
        // 退回 retain：自行配平。binding 是 getter，release 之后再读会抛错，故必须在 finally 之前读取。
        if (typeof rt?.retain === "function") {
          const reference = rt.retain(target, { source: "dsh-graph" });
          try {
            await reference.ready;
            const session = reference.binding?.session;
            if (!session?.prompt) return false;
            await session.prompt(parts, "queue");
            return true;
          } finally {
            try { reference.release?.(); } catch (e) { /* 已释放 → 幂等忽略 */ }
          }
        }
        // 0.1.5 回退：被动借用既有 binding，或按需 get（原样保留，行为不退化）。
        const session = rt?.binding?.(target)?.session ?? rt?.get?.(target);
        if (!session?.prompt) return false;
        await session.prompt(parts, "queue");
        return true;
      } catch (err) {
        if (warnLabel) console.warn(warnLabel, err);
        return false;
      }
    }

    // ===== g-321：0.1.6-alpha.2「先 retain 再借用」的会话引用生命周期 =====
    // 0.1.6-alpha.2 起 ClientSessions.binding(id) 只借用**已存在**的保留代际
    // （scopes.get(id)?.binding），不再按需 materialize scope：无任何 retain 时恒 undefined，
    // 渲染期被动 binding() 因此拿不到会话（看板「⚠️ 会话未接入」与「模型目录不可用」的根因）。
    // 0.1.5 的 binding(id) 是 resolve(id)?.binding（会按需 materialize），被动调用仍可用。
    // 故按能力探测分流，绝不做版本号分支：
    //   有 retain → effect 内 retain(target,{source:"dsh-graph"}) → 等 ready → 借 binding → cleanup release()
    //   无 retain → 保持原有渲染期被动 binding(id) 回退，行为不得退化
    // retain/release 严格配平：模块级按身份引用计数，同一 target 在同一组件树多处消费
    // （SessionPanel 与内嵌 LiveStrip 会同时解析同一 childId）只 retain 一次，计数归零才归还代际。
    const retainedBindings = new Map(); // identity -> { count, started, reference, bound, promise, listeners }

    function bindIdentity(parentId, childId) {
      return parentId || childId ? (parentId ?? "") + "\u0000" + (childId ?? "") : null;
    }

    function ensureBindingEntry(identity) {
      let entry = retainedBindings.get(identity);
      if (!entry) {
        entry = { count: 0, started: false, reference: null, bound: null, promise: null, listeners: new Set() };
        retainedBindings.set(identity, entry);
      }
      return entry;
    }

    // 保留代际状态变化 → 通知订阅者重取快照（useSyncExternalStore 的 subscribe 回调）
    function notifyBinding(entry) {
      for (const cb of [...entry.listeners]) {
        try { cb(); } catch (e) { /* 单个订阅者异常不得中断其它订阅者 */ }
      }
    }

    // 目录 entry → SubagentAddress（与 setupBoundSession 的 entry 筛选口径保持一致）
    // g-351：目录形状由 helpers.subagentCatalogEntries 探测（旧 subagentsByParent / 新 projectionsBySession）。
    function subagentAddressFromCatalog(parentId, childId) {
      return subagentAddressOf(sessionsRt, parentId, childId);
    }

    // 子代理会话的 retain 目标：优先 SubagentAddress——resolveTarget 对地址不校验存在性，
    // 且会把地址写入 manager.addresses，使 session.prompt 走 subagents 路由；
    // 拿不到地址时先按能力刷新目录（新 refreshProjections / 旧 refreshSubagents）再试；
    // 仍未收录 → null（降级为空绑定、保留看板占位，绝不抛错、绝不刷 console）。
    async function resolveSessionRetainTarget(parentId, childId) {
      if (!childId) return null;
      if (!parentId) return childId; // 顶层会话（supervisor）：id 即 retain 目标
      try {
        const direct = sessionsRt?.subagentAddress?.(childId);
        if (direct) return direct;
      } catch (e) { /* 地址探测不可用 → 继续走目录路径 */ }
      const cached = subagentAddressFromCatalog(parentId, childId);
      if (cached) return cached;
      await refreshSubagentCatalog(sessionsRt, parentId);
      return subagentAddressFromCatalog(parentId, childId);
    }

    // 建立一次保留代际并借取 binding。任何失败（unknown session / Controller disposed /
    // open 失败）都降级为 bound=null（未接入占位），绝不让看板崩、绝不冒泡异常。
    function startRetainedBinding(target, entry) {
      let reference = null;
      try {
        reference = sessionsRt.retain(target, { source: "dsh-graph" });
      } catch (e) {
        entry.bound = null;
        notifyBinding(entry);
        return;
      }
      entry.reference = reference;
      const settle = () => {
        let bound = null;
        try {
          // binding 是 getter（释放后抛错），必须在 ready 之后、release 之前读取
          const b = reference.binding;
          bound = b ? { session: b.session ?? null, eventSource: b.eventSource ?? null, sessionId: reference.sessionId } : null;
        } catch (e) { bound = null; }
        entry.bound = bound;
        notifyBinding(entry);
      };
      const ready = reference && reference.ready;
      if (ready && typeof ready.then === "function") {
        ready.then(settle, () => { entry.bound = null; notifyBinding(entry); });
      } else {
        settle();
      }
    }

    // 计数归零才归还；retain 与 release 严格配平（含 retain 抛错、ready 未 settle 的情况）
    function releaseBinding(identity) {
      const entry = retainedBindings.get(identity);
      if (!entry) return;
      entry.count -= 1;
      if (entry.count > 0) return;
      retainedBindings.delete(identity);
      const finish = () => { try { entry.reference?.release?.(); } catch (e) { /* 已释放，幂等 */ } };
      const p = entry.promise;
      if (p && typeof p.then === "function") p.then(finish, finish);
      else finish();
    }

    // g-321：生命周期绑定的会话引用 hook（useBoundSession / useSessionModel 共用）。
    //   target: SessionId 字符串或 SubagentAddress 对象；opts: { parentId, childId, enabled }
    // 渲染期只读缓存快照，retain 一律发生在 effect 内，cleanup 里 release 配平。
    // 返回 { session, eventSource, binding }；未接入 / 尚未 ready 时 session 与 eventSource 均为 null。
    function useSessionBinding(target, opts) {
      const o = opts || {};
      const addressTarget = target && typeof target === "object" ? target : null;
      const childId = o.childId ?? (addressTarget ? addressTarget.childSessionId : (typeof target === "string" ? target : null));
      const parentId = o.parentId ?? (addressTarget ? addressTarget.parentSessionId : null);
      const enabled = o.enabled !== false;
      const canRetain = typeof sessionsRt?.retain === "function";
      const identity = bindIdentity(parentId, childId);
      // 0.1.5 回退路径仍需 list 快照驱动重渲染（子代理会话入列后 binding 才可解析）
      const listSnap = useSessionsList();

      // 无 retain（0.1.5）：保持原有渲染期被动解析，行为不得退化
      const passive = React.useMemo(() => {
        if (canRetain || !sessionsRt || !childId) return null;
        try { return sessionsRt.binding(childId) ?? null; }
        // i18n-keep(category-a)：开发者控制台诊断日志（console.warn），非 UI 文案。
        catch (e) { console.warn("[dsh-graph-host] binding 解析失败", e); return null; }
      }, [canRetain, childId, listSnap]);

      // 快照读取必须引用稳定（entry.bound 只在保留代际建立/释放时替换），否则无限重渲染
      const subscribe = React.useCallback((cb) => {
        if (!canRetain || !enabled || identity == null) return NOOP_UNSUB();
        const entry = ensureBindingEntry(identity);
        entry.listeners.add(cb);
        return () => { entry.listeners.delete(cb); };
      }, [canRetain, enabled, identity]);

      const getSnapshot = React.useCallback(() => {
        if (!canRetain) return passive;
        if (!enabled || identity == null) return null;
        const entry = retainedBindings.get(identity);
        return entry ? entry.bound : null;
      }, [canRetain, enabled, identity, passive]);

      const bound = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

      // 依赖只取能力与身份，**不含** listSnap：0.1.6 的 publishRetention 会因我们自己的 retain
      // 更新 list 快照，若把 listSnap 放进依赖会形成 retain→通知→再 retain 的无限循环。
      React.useEffect(() => {
        if (!canRetain || !enabled || identity == null) return undefined;
        const entry = ensureBindingEntry(identity);
        entry.count += 1;
        let released = false;
        if (!entry.started) {
          entry.started = true;
          entry.promise = (async () => {
            const resolved = await resolveSessionRetainTarget(parentId, childId);
            if (resolved == null) { entry.bound = null; notifyBinding(entry); return; }
            startRetainedBinding(resolved, entry);
          })();
        }
        return () => {
          if (released) return;
          released = true;
          releaseBinding(identity);
        };
      }, [canRetain, enabled, identity, parentId, childId]);

      return {
        session: bound?.session ?? null,
        eventSource: bound?.eventSource ?? null,
        binding: bound ?? null,
      };
    }

    // 子代理地址配置（路由 prompt/history 到 subagents.*）。
    // 目录 entry 提供 mode：具体模式（'one-shot'/'continuable'）直接下发；宿主的「未判定」
    //（0.1.7 'unknown'）按 `catalogAddressMode` 下发通配值并由宿主按 identity 回填。
    // 目录未收录时跳过地址配置（指令走 session.prompt 默认路由，错误会明示）。
    // 实时窗口（session.open()）由 openBoundSessionStream 按 g-224 实时显示开关门控，不在此处打开。
    function setupBoundSession(parentId, childId, session) {
      if (boundSetup.has(childId)) return boundSetup.get(childId);
      const p = (async () => {
        if (parentId) {
          try {
            await refreshSubagentCatalog(sessionsRt, parentId);
            // g-351：与子会话导航/地址构造共用同一 entry 形状探测函数（旧带 kind、新无 kind）。
            const entry = catalogChildEntry(subagentCatalogEntries(sessionsRt, parentId), childId);
            if (entry) {
              // g-351：展示层只认具体模式；宿主的「未判定」（0.1.7 'unknown'）记 null，
              //        由 live-panel 省略该字段，绝不臆断显示成「一次性」。
              boundModes.set(childId, catalogEntryMode(entry));
              // g-217：0.1.2-alpha.2 权威签名 configureSubagent(address, parentAvailable?)——
              // 按指南单参调用（address 含 parentSessionId/childSessionId/mode），parentAvailable 缺省 undefined
              session.configureSubagent?.(
                { parentSessionId: parentId, childSessionId: childId, mode: catalogAddressMode(entry) });
            }
          } catch (e) {
            // i18n-keep(category-a)：开发者控制台诊断日志（console.warn），非 UI 文案。
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
          // i18n-keep(category-a)：开发者控制台诊断日志（console.warn），非 UI 文案。
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

    // 解析绑定 childId 的 Session / eventSource。
    // g-321：改为消费 useSessionBinding——0.1.6-alpha.2 先按生命周期 retain 再借取 binding
    // （无 retain 的 0.1.5 自动回退被动解析）；session / eventSource 语义与对外形状不变。
    // g-217：0.1.2-alpha.2 实时输出新家在 binding.eventSource（不在 session 上）；
    // 未接入 / 尚未 ready / retain 降级 → session、eventSource 均为 null，LiveStrip 保留占位。
    function useBoundSession(parentId, childId) {
      const binding = useSessionBinding(childId, { parentId: parentId ?? null, childId: childId ?? null });
      const session = binding.session;
      const eventSource = binding.eventSource;
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

    // g-321：排队深度 hook（inbox 投影优先，0.1.5 快照 queue 回退）。
    // getSnapshot 必须返回**按值稳定**的原语，否则 useSyncExternalStore 每次比较都判定变化 → 无限重渲染；
    // 因此这里只返回 pendingCount 数字，完整形状由 sessionQueueState 在事件回调中读取。
    function useSessionQueueDepth(session) {
      const face = React.useMemo(
        () => { try { return session?.projections?.faceOf?.("inbox") ?? null; } catch { return null; } },
        [session]);
      const subscribe = React.useCallback(
        (cb) => (face ? face.subscribe(cb) : (session ? session.subscribe(cb) : NOOP_UNSUB())), [face, session]);
      const getSnapshot = React.useCallback(
        () => sessionQueueState(session).pendingCount, [session]);
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
          return dgT("live.toolCall", { name: b.name });
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
      if (!(ms > 0)) return dgT("live.justNow");
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + dgT("live.seconds");
      const m = Math.floor(s / 60);
      if (m < 60) return m + dgT("live.minutes");
      const h = Math.floor(m / 60);
      if (h < 24) return h + dgT("live.hours") + (m % 60 ? " " + (m % 60) + dgT("live.minutesShort") : "");
      const d = Math.floor(h / 24);
      return d + dgT("live.days") + (h % 24 ? " " + (h % 24) + dgT("live.hours") : "");
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
          if (b?.type === "tool-call" && b.name) return dgT("live.toolCall", { name: b.name });
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
              const rec = upsert(byCall, pending, c.id, { name: c.name || dgT("live.toolCall", { name: "" }), args: "" });
              if (c.name) rec.name = c.name;
              rec.args += c.argumentsDelta || "";        // 累积，勿覆盖（§7.1）
            } else if (c.type === "block-end" && c.block?.type === "tool-call") {
              const rec = upsert(byCall, pending, c.block.id, { name: c.block.name || dgT("live.toolCall", { name: "" }), args: "" });
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
            const rec = upsert(byCall, pending, e.data?.callId, { name: e.data?.name || dgT("live.toolCall", { name: "" }), args: "" });
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
        `${icon} ${r.name || dgT("live.toolCall", { name: "" })}${r.complete && r.args ? ` · ${toolDetailFn(r.args)}` : ""}`;
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

      // React Hook 规则：所有 hook（useRef / useEffect / useState）必须在顶层无条件执行，严禁在 early return 之后
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

      if (!props.childId) return null;
      // g-188：有 childId 且父会话可定位时，整条 LiveStrip 直达子代理；吞掉冒泡避免打开卡片详情。
      const canOpen = Boolean(props.parentId && props.childId);
      const activateStrip = (e) => {
        e.stopPropagation();
        if (e.type === "keydown") {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
        }
        void openChildSession(props.parentId, props.childId);
      };
      const stripProps = {
        style: canOpen ? { ...S.liveStrip, cursor: "pointer" } : S.liveStrip,
        className: canOpen ? "dg-live-strip-clickable" : undefined,
        tabIndex: canOpen ? 0 : undefined,
        role: canOpen ? "button" : undefined,
        onClick: canOpen ? activateStrip : undefined,
        onKeyDown: canOpen ? activateStrip : undefined,
      };
      if (!session) {
        return h("div", { ...stripProps, title: props.childId },
          dgT("live.unconnected") + props.childId.slice(0, 8));
      }

      const staleDur = staleStatus && props.statusAt != null ? fmtElapsed(props.statusAt, now) : null;
      const meter = liveMeter(usage, pressure);
      // g-129 负责人 2026-08-22 格式：第一行 = 状态 + 流式内容（同行，流式时有时无不引起高度变化），
      // 右侧有足够宽度时显示 tok/ctx；第二行 = status_line 固定显示。
      const statusLabel = running ? "🟢 " + dgT("status.running") : "⚪ " + dgT("status.idle");
      const statusFull = running ? dgT("status.running") : dgT("status.idle");
      // 第二行 status_line 内容（stale 时也显示全文，tooltip 补延续时长——g-124）
      // g-239：区分真实生命周期运行态与人工汇报文本，避免空闲时谎报 ✅ 或失实展示运行态
      const formattedStatus = formatStatusWithLifecycle(props.statusLine, running, false, props.statusState);
      const statusRowText = props.statusLine
        ? formattedStatus.fullText
        : (staleStatus ? "⏳ " + dgT("status.stale", { duration: staleDur }) : null);
      // g-129 & g-239: 仅当真正 running 且无终态/阻塞/失败时带动画
      const statusRowClass = formattedStatus.isRunning ? "dg-running-flow" : "";
      const lineEl = line
        ? h("span", { style: { ...S.meta, fontSize: 10, overflow: "hidden",
                                textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 } },
            "⏵ " + line)
        : h("span", { style: { ...S.meta, fontSize: 10, flex: 1, overflow: "hidden",
                               textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "…");
      // g-225：常态展示精简 model ID，仅在 tooltip (title) 保留完整 provider/model 追溯
      const modelTitle = props.model ? dgT("live.model") + `${props.provider ? props.provider + "/" : ""}${props.model}` : null;
      // g-352 att-003 第 3 项：compact（窄档主管栏）＝ **单行**形态 —— 只保留「状态 + 状态行」这一行，
      // 不渲染 meter / 独立流式行 / 第二行状态行；文字一律 min-width:0 + 省略号收敛（不再互相重叠）。
      // 默认（未传 compact）走下面的原渲染路径，逐字不变（conversation.view 与卡片内嵌 LiveStrip 均如此）。
      if (props.compact) {
        return h(
          "div",
          { ...stripProps, title: [statusFull, props.statusLine ? dgT("live.status") + props.statusLine : null, modelTitle, meter ? dgT("live.resource") + meter : null].filter(Boolean).join("\n") },
          h("div", { style: { display: "flex", alignItems: "center", gap: 5, minWidth: 0, overflow: "hidden" } },
            h("span", { style: { color: running ? "var(--dsw-alias-state-success-primary, #3aa675)" : "var(--dsw-alias-label-tertiary, rgba(128,128,128,.9))", flexShrink: 0 } },
              statusLabel),
            h("span", { style: { ...S.meta, fontSize: 10, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              statusRowText || (line ? "⏵ " + line : "…"))),
        );
      }
      return h(
        "div",
        { ...stripProps, title: [statusFull, props.statusLine ? dgT("live.status") + props.statusLine : null, modelTitle, meter ? dgT("live.resource") + meter : null, line ? dgT("live.stream") + line : null].filter(Boolean).join("\n") },
        // 第一行：状态 + 流式内容（同行）；右侧有空间时显示 tok/ctx（flex 布局自动压缩）
        h("div", { style: { display: "flex", alignItems: "center", gap: 5 } },
          h("span", { style: { color: running ? "var(--dsw-alias-state-success-primary, #3aa675)" : "var(--dsw-alias-label-tertiary, rgba(128,128,128,.9))", flexShrink: 0 } },
            statusLabel),
          lineEl,
          meter
            ? h("span", { style: { ...S.meta, fontSize: 10, flexShrink: 0, marginLeft: 4 } }, meter)
            : null),
        // 第二行：status_line 固定显示（stale 时也显示全文）
        statusRowText
          ? h("div", {
              className: statusRowClass,
              style: { ...S.liveLine, marginTop: 1, fontSize: 10, overflow: "hidden",
                       textOverflow: "ellipsis", whiteSpace: "nowrap" },
              title: props.statusLine ? props.statusLine + (staleDur ? " (" + dgT("live.statusOngoing", { duration: staleDur }) + ")" : "") : undefined,
            }, statusRowText)
          : null,
      );
    }
    // Contract title shape: title: [statusFull, props.statusLine ? "状态：" + props.statusLine : null, modelTitle
