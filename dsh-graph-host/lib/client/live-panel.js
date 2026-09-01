    // 看板直达指令：向 continuable 子代理发文本（queue 排队 / steer 插队）。
    // 多模态降级：子代理图片源码级不支持（SUBAGENT_IMAGE_UNSUPPORTED）——明确提示而非静默失败。
    function PromptBox(props) {
      const { session, mode } = useBoundSession(props.parentId, props.childId);
      const [text, setText] = React.useState("");
      const [note, setNote] = React.useState(null);
      if (!props.childId || !session) return null;
      if (mode === "one-shot") {
        return h("div", { style: { ...S.meta, marginTop: 3 } },
          "📦 一次性子代理会话为只读，不能续发指令");
      }
      const send = async (sendMode) => {
        const t = text.trim();
        if (!t) return;
        setNote("发送中…");
        try {
          // session.prompt：continuable 子代理自动路由 api.subagents.prompt（仅文本）
          const res = await session.prompt([{ type: "text", text: t }], sendMode);
          if (res?.ok) {
            setText("");
            setNote(sendMode === "steer" ? "✅ 已插队发送" : "✅ 已排队");
          } else {
            const err = res?.error ?? {};
            const reason = String(err?.details?.reason ?? err?.code ?? "");
            if (reason.includes("SUBAGENT_IMAGE_UNSUPPORTED"))
              setNote("⚠️ 子代理会话不支持图片等多模态输入（SUBAGENT_IMAGE_UNSUPPORTED），请改用纯文本");
            else setNote("⚠️ 发送失败：" + (err?.message ?? reason ?? "未知错误"));
          }
        } catch (e) {
          setNote("⚠️ 发送异常：" + (e?.message ?? e));
        }
      };
      return h(
        "div",
        { style: S.promptBox, onClick: (e) => e.stopPropagation() },
        h("div", { style: S.promptRow },
          h("input", {
            style: S.promptInput,
            value: text,
            placeholder: "直达指令：发送到该子代理会话…",
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") send("queue"); },
          }),
          h("button", {
            style: { ...S.btn, flexShrink: 0 }, className: "dg-btn",
            title: "追加到会话队列尾部（queue）", onClick: () => send("queue"),
          }, "排队"),
          h("button", {
            style: { ...S.btn, flexShrink: 0 }, className: "dg-btn",
            title: "打断当前输出立即执行（steer）", onClick: () => send("steer"),
          }, "插队")),
        h("div", { style: { ...S.meta, fontSize: 10 } },
          "仅文本：子代理会话不支持图片等多模态输入（SUBAGENT_IMAGE_UNSUPPORTED）",
          note ? " ｜ " + note : ""),
      );
    }

    // 最近会话记录：api.subagents.history（无父会话时退化 api.sessions.history）
    function RecentRecords(props) {
      const [state, setState] = React.useState({ loading: true });
      React.useEffect(() => {
        let alive = true;
        const loadHistory = async () => {
          try {
            if (connectionRt?.api?.subagents?.history && props.parentId) {
              const r = await connectionRt.api.subagents.history({
                parentSessionId: props.parentId, childSessionId: props.childId,
                mode: props.mode ?? "continuable", maxMessages: 30,
              });
              if (!alive) return;
              if (r?.result?.ok) { setState({ loading: false, entries: r.result.value.events }); return; }
            }
            if (connectionRt?.api?.sessions?.history && props.childId) {
              const r = await connectionRt.api.sessions.history({ sessionId: props.childId, maxMessages: 30 });
              if (!alive) return;
              if (r?.result?.ok) { setState({ loading: false, entries: r.result.value.events }); return; }
            }
            if (!alive) return;
            setState({ loading: false, entries: [] });
          } catch (e) {
            if (alive) setState({ loading: false, error: String(e?.message ?? e) });
          }
        };
        loadHistory();
        return () => { alive = false; };
      }, [props.parentId, props.childId]);

      const entryText = (entry) => {
        const ev = entry?.event ?? {};
        const d = ev.data ?? {};
        if (ev.type === "user/message" || ev.type === "assistant/message") {
          const parts = (Array.isArray(d.content) ? d.content : [])
            .map((b) => b.type === "text" ? b.text
              : b.type === "reasoning" ? "💭" + String(b.text ?? "").slice(0, 120)
              : "[" + (b.type ?? "?") + "]")
            .join("");
          return (ev.type === "user/message" ? "🧑 " : "🤖 ") + (parts.trim().slice(0, 400) || "（空消息）");
        }
        if (ev.type === "assistant/tool-call") return "🔧 " + (d.name ?? "tool");
        return "· " + (ev.type ?? "未知事件");
      };

      let body;
      if (state.loading) body = "读取中…";
      else if (state.error) body = "读取失败：" + state.error;
      else if (!state.entries.length) body = "（无记录）";
      else body = state.entries.slice(-12).map((e, i) =>
        h("div", { key: i, style: S.recordItem }, entryText(e)));
      return h("div", { style: { marginTop: 4, fontSize: 12 } }, body);
    }

    // 当前模型查询（api.sessions.models，无投影走 RPC；30s 轮询）。
    // origin=subagent 的子会话被 host 围栏拒绝（agent-busy: owned by subagent routing，
    // dsh-api-remotes 源码级设计），此时退化查询父会话并标注 fromParent。
    // 查询某会话的当前模型选择。
    // g-109 判据反馈：子代理会话的 models 查询常失败（continuable idle 后无 live agent），
    // 旧逻辑回退父会话会把「父会话模型」冒充子代理实际模型（如用 flash 派发却显示 v4-pro），
    // 误导负责人。现改为失败即报错，由调用方用「重新执行指定路由」或「查询不可用」兜底。
    // g-194: 格式化模型展示文案，优雅降级，绝不向用户展示 owned by subagent routing 等内部错误
    function formatModelDisplay(dynamicModel, staticProvider, staticModel, staticRoute, relaunchRoute, modelErr) {
      if (dynamicModel && dynamicModel.model) {
        const p = dynamicModel.provider ? `${dynamicModel.provider}/` : "";
        return `${p}${dynamicModel.model}` + (dynamicModel.fromParent ? "（父会话，子代理继承）" : "");
      }
      if (staticProvider || staticModel) {
        if (staticProvider && staticModel) return `${staticProvider}/${staticModel}`;
        if (staticModel) return `${staticModel}（继承/默认 provider）`;
        return `${staticProvider}（继承/默认 model）`;
      }
      if (staticRoute) {
        return staticRoute;
      }
      if (relaunchRoute) {
        return `按重新执行指定：${relaunchRoute}`;
      }
      if (modelErr) {
        // 如果包含内部 routing 错误或私有 session 错误，转为安全的“默认配置/未指定”或“会话已隔离”
        if (typeof modelErr === "string" && (modelErr.includes("owned by subagent routing") || modelErr.includes("agent-busy") || modelErr.includes("session"))) {
          return "默认配置/未指定";
        }
        return "不可用：" + modelErr;
      }
      return "默认配置/未指定";
    }

    function formatShortModelDisplay(dynamicModel, staticProvider, staticModel, staticRoute, relaunchRoute) {
      if (dynamicModel && dynamicModel.model) return dynamicModel.model;
      if (staticModel) return staticModel;
      if (staticRoute) return String(staticRoute).split("/").pop();
      if (relaunchRoute) return "重派:" + String(relaunchRoute).split("/").pop();
      return null;
    }

    // 完整实时面板（抽屉/详情用）：实时条 + 模型 + 直达指令 + 最近记录。
    function useSessionModel(sessionId, parentId) {
      const [model, setModel] = React.useState(null); // {provider, model, fromParent}
      const [modelErr, setModelErr] = React.useState(null);
      React.useEffect(() => {
        if (!sessionId) return;
        let alive = true;
        const load = async () => {
          try {
            if (connectionRt?.api?.sessions?.models) {
              const r = await connectionRt.api.sessions.models({ sessionId });
              if (!alive) return;
              if (r?.result?.ok) {
                setModel({ ...(r.result.value.current ?? {}), fromParent: false });
                setModelErr(null);
                return;
              } else {
                setModel(null);
                setModelErr(r?.result?.error?.message ?? "查询失败");
                return;
              }
            }
            if (!alive) return;
            setModel(null);
            setModelErr(null);
          } catch (e) {
            if (alive) { setModel(null); setModelErr(String(e?.message ?? e)); }
          }
        };
        load();
        const t = setInterval(load, 30000);
        return () => { alive = false; clearInterval(t); };
      }, [sessionId, parentId]);
      return { model, modelErr };
    }

    // 完整实时面板（抽屉/详情用）：实时条 + 模型 + 直达指令 + 最近记录。
    // collapsible=true 时默认折叠，点击标题行展开；折叠态标题行内联显示状态/token/模型摘要。
    // g-109 判据反馈：实时会话控件中的「重新执行」——选择 provider/model 重新拉一个子代理。
    // kind="exec" → start-execution（目标执行子代理）；kind="collect" → start-collection（卡片收集子代理，需 cardId+prompt）。
    // 下拉数据源 = spawn-options 的 modelGroups（LLM provider 分组目录）；subagent provider（spawn/fork）不暴露给用户。
    function ReExecBox(props) {
      const { goalId, kind, cardId, prompt } = props;
      const [opts, setOpts] = React.useState(null); // {modelGroups, default}
      const [provider, setProvider] = React.useState("");
      const [model, setModel] = React.useState("");
      const [note, setNote] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        fetch(graphUrl("/api/dsh-graph/spawn-options"))
          .then((r) => r.json())
          .then((d) => {
            if (!alive) return;
            setOpts(d);
            // g-109 判据反馈：默认 = project.yaml executor（spawn-options.default）；
            // provider 不在目录 → 选第一个；model 默认取 project.yaml，若不在所选 provider
            // 的模型清单 → 选该清单第一个（不再出现「模型写死」且 provider/model 失配）。
            const groups = d?.modelGroups ?? [];
            const defP = d?.default?.provider ?? "";
            const defM = d?.default?.model ?? "";
            const effProvider = groups.some((g) => g.id === defP) ? defP : (groups[0]?.id ?? "");
            const g0 = groups.find((x) => x.id === effProvider);
            const ms = g0?.models ?? [];
            const effModel = ms.some((m) => m.id === defM) ? defM : (ms[0]?.id ?? "");
            setProvider(effProvider);
            setModel(effModel);
          })
          .catch(() => alive && setOpts({ modelGroups: null, default: null }));
        return () => { alive = false; };
      }, []);

      const groups = opts?.modelGroups ?? [];
      const currentGroup = groups.find((g) => g.id === provider) ?? null;
      const modelChoices = currentGroup?.models ?? [];

      const relaunch = async () => {
        setBusy(true);
        setNote("重新派发中…");
        try {
          const url = kind === "collect" ? "/api/dsh-graph/start-collection" : "/api/dsh-graph/start-execution";
          const body = { goal: goalId, provider: provider || undefined, model: model || undefined };
          if (kind === "collect") { body.card = cardId; body.prompt = prompt; }
          const r = await fetch(graphUrl(url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            if (data.child_id) {
              const route = data.model_route ? `（${data.model_route}）` : "";
              setNote("✅ 已重新派发子代理，id：" + data.child_id + " " + route);
              showToast("✅ 已重新派发子代理 " + route);
              if (data.model_route) props.onRelaunched?.(data.model_route);
            } else {
              setNote("⚠️ 子代理启动失败：" + (data.child_error || "无 child_id"));
            }
          } else {
            setNote("⚠️ 派发失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setBusy(false);
      };

      const selStyle = S.select;
      const optStyle = S.selectOption;
      const defP = opts?.default?.provider ?? "";
      const defM = opts?.default?.model ?? "";
      // 无模型目录（llm 服务不可用）：只显示默认模型 + 提示，仍可重新派发（走 project.yaml 默认）
      const noCatalog = !groups.length;
      return h("div", { style: { marginTop: 6, display: "flex", flexDirection: "column", gap: 4 } },
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
          h("span", { style: { ...S.meta, fontSize: 11 } }, "🔄 重新派发子代理："),
          noCatalog
            ? h("span", { style: { ...S.meta, fontSize: 11 } },
                defP ? `模型 ${defP}/${defM}` : "模型目录不可用")
            : [
                h("select", {
                  style: selStyle, value: provider,
                  className: "dg-select",
                  title: "LLM provider（缺省 project.yaml executor.provider）",
                  onChange: (e) => { setProvider(e.target.value); setModel(""); },
                },
                  groups.map((g) => h("option", { key: g.id, value: g.id, style: optStyle }, g.name ?? g.id))),
                h("select", {
                  style: selStyle, value: model,
                  className: "dg-select",
                  disabled: !modelChoices.length,
                  title: "模型（缺省 project.yaml executor.model）",
                  onChange: (e) => setModel(e.target.value),
                },
                  !modelChoices.length
                    ? h("option", { value: defM, style: optStyle }, defM ? `默认 ${defM}` : "model 不可用")
                    : [h("option", { key: "", value: "", style: optStyle }, "默认"),
                       ...modelChoices.map((m) => h("option", { key: m.id, value: m.id, style: optStyle }, m.name ?? m.id))]),
              ],
          h("button", {
            style: { ...S.btn, padding: "3px 10px", fontSize: 12 }, className: "dg-btn dg-relaunch",
            disabled: busy, onClick: relaunch,
          }, busy ? "派发中…" : (kind === "collect" ? "🔄 重新收集" : "🔄 重新执行"))),
        note ? h("div", { style: { ...S.meta, marginTop: 2 } }, note) : null,
      );
    }

    function SessionPanel(props) {
      const collapsible = !!props.collapsible;
      const [open, setOpen] = React.useState(!collapsible);
      const { session, mode } = useBoundSession(props.parentId, props.childId);
      const snap = useSessionSnapshot(session);
      const usage = useProjectionValue(session, "tokenUsage");
      const pressure = useProjectionValue(session, "contextPressure");
      const { model, modelErr } = useSessionModel(props.childId, props.parentId);
      const [showRecords, setShowRecords] = React.useState(false);

      const running = !!(snap && snap.running);
      const meter = liveMeter(usage, pressure);
      const statusLine = props.statusLine ?? null;
      const statusLabel = running ? "🟢 运行中" : "⚪ 空闲";
      // g-109 判据反馈：sessions.models 对子代理查询失败时，用「重新执行指定路由」兜底（绝不用父会话模型冒充）
      // g-194: 优先消费服务端下发的静态 provider / model / model_route，消除 subagent routing 报错
      const relaunchRoute = props.relaunchRoute ?? null;
      const staticProvider = props.provider ?? null;
      const staticModel = props.model ?? null;
      const staticRoute = props.modelRoute ?? null;
      const modelText = formatModelDisplay(model, staticProvider, staticModel, staticRoute, relaunchRoute, modelErr);
      const shortModel = formatShortModelDisplay(model, staticProvider, staticModel, staticRoute, relaunchRoute);
      // 折叠态标题行的内联摘要：状态 + statusLine + token/ctx + 模型短名
      const collapsedBits = [
        statusLabel,
        statusLine ? (running ? "⏳ " : "✅ ") + statusLine : null,
        meter || null,
        shortModel,
      ].filter(Boolean).join(" ｜ ");
      return h(
        "div",
        { style: S.livePanel },
        h("div", {
            style: { ...S.drawerH, display: "flex", alignItems: "center", gap: 6,
                     cursor: collapsible ? "pointer" : "default", userSelect: "none" },
            title: collapsible ? (open ? "点击收起" : "点击展开") : undefined,
            onClick: collapsible ? () => setOpen(!open) : undefined,
          },
          h("span", { style: { flexShrink: 0 } },
            (collapsible ? (open ? "▾ " : "▸ ") : "") + "📡 实时会话"),
          collapsible && !open
            ? h("span", { style: { ...S.meta, fontSize: 11, flex: 1, minWidth: 0,
                                   overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                collapsedBits || "（无状态）")
            : h("span", { style: { flex: 1 } }),
          sessionLinkBtn(props.parentId, props.childId, "↗ 转到对话")),
        !open ? null : [
          h(LiveStrip, { key: "s", parentId: props.parentId, childId: props.childId,
                         provider: staticProvider, model: staticModel,
                         statusLine }),
          h("div", { key: "m", style: { ...S.meta, marginTop: 3 } },
            "模型：" + modelText
            + (mode ? ` ｜ 模式：${mode === "continuable" ? "可续轮" : "一次性"}` : "")),
          h(PromptBox, { key: "p", parentId: props.parentId, childId: props.childId }),
          // g-109 判据反馈：实时会话控件内「重新执行」——子代理出错/无法运行时换 provider/model 重拉
          props.goalId
            ? h(ReExecBox, { key: "rx", goalId: props.goalId, kind: props.relaunchKind ?? "exec",
                             cardId: props.relaunchCardId, prompt: props.relaunchPrompt,
                             onRelaunched: props.onRelaunched })
            : null,
          h("div", { key: "r", style: { marginTop: 6 } },
            h("button", {
              style: S.btn, className: "dg-btn",
              onClick: () => setShowRecords(!showRecords),
            }, showRecords ? "▾ 收起最近记录" : "▸ 查看最近会话记录")),
          showRecords
            ? h(RecentRecords, { key: "rr", parentId: props.parentId, childId: props.childId, mode })
            : null,
        ],
      );
    }

    // g-108 看板顶部 supervisor 状态栏：复用 LiveStrip（运行/空闲、最新流式行、tok/ctx）
    // + 模型名（useSessionModel，顶层会话直接查）+ 一键跳转主管对话。
    // 会话 id 来自 board 端点下发的 supervisorSession（project.yaml），不硬编码。
    // g-a92e1406 判据 3① 扩展：statusLine 传 supervisor 自己的 status_line（事件流最新一条），
    // 运行中由 LiveStrip 走 StatusLine 带动画（流动背景 + 图标 pulse）。
