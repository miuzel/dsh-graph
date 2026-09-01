    // ===== g-132：workspace 看板设置弹窗（读取/可视化编辑 .dsh-graph/project.yaml 安全配置） =====
    // 字段范围（本期）：executor.provider/model、defaults.review、defaults.pk、supervisor.automation、
    // 子代理补充提示词 workspace 覆盖（三态：default 继承 / 自定义覆盖 / 显式空禁用）。
    // 保存走 PUT/POST /api/dsh-graph/settings（原子写；保留注释/未知键；失败不半写入）。
    function SettingsModal(props) {
      const [loading, setLoading] = React.useState(true);
      const [form, setForm] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [note, setNote] = React.useState(null); // {kind:"ok"|"err", text}
      const [error, setError] = React.useState(null);
      const [showAdvanced, setShowAdvanced] = React.useState(false);
      // att-002：服务端下发的 canonical .dsh-graph/project.yaml 绝对路径（只消费，不自行猜 graphRoot）
      const [configFile, setConfigFile] = React.useState(null);
      // g-214：刷新间隔配置（localStorage 持久化，下限 5s）
      const [refreshIntervalInput, setRefreshIntervalInput] = React.useState(() => String(getRefreshInterval()));
      const [intervalWarn, setIntervalWarn] = React.useState(null);

      const handleIntervalChange = (val) => {
        setRefreshIntervalInput(val);
        const num = Number(val);
        if (val.trim() === "" || !Number.isFinite(num) || num < MIN_REFRESH_INTERVAL) {
          setIntervalWarn("刷新间隔最小限制为 5 秒（保存时将自动纠偏为 5s）");
        } else {
          setIntervalWarn(null);
        }
      };

      const set = (path, value) => {
        setForm((f) => {
          const next = JSON.parse(JSON.stringify(f));
          let cur = next;
          for (let i = 0; i < path.length - 1; i++) {
             if (!cur[path[i]] || typeof cur[path[i]] !== "object") cur[path[i]] = {};
             cur = cur[path[i]];
           }
          cur[path[path.length - 1]] = value;
          return next;
        });
      };
      // 三态提示词切换：default/disable 清空 value，override 保留文本
      const setPromptState = (key, state) => {
        set(["prompt_overrides", key, "state"], state);
        if (state !== "override") set(["prompt_overrides", key, "value"], null);
      };
      const setPromptValue = (key, value) => set(["prompt_overrides", key, "value"], value);

      const load = async () => {
        setLoading(true); setError(null);
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/settings"));
          const data = await r.json();
          if (!r.ok) throw new Error(data?.error || ("请求失败 " + r.status));
          setForm(data);
          setConfigFile(data.configFile ?? null);
        } catch (e) {
          setError("加载配置失败：" + String(e?.message ?? e));
        } finally { setLoading(false); }
      };
      React.useEffect(() => { load(); }, []);
      // 目录化 select（与 settings.js g-133 同源）：挂载时用同 scope 的 gConnectionApi/loadHostCatalog
      // 读取当前 Host 的 llm.providers/llm.models 合法目录（g-215 探测链：优先 0.1.2-alpha.2 新版 RPC，回退 0.1.1-rc 旧版）。
      // RPC 缺失/失败时目录状态置 unavailable，降级为「提示 + 保留已存值」，不阻止保存。
      // provider 只列 active 且有模型目录的 provider；model 按当前 provider 过滤；
      // 空项代表继承父会话；未列出的已存旧值保留为固定 option。
      const [catalog, setCatalog] = React.useState({ status: "loading" });
      React.useEffect(() => {
        let alive = true;
        loadHostCatalog(gConnectionApi)
          .then((c) => { if (alive) setCatalog(c); })
          .catch(() => { if (alive) setCatalog({ status: "unavailable" }); });
        return () => { alive = false; };
      }, []);

      // g-181：backdrop 误关保护——组件顶部调用（多分支共享同一 guard，保持 Hook 顺序稳定）
      const backdropGuard = useBackdropClose(props.onClose);

      const save = async () => {
        if (!form) return;
        setSaving(true); setNote(null); setError(null);
        // g-214: 保存并持久化刷新间隔到 localStorage（非法值或 <5s 自动纠偏为 5s）
        const correctedInterval = setRefreshInterval(refreshIntervalInput);
        setRefreshIntervalInput(String(correctedInterval));
        setIntervalWarn(null);
        const lanesRaw = form.defaults?.pk?.lanes;
        const lanes = lanesRaw === null || lanesRaw === "" || lanesRaw === undefined ? 1 : Number(lanesRaw);
        if (!Number.isInteger(lanes) || lanes < 1) {
          setNote({ kind: "err", text: "pk.lanes 必须是 >=1 的整数" });
          setSaving(false); return;
        }
        const rawAuto = form.supervisor?.automation ?? {};
        const cleanAuto = {};
        for (const [k, v] of Object.entries(rawAuto)) {
          if (v === "human" || v === "ai") cleanAuto[k] = v;
          else cleanAuto[k] = null;
        }
        const patch = {
          executor: { provider: form.executor?.provider ?? "", model: form.executor?.model ?? "" },
          defaults: {
            review: { reviewer: form.defaults?.review?.reviewer ?? "", prompt: form.defaults?.review?.prompt ?? null },
            pk: { lanes, sandbox: form.defaults?.pk?.sandbox ?? "" },
          },
          supervisor: { automation: cleanAuto },
          prompt_overrides: {
            subagent: form.prompt_overrides?.subagent ?? { state: "default", value: null },
          },
        };
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/settings"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data?.error || ("保存失败 " + r.status));
          setForm(data.config ?? form); // 用服务端回填的最新配置刷新
          props.onSaved?.();
          props.onClose?.();
        } catch (e) {
          setNote({ kind: "err", text: "保存失败：" + String(e?.message ?? e) });
        } finally { setSaving(false); }
      };

      if (loading) {
        return h("div", { style: S.overlay, ...backdropGuard },
          h("div", { style: { ...S.modal, maxWidth: 520 }, onClick: (e) => e.stopPropagation() },
            h("span", { style: S.close, onClick: props.onClose }, "✕"),
            h("div", { style: S.modalH }, "看板设置"),
            h("div", { style: { ...S.meta, marginTop: 8 } }, "正在读取配置…")));
      }
      if (!form) {
        return h("div", { style: S.overlay, ...backdropGuard },
          h("div", { style: { ...S.modal, maxWidth: 520 }, onClick: (e) => e.stopPropagation() },
            h("span", { style: S.close, onClick: props.onClose }, "✕"),
            h("div", { style: S.modalH }, "看板设置"),
            error ? h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-error-primary, #f08080)", marginTop: 8 } }, error) : null,
            h("button", { style: { ...S.btn, marginTop: 10 }, className: "dg-btn", onClick: load }, "重试")));
      }

      const auto = form.supervisor?.automation ?? {};
      const automationOptions = (val) => [
        h("option", { value: "", style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, "（未设置）"),
        h("option", { value: "human", style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, "human（人工）"),
        h("option", { value: "ai", style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, "ai（自动）"),
      ];
      const promptOverride = (key, label) => {
        const ov = form.prompt_overrides?.[key] ?? { state: "default", value: null };
        const body =
          ov.state === "override"
            ? h("textarea", {
                style: { ...S.promptInput, width: "100%", minHeight: 56, resize: "vertical" },
                value: ov.value ?? "",
                placeholder: "输入覆盖文本（支持空格/引号/#/多行）…",
                onChange: (e) => setPromptValue(key, e.target.value),
              })
            : h("div", { style: S.meta },
                ov.state === "default" ? "（继承当前 profile 全局提示词）" : "（全局提示词被禁用）");
        const stateBtn = (st) => h("button", {
          key: st,
          className: "dg-btn",
          style: {
            ...S.btn, fontSize: 11, padding: "2px 8px", cursor: "pointer",
            border: "1px solid " + (ov.state === st ? "rgba(76,141,255,.55)" : "rgba(128,128,128,.3)"),
            background: ov.state === st ? "rgba(76,141,255,.15)" : "rgba(128,128,128,.12)",
            fontWeight: ov.state === st ? 700 : 400,
          },
          title: st === "default" ? "继承当前 DSH profile 全局值" : (st === "override" ? "自定义文本覆盖全局" : "显式禁用全局提示词"),
          onClick: () => setPromptState(key, st),
        }, st === "default" ? "default（继承）" : (st === "override" ? "override（覆盖）" : "disable（禁用）"));
        return h("div", { style: { marginBottom: 10 } },
          h("div", { style: { fontWeight: 600, marginBottom: 4 } }, label),
          h("div", { style: { display: "flex", gap: 6, marginBottom: 4 } },
            ["default", "override", "disable"].map((st) => stateBtn(st))),
          body);
      };

      // ===== g-133：provider/model 合法目录派生（与 settings.js 页面同源逻辑，字段换成 executor.*） =====
      // 目录仅 advisory 可选列表：未列出的已存旧值保留为固定 option（带「未列出/读取中/不可用」后缀），
      // 不拦截保存；空值 = 继承父会话。保存仍写 form.executor.provider/model 到 workspace project.yaml。
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
      const curProvider = form.executor?.provider ?? "";
      const curModel = form.executor?.model ?? "";
      const legacySuffix = catReady
        ? "（已存值，当前目录未列出）"
        : (catalog.status === "loading" ? "（目录读取中…）" : "（目录不可用）");
      // provider 切换：切到合法新 provider 且现有 model 不属于其目录则清空 model（保留空=继承语义）；
      // 切到已存 legacy provider / 留空不强行清空，避免丢失已存 model。
      const onProviderChange = (v) => {
        set(["executor", "provider"], v);
        if (v !== "" && legalProviderIds.has(v) && curModel !== "" && !(legalModelsByProvider.get(v)?.has(curModel))) {
          set(["executor", "model"], "");
        }
      };
      const opt = (key, value, label) =>
        h("option", { key, value, style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, label);
      const providerOptions = (() => {
        const opts = [opt("__blank-p", "", "（继承父会话）")];
        // 已存 provider 未在合法目录中（含目录未就绪时无法校验）→ 保留为固定 option
        if (curProvider !== "" && !(catReady && legalProviderIds.has(curProvider))) {
          opts.push(opt("__cur-p", curProvider, curProvider + legacySuffix));
        }
        if (catReady) for (const p of legalProviders) opts.push(opt(p.provider, p.provider, providerLabel(p.provider)));
        return opts;
      })();
      const modelOptions = (() => {
        const opts = [opt("__blank-m", "", "（继承父会话）")];
        // 已存 model 是否出现在目录中：目录就绪时按所选 provider 校验；未就绪时无法校验 → 一律保留
        const curListed = catReady && (curProvider !== ""
          ? (legalModelsByProvider.get(curProvider)?.has(curModel) ?? false)
          : allLegalModels.some((m) => m.value === curModel));
        if (curModel !== "" && !curListed) opts.push(opt("__cur-m", curModel, curModel + legacySuffix));
        if (catReady) {
          if (curProvider !== "") {
            const g = groupById.get(curProvider);
            if (g) for (const m of g.models) opts.push(opt(g.id + "/" + m.id, m.id, m.name ?? m.id));
          } else {
            for (const m of allLegalModels) opts.push(opt(m.label, m.value, m.label));
          }
        }
        return opts;
      })();

      return h("div", { style: S.overlay, ...backdropGuard },
        h("div", { style: { ...S.modal, maxWidth: 640 }, onClick: (e) => e.stopPropagation() },
          h("span", { style: S.close, onClick: props.onClose }, "✕"),
          h("div", { style: S.modalH }, "看板设置"),
          h("div", { style: S.meta }, "编辑当前 workspace 的 .dsh-graph/project.yaml 安全配置；写回保留未知键与注释。"),
          // att-002：配置文件操作入口——复用 goal-modal 的 Host openPath/copyText/toast/fallback 机制
          configFile
            ? h("div", { style: { display: "flex", alignItems: "center", gap: 4, marginTop: 4 } },
                h("span", { style: { fontSize: 11, opacity: 0.7 } }, "📄 project.yaml"),
                h("button", {
                  style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                  className: "dg-btn",
                  title: "用系统默认编辑器打开 project.yaml",
                  onClick: async (e) => {
                    e.stopPropagation();
                    // g-222：统一走共享 openHostPath，失败透出可理解错误（C3/C4）
                    const r = await openHostPath(configFile);
                    if (r.opened) { showToast("✅ 已打开 project.yaml"); return; }
                    await copyText(configFile);
                    if (r.error) { showToast("⚠️ 打开失败：" + openErrorText(r.error)); }
                    else { showToast("✅ 路径已复制（打开不可用）"); }
                  },
                }, "打开"),
                h("button", {
                  style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                  className: "dg-btn",
                  title: "复制 project.yaml 路径",
                  onClick: async (e) => { e.stopPropagation(); const ok = await copyText(configFile); if (ok) showToast("✅ 路径已复制"); },
                }, "复制路径"))
            : null,
           h("button", { className: "dg-btn", style: { ...S.btn, marginTop: 6, fontSize: 12 }, onClick: () => setShowAdvanced((v) => !v) }, showAdvanced ? "隐藏高级/仅存储字段" : "显示高级/仅存储字段"),
          h("hr", { style: { border: "none", borderTop: "1px solid rgba(128,128,128,.25)", margin: "10px 0" } }),
          h("div", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
            h("span", { style: { fontWeight: 700, fontSize: 12, flexShrink: 0 } }, "看板数据自动刷新："),
            h("input", {
              style: { ...S.promptInput, width: 38, flex: "none", padding: "2px 4px", textAlign: "center", fontSize: 12, boxSizing: "border-box" },
              type: "number",
              min: MIN_REFRESH_INTERVAL,
              step: 1,
              value: refreshIntervalInput,
              onChange: (e) => handleIntervalChange(e.target.value),
            }),
            h("span", { style: { ...S.meta, fontSize: 11, flexShrink: 0 } }, "秒"),
            h("span", { style: { ...S.meta, fontSize: 11, opacity: 0.7 } }, "（下限 5 秒）")),
          intervalWarn ? h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-error-primary, #f08080)", marginTop: 2 } }, "⚠️ " + intervalWarn) : null,

          h("hr", { style: { border: "none", borderTop: "1px solid rgba(128,128,128,.25)", margin: "10px 0" } }),

          h("div", { style: { fontWeight: 700, marginBottom: 4 } }, "执行子代理模型路由"),
          // g-133：两列并排各占一半的可收缩 flex 布局——父容器 minWidth:0、子列 flex:"1 1 0"+minWidth:0、
          // 控件 boxSizing:"border-box"，避免 provider/model 两列在窄容器下重叠/溢出。
          h("div", { style: { display: "flex", gap: 8, minWidth: 0 } },
            h("div", { style: { flex: "1 1 0", minWidth: 0 } },
              h("label", { style: { display: "block", marginBottom: 2, fontSize: 11, opacity: 0.8 } }, "provider"),
              h("select", { style: { ...S.promptInput, width: "100%", boxSizing: "border-box" }, value: curProvider, onChange: (e) => onProviderChange(e.target.value) },
                ...providerOptions)),
            h("div", { style: { flex: "1 1 0", minWidth: 0 } },
              h("label", { style: { display: "block", marginBottom: 2, fontSize: 11, opacity: 0.8 } }, "model"),
              h("select", { style: { ...S.promptInput, width: "100%", boxSizing: "border-box" }, value: curModel, onChange: (e) => set(["executor", "model"], e.target.value) },
                ...modelOptions))),
          h("div", { style: { ...S.meta, marginTop: 4 } },
            catReady
              ? "目录来自当前 Host（llm.providers/models，仅可选列表）：provider 仅列 active 且有模型目录的项；model 按当前 provider 过滤；空项继承父会话；已存但未列出的旧值保留为固定选项、仍可保存。"
              : (catalog.status === "loading" ? "正在读取当前 Host 的合法 provider/model 目录…" : "当前 Host 目录不可用（llm.providers/models 缺失）——已存值保留可选、仍可保存。")),

          h("hr", { style: { display: showAdvanced ? "block" : "none", border: "none", borderTop: "1px solid rgba(128,128,128,.25)", margin: "10px 0" } }),
          h("div", { style: { display: showAdvanced ? "block" : "none", fontWeight: 700, marginBottom: 4 } }, "高级/仅存储字段"),
          h("div", { style: { display: showAdvanced ? "flex" : "none", gap: 8, flexWrap: "wrap" } },
            h("div", { style: { flex: "1 1 120px" } },
              h("label", { style: { display: "block", marginBottom: 2, fontSize: 11, opacity: 0.8 } }, "review.reviewer"),
              h("input", { style: { ...S.promptInput, width: "100%" }, value: form.defaults?.review?.reviewer ?? "", onChange: (e) => set(["defaults", "review", "reviewer"], e.target.value) })),
            h("div", { style: { flex: "1 1 120px" } },
              h("label", { style: { display: "block", marginBottom: 2, fontSize: 11, opacity: 0.8 } }, "review.prompt"),
              h("input", { style: { ...S.promptInput, width: "100%" }, value: form.defaults?.review?.prompt ?? "", onChange: (e) => set(["defaults", "review", "prompt"], e.target.value === "" ? null : e.target.value) })),
            h("div", { style: { flex: "1 1 90px" } },
              h("label", { style: { display: "block", marginBottom: 2, fontSize: 11, opacity: 0.8 } }, "pk.lanes"),
              h("input", { style: { ...S.promptInput, width: "100%" }, type: "number", min: 1, value: form.defaults?.pk?.lanes ?? 1, onChange: (e) => set(["defaults", "pk", "lanes"], e.target.value) })),
            h("div", { style: { flex: "1 1 120px" } },
              h("label", { style: { display: "block", marginBottom: 2, fontSize: 11, opacity: 0.8 } }, "pk.sandbox"),
              h("input", { style: { ...S.promptInput, width: "100%" }, value: form.defaults?.pk?.sandbox ?? "", onChange: (e) => set(["defaults", "pk", "sandbox"], e.target.value) }))),

          h("hr", { style: { display: showAdvanced ? "block" : "none", border: "none", borderTop: "1px solid rgba(128,128,128,.25)", margin: "10px 0" } }),
          h("div", { style: { display: showAdvanced ? "block" : "none", fontWeight: 700, marginBottom: 4 } }, "主管自动化（高级/仅存储字段）"),
          h("div", { style: { display: showAdvanced ? "grid" : "none", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 } },
            Object.keys({ scope_planning: "范围规划", integration_decision: "集成决策", rework: "返工决策", memory_promotion: "记忆提炼", skill_proposal: "技能提案", release: "发布" }).map((k) =>
              h("div", { key: k },
                h("label", { style: { display: "block", marginBottom: 2, fontSize: 11, opacity: 0.8 } }, k),
                h("select", { style: { ...S.promptInput, width: "100%" }, value: auto[k] ?? "", onChange: (e) => set(["supervisor", "automation", k], e.target.value === "" ? null : e.target.value) },
                  ...automationOptions(auto[k]))))),

          h("hr", { style: { display: showAdvanced ? "block" : "none", border: "none", borderTop: "1px solid rgba(128,128,128,.25)", margin: "10px 0" } }),
          h("div", { style: { fontWeight: 700, marginBottom: 4 } }, "补充提示词 workspace 覆盖"),
          promptOverride("subagent", "子代理补充提示词"),


          h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 6 } },
            h("button", { style: { ...S.btn, padding: "6px 16px", fontSize: 13 }, className: "dg-btn", disabled: saving, onClick: save },
              saving ? "保存中…" : "保存"),
            h("button", { style: { ...S.btn, padding: "6px 12px", fontSize: 12 }, className: "dg-btn", onClick: props.onClose }, "关闭"),
            note ? h("span", { style: { ...S.meta, color: note.kind === "ok" ? "var(--dsw-alias-label-primary, #6ee7a0)" : "var(--dsw-alias-state-error-primary, #f08080)", marginLeft: 8 } }, note.text) : null),
          error ? h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-error-primary, #f08080)", marginTop: 6 } }, error) : null));
    }
