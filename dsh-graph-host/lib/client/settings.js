    // g-133：dsh-graph profile 级全局默认设置页（settings.section：看板设置）。
    // 仅保留子代理默认 provider、默认 model id、子代理默认补充提示词。
    // 该配置写入当前 DSH profile 的用户级全局设置（settingsScope.bind({namespace:"dsh-graph"})），
    // 不写当前 workspace；provider/model 仅作缺省值（workspace project.yaml 明确配置优先）。
    // 覆盖层：settings scope 按 profile 隔离；memory scope 通过 Host settings RPC 兼容读写。
    // g-133：provider/model 由自由文本 input 改为合法目录 select——目录来自 ctx.get('connection').api
    // 的 llm.providers/llm.models（仅 advisory 可选列表，不拦截保存）；settings.yaml 已存但目录
    // 未列出的旧值保留为「已存值（当前目录未列出）」固定 option（不可自由编辑、可继续保存）。
    const GRAPH_SETTINGS_NS = "dsh-graph";
    // g-453：新线（宿主设置表单投影）的命名空间 = profile 条目 id（cordis.patch.yml 的 insert id）
    // —— 与历史 namespace 名不同，两者都作候选按 describe 的实际 ns 集合发现（见 createGraphSettingsApiScope）。
    const GRAPH_SETTINGS_ENTRY_ID = "dsh-graph-host";
    const GRAPH_SETTINGS_NS_CANDIDATES = [GRAPH_SETTINGS_ENTRY_ID, GRAPH_SETTINGS_NS];
    // g-453：profile 全局设置 scope。绑定**迟到且可订阅**：
    //  - 宿主 0.2.0-rc.2 起客户端设置服务不再叫 `settingsScope`，改为点分服务名 `remote.settings`
    //    （`ctx.get("remote.settings")` 可取；属性访问 `ctx.remote.settings` 会撞 cordis 注入门禁
    //    `cannot get property "remote.settings" without inject` —— 0.2.0-rc.2 隔离实例实测）。
    //    但该腿**可被补偿**（下方 `ctx.inject(["remote.settings"], …)` 的声明即补偿），故不是承重腿：
    //    真正的承重腿是**命名空间发现**（=`profile 条目 id`，见 createGraphSettingsApiScope 处注释）。
    //  - 服务可能在 apply 之后才 provide（api-gateway 的 `$mount` 是异步的）⇒ 不能只绑一次。
    //  - 能力判定 = 「服务自身能否取到 / 能否 inject」，任何地方都不比对宿主版本号。
    //  - **迟到订阅路径的可达性（如实标注）**：本宿主上 `apply` 的绑定**先于**组件挂载（立即绑定已完成、
    //    `remote.settings` 在设置页打开前已可读）⇒ 「先渲染降级态、再 publish 重渲染」这段端到端序列在
    //    **真机上不可达**，属**防御路径**（宿主将来把服务 provide 推迟到挂载之后才会走到）。
    //    该路径的语义由 `core/tests/config-global.test.ts` 的 vm 行为夹具**直接驱动真实源码**覆盖
    //    （服务缺席 → inject 迟到触发 → 订阅者被唤醒 → 读到可用绑定；退订后不再唤醒），
    //    组件侧接线（effect 订阅 + `[scope]` 重渲染依赖）另有结构断言 —— 不再声称「真机已覆盖」。
    let gSettingsScope = null;
    // 绑定来源与优先级：同源幂等、高优先级（旧线 `settingsScope`）不被低优先级替换、服务实例更换即重绑。
    let gSettingsScopeSource = null;
    let gSettingsScopeRank = -1;
    const gSettingsScopeListeners = new Set();
    function subscribeGraphSettingsScope(listener) {
      gSettingsScopeListeners.add(listener);
      return () => { gSettingsScopeListeners.delete(listener); };
    }
    function publishGraphSettingsScope(scope, source, rank) {
      if (!scope) return gSettingsScope; // 解析失败不覆盖既有可用绑定（降级态保持原样）
      if (gSettingsScope && rank < gSettingsScopeRank) return gSettingsScope;
      if (gSettingsScope && rank === gSettingsScopeRank && source === gSettingsScopeSource) return gSettingsScope;
      gSettingsScope = scope;
      gSettingsScopeSource = source ?? null;
      gSettingsScopeRank = rank;
      for (const listener of [...gSettingsScopeListeners]) { try { listener(); } catch { /* 静默 */ } }
      return gSettingsScope;
    }
    // g-133：数据源 = ctx.get('connection').api（registerGraphSettingsSection 捕获），挂载时读 llm 目录。
    let gConnectionApi = null;
    let settingsModeInstanceSeq = 0;

    // 3082 的 settingsScope 在非 loopback 浏览器上下文会是 memory；此时仍可
    // 通过已存在的 profile settings RPC 读写 Host，而不是把配置伪装成 workspace 数据。
    function createGraphSettingsApiScope(api, ctx = (typeof appCtx !== "undefined" ? appCtx : null), remoteSettingsIn = null) {
      // g-425：受保护读取——`ctx?.remote` 裸回退在 remote 服务缺席时会撞 cordis 注入门禁抛错
      // （被调用方 bindGraphSettingsScope 的 try/catch 吞成「设置页整页降级」）。
      // g-453 根因是**两条腿**（Lane A 真机变异核验后的如实表述）：
      //   腿① 读取口径：`remote.settings` 是**点分服务名**，属性访问撞注入门禁
      //   `cannot get property "remote.settings" without inject`（0.2.0-rc.2 隔离实例实测：**基线产物**
      //   apply 后 ≈353ms 即抛、被 catch 吞成 `gSettingsScope = null` ⇒ 整页降级）。**但这条腿可被补偿**：
      //   本版新增的 `ctx.inject(["remote.settings"], …)` 声明使属性访问在同一注入域内合法 ⇒ Lane A 变异
      //   n1（把读取改回属性回退）真机**仍可用** ⇒ 腿①**不足单独解释**用户可见缺陷。静态守卫仍钉住它
      //   （`optionalServicePath` 语义 + 点分名不得走 optionalService），但不声称它单独致命。
      //   腿② 命名空间发现（**承重腿，无任何补偿**）：新线设置命名空间 = **profile 条目 id**
      //   `dsh-graph-host`，不是历史 namespace 名 `dsh-graph` —— 写死历史名 ⇒ 0 控件 + 「未暴露命名空间」，
      //   且当时整套门禁全绿（与 dsh-market 的 `settingsScope`→`settings` 静默失效同型）。
      //   ⇒ 腿② 必须按 `describe()` 返回的**实际 ns 集合**发现（见下方 GRAPH_SETTINGS_NS_CANDIDATES）。
      const remoteSettings = remoteSettingsIn
        ?? optionalServicePath(ctx, "remote.settings")
        ?? (typeof appCtx !== "undefined" ? optionalServicePath(appCtx, "remote.settings") : null);
      const describeFn = typeof remoteSettings?.describe === "function"
        ? () => remoteSettings.describe()
        : (typeof api?.settings?.describe === "function" ? () => api.settings.describe({}) : null);
      const mutateFn = typeof remoteSettings?.mutate === "function"
        ? (ns, ops, expectedRevision) => remoteSettings.mutate(ns, ops, expectedRevision)
        : (typeof api?.settings?.mutate === "function" ? (ns, ops, expectedRevision) => api.settings.mutate({ ns, ops, ...(expectedRevision === undefined ? {} : { expectedRevision }) }) : null);

      if (!describeFn || !mutateFn) return null;
      let snapshot = { status: "loading", value: null, writable: false, revision: undefined };
      // g-453：新线（设置表单投影）里 `SettingsDescriptor.ns` 是 **profile 条目 id**
      // （cordis.patch.yml 的 insert id = `dsh-graph-host`），不是历史 namespace 名 `dsh-graph`
      // ——0.2.0-rc.2 隔离实例实测 describe() 服务的是 `dsh-graph-host`。宿主侧
      // `readGraphSettingsFromForms` 同样容忍「条目 id 或包名」，故这里按 describe 的**实际 ns 集合**
      // 发现绑定（能力探测，不比对任何版本号），历史 namespace 名保留为候选。
      let resolvedNs = null;
      const pickRow = (view) => {
        const rows = Array.isArray(view?.namespaces) ? view.namespaces : [];
        return rows.find((candidate) => candidate?.ns === resolvedNs)
          ?? rows.find((candidate) => GRAPH_SETTINGS_NS_CANDIDATES.includes(candidate?.ns))
          ?? null;
      };
      const listeners = new Set();
      const notify = () => listeners.forEach((listener) => listener());
      const scope = {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        async load() {
          const res = await describeFn();
          const view = res && typeof res === "object" && "ok" in res ? (res.ok ? res.value : null) : (res?.result?.ok ? res.result.value : null);
          if (!view) throw new Error(res?.error?.message ?? res?.result?.error?.message ?? dgT("settings.readProfileFail"));
          const row = pickRow(view);
          if (!row) {
            resolvedNs = null;
            snapshot = { ...snapshot, status: "unavailable", writable: view.writable !== false };
          } else {
            resolvedNs = row.ns;
            snapshot = { status: "ready", value: row.value ?? {}, writable: view.writable !== false, revision: row.revision };
          }
          notify();
        },
        async set(field, value) {
          const ns = resolvedNs ?? GRAPH_SETTINGS_NS;
          const res = await mutateFn(ns, [{ op: "set", path: [field], value }], snapshot.revision);
          const row = res && typeof res === "object" && "ok" in res ? (res.ok ? res.value : null) : (res?.result?.ok ? res.result.value : null);
          if (!row) throw new Error(res?.error?.message ?? res?.result?.error?.message ?? dgT("settings.saveProfileFail"));
          resolvedNs = row.ns ?? ns;
          snapshot = { ...snapshot, status: "ready", value: row.value ?? snapshot.value, revision: row.revision };
          notify();
        },
      };
      scope.load().catch((error) => {
        snapshot = { ...snapshot, status: "unavailable", error: String(error?.message ?? error) };
        notify();
      });
      return scope;
    }

    // g-133/g-453：解析并绑定 profile 设置 scope。
    // 优先级：① 旧线注入键 `settingsScope`（memory 空壳不算，改用 Host API）→ ② `remote.settings`
    // 点分服务 / `connection.api` REST 降级。**能力判定只看服务能否取到**，不看宿主版本号。
    function bindGraphSettingsScope(ctx) {
      if (!ctx) return gSettingsScope;
      try {
        const legacy = optionalServicePath(ctx, "settingsScope");
        const bound = typeof legacy?.bind === "function" ? legacy.bind({ namespace: GRAPH_SETTINGS_NS }) : null;
        if (bound && bound.getSnapshot?.().mode !== "memory") return publishGraphSettingsScope(bound, legacy, 1);
        // g-425：`ctx?.connection` 同口径改受保护读取（connection 未注册时不再抛错中断降级链）。
        const remoteSettings = optionalServicePath(ctx, "remote.settings");
        const connection = optionalService(ctx, "connection");
        const apiScope = createGraphSettingsApiScope(connection?.api, ctx, remoteSettings);
        return publishGraphSettingsScope(apiScope, remoteSettings ?? connection?.api ?? null, 0);
      } catch {
        // 解析失败：不覆盖既有可用绑定（页面仍显示既有降级提示，语义与 g-425 一致）
        return gSettingsScope;
      }
    }

    // g-453：席位服务可能在 apply 之后才 provide ⇒ 除立即尝试外，按**服务自身**再等一次。
    // `settingsScope`（旧线注入键）与 `remote.settings`（0.2.0-rc.2 点分名）各自独立探测、互不阻塞；
    // 宿主没有该服务时 inject 回调永不触发且零报错（dsh-market 同款纪律，检测手段只有 inject 探测）。
    const GRAPH_SETTINGS_SERVICE_KEYS = ["settingsScope", "remote.settings"];
    function armGraphSettingsScope(ctx) {
      bindGraphSettingsScope(ctx);
      for (const key of GRAPH_SETTINGS_SERVICE_KEYS) {
        try {
          ctx?.inject?.([key], (scope) => { bindGraphSettingsScope(scope ?? ctx); });
        } catch { /* inject 不可用：静默（立即绑定的结果照旧生效） */ }
      }
    }

    // g-133 / g-215：从当前 Host 读取合法 provider/model 目录。
    // providers: [{provider, displayName, active,...}]；models: {groups:[{id,name,models:[{id,name,...}]}], failures:[...]}。
    // 降级探测链：
    // 1. 优先调用 0.1.2-alpha.2 新版 API 获取 Host 模型与 Provider 目录（Remote RPC session.modelCatalog / modelDirectories / window.__DSH_RUNTIME__）；
    // 2. 若新版 API 缺失或未返回有效数据，尝试通过 0.1.1-rc 旧版 API 机制主动获取一次（connection.api.llm.providers/models）；
    // 3. 尝试通过服务端 REST /api/dsh-graph/spawn-options 获取后端枚举好的模型目录；
    // 4. 仅在所有方式均不可用时才进入最终降级兜底（status: "unavailable"，保留已存配置、支持保存、不报未捕获异常）。
    async function loadHostCatalog(api, ctx = (typeof appCtx !== "undefined" ? appCtx : null)) {
      // 1. 优先调用 0.1.2-alpha.2 新版 API
      try {
        // g-425：`ctx?.remote` / `appCtx?.remote` 同口径改受保护读取——旧写法在 remote 缺席时
        // 会撞注入门禁抛错并被本 try 吞掉，使第 1 步（含 modelDirectories 精确目录）整段被跳过。
        const remote = optionalService(ctx, "remote")
          ?? (typeof appCtx !== "undefined" ? optionalService(appCtx, "remote") : null)
          ?? (typeof window !== "undefined" ? window.__DSH_REMOTE__ : null);
        // Remote session 方法依赖所属 session proxy 的 this；脱离 receiver 调用会失败并误回退到
        // 旧 llm.models（旧目录不含 reasoning 元数据），导致有能力的模型显示为空选择器。
        const session = remote?.session;
        const modelCatalogFn = typeof session?.modelCatalog === "function"
          ? session.modelCatalog.bind(session)
          : (typeof remote?.["session/modelCatalog"] === "function" ? remote["session/modelCatalog"].bind(remote) : null);
        if (typeof modelCatalogFn === "function") {
          const res = await modelCatalogFn();
          const val = res && typeof res === "object" && "ok" in res ? (res.ok ? res.value : null) : res;
          if (val && Array.isArray(val.groups) && val.groups.length > 0) {
            const routableSet = new Set(Array.isArray(val.routableProviders) ? val.routableProviders : []);
            const providers = val.groups.map((g) => ({
              provider: g.id,
              displayName: g.name ?? g.id,
              active: routableSet.size > 0 ? routableSet.has(g.id) : true,
            }));
            return {
              status: "ready",
              providers,
              groups: val.groups,
              failures: Array.isArray(val.failures) ? val.failures : [],
            };
          }
        }

        const modelDirectories = ctx?.get?.("modelDirectories") ?? (typeof appCtx !== "undefined" ? appCtx?.get?.("modelDirectories") : null);
        if (typeof modelDirectories?.catalog?.load === "function") {
          const catVal = await modelDirectories.catalog.load();
          if (catVal && Array.isArray(catVal.groups) && catVal.groups.length > 0) {
            const routableSet = new Set(Array.isArray(catVal.routableProviders) ? catVal.routableProviders : []);
            const providers = catVal.groups.map((g) => ({
              provider: g.id,
              displayName: g.name ?? g.id,
              active: routableSet.size > 0 ? routableSet.has(g.id) : true,
            }));
            return {
              status: "ready",
              providers,
              groups: catVal.groups,
              failures: Array.isArray(catVal.failures) ? catVal.failures : [],
            };
          }
        }
      } catch {
        // 新版 API 探测失败，继续回退到 0.1.1-rc 旧版 API
      }

      // 2. 0.1.1-rc 旧版 API 探测（api.llm.providers / api.llm.models）
      try {
        // g-425：`ctx?.connection` / `appCtx?.connection` 同口径改受保护读取（connection 缺席时
        // 旧写法抛错被本 try 吞掉，使旧版 API 探测整段被跳过）。
        const legacyConn = optionalService(ctx, "connection")
          ?? (typeof appCtx !== "undefined" ? optionalService(appCtx, "connection") : null);
        const legacyApi = api ?? legacyConn?.api;
        if (legacyApi?.llm?.providers && legacyApi?.llm?.models) {
          const [pRes, mRes] = await Promise.allSettled([legacyApi.llm.providers({}), legacyApi.llm.models({})]);
          const pv = pRes.status === "fulfilled" ? pRes.value?.result?.value : null;
          const mv = mRes.status === "fulfilled" ? mRes.value?.result?.value : null;
          if (pv && mv && (Array.isArray(pv.providers) || Array.isArray(mv.groups))) {
            return {
              status: "ready",
              providers: Array.isArray(pv.providers) ? pv.providers : [],
              groups: Array.isArray(mv.groups) ? mv.groups : [],
              failures: Array.isArray(mv.failures) ? mv.failures : [],
            };
          }
        }
      } catch {
        // 旧版 API 异常，进入服务端 REST 探测
      }

      // 3. 服务端 REST /api/dsh-graph/spawn-options 兜底获取（后端 ctx.llm 枚举）
      try {
        const r = await fetch(graphUrl("/api/dsh-graph/spawn-options"));
        if (r.ok) {
          const spawnData = await r.json();
          if (spawnData && Array.isArray(spawnData.modelGroups) && spawnData.modelGroups.length > 0) {
            const providers = spawnData.modelGroups.map((g) => ({
              provider: g.id,
              displayName: g.name ?? g.id,
              active: true,
            }));
            return {
              status: "ready",
              providers,
              groups: spawnData.modelGroups,
              failures: [],
            };
          }
        }
      } catch {
        // REST 获取失败
      }

      // 4. 最终降级兜底
      return { status: "unavailable" };
    }

    const GSS = {
      panel: { display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 },
      title: { margin: 0, fontSize: 16, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      desc: { margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary)" },
      field: { display: "flex", flexDirection: "column", gap: 6 },
      label: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-secondary)" },
      hint: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" },
      select: {
        boxSizing: "border-box", width: "100%", border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8, padding: "6px 10px", fontSize: 13, color: "var(--dsw-alias-label-primary)",
        background: "var(--dsw-alias-bg-layer-1)", fontFamily: "inherit",
      },
      textarea: {
        boxSizing: "border-box", width: "100%", minHeight: 72, resize: "vertical",
        border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: "6px 10px",
        fontSize: 13, color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-1)",
        fontFamily: "inherit",
      },
      row: { display: "flex", gap: 8, alignItems: "center" },
      btnPrimary: {
        boxSizing: "border-box", height: 32, cursor: "pointer", border: "none", borderRadius: 16,
        padding: "0 14px", fontSize: 13, background: "var(--dsw-alias-button-primary-fill)",
        color: "var(--dsw-alias-label-primary-foreground)",
      },
      noteOk: { fontSize: 12, color: "var(--dsw-alias-state-success-primary)" },
      noteErr: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)" },
      note: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" },
      badge: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" },
    };

    // 看板设置页组件：读/写 dsh-graph profile 全局默认。
    // g-453：同一组件占三个席位（settings.section / settings.plugins.tab / plugins.bundle.config）；
    // `hideTitle` 由注册方给出——标签页席位紧邻同名 tab 标签，组件不再重复同名标题
    // （宿主内置「插件列表」tab 同样不自带页内标题）；section 与组合包页保留标题。
    function GraphSettingsSection(props) {
      useLocaleRevision();
      useLocaleRevision();
      const hideTitle = props?.hideTitle === true;
      const modeIdRef = React.useRef(null);
      if (modeIdRef.current == null) modeIdRef.current = `dg-global-subagent-mode-${++settingsModeInstanceSeq}`;
      const modeId = modeIdRef.current;
      // g-453：scope 可能**迟到绑定**（服务 apply 之后才 provide）⇒ 组件必须订阅绑定事件重渲染，
      // 否则早已按降级提示挂载的页面会永远停在旧态（与 g-431 locale 迟到绑定同型教训）。
      const [scope, setScope] = React.useState(gSettingsScope);
      React.useEffect(() => {
        setScope(gSettingsScope);
        return subscribeGraphSettingsScope(() => setScope(gSettingsScope));
      }, []);
      const [snap, setSnap] = React.useState(gSettingsScope ? gSettingsScope.getSnapshot() : null);
      const [draft, setDraft] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [saved, setSaved] = React.useState("");
      const [error, setError] = React.useState("");
      const [catalog, setCatalog] = React.useState({ status: "loading" });
      React.useEffect(() => {
        if (!scope) return undefined;
        const upd = () => { setSnap(scope.getSnapshot()); };
        upd();
        return scope.subscribe(upd);
      }, [scope]);
      // g-133 / g-215：挂载时读取 llm.providers/llm.models（当前 Host 合法目录）。
      // RPC 缺失/失败时目录状态置 unavailable，页面降级为「提示 + 保留已存值」，不崩溃。
      React.useEffect(() => {
        let alive = true;
        loadHostCatalog(gConnectionApi, typeof appCtx !== "undefined" ? appCtx : null)
          .then((c) => { if (alive) setCatalog(c); })
          .catch(() => { if (alive) setCatalog({ status: "unavailable" }); });
        return () => { alive = false; };
      }, []);

      const titleNode = hideTitle ? null : h("h3", { style: GSS.title }, dgT("settings.title"));

      // 没有 settings scope 且没有 Host API：整页降级（确实无持久化能力）
      if (!scope) {
        return h("div", { style: GSS.panel },
          titleNode,
          h("p", { style: GSS.desc }, dgT("profileSettings.unavailableDesc")),
        );
      }
      const status = snap?.status ?? "loading";
      const value = snap?.value ?? null;
      const writable = snap?.writable !== false;

      if (status === "loading") {
        return h("div", { style: GSS.panel },
          titleNode,
          h("p", { style: GSS.note }, dgT("profileSettings.reading")),
        );
      }
      if (status === "unavailable") {
        return h("div", { style: GSS.panel },
          titleNode,
          h("p", { style: GSS.desc }, dgT("profileSettings.noNamespace")),
        );
      }

      // 当前已保存快照 + 本地草稿（草稿缺省即当前值）
      const draftValue = draft ?? {
        subagentProvider: value?.subagentProvider ?? "",
        subagentModel: value?.subagentModel ?? "",
        subagentReasoningEffort: value?.subagentReasoningEffort ?? "",
        subagentMode: value?.subagentMode ?? "",
        subagentPrompt: value?.subagentPrompt ?? "",
        promptLanguage: value?.promptLanguage ?? "follow",
      };
      const setField = (k, v) => setDraft({ ...draftValue, [k]: v });

      // g-191：受控子代理执行模式（当前支持标准模式与带工具物理过滤的极简模式）
      const modeOptions = [
        { id: "", name: dgT("profileSettings.modeDefault"), desc: dgT("profileSettings.modeDefaultDesc") },
        { id: "standard", name: dgT("profileSettings.modeStandard"), desc: dgT("profileSettings.modeStandardDesc") },
        { id: "minimal", name: dgT("profileSettings.modeMinimal"), desc: dgT("profileSettings.modeMinimalDesc") },
      ];
      const curMode = draftValue.subagentMode ?? "";

      // g-133：合法目录派生。合法 provider = active 且有非空模型目录；model 合法 = 属于所选 provider 目录
      //（未选 provider 时属于任一目录）；空值 = 继承父会话。目录仅作 advisory 可选列表，不拦截保存。
      const catReady = catalog.status === "ready";
      const providerById = new Map(catReady ? catalog.providers.map((p) => [p.provider, p]) : []);
      const groupById = new Map(catReady ? catalog.groups.map((g) => [g.id, g]) : []);
      const providerLabel = (id) => {
        const p = providerById.get(id);
        if (p?.displayName && p.displayName !== id) return p.displayName + "（" + id + "）";
        return p?.displayName || groupById.get(id)?.name || id;
      };
      const legalProviders = catReady
        ? catalog.providers.filter((p) => p.active && (groupById.get(p.provider)?.models.length ?? 0) > 0)
        : [];
      const legalProviderIds = new Set(legalProviders.map((p) => p.provider));
      const allLegalModels = []; // 未选 provider 时全量合法模型（label: provider/name 区分）
      const legalModelsByProvider = new Map(); // providerId -> Set(modelId)
      if (catReady) {
        for (const g of catalog.groups) {
          const ids = new Set();
          for (const m of g.models) {
            ids.add(m.id);
            allLegalModels.push({ value: m.id, label: providerLabel(g.id) + "/" + (m.name ?? m.id) });
          }
          legalModelsByProvider.set(g.id, ids);
        }
      }
      const curProvider = draftValue.subagentProvider ?? "";
      const curModel = draftValue.subagentModel ?? "";
      // 已存旧值未出现在目录时的 option 后缀：目录就绪 → 「已存值（当前目录未列出）」；
      // 目录未就绪 → 按读取中/不可用提示，保证已存值始终可见可选（advisory，不拦截保存）。
      const legacySuffix = catReady
        ? dgT("profileSettings.legacySuffixListed")
        : (catalog.status === "loading" ? dgT("profileSettings.legacySuffixLoading") : dgT("profileSettings.legacySuffixUnavailable"));
      // provider 切换：切到合法新 provider 且现有 model 不属于其目录则清空 model（保留空=继承语义）；
      // 切到已存 legacy provider / 留空不强行清空，避免丢失已存 model。
      const onProviderChange = (v) => {
        const next = { ...draftValue, subagentProvider: v };
        if (v !== "" && legalProviderIds.has(v) && curModel !== "" && !(legalModelsByProvider.get(v)?.has(curModel))) {
          next.subagentModel = "";
        }
        setDraft(next);
      };
      const providerOptions = (() => {
        const opts = [h("option", { key: "__blank-p", value: "" }, dgT("profileSettings.inheritParent"))];
        // 已存 provider 未在合法目录中（含目录未就绪时无法校验）→ 保留为固定 option
        if (curProvider !== "" && !(catReady && legalProviderIds.has(curProvider))) {
          opts.push(h("option", { key: "__cur-p", value: curProvider }, curProvider + legacySuffix));
        }
        if (catReady) for (const p of legalProviders) {
          opts.push(h("option", { key: p.provider, value: p.provider }, providerLabel(p.provider)));
        }
        return opts;
      })();
      const modelOptions = (() => {
        const opts = [h("option", { key: "__blank-m", value: "" }, dgT("profileSettings.inheritParent"))];
        // 已存 model 是否出现在目录中：目录就绪时按所选 provider 校验；未就绪时无法校验 → 一律保留
        const curListed = catReady && (curProvider !== ""
          ? (legalModelsByProvider.get(curProvider)?.has(curModel) ?? false)
          : allLegalModels.some((m) => m.value === curModel));
        if (curModel !== "" && !curListed) {
          opts.push(h("option", { key: "__cur-m", value: curModel }, curModel + legacySuffix));
        }
        if (catReady) {
          if (curProvider !== "") {
            const g = groupById.get(curProvider);
            if (g) for (const m of g.models) opts.push(h("option", { key: g.id + "/" + m.id, value: m.id }, m.name ?? m.id));
          } else {
            for (const m of allLegalModels) opts.push(h("option", { key: m.label, value: m.value }, m.label));
          }
        }
        return opts;
      })();
      // reasoning 元数据由 Host 模型目录声明；不维护客户端固定档位词表。
      // 未选 provider 时仅在 model id 唯一时推导能力，避免同名模型跨 provider 错配。
      const selectedModel = (() => {
        if (!catReady || curModel === "") return null;
        if (curProvider !== "") return groupById.get(curProvider)?.models.find((m) => m.id === curModel) ?? null;
        const matches = catalog.groups.flatMap((g) => g.models.filter((m) => m.id === curModel));
        return matches.length === 1 ? matches[0] : null;
      })();
      const effortChoices = Array.isArray(selectedModel?.reasoning?.efforts) ? selectedModel.reasoning.efforts : [];
      const curEffort = draftValue.subagentReasoningEffort ?? "";
      const effortListed = effortChoices.some((effort) => effort?.id === curEffort);
      const effortOptions = [h("option", { key: "__blank-e", value: "" }, dgT("profileSettings.inheritSelected"))];
      if (curEffort !== "" && !effortListed) {
        effortOptions.push(h("option", { key: "__cur-e", value: curEffort }, curEffort + legacySuffix));
      }
      for (const effort of effortChoices) {
        if (typeof effort?.id === "string" && effort.id !== "") {
          effortOptions.push(h("option", { key: "effort:" + effort.id, value: effort.id }, effort.name ?? effort.id));
        }
      }

      const save = async () => {
        if (!scope || !writable) return;
        // g-133：目录仅作 advisory 可选列表，不拦截保存——留空继承、已存旧值、目录合法项均可保存。
        setSaving(true); setError(""); setSaved("");
        try {
          // 一次提交，按字段逐个 set（settings scope 每字段 revision-fenced 写入）。
          await scope.set("subagentProvider", draftValue.subagentProvider ?? "");
          await scope.set("subagentModel", draftValue.subagentModel ?? "");
          await scope.set("subagentReasoningEffort", draftValue.subagentReasoningEffort ?? "");
          await scope.set("subagentMode", draftValue.subagentMode ?? "");
          await scope.set("subagentPrompt", draftValue.subagentPrompt ?? "");
           await scope.set("promptLanguage", draftValue.promptLanguage ?? "follow");
          setSaved(dgT("profileSettings.saved"));
          setDraft(null); // 成功后才归位草稿（快照已更新）
        } catch (e) {
          // 失败保留草稿（用户可纠错重试）且不丢已保存旧值（settings 失败不落盘）
          setError(dgT("profileSettings.saveFail") + String(e?.message ?? e));
        } finally {
          setSaving(false);
        }
      };

      return h("div", { style: GSS.panel },
        titleNode,
        h("p", { style: GSS.desc }, dgT("profileSettings.desc")),
        h("p", { style: GSS.badge }, status === "ready" && !writable ? dgT("profileSettings.readOnly") : ""),
        h("div", { style: GSS.field },
          h("label", { style: GSS.label }, dgT("profileSettings.providerLabel")),
          h("select", { style: GSS.select, value: curProvider, disabled: !writable,
            onChange: (e) => onProviderChange(e.target.value) }, ...providerOptions),
          h("span", { style: GSS.hint },
            catReady
              ? dgT("profileSettings.providerHint")
              : (catalog.status === "loading" ? dgT("profileSettings.providerLoading") : dgT("profileSettings.providerUnavailable")))),
        h("div", { style: GSS.field },
          h("label", { style: GSS.label }, dgT("profileSettings.modelLabel")),
          h("select", { style: GSS.select, value: curModel, disabled: !writable,
            onChange: (e) => setField("subagentModel", e.target.value) }, ...modelOptions),
          h("span", { style: GSS.hint },
            catReady
              ? dgT("profileSettings.modelHint")
              : (catalog.status === "loading" ? dgT("profileSettings.modelLoading") : dgT("profileSettings.modelUnavailable")))),
        catReady && catalog.failures.length > 0
          ? h("span", { style: GSS.hint }, dgT("profileSettings.providerFailures", { failures: catalog.failures.map((f) => f.id).join("、") }))
          : null,
        h("div", { style: GSS.field },
          h("label", { style: GSS.label }, dgT("profileSettings.effortLabel")),
          h("select", { style: GSS.select, value: curEffort, disabled: !writable,
            onChange: (e) => setField("subagentReasoningEffort", e.target.value) }, ...effortOptions),
          h("span", { style: GSS.hint },
            catReady
              ? (effortChoices.length > 0
                ? dgT("profileSettings.effortHintChoices")
                : dgT("profileSettings.effortHintNone"))
              : dgT("profileSettings.effortHintWaiting"))),
        h("div", { style: GSS.field },
          h("label", { style: GSS.label, htmlFor: modeId }, dgT("profileSettings.modeLabel")),
          h("select", { id: modeId, "aria-label": dgT("profileSettings.modeLabel"), style: GSS.select, value: curMode, disabled: !writable,
            onChange: (e) => setField("subagentMode", e.target.value) },
            modeOptions.map((m) => h("option", { key: m.id, value: m.id }, m.name))),
          h("span", { style: GSS.hint }, dgT("profileSettings.modeHint"))),
        h("div", { style: GSS.field },
          h("label", { style: GSS.label }, dgT("profileSettings.promptLanguageLabel")),
           h("select", { style: GSS.select, value: draftValue.promptLanguage ?? "follow", disabled: !writable,
             onChange: (e) => setField("promptLanguage", e.target.value) },
             h("option", { value: "follow" }, dgT("profileSettings.promptLanguageFollow")),
             h("option", { value: "zh" }, dgT("profileSettings.promptLanguageZh")),
             h("option", { value: "en" }, dgT("profileSettings.promptLanguageEn"))),
           h("span", { style: GSS.hint }, dgT("profileSettings.promptLanguageHint"))),
         h("div", { style: GSS.field },
           h("label", { style: GSS.label }, dgT("profileSettings.promptLabel")),
          h("textarea", { style: GSS.textarea, value: draftValue.subagentPrompt, disabled: !writable,
            placeholder: dgT("profileSettings.promptPlaceholder"),
            onChange: (e) => setField("subagentPrompt", e.target.value) }),
          h("span", { style: GSS.hint }, dgT("profileSettings.promptHint"))),
        h("div", { style: GSS.row },
          h("button", { style: GSS.btnPrimary, disabled: saving || !writable, onClick: save },
            saving ? dgT("profileSettings.saving") : dgT("profileSettings.save")),
          saved ? h("span", { style: GSS.noteOk }, saved) : null,
          error ? h("span", { style: GSS.noteErr }, error) : null),
      );
    }

    // 注册 profile 全局设置页的三个席位（plugin.js apply 调用）：
    //   ① `settings.section`「看板设置」——g-133 旧线席位，**保留**（读写成活后不再降级）；
    //   ② `settings.plugins.tab`——g-453：设置 → 内置插件 里的 dsh-graph 标签页；
    //   ③ `plugins.bundle.config`——g-453：侧边栏插件面板 → dsh-graph 组合包页的配置表单（keyed by 包名）。
    // 三个席位**一律经 ctx.slots.inject 注册**：宿主只在对应页面挂载时才声明该 slot，apply 里直接
    // register 会静默 no-op 或报错；宿主没有该 slot 时 inject 回调永不触发且零报错（不影响看板与工具）。
    // settingsScope / remote.settings 缺失时页面按既有语义给提示，绝不抛错。
    const GRAPH_PACKAGE_NAME = "dsh-graph";
    function registerGraphSettingsSection(ctx) {
      try {
        // g-133：数据源捕获 —— ctx.get('connection').api（组件挂载时读 llm.providers/models 目录）。
        gConnectionApi = (() => {
          // g-425：统一走 optionalService（原实现靠外层 try/catch 兜住 `ctx?.connection` 裸访问；
          // 结果等价，改为唯一读取口径后静态守卫可 fail-closed 禁止裸回退复发）。
          try { return optionalService(ctx, "connection")?.api ?? null; } catch { return null; }
        })();
        // g-453：绑定 + 迟到等待（宿主服务改名/晚 provide 都不再永久降级）。
        armGraphSettingsScope(ctx);
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "dsh-graph-settings",
              order: 60,
              // g-230：locale-following thunk——resolveSlotLabel 对 function 求值，切语言时重算
              label: () => dgT("settings.title"),
            },
            (props) => h(GraphSettingsSection, props),
          ),
        );
        // 席位②：标签页紧邻同名 tab 标签 ⇒ 传 hideTitle，不重复渲染同名页内标题。
        ctx.slots.inject("settings.plugins.tab", () =>
          ctx.slots.register(
            {
              name: "settings.plugins.tab",
              id: GRAPH_PACKAGE_NAME,
              order: 60,
              // 同 g-230：locale-following thunk，切语言时宿主重算标签文案
              label: () => dgT("settings.title"),
            },
            () => h(GraphSettingsSection, { hideTitle: true }),
          ),
        );
        // 席位③：`summary` 是列表里的一行摘要（组合包自身描述已承担），按 slot 契约返回 null；只渲染 page。
        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register(
            {
              name: "plugins.bundle.config",
              key: GRAPH_PACKAGE_NAME,
            },
            (ownerProps) => (ownerProps?.view === "summary" ? null : h(GraphSettingsSection, {})),
          ),
        );
      } catch { /* slots 缺失或重复注册：静默（不影响看板/工具） */ }
    }
