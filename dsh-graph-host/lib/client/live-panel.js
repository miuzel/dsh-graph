    let reExecModeInstanceSeq = 0;
    // 看板直达指令：向 continuable 子代理发文本（queue 排队 / steer 插队）。
    // 多模态降级：子代理图片源码级不支持（SUBAGENT_IMAGE_UNSUPPORTED）——明确提示而非静默失败。
    function PromptBox(props) {
      const { session, mode } = useBoundSession(props.parentId, props.childId);
      const [text, setText] = React.useState("");
      const [note, setNote] = React.useState(null);
      if (!props.childId || !session) return null;
      if (mode === "one-shot") {
        return h("div", { style: { ...S.meta, marginTop: 3 } },
          dgT("live.readOnly"));
      }
      const send = async (sendMode) => {
        const t = text.trim();
        if (!t) return;
        setNote(dgT("common.sending"));
        try {
          // session.prompt：continuable 子代理自动路由 api.subagents.prompt（仅文本）
          const res = await session.prompt([{ type: "text", text: t }], sendMode);
          if (res?.ok) {
            setText("");
            setNote(sendMode === "steer" ? dgT("common.sent") : dgT("common.sent"));
          } else {
            const err = res?.error ?? {};
            const reason = String(err?.details?.reason ?? err?.code ?? "");
            if (reason.includes("SUBAGENT_IMAGE_UNSUPPORTED"))
              setNote(dgT("live.textOnly"));
            else setNote(dgT("criteria.feedbackSendFail") + (err?.message ?? reason ?? dgT("drag.unknownError")));
          }
        } catch (e) {
          setNote(dgT("drag.requestFail") + (e?.message ?? e));
        }
      };
      return h(
        "div",
        { style: S.promptBox, onClick: (e) => e.stopPropagation() },
        h("div", { style: S.promptRow },
          h("input", {
            style: S.promptInput,
            value: text,
            placeholder: dgT("live.promptPlaceholder"),
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") send("queue"); },
          }),
          h("button", {
            style: { ...S.btn, flexShrink: 0 }, className: "dg-btn",
            title: dgT("live.queueTooltip"), onClick: () => send("queue"),
          }, dgT("live.queue")),
          h("button", {
            style: { ...S.btn, flexShrink: 0 }, className: "dg-btn",
            title: dgT("live.steerTooltip"), onClick: () => send("steer"),
          }, dgT("live.steer"))),
        h("div", { style: { ...S.meta, fontSize: 10 } },
          dgT("live.textOnly"),
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
          return (ev.type === "user/message" ? "🧑 " : "🤖 ") + (parts.trim().slice(0, 400) || dgT("live.emptyMessage"));
        }
        if (ev.type === "assistant/tool-call") return "🔧 " + (d.name ?? "tool");
        return dgT("live.unknownEvent") + " " + (ev.type ?? "");
      };

      let body;
      if (state.loading) body = dgT("live.reading");
      else if (state.error) body = dgT("live.readFailed") + state.error;
      else if (!state.entries.length) body = dgT("live.noRecords");
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
        return `${p}${dynamicModel.model}` + (dynamicModel.fromParent ? " (" + dgT("live.inherited") + ")" : "");
      }
      if (staticProvider || staticModel) {
        if (staticProvider && staticModel) return `${staticProvider}/${staticModel}`;
        if (staticModel) return `${staticModel} (" + dgT("live.inheritProvider") + ")`;
        return `${staticProvider} (" + dgT("live.inheritModel") + ")`;
      }
      if (staticRoute) {
        return staticRoute;
      }
      if (relaunchRoute) {
        return dgT("live.relaunchSpecified") + relaunchRoute;
      }
      if (modelErr) {
        // 如果包含内部 routing 错误或私有 session 错误，转为安全的“默认配置/未指定”或“会话已隔离”
        if (typeof modelErr === "string" && (modelErr.includes("owned by subagent routing") || modelErr.includes("agent-busy") || modelErr.includes("session"))) {
          return dgT("live.defaultConfig");
        }
        return dgT("live.unavailable") + modelErr;
      }
      return dgT("live.defaultConfig");
    }

    function formatShortModelDisplay(dynamicModel, staticProvider, staticModel, staticRoute, relaunchRoute) {
      if (dynamicModel && dynamicModel.model) return dynamicModel.model;
      if (staticModel) return staticModel;
      if (staticRoute) return String(staticRoute).split("/").pop();
      if (relaunchRoute) return dgT("live.relaunchShort") + String(relaunchRoute).split("/").pop();
      return null;
    }

    // 当前模型来自 sessions.binding(sessionId).session 的 modelSelection 投影。
    // 旧版 api.sessions.models 已从 Host 移除；缺少该 API 时不能保持“查询中”假状态。
    function useSessionModel(sessionId, parentId) {
      const binding = React.useMemo(() => {
        if (!sessionsRt || !sessionId) return null;
        try { return sessionsRt.binding(sessionId) ?? null; }
        catch { return null; }
      }, [sessionId]);
      const selection = useProjectionValue(binding?.session ?? null, "modelSelection");
      const current = selection?.next ?? selection?.lastUsed ?? null;
      return {
        model: current ? { provider: current.provider, model: current.model } : null,
        modelErr: selection === undefined ? dgT("live.modelUnavailable") : null,
      };
    }

    // 完整实时面板（抽屉/详情用）：实时条 + 模型 + 直达指令 + 最近记录。
    // collapsible=true 时默认折叠，点击标题行展开；折叠态标题行内联显示状态/token/模型摘要。
    // g-109 判据反馈：实时会话控件中的「重新执行」——选择 provider/model 重新拉一个子代理。
    // kind="exec" → start-execution（目标执行子代理）；kind="collect" → start-collection（卡片收集子代理，需 cardId+prompt）。
    // 下拉数据源 = spawn-options 的 modelGroups（LLM provider 分组目录）；subagent provider（spawn/fork）不暴露给用户。
    function ReExecBox(props) {
      const modeIdRef = React.useRef(null);
      if (modeIdRef.current == null) modeIdRef.current = `dg-reexec-subagent-mode-${++reExecModeInstanceSeq}`;
      const modeId = modeIdRef.current;
      const { goalId, kind, cardId, prompt } = props;
      const [opts, setOpts] = React.useState(null); // {modelGroups, default}
      const [provider, setProvider] = React.useState("");
      const [model, setModel] = React.useState("");
      const [mode, setMode] = React.useState("");
      const [isolateWorktree, setIsolateWorktree] = React.useState(() => defaultWorktreeForGoalType(props.goalType));
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
            const defMode = d?.default?.mode ?? "";
            setProvider(effProvider);
            setModel(effModel);
            setMode(defMode);
          })
          .catch(() => alive && setOpts({ modelGroups: null, default: null }));
        return () => { alive = false; };
      }, []);

      const groups = opts?.modelGroups ?? [];
      const currentGroup = groups.find((g) => g.id === provider) ?? null;
      const modelChoices = currentGroup?.models ?? [];
      const modeList = opts?.modes ?? [
        { id: "standard", name: dgT("live.modeStandard") },
        { id: "minimal", name: dgT("live.modeMinimal") },
      ];

      const relaunch = async () => {
        setBusy(true);
        setNote(dgT("live.relaunching"));
        try {
          const url = kind === "collect" ? "/api/dsh-graph/start-collection" : "/api/dsh-graph/start-execution";
          const body = {
            goal: goalId,
            provider: provider || undefined,
            model: model || undefined,
            mode: mode || undefined,
          };
          if (kind === "collect") {
            body.card = cardId;
            body.prompt = prompt;
          } else {
            body.worktree = isolateWorktree;
          }
          const r = await fetch(graphUrl(url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            if (data.child_id) {
              const route = data.model_route ? `（${data.model_route}）` : "";
              const modeTag = data.mode ? `[${data.mode}]` : "";
              setNote(dgT("live.relaunched") + " " + modeTag + "，id：" + data.child_id + " " + route);
              showToast(dgT("live.relaunched") + " " + modeTag + " " + route);
              if (data.model_route) props.onRelaunched?.(data.model_route);
            } else {
              setNote(dgT("exec.childFailed") + (data.child_error || dgT("exec.childNotStarted")));
            }
          } else {
            setNote(dgT("exec.executeFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setNote(dgT("drag.requestFail") + String(e?.message ?? e));
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
          h("span", { style: { ...S.meta, fontSize: 11 } }, dgT("live.relaunch")),
          noCatalog
            ? h("span", { style: { ...S.meta, fontSize: 11 } },
                defP ? dgT("live.model") + `${defP}/${defM}` : dgT("live.modelUnavailable"))
            : [
                h("select", {
                  style: selStyle, value: provider,
                  className: "dg-select",
                  title: dgT("live.providerTooltip"),
                  onChange: (e) => { setProvider(e.target.value); setModel(""); },
                },
                  groups.map((g) => h("option", { key: g.id, value: g.id, style: optStyle }, g.name ?? g.id))),
                h("select", {
                  style: selStyle, value: model,
                  className: "dg-select",
                  disabled: !modelChoices.length,
                  title: dgT("live.modelTooltip"),
                  onChange: (e) => setModel(e.target.value),
                },
                  !modelChoices.length
                    ? h("option", { value: defM, style: optStyle }, defM ? dgT("live.defaultModel") + " " + defM : dgT("live.modelUnavailable"))
                    : [h("option", { key: "", value: "", style: optStyle }, dgT("live.defaultModel")),
                       ...modelChoices.map((m) => h("option", { key: m.id, value: m.id, style: optStyle }, m.name ?? m.id))]),
                kind !== "collect" ? h("select", {
                  id: modeId,
                  "aria-label": dgT("live.modeAria"),
                  style: selStyle, value: mode,
                  className: "dg-select",
                  title: dgT("live.modeTooltip"),
                  onChange: (e) => setMode(e.target.value),
                },
                  h("option", { key: "", value: "", style: optStyle }, dgT("live.modeDefault")),
                  ...modeList.map((m) => h("option", { key: m.id, value: m.id, style: optStyle }, m.name ?? m.id))) : null,
                kind !== "collect" ? h("label", {
                  style: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, cursor: "pointer", userSelect: "none" },
                },
                  h("input", {
                    type: "checkbox",
                    checked: isolateWorktree,
                    onChange: (e) => setIsolateWorktree(e.target.checked),
                    style: { cursor: "pointer" },
                  }),
                  h("span", null, dgT("exec.isolateWorktree")),
                ) : null,
              ],
          h("button", {
            style: { ...S.btn, padding: "3px 10px", fontSize: 12 }, className: "dg-btn dg-relaunch",
            disabled: busy, onClick: relaunch,
          }, busy ? dgT("drawer.dispatching") : (kind === "collect" ? dgT("live.recollect") : dgT("exec.execute")))),
        note ? h("div", { style: { ...S.meta, marginTop: 2 } }, note) : null,
      );
    }


    // g-190：解绑子代理组件（安全 detach）——确认 + reason + 错误反馈。
    // 仅目标 owner 界面（goal modal 详情）展示；子代理仍运行（snapshot running）时禁用并提示先受控停止。
    // 调用 /api/dsh-graph/unbind：goal + attempt（唯一 selector）+ 当前 binding token（CAS）；
    // 成功回调 onDetached 刷新详情与看板；失败展示服务端 error（409 = token/活跃冲突，400 = 校验/授权）。
    function UnbindChildBox(props) {
      const { goalId, attemptId, bindingToken, childId, running, onDetached } = props;
      const [confirm, setConfirm] = React.useState(false);
      const [reason, setReason] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null);
      const doUnbind = async () => {
        const isLegacy = !bindingToken;
        if (isLegacy && !reason.trim()) {
          setNote(dgT("live.unbindReasonLegacyRequired"));
          return;
        }
        setBusy(true);
        setNote(dgT("live.unbinding"));
        try {
          const body = {
            goal: goalId,
            attempt: attemptId,
            token: bindingToken || undefined,
            legacy: isLegacy ? true : undefined,
            reason: reason.trim() || undefined,
          };
          const r = await fetch(graphUrl("/api/dsh-graph/unbind"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            setNote(dgT("live.unboundSuccess"));
            showToast(dgT("live.unbound"));
            setConfirm(false);
            onDetached?.();
          } else {
            setNote(dgT("live.unbindFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setNote(dgT("drag.requestFail") + String(e?.message ?? e));
        }
        setBusy(false);
      };
      if (!confirm) {
        return h(
          "div",
          { style: { marginTop: 4, display: "flex", alignItems: "center", gap: 6 } },
          h("button", {
            style: { ...S.btnDanger, padding: "2px 8px", fontSize: 11 },
            className: "dg-btn-danger",
            onClick: () => { setConfirm(true); setNote(null); },
            title: dgT("live.unbindTooltip"),
          }, dgT("live.unbind")),
          note ? h("span", { style: { ...S.meta, fontSize: 11 } }, note) : null,
        );
      }
      return h(
        "div",
        { style: { marginTop: 6, padding: "6px 8px", borderRadius: 4, background: "rgba(224,165,58,.08)", border: "1px solid rgba(224,165,58,.3)" } },
        h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-warn-label, #e0a53a)", fontWeight: 600, marginBottom: 4 } },
          dgT("live.unbindPrompt") + " " + (childId ? String(childId).slice(0, 8) : "") + "？"),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("input", {
            style: { ...S.promptInput, fontSize: 11 },
            value: reason,
            placeholder: dgT("live.unbindReason"),
            onChange: (e) => setReason(e.target.value),
          }),
          running
            ? h("div", { style: { fontSize: 11, color: "var(--dsw-alias-state-error-primary, #d66)" } },
                dgT("live.unbindRunning"))
            : null,
          h("div", { style: { display: "flex", gap: 6, marginTop: 2 } },
            h("button", {
              style: { ...S.btnDanger, padding: "2px 10px", fontSize: 11 },
              className: "dg-btn-danger",
              disabled: busy || running,
              onClick: doUnbind,
            }, busy ? dgT("live.unbinding") : dgT("live.unbindConfirm")),
            h("button", {
              style: { ...S.btn, padding: "2px 8px", fontSize: 11 },
              className: "dg-btn",
              onClick: () => { setConfirm(false); setNote(null); },
            }, dgT("common.cancel")))),
        note ? h("div", { style: { ...S.meta, marginTop: 4, fontSize: 11 } }, note) : null,
      );
    }

    function SessionPanel(props) {
      useLocaleRevision();
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
      const statusLabel = running ? "🟢 " + dgT("status.running") : "⚪ " + dgT("status.idle");
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
        statusLine ? formatStatusWithLifecycle(statusLine, running, false, props.statusState).fullText : null,
        meter || null,
        shortModel,
      ].filter(Boolean).join(" ｜ ");
      return h(
        "div",
        { style: S.livePanel },
        h("div", {
            style: { ...S.drawerH, display: "flex", alignItems: "center", gap: 6,
                     cursor: collapsible ? "pointer" : "default", userSelect: "none" },
            title: collapsible ? (open ? dgT("live.collapse") : dgT("live.expand")) : undefined,
            onClick: collapsible ? () => setOpen(!open) : undefined,
          },
          h("span", { style: { flexShrink: 0 } },
            (collapsible ? (open ? "▾ " : "▸ ") : "") + dgT("live.title")),
          collapsible && !open
            ? h("span", { style: { ...S.meta, fontSize: 11, flex: 1, minWidth: 0,
                                   overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                collapsedBits || dgT("live.noStatus"))
            : h("span", { style: { flex: 1 } }),
          sessionLinkBtn(props.parentId, props.childId, dgT("live.goToChat"))),
        !open ? null : [
          h(LiveStrip, { key: "s", parentId: props.parentId, childId: props.childId,
                         provider: staticProvider, model: staticModel,
                         statusLine }),
          h("div", { key: "m", style: { ...S.meta, marginTop: 3 } },
            dgT("live.model") + modelText
            + (props.subagentMode ? ` ｜ ${dgT("live.executionMode")} ${props.subagentMode}` : "")
            + (mode ? ` ｜ ${dgT("live.sessionMode")} ${mode === "continuable" ? dgT("live.continuable") : dgT("live.oneShot")}` : "")),
          h(PromptBox, { key: "p", parentId: props.parentId, childId: props.childId }),
          // g-109 判据反馈：实时会话控件内「重新执行」——子代理出错/无法运行时换 provider/model 重拉
          props.goalId
            ? h(ReExecBox, { key: "rx", goalId: props.goalId, kind: props.relaunchKind ?? "exec",
                             cardId: props.relaunchCardId, prompt: props.relaunchPrompt,
                             onRelaunched: props.onRelaunched })
            : null,
          // g-190：目标执行 attempt 的解绑控件（带 binding token / attemptId / running 状态）
          props.goalId && props.attemptId && props.bindingToken
            ? h(UnbindChildBox, {
                key: "ub",
                goalId: props.goalId,
                attemptId: props.attemptId,
                bindingToken: props.bindingToken,
                childId: props.childId,
                running,
                onDetached: props.onDetached,
              })
            : null,
          h("div", { key: "r", style: { marginTop: 6 } },
            h("button", {
              style: S.btn, className: "dg-btn",
              onClick: () => setShowRecords(!showRecords),
            }, showRecords ? "▾ " + dgT("live.recordsCollapse") : "▸ " + dgT("live.records"))),
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

    // Source contract: aria-label": "重新执行子代理模式".
    // Contract marker: aria-label": "重新执行子代理模式"; 执行模式
