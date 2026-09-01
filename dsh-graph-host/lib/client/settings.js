    // g-133：dsh-graph profile 级全局默认设置页（settings.section：看板设置）。
    // 仅保留子代理默认 provider、默认 model id、子代理默认补充提示词。
    // 该配置写入当前 DSH profile 的用户级全局设置（settingsScope.bind({namespace:"dsh-graph"})），
    // 不写当前 workspace；provider/model 仅作缺省值（workspace project.yaml 明确配置优先）。
    // 覆盖层：settings scope 按 profile 隔离；memory scope 通过 Host settings RPC 兼容读写。
    // g-133：provider/model 由自由文本 input 改为合法目录 select——目录来自 ctx.get('connection').api
    // 的 llm.providers/llm.models（仅 advisory 可选列表，不拦截保存）；settings.yaml 已存但目录
    // 未列出的旧值保留为「已存值（当前目录未列出）」固定 option（不可自由编辑、可继续保存）。
    const GRAPH_SETTINGS_NS = "dsh-graph";
    // plugin.js apply 里绑定后的 settings scope（从 ctx.settingsScope.bind 得到），组件经它读写。
    let gSettingsScope = null;
    // g-133：数据源 = ctx.get('connection').api（registerGraphSettingsSection 捕获），挂载时读 llm 目录。
    let gConnectionApi = null;

    // 3082 的 settingsScope 在非 loopback 浏览器上下文会是 memory；此时仍可
    // 通过已存在的 profile settings RPC 读写 Host，而不是把配置伪装成 workspace 数据。
    function createGraphSettingsApiScope(api, ctx = (typeof appCtx !== "undefined" ? appCtx : null)) {
      const remoteSettings = ctx?.get?.("remote")?.settings ?? ctx?.remote?.settings ?? (typeof appCtx !== "undefined" ? (appCtx?.get?.("remote")?.settings ?? appCtx?.remote?.settings) : null);
      const describeFn = typeof remoteSettings?.describe === "function"
        ? () => remoteSettings.describe()
        : (typeof api?.settings?.describe === "function" ? () => api.settings.describe({}) : null);
      const mutateFn = typeof remoteSettings?.mutate === "function"
        ? (ns, ops, expectedRevision) => remoteSettings.mutate(ns, ops, expectedRevision)
        : (typeof api?.settings?.mutate === "function" ? (ns, ops, expectedRevision) => api.settings.mutate({ ns, ops, ...(expectedRevision === undefined ? {} : { expectedRevision }) }) : null);

      if (!describeFn || !mutateFn) return null;
      let snapshot = { status: "loading", value: null, writable: false, revision: undefined };
      const listeners = new Set();
      const notify = () => listeners.forEach((listener) => listener());
      const scope = {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        async load() {
          const res = await describeFn();
          const view = res && typeof res === "object" && "ok" in res ? (res.ok ? res.value : null) : (res?.result?.ok ? res.result.value : null);
          if (!view) throw new Error(res?.error?.message ?? res?.result?.error?.message ?? "读取 profile 设置失败");
          const row = view.namespaces?.find((candidate) => candidate.ns === GRAPH_SETTINGS_NS);
          if (!row) {
            snapshot = { ...snapshot, status: "unavailable", writable: view.writable !== false };
          } else {
            snapshot = { status: "ready", value: row.value ?? {}, writable: view.writable !== false, revision: row.revision };
          }
          notify();
        },
        async set(field, value) {
          const res = await mutateFn(GRAPH_SETTINGS_NS, [{ op: "set", path: [field], value }], snapshot.revision);
          const row = res && typeof res === "object" && "ok" in res ? (res.ok ? res.value : null) : (res?.result?.ok ? res.result.value : null);
          if (!row) throw new Error(res?.error?.message ?? res?.result?.error?.message ?? "保存 profile 设置失败");
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

    // 优先使用官方 settingsScope；memory scope 只提供本地空壳，必须改用 Host API。
    function bindGraphSettingsScope(ctx) {
      try {
        const bound = ctx?.get?.("settingsScope")?.bind({ namespace: GRAPH_SETTINGS_NS });
        if (bound && bound.getSnapshot?.().mode !== "memory") return (gSettingsScope = bound);
        const connection = ctx?.get?.("connection") ?? ctx?.connection;
        return (gSettingsScope = createGraphSettingsApiScope(connection?.api, ctx));
      } catch {
        gSettingsScope = null;
        return null;
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
        const remote = ctx?.get?.("remote") ?? ctx?.remote ?? (typeof appCtx !== "undefined" ? (appCtx?.get?.("remote") ?? appCtx?.remote) : null) ?? (typeof window !== "undefined" ? window.__DSH_REMOTE__ : null);
        const modelCatalogFn = remote?.session?.modelCatalog ?? (typeof remote?.["session/modelCatalog"] === "function" ? remote["session/modelCatalog"].bind(remote) : null);
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
        const legacyApi = api ?? (ctx?.get?.("connection") ?? ctx?.connection ?? (typeof appCtx !== "undefined" ? (appCtx?.get?.("connection") ?? appCtx?.connection) : null))?.api;
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
    function GraphSettingsSection(_props) {
      const [snap, setSnap] = React.useState(gSettingsScope ? gSettingsScope.getSnapshot() : null);
      const [draft, setDraft] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [saved, setSaved] = React.useState("");
      const [error, setError] = React.useState("");
      const [catalog, setCatalog] = React.useState({ status: "loading" });
      React.useEffect(() => {
        if (!gSettingsScope) return;
        const upd = () => { const s = gSettingsScope.getSnapshot(); setSnap(s); };
        upd();
        const un = gSettingsScope.subscribe(upd);
        return un;
      }, []);
      // g-133 / g-215：挂载时读取 llm.providers/llm.models（当前 Host 合法目录）。
      // RPC 缺失/失败时目录状态置 unavailable，页面降级为「提示 + 保留已存值」，不崩溃。
      React.useEffect(() => {
        let alive = true;
        loadHostCatalog(gConnectionApi, typeof appCtx !== "undefined" ? appCtx : null)
          .then((c) => { if (alive) setCatalog(c); })
          .catch(() => { if (alive) setCatalog({ status: "unavailable" }); });
        return () => { alive = false; };
      }, []);

      // 没有 settings scope 且没有 Host API：整页降级（确实无持久化能力）
      if (!gSettingsScope) {
        return h("div", { style: GSS.panel },
          h("h3", { style: GSS.title }, "看板设置"),
          h("p", { style: GSS.desc }, "当前 DSH profile 未暴露设置服务（settingsScope 缺失），无法读写 dsh-graph 全局配置。"),
        );
      }
      const status = snap?.status ?? "loading";
      const value = snap?.value ?? null;
      const writable = snap?.writable !== false;

      if (status === "loading") {
        return h("div", { style: GSS.panel },
          h("h3", { style: GSS.title }, "看板设置"),
          h("p", { style: GSS.note }, "正在读取 dsh-graph 全局配置…"),
        );
      }
      if (status === "unavailable") {
        return h("div", { style: GSS.panel },
          h("h3", { style: GSS.title }, "看板设置"),
          h("p", { style: GSS.desc }, "此 profile 未暴露 dsh-graph 设置命名空间（可能未连接 Host，或为 memory 模式），无法读写全局配置。"),
        );
      }

      // 当前已保存快照 + 本地草稿（草稿缺省即当前值）
      const draftValue = draft ?? {
        subagentProvider: value?.subagentProvider ?? "",
        subagentModel: value?.subagentModel ?? "",
        subagentPrompt: value?.subagentPrompt ?? "",
      };
      const setField = (k, v) => setDraft({ ...draftValue, [k]: v });

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
        ? "（已存值，当前目录未列出）"
        : (catalog.status === "loading" ? "（目录读取中…）" : "（目录不可用）");
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
        const opts = [h("option", { key: "__blank-p", value: "" }, "（继承父会话）")];
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
        const opts = [h("option", { key: "__blank-m", value: "" }, "（继承父会话）")];
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

      const save = async () => {
        if (!gSettingsScope || !writable) return;
        // g-133：目录仅作 advisory 可选列表，不拦截保存——留空继承、已存旧值、目录合法项均可保存。
        setSaving(true); setError(""); setSaved("");
        try {
          // 一次提交，按字段逐个 set（settings scope 每字段 revision-fenced 写入）。
          await gSettingsScope.set("subagentProvider", draftValue.subagentProvider ?? "");
          await gSettingsScope.set("subagentModel", draftValue.subagentModel ?? "");
          await gSettingsScope.set("subagentPrompt", draftValue.subagentPrompt ?? "");
          setSaved("已保存到当前 profile。");
          setDraft(null); // 成功后才归位草稿（快照已更新）
        } catch (e) {
          // 失败保留草稿（用户可纠错重试）且不丢已保存旧值（settings 失败不落盘）
          setError("保存失败：" + String(e?.message ?? e));
        } finally {
          setSaving(false);
        }
      };

      return h("div", { style: GSS.panel },
        h("h3", { style: GSS.title }, "看板设置"),
        h("p", { style: GSS.desc },
          "管理 dsh-graph 的 profile 级全局默认：子代理默认 provider/model 与补充提示词。" +
          "该配置写入当前 DSH profile，跨 workspace 生效；workspace 的 project.yaml 明确配置优先。" +
          "补充提示词默认为空，workspace 用 default/自定义文本/显式空值选择继承、覆盖或禁用。"),
        h("p", { style: GSS.badge }, status === "ready" && !writable ? "当前为只读（Host 设置不可写）。" : ""),
        h("div", { style: GSS.field },
          h("label", { style: GSS.label }, "子代理默认 provider"),
          h("select", { style: GSS.select, value: curProvider, disabled: !writable,
            onChange: (e) => onProviderChange(e.target.value) }, ...providerOptions),
          h("span", { style: GSS.hint },
            catReady
              ? "仅作缺省值：graph_start_attempt 单次指定的 provider 与 workspace project.yaml 的 executor.provider 更优先；留空继承父会话。目录仅作可选列表（advisory），已存但未列出的旧值保留为固定选项、仍可保存。"
              : (catalog.status === "loading" ? "正在读取当前 Host 的合法 provider 目录…" : "无法读取当前 Host 的合法 provider 目录（llm.providers/models 不可用），目录加载失败——已存值保留可选，可先编辑补充提示词。"))),
        h("div", { style: GSS.field },
          h("label", { style: GSS.label }, "子代理默认 model id"),
          h("select", { style: GSS.select, value: curModel, disabled: !writable,
            onChange: (e) => setField("subagentModel", e.target.value) }, ...modelOptions),
          h("span", { style: GSS.hint },
            catReady
              ? "按所选 provider 过滤；未选 provider 时列出全部目录模型（provider/模型名）。同理仅作缺省值，单次 model 与 project.yaml 的 executor.model 更优先；留空继承父会话。"
              : (catalog.status === "loading" ? "正在读取当前 Host 的合法模型目录…" : "无法读取当前 Host 的合法模型目录（llm.providers/models 不可用），目录加载失败——已存值保留可选，可先编辑补充提示词。"))),
        catReady && catalog.failures.length > 0
          ? h("span", { style: GSS.hint }, "部分 provider 的模型目录读取失败（" + catalog.failures.map((f) => f.id).join("、") + "），相关 provider 暂不可选。")
          : null,
        h("div", { style: GSS.field },
          h("label", { style: GSS.label }, "子代理默认补充提示词"),
          h("textarea", { style: GSS.textarea, value: draftValue.subagentPrompt, disabled: !writable,
            placeholder: "可选：注入到每个执行子代理 prompt 的补充内容（默认空）",
            onChange: (e) => setField("subagentPrompt", e.target.value) }),
          h("span", { style: GSS.hint }, "默认为空；workspace 覆盖字段 default 继承此项，自定义文本覆盖，显式空值禁用该项全局提示词。")),
        h("div", { style: GSS.row },
          h("button", { style: GSS.btnPrimary, disabled: saving || !writable, onClick: save },
            saving ? "保存中…" : "保存"),
          saved ? h("span", { style: GSS.noteOk }, saved) : null,
          error ? h("span", { style: GSS.noteErr }, error) : null),
      );
    }

    // 注册「看板设置」settings.section 页（plugin.js apply 调用）。settingsScope 缺失时整页降级。
    function registerGraphSettingsSection(ctx) {
      try {
        // g-133：数据源捕获 —— ctx.get('connection').api（组件挂载时读 llm.providers/models 目录）。
        gConnectionApi = (() => {
          try { return (ctx?.get?.("connection") ?? ctx?.connection)?.api ?? null; } catch { return null; }
        })();
        bindGraphSettingsScope(ctx);
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id: "dsh-graph-settings", order: 60, label: "看板设置" },
            (props) => h(GraphSettingsSection, props),
          ),
        );
      } catch { /* slots 缺失或重复注册：静默（不影响看板/工具） */ }
    }
