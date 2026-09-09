    // g-223：按 sessionId 解析 workspace；无法验证时必须 fail closed，绝不跨会话复用缓存。
    // g-244：谱系回溯补全——快照兼容 byId/items 两种形状，父链兼容 parentId/parentSessionId，
    //        并用 subagentsByParent 目录反查与 currentAddress 导航地址补齐「目录型子会话」的直接父。
    let lastGoodWorkspace = null;
    function setLastGoodWorkspace(ws) { if (typeof ws === "string" && ws) lastGoodWorkspace = ws; }
    // wsOf(sid) remains the explicit workspace-membership check; viewed?.parentSessionId is walked safely.
    function resolveWorkspaceOfSession(sessionId) {
      try {
        const rawWsItems = workspacesRt?.list?.getSnapshot?.()?.items
          ?? appCtx?.get?.("workspaces")?.list?.getSnapshot?.()?.items;
        const wsItems = Array.isArray(rawWsItems) ? rawWsItems : [];
        const wsOf = (sid) => wsItems.find((w) => Array.isArray(w?.sessionIds)
          && w.sessionIds.includes(sid) && typeof w.path === "string" && w.path);
        // g-244：路径归一（去掉尾斜杠）。仅接受绝对路径，相对 cwd 会让服务端按进程 cwd 解析。
        const normPath = (p) => (typeof p === "string" && p ? (p.replace(/\/+$/, "") || "/") : null);
        // g-244：cwd 落在某个已知 workspace 根之下（含 worktree 子目录）时，归一到最长的那个根。
        const wsRootOfPath = (p) => {
          const abs = normPath(p);
          if (!abs || abs[0] !== "/") return null;
          let best = null;
          for (const w of wsItems) {
            const root = normPath(w?.path);
            if (!root || root[0] !== "/") continue;
            const hit = abs === root || abs.startsWith(root === "/" ? "/" : root + "/");
            if (hit && (best === null || root.length > best.length)) best = root;
          }
          return best;
        };
        const rt = sessionsRt ?? appCtx?.get?.("sessions");
        const snap = rt?.list?.getSnapshot?.() ?? {};
        // g-244：运行时列表快照是 byId 记录；仅旧/降级形状是 items 数组，两种都读。
        const itemList = Array.isArray(snap.items) ? snap.items : null;
        const byId = (sid) => {
          const rec = snap.byId;
          if (rec && typeof rec === "object" && Object.prototype.hasOwnProperty.call(rec, sid)) return rec[sid];
          return itemList ? itemList.find((s) => s && (s.sessionId === sid || s.id === sid)) : undefined;
        };
        // g-244：子 → 直接父 反查表（subagentsByParent 目录 + currentAddress 导航地址）。
        const parentIndex = new Map();
        const catalogs = snap.subagentsByParent;
        if (catalogs && typeof catalogs === "object") {
          for (const pid of Object.keys(catalogs)) {
            const entries = catalogs[pid]?.entries;
            if (!Array.isArray(entries)) continue;
            for (const e of entries) {
              if (e && e.kind === "child" && typeof e.id === "string" && e.id && !parentIndex.has(e.id)) {
                parentIndex.set(e.id, pid);
              }
            }
          }
        }
        const addr = snap.currentAddress;
        if (addr && typeof addr.childSessionId === "string" && typeof addr.parentSessionId === "string"
          && !parentIndex.has(addr.childSessionId)) {
          parentIndex.set(addr.childSessionId, addr.parentSessionId);
        }
        const parentOf = (sid) => {
          const item = byId(sid);
          if (typeof item?.parentId === "string" && item.parentId) return item.parentId;
          if (typeof item?.parentSessionId === "string" && item.parentSessionId) return item.parentSessionId;
          const indexed = parentIndex.get(sid);
          return typeof indexed === "string" && indexed ? indexed : null;
        };
        const pathOf = (sid) => {
          const seen = new Set();
          let current = sid;
          while (current && !seen.has(current)) {
            seen.add(current);
            const mapped = wsOf(current);
            if (mapped?.path) return mapped.path;
            const item = byId(current);
            const cwd = normPath(item?.cwd);
            if (cwd && cwd[0] === "/") {
              // g-244：谱系子会话（或 worktree 目录）的 cwd 归一到父工程根；
              // 无血缘的普通会话仍按自己的 cwd 解析，不改变 g-223 既有语义。
              const lineageParent = parentOf(current);
              if (lineageParent || /\/\.worktrees\//.test(cwd)) {
                const root = wsRootOfPath(cwd);
                if (root) return root;
              }
              return cwd;
            }
            current = parentOf(current);
          }
          return null;
        };
        const sid = sessionId ?? viewedSessionId;
        // Any supplied/viewed session is an isolation boundary: no current/cache fallback.
        if (sid) {
          const resolved = pathOf(sid);
          if (resolved) { setLastGoodWorkspace(resolved); return resolved; }
          return null;
        }
        // With no session selected, only the runtime's current session is eligible.
        const current = typeof snap.current === "string" && snap.current
          ? snap.current
          : (typeof snap.currentAddress?.childSessionId === "string" ? snap.currentAddress.childSessionId : null);
        const resolved = current ? pathOf(current) : null;
        if (resolved) { setLastGoodWorkspace(resolved); return resolved; }
        return null;
      } catch { return null; }
    }

    function currentWorkspace() {
      return resolveWorkspaceOfSession(viewedSessionId);
    }

    // 给 /api/dsh-graph* 请求统一追加 ?workspace=；未知 workspace 时由调用方 fail closed。
    function graphUrl(path, extraParams = {}, explicitWs = null) {
      const p = new URLSearchParams(extraParams);
      const ws = explicitWs ?? currentWorkspace();
      if (!ws) return null;
      p.set("workspace", ws);
      const qs = p.toString();
      return path + (path.includes("?") ? "&" : "?") + qs;
    }

    // 跳转后把会话页切回「对话」tab：chat 是 conversation.view 中 order=0 的固定首 tab；
    // tab 选中态存在 ui-conversation 的 per-session chatStore 内、无跨插件 API（源码核实），
    // 故在跳转后点一下首 tab（仅当当前选中不是它）。无 tab 栏（单视图）时不动。
    function activateChatTab() {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        try {
          const tabs = document.querySelectorAll('[role="tablist"] [role="tab"]');
          if (tabs.length < 2) return;
          const first = tabs[0];
          if (first.getAttribute("aria-selected") !== "true") first.click();
        } catch { /* 静默 */ }
      }));
    }
    const openingChildSessions = new Set();
    async function openChildSession(parentSessionId, childId) {
      if (!parentSessionId || !childId) return;
      const navigationKey = parentSessionId + "\u0000" + childId;
      if (openingChildSessions.has(navigationKey)) return;
      openingChildSessions.add(navigationKey);
      const rt = sessionsRt ?? appCtx?.get?.("sessions");
      try {
        if (!rt) return;
        // 目录必须先加载，否则 selectSubagent 抛 "not a healthy catalog child"（发现#21）
        rt.setSubagentCatalogOpen?.(parentSessionId, true);
        await rt.refreshSubagents?.(parentSessionId);
        const entries = rt.list?.getSnapshot?.().subagentsByParent?.[parentSessionId]?.entries ?? [];
        const entry = entries.find((e) => e.kind === "child" && e.id === childId);
        if (entry) {
          rt.openSubagent?.({ parentSessionId, childSessionId: childId, mode: entry.mode });
          activateChatTab();
        } else {
          // 目录里没有（不健康/已清理）：退化为打开父会话
          console.warn("[dsh-graph-host] child not in catalog, opening parent:", childId);
          rt.open?.(parentSessionId);
          activateChatTab();
        }
      } catch (e) {
        console.warn("[dsh-graph-host] openSubagent failed", e);
        try { rt?.open?.(parentSessionId); activateChatTab(); } catch { /* 静默 */ }
      } finally {
        openingChildSessions.delete(navigationKey);
      }
    }
    function sessionLinkBtn(parentSessionId, childId, label) {
      // 没有父会话就不渲染假入口：无法定位子会话时保持页面其它内容可用。
      if (!childId || !parentSessionId) return null;
      return h("button", {
        style: { ...S.btn, fontSize: 11, padding: "0 6px", marginLeft: 6, flexShrink: 0 },
        className: "dg-btn dg-session-link",
        type: "button",
        title: dgT('card.goToSession'),
        onClick: (e) => { e.stopPropagation(); void openChildSession(parentSessionId, childId); },
      }, label ?? dgT("card.goToSession"));
    }
    return {
      name: "dsh-graph",
      // connection/remote/modelDirectories 是可选 capability：不得把它们列为硬 inject，
      // 否则旧/部分 profile 未激活其中任一服务时，整个看板 client apply 会被 runner 阻断。
      inject: ["slots", "sessions"],
      apply(ctx) {
        appCtx = ctx;
        sessionsRt = ctx.sessions ?? null;
        connectionRt = ctx.get?.("connection") ?? null;
        // workspaces 服务经 ctx.get(name) 可选查找即可取到（runner 的 ctx.get 方法不要求 inject 声明，
        // 注入门禁只拦 ctx.workspaces 属性访问；workspaces 由 client-runtime `ctx.reflect.provide` 提供）
        workspacesRt = ctx.get?.("workspaces") ?? null;
        // g-230：注册 i18n 命名空间并创建全局翻译函数 t。
        // locale 服务通过 ctx.get 可选获取（核心内置服务但不列为硬 inject 以免阻断旧 profile）。
        const localeService = ctx.get?.("locale") ?? ctx.locale ?? null;
        const localeBind = registerI18n({ locale: localeService });
        dgT = createTranslator(localeBind);
        // g-230：监听语言切换——locale/change 事件触发时重建翻译函数（locale.bind 返回稳定引用，
        // 但字典注册不触发 locale/change；仅活跃语言切换时需要响应）。
        if (localeService && typeof ctx.on === "function") {
          ctx.on('locale/change', () => {
            // bind 返回稳定引用（已注册的命名空间），翻译函数自动读取当前活跃语言；
            // 此处仅在语言切换时强制刷新 React 渲染（通过状态广播机制）。
            try {
              dgT = createTranslator(localeBind || registerI18n({ locale: localeService }));
              // 通知看板组件重新渲染以响应语言切换
              window.dispatchEvent(new CustomEvent('dsh-graph:locale-changed'));
            } catch { /* 静默 */ }
          });
        }
        ctx.slots.inject("conversation.session.header.actions", () =>
          ctx.slots.register(
            { name: "conversation.session.header.actions", id: "dsh-graph-supervisor-badge", order: -9 },
            (props) => h(SupervisorHeaderBadge, props),
          ),
        );
        ctx.slots.inject("conversation.view", () =>
          ctx.slots.register(
            {
              name: "conversation.view",
              id: "dsh-graph-kanban",
              order: 80,
              get label() { return dgT("board.title"); },
            },
            (props) => h(KanbanView, props),
          ),
        );
        // g-133：注册「看板设置」settings.section 页（profile 级全局默认配置）。
        // settingsScope 缺失 / slots 未就绪时整页降级，不影响看板与工具。
        // 设置页必须在 apply 时立即注册，不能依赖可选 remote 激活——remote 缺失时
        // REST fallback 仍可正常读写配置；remote 后续激活时再升级 ctx 以获取精确 model catalog。
        try { registerGraphSettingsSection(ctx); } catch { /* 静默 */ }
        // g-231：remote 可选激活——若 remote service 后续激活，升级 appCtx 和 connectionRt
        // 使 loadHostCatalog 能从 session.modelCatalog 获取含 reasoning.efforts 的精确目录。
        // remote 缺失时此回调不执行，设置页仍通过 REST/legacy 降级正常工作。
        ctx.inject?.(["remote"], (scope) => {
          appCtx = scope;
          connectionRt = scope.get?.("connection") ?? connectionRt;
          // 已注册的 settings section 通过 appCtx 变量读取 catalog，无需重复注册。
        });
        console.log("[dsh-graph-host] client apply: kanban view registered (i18n enabled)");
      },
    };
  },
});