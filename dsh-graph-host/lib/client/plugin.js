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
        // g-351：直接父索引的目录来源改为形状探测（旧 subagentsByParent / 新 projectionsBySession），
        // 索引构造与反查口径保持不变。
        const catalogsByParent = new Map();
        try {
          const legacy = snap.subagentsByParent;
          if (legacy && typeof legacy === "object") {
            for (const pid of Object.keys(legacy)) catalogsByParent.set(pid, legacy[pid]?.entries);
          }
          const projected = snap.projectionsBySession;
          if (projected && typeof projected === "object") {
            for (const pid of Object.keys(projected)) {
              if (!catalogsByParent.has(pid)) catalogsByParent.set(pid, projected[pid]?.values?.subagentCatalog);
            }
          }
        } catch { /* 形状不符 → 空索引，按未收录降级 */ }
        // g-244：运行时列表快照是 byId 记录；仅旧/降级形状是 items 数组，两种都读。
        const itemList = Array.isArray(snap.items) ? snap.items : null;
        const byId = (sid) => {
          const rec = snap.byId;
          if (rec && typeof rec === "object" && Object.prototype.hasOwnProperty.call(rec, sid)) return rec[sid];
          return itemList ? itemList.find((s) => s && (s.sessionId === sid || s.id === sid)) : undefined;
        };
        // g-244：子 → 直接父 反查表（子代理目录 + currentAddress 导航地址）。
        // g-351：目录 entry 的形状探测（旧带 kind / 新无 kind）统一走 catalogParentIndex，
        //        与子会话导航、地址构造共用同一判定函数；此处不再内联 kind 谓词。
        const parentIndex = catalogParentIndex(catalogsByParent);
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
        // g-321：会话激活判断双向兼容——0.1.5-rc.2 用 snap.current / snap.currentAddress；
        // 0.1.6-alpha.2 移除了二者，改为「本地引用计数里 mainView > 0 的那一行」
        // （与 DSH 自身 ui-workspace / ui-settings-general 的判定同源）。
        const retainedMainViewId = (() => {
          const list = Array.isArray(snap.items)
            ? snap.items
            : (snap.byId && typeof snap.byId === "object" ? Object.values(snap.byId) : []);
          for (const s of list) {
            if (!s || (s.retainedBy?.mainView ?? 0) <= 0) continue;
            if (typeof s.id === "string" && s.id) return s.id;
            if (typeof s.sessionId === "string" && s.sessionId) return s.sessionId;
          }
          return null;
        })();
        const current = typeof snap.current === "string" && snap.current
          ? snap.current
          : (typeof snap.currentAddress?.childSessionId === "string" && snap.currentAddress.childSessionId
            ? snap.currentAddress.childSessionId
            : retainedMainViewId);
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
    // g-330 风险核实（0.1.6-alpha.2 真机 3083）：右侧栏页签条本身是 role="presentation"
    //（`data-dockkit-strip-tabs`），不构成 `[role="tablist"]`，故下面这条全文档查询在右侧栏
    // 打开时也不会取到右侧栏页签；实测从右侧栏看板点「转到对话」后主区确实切回「对话」。
    // 结论：前提成立，无需为此改动本函数（不改共享跳转路径）。
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
    // g-321：会话导航双向兼容（0.1.6 起导航职责从 sessions 服务迁移到 uiWorkspace）。
    // uiWorkspace 由 ui-workspace 插件声明在 Context 上，按可选能力经 ctx.get 探测取得；
    // 缺失（0.1.5-rc.2 或未激活该插件的精简 profile）时回退到 sessions.open/openSubagent，
    // 绝不把 uiWorkspace 列为硬 inject——那会让旧 profile 的整个看板 client apply 被阻断。
    function uiWorkspaceRt() {
      try { return appCtx?.get?.("uiWorkspace") ?? appCtx?.uiWorkspace ?? null; } catch { return null; }
    }
    // 统一跳转：优先 uiWorkspace.openSession(target)（0.1.6），回退 legacyFn（0.1.5 的 sessions.*）。
    // target 是 SessionId 或 SubagentAddress，两种版本共用同一份 address 形状。
    function openSessionTarget(target, legacyFn) {
      const uw = uiWorkspaceRt();
      if (uw && typeof uw.openSession === "function") {
        try { uw.openSession(target); return true; }
        // i18n-keep(category-a)：开发者控制台诊断日志（console.warn），非 UI 文案。
        catch (e) { console.warn("[dsh-graph-host] uiWorkspace.openSession 失败，回退 sessions.*", e); }
      }
      if (typeof legacyFn === "function") {
        try { if (legacyFn() !== false) return true; }
        // i18n-keep(category-a)：开发者控制台诊断日志（console.warn），非 UI 文案。
        catch (e) { console.warn("[dsh-graph-host] 旧版会话导航 API 失败", e); }
      }
      return false;
    }
    async function openChildSession(parentSessionId, childId) {
      if (!parentSessionId || !childId) return;
      const navigationKey = parentSessionId + "\u0000" + childId;
      if (openingChildSessions.has(navigationKey)) return;
      openingChildSessions.add(navigationKey);
      const rt = sessionsRt ?? appCtx?.get?.("sessions");
      try {
        if (!rt) return;
        // 目录必须先加载，否则 selectSubagent 抛 "not a healthy catalog child"（发现#21）
        await refreshSubagentCatalog(rt, parentSessionId);
        // g-351：entry 形状探测与地址构造统一走 helpers 的同一判定函数
        //（旧宿主 entry 带 kind、新宿主无 kind；此处内联 kind 谓词会让新宿主恒不命中，
        //  点「↗ 转到对话」静默退化为打开父会话）。
        const entry = catalogChildEntry(subagentCatalogEntries(rt, parentSessionId), childId);
        if (entry) {
          // g-321：0.1.5 走 sessions.openSubagent(address)；0.1.6 该 API 已移除，
          // 由 uiWorkspace.openSession(address) 一步完成「选中会话 + 切到对话」。
          const address = { parentSessionId, childSessionId: childId, mode: catalogAddressMode(entry) };
          if (!openSessionTarget(address, typeof rt.openSubagent === "function" ? () => rt.openSubagent(address) : null)) {
            // i18n-keep(category-a)：开发者控制台诊断日志（console.warn），非 UI 文案。
            console.warn("[dsh-graph-host] 无可用子会话导航 API（uiWorkspace.openSession / sessions.openSubagent 均缺失）：", childId);
          }
          activateChatTab();
        } else {
          // 目录里没有（不健康/已清理）：退化为打开父会话
          console.warn("[dsh-graph-host] child not in catalog, opening parent:", childId);
          openSessionTarget(parentSessionId, typeof rt.open === "function" ? () => rt.open(parentSessionId) : null);
          activateChatTab();
        }
      } catch (e) {
        console.warn("[dsh-graph-host] openSubagent failed", e);
        try {
          openSessionTarget(parentSessionId, typeof rt?.open === "function" ? () => rt.open(parentSessionId) : null);
          activateChatTab();
        } catch { /* 静默 */ }
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
    // ===== g-330：右侧栏页签入口（方案 B）=====
    // 保留会话内 conversation.view 入口不变，另在 DSH 右侧栏以 tab 形式打开同一份 KanbanView。
    // 做法对齐 dsh-context 的 watchSidebarContextTab（两段式注册）：
    //   ① ctx.sidebarRightTabs.register({ id, kind, title, guide }) —— 类型（静态面）
    //   ② sidebar.right.pane.tab        seat（key = 同一个 id）—— 本体
    //   ③ sidebar.right.pane.tab.title  seat（key = 同一个 id）—— chip 标题
    // id 必须全局唯一、kind 必须带命名空间：registry 对重复 id、以及同 band 的 kind 冲突会抛异常，
    // 外部插件可能已占用朴素名 graph/kanban/context，故两者都用包名 "dsh-graph"。
    const SIDEBAR_TAB_ID = "dsh-graph";
    const SIDEBAR_TAB_KIND = "dsh-graph";
    // guide 胶囊的位置：排在宿主内置 Files 条目（order 10）之后，与 dsh-context（order 20）一致。
    const SIDEBAR_GUIDE_ORDER = 20;
    // 右侧栏页签的字形（看板列）。currentColor + 透明度分层，自动跟随宿主主题；
    // 自带组件而非复用产品图标：不依赖 primitives 的图标导出面（旧宿主可能没有）。
    function GraphTabIcon({ size = 16, className }) {
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none", className,
        "aria-hidden": "true", xmlns: "http://www.w3.org/2000/svg",
        style: { flex: "none" },
      },
        h("rect", { x: 1, y: 2, width: 3.6, height: 12, rx: 1.2, fill: "currentColor", opacity: 0.5 }),
        h("rect", { x: 6.2, y: 2, width: 3.6, height: 8.5, rx: 1.2, fill: "currentColor", opacity: 0.78 }),
        h("rect", { x: 11.4, y: 2, width: 3.6, height: 5.5, rx: 1.2, fill: "currentColor" }));
    }
    // chip 标题 seat：图标 + 文案。dockkit 的 chip 标题是 flex 行、且右侧有 30px 渐隐遮罩
    // （._tabTitle mask-image linear-gradient calc(100% - 30px)），故图标 flex:none、
    // 文案留 30px 右内边距，让渐隐落在文字之后——与 dsh-context 的 lc-title-label 同一处理。
    function GraphTabTitle() {
      // 切语言时重算：本组件订阅 dsh-graph:locale-changed（plugin 在 locale/change 时广播）。
      useLocaleRevision();
      return h(React.Fragment, null,
        h(GraphTabIcon, { size: 16 }),
        h("span", {
          style: { paddingRight: 30, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
        }, dgT("sidebar.tab.title")));
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
              // g-230：locale-following thunk——resolveSlotLabel 对 function 求值，切语言时重算
              label: () => dgT("board.title"),
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
        // ===== g-330：右侧栏页签（方案 B）=====
        // 必须走 deferred inject，不得进上面的硬 inject（inject: ["slots", "sessions"] 保持不变）：
        // 宿主没有 sidebarRightTabs（精简 profile / 旧宿主）时回调不触发 ⇒ 不注册、不 pend、不报错，
        // 会话内看板、设置页、header badge 全部照旧。全程特性探测，不做任何版本号比较。
        try {
          ctx.inject?.(["sidebarRightTabs"], (injected) => {
            const scope = injected ?? {};
            const disposers = [];
            const own = (result) => { if (typeof result === "function") disposers.push(result); };
            const disposeAll = () => {
              for (const d of disposers) { try { d(); } catch { /* 静默 */ } }
            };
            try {
              const tabs = scope.sidebarRightTabs;
              // 注册表经注入的 scope 取 slots（与 dsh-context 同源）；形状不符即静默降级。
              const sidebarSlots = scope.slots ?? ctx.slots;
              if (!tabs || typeof tabs.register !== "function") return;
              if (!sidebarSlots || typeof sidebarSlots.register !== "function") return;
              own(tabs.register({
                id: SIDEBAR_TAB_ID,
                kind: SIDEBAR_TAB_KIND,
                // g-230 纪律：thunk 标签，按活跃语言即时重算（guide 条目同理）
                title: () => dgT("sidebar.tab.title"),
                guide: [{
                  id: SIDEBAR_TAB_ID,
                  order: SIDEBAR_GUIDE_ORDER,
                  title: () => dgT("sidebar.tab.title"),
                  description: () => dgT("sidebar.guide.description"),
                  icon: GraphTabIcon,
                }],
              }));
              // 本体 seat：复用与 conversation.view **完全相同**的 KanbanView、数据源与渲染实现
              // （g-352 att-005：头部/工具条是同一份实现、零 host 门控 ⇒ 两侧 DOM/行为完全一致；
              //  host: "sidebar" 仅作为挂载点标识保留，不再门控任何渲染）。
              // 该 seat 是 session 作用域，投递与 conversation.view 相同的标准套件，含 sessionId ⇒
              //  workspace 解析链无需任何改动，也不触碰 g-113 的会话隔离边界。
              own(sidebarSlots.inject("sidebar.right.pane.tab", () => sidebarSlots.register(
                { name: "sidebar.right.pane.tab", key: SIDEBAR_TAB_ID, locale: "dsh-graph" },
                (props) => h(KanbanView, { ...props, host: "sidebar" }),
              )));
              // chip 标题 seat
              own(sidebarSlots.inject("sidebar.right.pane.tab.title", () => sidebarSlots.register(
                { name: "sidebar.right.pane.tab.title", key: SIDEBAR_TAB_ID },
                (props) => h(GraphTabTitle, props),
              )));
            } catch (e) {
              // id/kind 被占用、registry 抛错等：撤销已成功的部分注册；
              // 右侧栏只是没有这个页签，绝不拖垮浏览器。
              disposeAll();
              // i18n-keep(category-a)：开发者控制台诊断日志（console.warn），非 UI 文案。
              console.warn("[dsh-graph-host] sidebarRight tab 注册失败，已撤销（右侧栏无该页签）", e);
              return;
            }
            return disposeAll;
          });
        } catch (e) {
          // i18n-keep(category-a)：开发者控制台诊断日志（console.warn），非 UI 文案。
          console.warn("[dsh-graph-host] sidebarRight deferred inject 失败（右侧栏无该页签）", e);
        }
        console.log("[dsh-graph-host] client apply: kanban view registered (i18n enabled)");
      },
    };
  },
});