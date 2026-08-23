    // 流式时有时无不再引起高度变化）；status_line + tok/ctx 放 tooltip（悬浮查看）。
    function LiveStrip(props) {
      const { session } = useBoundSession(props.parentId, props.childId);
      const snap = useSessionSnapshot(session);
      const usage = useProjectionValue(session, "tokenUsage");
      const pressure = useProjectionValue(session, "contextPressure");
      if (!props.childId) return null;
      if (!session) {
        return h("div", { style: S.liveStrip, title: props.childId },
          "🔌 会话未接入（不在会话列表）：" + props.childId.slice(0, 8));
      }
      const running = !!(snap && snap.running);
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
      const line = snap && snap.chat ? lastStreamLine(snap.chat.legacy.partial) : null;
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
      return h(
        "div",
        { style: S.liveStrip, title: [statusFull, props.statusLine ? "状态：" + props.statusLine : null, meter ? "资源：" + meter : null, line ? "流式：" + line : null].filter(Boolean).join("\n") },
        // 第一行：状态 + 流式内容（同行）；右侧有空间时显示 tok/ctx（flex 布局自动压缩）
        h("div", { style: { display: "flex", alignItems: "center", gap: 5 } },
          h("span", { style: { color: running ? "#3aa675" : "rgba(128,128,128,.9)", flexShrink: 0 } },
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
              title: props.statusLine ? props.statusLine + (staleDur ? "（状态已延续 " + staleDur + "）" : "") : undefined,
            }, statusRowText)
          : null,
      );
    }

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
        if (!connectionRt) { setState({ loading: false, error: "connection 服务不可用" }); return; }
        let alive = true;
        const call = props.parentId
          ? connectionRt.api.subagents.history({
              parentSessionId: props.parentId, childSessionId: props.childId,
              mode: props.mode ?? "continuable", maxMessages: 30,
            })
          : connectionRt.api.sessions.history({ sessionId: props.childId, maxMessages: 30 });
        call
          .then((r) => alive && setState(r?.result?.ok
            ? { loading: false, entries: r.result.value.events }
            : { loading: false, error: r?.result?.error?.message ?? "读取失败" }))
          .catch((e) => alive && setState({ loading: false, error: String(e?.message ?? e) }));
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
    function useSessionModel(sessionId, parentId) {
      const [model, setModel] = React.useState(null); // {provider, model, fromParent}
      const [modelErr, setModelErr] = React.useState(null);
      React.useEffect(() => {
        if (!sessionId || !connectionRt) return;
        let alive = true;
        const load = async () => {
          try {
            const r = await connectionRt.api.sessions.models({ sessionId });
            if (!alive) return;
            if (r?.result?.ok) {
              setModel({ ...(r.result.value.current ?? {}), fromParent: false });
              setModelErr(null);
            } else {
              setModel(null);
              setModelErr(r?.result?.error?.message ?? "查询失败");
            }
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

      const selStyle = {
        fontSize: 12, padding: "2px 6px", cursor: "pointer", maxWidth: 160,
        background: "rgba(128,128,128,.10)", color: "inherit",
        border: "1px solid rgba(128,128,128,.35)", borderRadius: 4,
      };
      // 深色主题：浏览器原生 option 默认白底，下拉展开时突兀 → 显式深色底
      const optStyle = { background: "#2a2b31", color: "#e6e6e6" };
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
                  title: "LLM provider（缺省 project.yaml executor.provider）",
                  onChange: (e) => { setProvider(e.target.value); setModel(""); },
                },
                  groups.map((g) => h("option", { key: g.id, value: g.id, style: optStyle }, g.name ?? g.id))),
                h("select", {
                  style: selStyle, value: model,
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
      const relaunchRoute = props.relaunchRoute ?? null;
      const modelText = model
        ? `${model.provider}/${model.model}` + (model.fromParent ? "（父会话，子代理继承）" : "")
        : relaunchRoute ? `按重新执行指定：${relaunchRoute}` : modelErr ? "不可用：" + modelErr : "查询中…";
      // 折叠态标题行的内联摘要：状态 + statusLine + token/ctx + 模型短名
      const collapsedBits = [
        statusLabel,
        statusLine ? (running ? "⏳ " : "✅ ") + statusLine : null,
        meter || null,
        model ? model.model : relaunchRoute ? "重派:" + String(relaunchRoute).split("/").pop() : null,
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
