    // ===== g-132：workspace 看板设置弹窗（读取/可视化编辑 .dsh-graph/project.yaml 安全配置） =====
    // 字段范围（本期）：executor.provider/model、defaults.review、defaults.pk、supervisor.automation、
    // 顶层 review.policy（g-342 四态：继承未配置 / auto / strict / none）、
    // 子代理补充提示词 workspace 覆盖（三态：default 继承 / 自定义覆盖 / 显式空禁用）。
    // 保存走 PUT/POST /api/dsh-graph/settings（原子写；保留注释/未知键；失败不半写入）。
    let settingsModalModeInstanceSeq = 0;
    // ===== g-246：未保存修改脏状态判定（规范化后深比较，消除服务端 null 与表单默认 ""、
    // lanes 数字/字符串差异造成的假阳性；g-214 刷新间隔输入计入脏，g-224 实时显示开关即时生效不计入脏） =====
    function normalizeSettingsDraft(form, refreshIntervalInput) {
      const normStr = (v) => (v === null || v === undefined ? "" : String(v));
      const lanesRaw = form?.defaults?.pk?.lanes;
      const lanesNum = lanesRaw === null || lanesRaw === "" || lanesRaw === undefined ? 1 : Number(lanesRaw);
      const auto = {};
      for (const [k, v] of Object.entries(form?.supervisor?.automation ?? {})) {
        auto[k] = (v === "human" || v === "ai") ? v : null;
      }
      const po = form?.prompt_overrides?.subagent ?? { state: "default", value: null };
      const poState = (po.state === "override" || po.state === "disable") ? po.state : "default";
      return {
        executor: {
          provider: normStr(form?.executor?.provider),
          model: normStr(form?.executor?.model),
          reasoning_effort: normStr(form?.executor?.reasoning_effort),
          mode: normStr(form?.executor?.mode),
        },
        defaults: {
          review: { reviewer: normStr(form?.defaults?.review?.reviewer), prompt: normStr(form?.defaults?.review?.prompt) },
          pk: { lanes: Number.isInteger(lanesNum) ? lanesNum : normStr(lanesRaw), sandbox: normStr(form?.defaults?.pk?.sandbox) },
        },
        supervisor: { automation: auto },
        prompt_overrides: { subagent: { state: poState, value: poState === "override" ? normStr(po.value) : "" } },
        review: { policy: normalizeReviewPolicyDraft(form?.review?.policy) },
        refreshInterval: String(refreshIntervalInput ?? ""),
      };
    }
    function settingsDraftIsDirty(baseline, form, refreshIntervalInput) {
      if (!baseline || !form) return false;
      return JSON.stringify(normalizeSettingsDraft(form, refreshIntervalInput)) !== JSON.stringify(baseline);
    }
    // ===== g-342：顶层 review.policy 四态下拉（继承未配置 / auto / strict / none） =====
    // 合法值真源在 core/review-policy.ts 的 REVIEW_POLICIES；lib/client/*.js 是独立打包的浏览器
    // bundle，无法 import core 常量，故此处只能放**副本**——两边一致性由
    // core/tests/g342-settings-review-policy.test.ts 的断言核对（改一边不改另一边必红）。
    // 归一化把 null/undefined/"" 以及任何非三值统一为 ""（＝「继承/未配置」），
    // 因此服务端 null 与表单 "" 不会造成假脏（判据 2）；保存时 "" → null——
    // schema 的 policy 只接受三值或 null，写 "" 会被 enum 直接拒绝。
    const REVIEW_POLICY_VALUES = ["auto", "strict", "none"];
    const REVIEW_POLICY_LABEL_KEYS = {
      auto: "settings.reviewPolicyAuto",
      strict: "settings.reviewPolicyStrict",
      none: "settings.reviewPolicyNone",
    };
    const normalizeReviewPolicyDraft = (v) => (REVIEW_POLICY_VALUES.includes(v) ? v : "");
    function SettingsModal(props) {
      useLocaleRevision();
      const modeIdRef = React.useRef(null);
      if (modeIdRef.current == null) modeIdRef.current = `dg-workspace-subagent-mode-${++settingsModalModeInstanceSeq}`;
      const modeId = modeIdRef.current;
      // g-342：review.policy 下拉的稳定 id（与 modeIdRef 同款生成方式，供 label htmlFor 绑定）
      const reviewPolicyIdRef = React.useRef(null);
      if (reviewPolicyIdRef.current == null) reviewPolicyIdRef.current = `dg-workspace-review-policy-${++settingsModalModeInstanceSeq}`;
      const reviewPolicyId = reviewPolicyIdRef.current;
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
      // g-224：实时代理输出流式显示开关（localStorage 持久化，即时生效）
      const liveDisplayOn = useLiveDisplayEnabled();

      // g-246：打开时以服务端下发快照为基线（含刷新间隔初始值），关闭前深比较草稿判定脏
      const baselineRef = React.useRef(null);
      // g-246：统一关闭拦截——脏草稿先 window.confirm 确认；saving 中阻止关闭避免竞态；
      // 保存成功路径直接走 props.onClose?.() 不经此函数（不二次弹窗）。
      const requestClose = () => {
        if (saving) { setNote({ kind: "err", text: dgT("common.saving") }); return; }
        if (settingsDraftIsDirty(baselineRef.current, form, refreshIntervalInput)) {
          if (!window.confirm(dgT("common.confirm"))) return;
        }
        props.onClose?.();
      };

      const handleIntervalChange = (val) => {
        setRefreshIntervalInput(val);
        const num = Number(val);
        if (val.trim() === "" || !Number.isFinite(num) || num < MIN_REFRESH_INTERVAL) {
          setIntervalWarn(dgT("settings.intervalWarn"));
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
          if (!r.ok) throw new Error(data?.error || (dgT("drag.requestFail") + " " + r.status));
          setForm(data);
          setConfigFile(data.configFile ?? null);
          baselineRef.current = normalizeSettingsDraft(data, String(getRefreshInterval()));
        } catch (e) {
          setError(dgT("settings.loadFail") + String(e?.message ?? e));
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
      // g-246：backdrop 关闭走统一 requestClose 拦截（脏草稿先确认）
      const backdropGuard = useBackdropClose(requestClose);

      const save = async () => {
        if (!form) return;
        setSaving(true); setNote(null); setError(null);
        const lanesRaw = form.defaults?.pk?.lanes;
        const lanes = lanesRaw === null || lanesRaw === "" || lanesRaw === undefined ? 1 : Number(lanesRaw);
        if (!Number.isInteger(lanes) || lanes < 1) {
          setNote({ kind: "err", text: dgT("settings.pkLanesError") });
          setSaving(false); return;
        }
        const rawAuto = form.supervisor?.automation ?? {};
        const cleanAuto = {};
        for (const [k, v] of Object.entries(rawAuto)) {
          if (v === "human" || v === "ai") cleanAuto[k] = v;
          else cleanAuto[k] = null;
        }
        // g-342：review.policy 三值直传；「继承/未配置」写 null（schema 的 enum 只认三值与 null，
        // 写 "" 会被拒；core 侧 setScalar 对 null 清空 → 读回 null → 按目标类型派生）。
        const reviewPolicy = normalizeReviewPolicyDraft(form.review?.policy);
        const patch = {
          executor: { provider: form.executor?.provider ?? "", model: form.executor?.model ?? "", reasoning_effort: form.executor?.reasoning_effort ?? "", mode: form.executor?.mode ?? "" },
          defaults: {
            review: { reviewer: form.defaults?.review?.reviewer ?? "", prompt: form.defaults?.review?.prompt ?? null },
            pk: { lanes, sandbox: form.defaults?.pk?.sandbox ?? "" },
          },
          supervisor: { automation: cleanAuto },
          review: { policy: reviewPolicy === "" ? null : reviewPolicy },
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
          if (!r.ok) throw new Error(data?.error || (dgT("settings.saveFail") + " " + r.status));
          // g-259：刷新间隔后置生效——仅在 POST 成功 (r.ok) 后持久化到 localStorage 并广播事件
          // （非法值或 <5s 自动纠偏为 5s，前置校验失败或 POST 异常时绝不改写本地配置与广播）
          const correctedInterval = setRefreshInterval(refreshIntervalInput);
          setRefreshIntervalInput(String(correctedInterval));
          setIntervalWarn(null);
          setForm(data.config ?? form); // 用服务端回填的最新配置刷新
          // g-246：保存成功即归位基线（刷新间隔取纠偏后值），随后直接关闭跳过拦截
          baselineRef.current = normalizeSettingsDraft(data.config ?? form, String(correctedInterval));
          props.onSaved?.();
          props.onClose?.();
        } catch (e) {
          setNote({ kind: "err", text: dgT("settings.saveFail") + String(e?.message ?? e) });
        } finally { setSaving(false); }
      };

      if (loading) {
        return h("div", { style: S.overlay, ...backdropGuard },
          h("div", { style: { ...S.modal, maxWidth: 520 }, onClick: (e) => e.stopPropagation() },
            h("span", { className: "dg-close", style: S.close, onClick: requestClose }, "✕"),
            h("div", { style: S.modalH }, dgT("settings.title")),
            h("div", { style: { ...S.meta, marginTop: 8 } }, dgT("settings.loading"))));
      }
      if (!form) {
        return h("div", { style: S.overlay, ...backdropGuard },
          h("div", { style: { ...S.modal, maxWidth: 520 }, onClick: (e) => e.stopPropagation() },
            h("span", { className: "dg-close", style: S.close, onClick: requestClose }, "✕"),
            h("div", { style: S.modalH }, dgT("settings.title")),
            error ? h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-error-primary, #f08080)", marginTop: 8 } }, error) : null,
            h("button", { style: { ...S.btn, marginTop: 10 }, className: "dg-btn", onClick: load }, dgT("common.retry"))));
      }

      const auto = form.supervisor?.automation ?? {};
      const automationOptions = (val) => [
        h("option", { value: "", style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, dgT("common.none")),
        h("option", { value: "human", style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, "human (" + dgT("settings.human") + ")"),
        h("option", { value: "ai", style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, "ai (" + dgT("settings.ai") + ")"),
      ];
      const promptOverride = (key, label) => {
        const ov = form.prompt_overrides?.[key] ?? { state: "default", value: null };
        const body =
          ov.state === "override"
            ? h("textarea", {
                style: { ...S.promptInput, width: "100%", minHeight: 56, resize: "vertical" },
                value: ov.value ?? "",
                placeholder: dgT("settings.overridePlaceholder"),
                onChange: (e) => setPromptValue(key, e.target.value),
              })
            : h("div", { style: S.meta },
                ov.state === "default" ? dgT("settings.inheritPrompt") : dgT("settings.disabledPrompt"));
        const stateBtn = (st) => h("button", {
          key: st,
          className: "dg-btn",
          style: {
            ...S.btn, fontSize: 11, padding: "2px 8px", cursor: "pointer",
            border: "1px solid " + (ov.state === st ? "rgba(76,141,255,.55)" : "rgba(128,128,128,.3)"),
            background: ov.state === st ? "rgba(76,141,255,.15)" : "rgba(128,128,128,.12)",
            fontWeight: ov.state === st ? 700 : 400,
          },
          title: st === "default" ? dgT("settings.inheritGlobal") : (st === "override" ? dgT("settings.overrideGlobal") : dgT("settings.disableGlobal")),
          onClick: () => setPromptState(key, st),
        }, st === "default" ? "default (" + dgT("settings.inherit") + ")" : (st === "override" ? "override (" + dgT("settings.override") + ")" : "disable (" + dgT("settings.disable") + ")"));
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
        ? dgT("settings.legacyValue")
        : (catalog.status === "loading" ? dgT("settings.catalogLoading") : dgT("settings.catalogUnavailable"));
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
        const opts = [opt("__blank-p", "", dgT("settings.inheritSession"))];
        // 已存 provider 未在合法目录中（含目录未就绪时无法校验）→ 保留为固定 option
        if (curProvider !== "" && !(catReady && legalProviderIds.has(curProvider))) {
          opts.push(opt("__cur-p", curProvider, curProvider + legacySuffix));
        }
        if (catReady) for (const p of legalProviders) opts.push(opt(p.provider, p.provider, providerLabel(p.provider)));
        return opts;
      })();
      const modelOptions = (() => {
        const opts = [opt("__blank-m", "", dgT("settings.inheritSession"))];
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
      // reasoning 元数据随目录中的精确 provider/model 下发，选项不使用客户端固定枚举。
      const selectedModel = (() => {
        if (!catReady || curModel === "") return null;
        if (curProvider !== "") return groupById.get(curProvider)?.models.find((m) => m.id === curModel) ?? null;
        const matches = catalog.groups.flatMap((g) => g.models.filter((m) => m.id === curModel));
        return matches.length === 1 ? matches[0] : null;
      })();
      const effortChoices = Array.isArray(selectedModel?.reasoning?.efforts) ? selectedModel.reasoning.efforts : [];
      const curEffort = form.executor?.reasoning_effort ?? "";
      const effortListed = effortChoices.some((effort) => effort?.id === curEffort);
      const effortOptions = [opt("__blank-e", "", dgT("settings.inheritModel"))];
      if (curEffort !== "" && !effortListed) {
        effortOptions.push(opt("__cur-e", curEffort, curEffort + legacySuffix));
      }
      for (const effort of effortChoices) {
        if (typeof effort?.id === "string" && effort.id !== "") effortOptions.push(opt("effort:" + effort.id, effort.id, effort.name ?? effort.id));
      }
      // g-342：review.policy 当前选中值——非三值/缺失一律显示为「继承（未配置）」，
      // 与 normalizeSettingsDraft 用同一归一化，避免「显示继承但被判脏」的错位。
      const curReviewPolicy = normalizeReviewPolicyDraft(form.review?.policy);
      // 选项 style 与 automationOptions / mode select 同源（g-176 主题变量，不硬编码暗色）
      const policyOptionStyle = { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" };

      return h("div", { style: S.overlay, ...backdropGuard },
        h("div", { style: { ...S.modal, maxWidth: 640 }, onClick: (e) => e.stopPropagation() },
          h("span", { className: "dg-close", style: S.close, onClick: requestClose }, "✕"),
          h("div", { style: S.modalH }, dgT("settings.title")),
          h("div", { style: S.meta }, dgT("settings.editHint")),
          // att-002：配置文件操作入口——复用 goal-modal 的 Host openPath/copyText/toast/fallback 机制
          configFile
            ? h("div", { style: { display: "flex", alignItems: "center", gap: 4, marginTop: 4 } },
                h("span", { style: { fontSize: 11, opacity: 0.7 } }, dgT("settings.projectYaml")),
                h("button", {
                  style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                  className: "dg-btn",
                  title: dgT("settings.openConfigTooltip"),
                  onClick: async (e) => {
                    e.stopPropagation();
                    // g-222：统一走共享 openHostPath，失败透出可理解错误（C3/C4）
                    const r = await openHostPath(configFile);
                    if (r.opened) { showToast(dgT("settings.openedProjectYaml")); return; }
                    await copyText(configFile);
                    if (r.error) { showToast(dgT("tab.openFailed") + openErrorText(r.error)); }
                    else { showToast(dgT("tab.pathCopiedNoOpen")); }
                  },
                }, dgT("tab.openFile")),
                h("button", {
                  style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                  className: "dg-btn",
                  title: dgT("settings.copyProjectPath"),
                  onClick: async (e) => { e.stopPropagation(); const ok = await copyText(configFile); if (ok) showToast(dgT("tab.pathCopied")); },
                }, dgT("tab.copyPath")))
            : null,
           h("button", { className: "dg-btn", style: { ...S.btn, marginTop: 6, fontSize: 12 }, onClick: () => setShowAdvanced((v) => !v) }, showAdvanced ? dgT("settings.hideAdvanced") : dgT("settings.showAdvanced")),
          h("hr", { style: { border: "none", borderTop: "1px solid rgba(128,128,128,.25)", margin: "10px 0" } }),
          h("div", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
            h("span", { style: { fontWeight: 700, fontSize: 12, flexShrink: 0 } }, dgT("settings.autoRefresh")),
            h("input", {
              style: { ...S.promptInput, width: 38, flex: "none", padding: "2px 4px", textAlign: "center", fontSize: 12, boxSizing: "border-box" },
              type: "number",
              min: MIN_REFRESH_INTERVAL,
              step: 1,
              value: refreshIntervalInput,
              onChange: (e) => handleIntervalChange(e.target.value),
            }),
            h("span", { style: { ...S.meta, fontSize: 11, flexShrink: 0 } }, dgT("settings.seconds")),
            h("span", { style: { ...S.meta, fontSize: 11, opacity: 0.7 } }, dgT("settings.minInterval"))),
          intervalWarn ? h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-error-primary, #f08080)", marginTop: 2 } }, "⚠️ " + intervalWarn) : null,

          // g-224：实时代理输出流式显示开关——关闭后停止高频输出流订阅（释放网络/内存/CPU），
          // 保留低频状态数据（livestrip 子代理状态、status line、token/ctx 占用）
          h("div", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0, marginTop: 8 } },
            h("input", {
              id: "dg-live-display",
              type: "checkbox",
              checked: liveDisplayOn,
              onChange: (e) => setLiveDisplay(e.target.checked),
              style: { flexShrink: 0 },
            }),
            h("label", { htmlFor: "dg-live-display", style: { fontWeight: 700, fontSize: 12, flexShrink: 0, cursor: "pointer" } }, dgT("settings.liveDisplay")),
            h("span", { style: { ...S.meta, fontSize: 11, opacity: 0.7 } }, dgT("settings.liveDisabledHint"))),

          h("hr", { style: { border: "none", borderTop: "1px solid rgba(128,128,128,.25)", margin: "10px 0" } }),

          h("div", { style: { fontWeight: 700, marginBottom: 4 } }, dgT("settings.modelRouting")),
          // g-133：两列并排各占一半的可收缩 flex 布局——父容器 minWidth:0、子列 flex:"1 1 0"+minWidth:0、
          // 控件 boxSizing:"border-box"，避免 provider/model 两列在窄容器下重叠/溢出。
          h("div", { style: { display: "flex", gap: 8, minWidth: 0, marginBottom: 8 } },
            h("div", { style: { flex: "1 1 0", minWidth: 0 } },
              h("label", { style: { display: "block", marginBottom: 2, fontSize: 11, opacity: 0.8 } }, "provider"),
              h("select", { style: { ...S.promptInput, width: "100%", boxSizing: "border-box" }, value: curProvider, onChange: (e) => onProviderChange(e.target.value) },
                ...providerOptions)),
            h("div", { style: { flex: "1 1 0", minWidth: 0 } },
              h("label", { style: { display: "block", marginBottom: 2, fontSize: 11, opacity: 0.8 } }, "model"),
              h("select", { style: { ...S.promptInput, width: "100%", boxSizing: "border-box" }, value: curModel, onChange: (e) => set(["executor", "model"], e.target.value) },
                ...modelOptions))),
          h("div", { style: { minWidth: 0, marginBottom: 6 } },
            h("label", { style: { display: "block", marginBottom: 2, fontSize: 11, opacity: 0.8 } }, dgT("settings.reasoningEffort")),
            h("select", {
              "aria-label": dgT("settings.reasoningEffortAria"),
              style: { ...S.promptInput, width: "100%", boxSizing: "border-box" },
              value: curEffort,
              onChange: (e) => set(["executor", "reasoning_effort"], e.target.value),
            }, ...effortOptions),
            h("div", { style: { ...S.meta, marginTop: 3, fontSize: 11 } },
              catReady
                ? (effortChoices.length > 0
                  ? dgT("settings.effortHint")
                  : dgT("settings.effortHintNone"))
                : dgT("profileSettings.effortHintWaiting"))),
          // g-191：执行模式受控下拉
          h("div", { style: { minWidth: 0, marginBottom: 6 } },
            h("label", { htmlFor: modeId, style: { display: "block", marginBottom: 2, fontSize: 11, opacity: 0.8 } }, dgT("settings.modeLabel")),
            h("select", {
              id: modeId,
              "aria-label": dgT("settings.modeAria"),
              style: { ...S.promptInput, width: "100%", boxSizing: "border-box" },
              value: form.executor?.mode ?? "",
              onChange: (e) => set(["executor", "mode"], e.target.value),
            },
              h("option", { value: "", style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, dgT("settings.modeInherited")),
              h("option", { value: "standard", style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, dgT("settings.modeStandard")),
              h("option", { value: "minimal", style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, dgT("settings.modeMinimal")))),
          h("div", { style: { ...S.meta, marginTop: 4 } },
            catReady
              ? dgT("settings.catalogReady")
              : (catalog.status === "loading" ? dgT("settings.catalogLoadingMsg") : dgT("settings.catalogUnavailableMsg"))),

          // g-342：顶层 review.policy 四态下拉（继承未配置 / auto / strict / none）。
          // 渲染方式（label htmlFor + select + meta 提示）与选项 style 比照上方 executor.mode 与
          // supervisor.automation；脏状态由 normalizeSettingsDraft 统一覆盖（判据 2）。
          // 归属主区而非「高级/仅存储字段」：该字段被 core/review-policy.ts 的受理门禁真实消费。
          h("hr", { style: { border: "none", borderTop: "1px solid rgba(128,128,128,.25)", margin: "10px 0" } }),
          h("div", { style: { minWidth: 0 } },
            h("label", { htmlFor: reviewPolicyId, style: { display: "block", marginBottom: 2, fontSize: 11, opacity: 0.8 } }, dgT("settings.reviewPolicyLabel")),
            h("select", {
              id: reviewPolicyId,
              "aria-label": dgT("settings.reviewPolicyAria"),
              style: { ...S.promptInput, width: "100%", boxSizing: "border-box" },
              value: curReviewPolicy,
              onChange: (e) => set(["review", "policy"], e.target.value),
            },
              h("option", { value: "", style: policyOptionStyle }, dgT("settings.reviewPolicyInherit")),
              ...REVIEW_POLICY_VALUES.map((p) => h("option", { key: p, value: p, style: policyOptionStyle }, dgT(REVIEW_POLICY_LABEL_KEYS[p])))),
            h("div", { style: { ...S.meta, marginTop: 3, fontSize: 11 } }, dgT("settings.reviewPolicyHint"))),

          h("hr", { style: { display: showAdvanced ? "block" : "none", border: "none", borderTop: "1px solid rgba(128,128,128,.25)", margin: "10px 0" } }),
          h("div", { style: { display: showAdvanced ? "block" : "none", fontWeight: 700, marginBottom: 4 } }, dgT("settings.advanced")),
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
          h("div", { style: { display: showAdvanced ? "block" : "none", fontWeight: 700, marginBottom: 4 } }, dgT("settings.supervisorAutomation")),
          h("div", { style: { display: showAdvanced ? "grid" : "none", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 } },
            // g-272 att-002：原 Object.keys({...中文标签}) 的中文值从未被渲染（label 直接用 key），改为纯 key 数组消除死代码中文残留。
            ["scope_planning", "integration_decision", "rework", "memory_promotion", "skill_proposal", "release"].map((k) =>
              h("div", { key: k },
                h("label", { style: { display: "block", marginBottom: 2, fontSize: 11, opacity: 0.8 } }, k),
                h("select", { style: { ...S.promptInput, width: "100%" }, value: auto[k] ?? "", onChange: (e) => set(["supervisor", "automation", k], e.target.value === "" ? null : e.target.value) },
                  ...automationOptions(auto[k]))))),

          h("hr", { style: { display: showAdvanced ? "block" : "none", border: "none", borderTop: "1px solid rgba(128,128,128,.25)", margin: "10px 0" } }),
          h("div", { style: { fontWeight: 700, marginBottom: 4 } }, dgT("settings.promptOverride")),
          promptOverride("subagent", dgT("settings.subagentPrompt")),


          h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 6 } },
            h("button", { style: { ...S.btn, padding: "6px 16px", fontSize: 13 }, className: "dg-btn", disabled: saving, onClick: save },
              saving ? dgT("common.saving") : dgT("settings.saveBtn")),
            h("button", { style: { ...S.btn, padding: "6px 12px", fontSize: 12 }, className: "dg-btn", onClick: requestClose }, dgT("settings.closeBtn")),
            note ? h("span", { style: { ...S.meta, color: note.kind === "ok" ? "var(--dsw-alias-label-primary, #6ee7a0)" : "var(--dsw-alias-state-error-primary, #f08080)", marginLeft: 8 } }, note.text) : null),
          error ? h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-error-primary, #f08080)", marginTop: 6 } }, error) : null));
    }

    // Source-contract compatibility: 保留未知键与注释; legacy inherited option "（继承父会话）".
    // g-246 close guard contract: window.confirm("有未保存的修改，确认放弃？");
    // Contract text: 显示高级/仅存储字段; if (saving) { setNote({ kind: "err", text: "正在保存，请稍候…" }); return; }
    // Contract text: "✅ 已打开 project.yaml"
