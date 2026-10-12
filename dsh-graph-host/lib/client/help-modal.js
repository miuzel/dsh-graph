    // ===== g-481：「使用说明」弹窗 =====
    // 看板标题栏原「🧩 Graph 设计」入口升格为「📖 使用说明」；原独立的「Graph 设计」弹窗**不再是
    // 独立入口**，它的两张交互图成为本弹窗的第 5 个页签（图部分逐字沿用 g-462 的实现）。
    // 五个页签：使用说明 / 提示词模板 / 工具清单 / 常见问题 / Graph 设计。
    //
    // 单一真源（不新增平行硬编码清单）：
    //   · 版本号 = constants.js 的 PLUGIN_VERSION（本模块不写任何版本字面量）；
    //   · 工具清单 / 提示词资产清单 = 宿主 `/api/dsh-graph/help/catalog`（注册真源投影）——
    //     本模块**不硬编码任何工具名或资产名**，只为资产配 i18n 展示标签（缺标签则回退资产基名，
    //     故宿主新增资产时界面上仍可见，不会静默丢项）；
    //   · 提示词资产正文 = 宿主只读路由 `/api/dsh-graph/help/asset/<name>`（随包产物同源，只读）。
    // 本模块位于工厂作用域（build-client.sh 中排在 drag-prompts 之前）⇒ 组件身份稳定：
    // 切页签或父级重渲染都不会卸载重建子树，Graph 页签的 iframe 因此不会反复重载。
    const HELP_TABS = [
      { key: "usage", labelKey: "help.tab.usage" },
      { key: "prompts", labelKey: "help.tab.prompts" },
      { key: "tools", labelKey: "help.tab.tools" },
      { key: "faq", labelKey: "help.tab.faq" },
      { key: "design", labelKey: "help.tab.design" },
    ];
    // Graph 页签：与 g-462 逐字一致的两张**随包发布**交互图（白名单同源，见宿主 DESIGN_DIAGRAM_FILES）。
    const DESIGN_DIAGRAM_TABS = [
      { key: "lifecycle", file: "design-philosophy.lifecycle.html", labelKey: "design.tab.lifecycle" },
      { key: "workflow", file: "design-philosophy.workflow.html", labelKey: "design.tab.workflow" },
    ];
    const HELP_ASSET_URL = "/api/dsh-graph/help/asset/";
    const HELP_CATALOG_URL = "/api/dsh-graph/help/catalog";
    // 「使用说明」页签的段落（顺序即阅读顺序；文案全部走 i18n，zh/en 对称）。
    const HELP_USAGE_KEYS = [
      "help.usage.what", "help.usage.board", "help.usage.flow",
      "help.usage.dispatch", "help.usage.review", "help.usage.tabs",
    ];
    // FAQ 项编号（只用于取 i18n 键与 React key，界面上不显示编号）。
    const HELP_FAQ_ITEMS = [1, 2, 3, 4, 5, 6, 7];
    // g-489：使用说明页签的**分模块章节**（顺序即展示顺序：看板/目标/版本管理/泳道/侧边栏/
    // 上下文卡片与项目知识库/记忆系统/子代理与 agent teams/常用设置）。每章三要素缺一即判红
    //（core/tests/g489-help-content.test.ts）。
    const HELP_MODULE_CHAPTERS = [
      "board", "goal", "version", "lane", "sidebar", "cards", "memory", "subagents", "settings",
    ];
    // 章内三要素：是什么 / 怎么用 / 关键操作（后缀 → 展示标签键）。
    const HELP_CHAPTER_FIELDS = [
      { key: "what", labelKey: "help.mod.what" },
      { key: "how", labelKey: "help.mod.how" },
      { key: "ops", labelKey: "help.mod.ops" },
    ];

    /** 资产展示标签：优先 i18n（`help.asset.<base>`）；缺键时回退到资产基名 ⇒ 新资产仍可见。 */
    function helpAssetLabel(base) {
      const key = "help.asset." + base;
      const label = dgT(key);
      return label === key ? base : label;
    }

    /** 宿主帮助目录（工具清单 + 资产清单 + 生效提示词语言）。只读 GET，失败给可读错误。 */
    function useHelpCatalog() {
      const [state, setState] = React.useState({ status: "loading", catalog: null, error: "" });
      React.useEffect(() => {
        let alive = true;
        fetch(HELP_CATALOG_URL, { headers: { accept: "application/json" } })
          .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
          .then((data) => { if (alive) setState({ status: "ready", catalog: data, error: "" }); })
          .catch((e) => { if (alive) setState({ status: "error", catalog: null, error: String(e?.message ?? e) }); });
        return () => { alive = false; };
      }, []);
      return state;
    }

    /** 目录里生效的资产语言（宿主按提示词语言设置解析；缺省中文，与引擎降级口径一致）。 */
    function helpCatalogLanguage(catalog) {
      return catalog && catalog.prompt_language === "en" ? "en" : "zh";
    }

    /** 目录条目里的双语字段取值（生效语言优先，缺该语言回落 zh；两者都缺给空串）。 */
    function helpCatalogText(field, lang) {
      if (!field || typeof field !== "object") return "";
      return field[lang] || field.zh || field.en || "";
    }

    /** g-489 入门第一步：先指定主管 Agent（技能名 + 接管这一步 + 可直接复制的示例提示词）。
     *  说明文案与示例提示词全部走 i18n（本模块不得出现任何工具名字面量）。 */
    function HelpEntryStep() {
      const [note, setNote] = React.useState("");
      const prompt = dgT("help.entry.prompt");
      React.useEffect(() => {
        if (!note) return undefined;
        const timer = setTimeout(() => setNote(""), 2400);
        return () => clearTimeout(timer);
      }, [note]);
      return h("div", {
        className: "dg-help-entry",
        style: {
          marginTop: 12, padding: "10px 12px", borderRadius: 6,
          background: "rgba(76,141,255,.10)", border: "1px solid rgba(76,141,255,.35)",
        },
      },
        h("div", { className: "dg-help-entry-title", style: { fontWeight: 700, fontSize: 13 } }, dgT("help.entry.title")),
        h("p", {
          className: "dg-help-p dg-help-entry-body",
          style: { margin: "6px 0 0", fontSize: 12.5, lineHeight: 1.75 },
        }, dgT("help.entry.body")),
        h("div", {
          style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 8 },
        },
          h("div", { className: "dg-help-entry-label", style: { ...S.meta, marginRight: "auto" } }, dgT("help.entry.promptLabel")),
          h("button", {
            className: "dg-btn dg-help-entry-copy",
            style: { ...S.btn, padding: "2px 10px", fontSize: 12 },
            onClick: async () => {
              // 复用工厂作用域既有的复制实现（Clipboard API + execCommand 回退），不新增第二套。
              const ok = await copyText(prompt);
              setNote(ok ? dgT("help.entry.copied") : dgT("help.entry.copyFail"));
            },
          }, dgT("help.entry.copy")),
          note
            ? h("span", { className: "dg-help-entry-note", style: S.meta }, note)
            : null),
        h("pre", {
          className: "dg-help-entry-prompt",
          style: {
            margin: "6px 0 0", padding: "8px 10px", borderRadius: 6, fontSize: 12, lineHeight: 1.7,
            whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit",
            background: "rgba(128,128,128,.10)",
          },
        }, prompt));
    }

    /** g-489 分模块章节：一章一块，三要素逐行标出（是什么 / 怎么用 / 关键操作）。 */
    function HelpModuleChapter(props) {
      const chapter = props.chapter;
      return h("div", {
        className: "dg-help-chapter",
        style: { marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(128,128,128,.22)" },
      },
        h("div", {
          className: "dg-help-chapter-title",
          style: { fontWeight: 700, fontSize: 13 },
        }, dgT("help.mod." + chapter + ".title")),
        ...HELP_CHAPTER_FIELDS.map((f) => h("div", {
          key: "help-mod-" + chapter + "-" + f.key,
          className: "dg-help-chapter-row dg-help-chapter-" + f.key,
          style: { display: "flex", gap: 8, marginTop: 4, fontSize: 12, lineHeight: 1.75 },
        },
          h("span", {
            className: "dg-help-chapter-label",
            style: { ...S.meta, flex: "0 0 56px", whiteSpace: "nowrap" },
          }, dgT(f.labelKey)),
          h("span", {
            className: "dg-help-chapter-text",
            style: { flex: "1 1 auto", minWidth: 0, opacity: 0.92 },
          }, dgT("help.mod." + chapter + "." + f.key)))));
    }

    function HelpUsageTab() {
      return h("div", { className: "dg-help-usage" },
        h("div", {
          className: "dg-help-version",
          style: { ...S.meta, marginBottom: 8 },
        }, dgT("help.version", { version: PLUGIN_VERSION })),
        ...HELP_USAGE_KEYS.map((key) => h("p", {
          key: "help-usage-" + key,
          className: "dg-help-p",
          style: { margin: "0 0 8px", fontSize: 13, lineHeight: 1.7 },
        }, dgT(key))),
        h(HelpEntryStep, { key: "help-entry-step" }),
        h("div", {
          className: "dg-help-mod-title",
          style: { fontWeight: 700, fontSize: 14, marginTop: 16 },
        }, dgT("help.mod.title")),
        h("p", {
          className: "dg-help-p dg-help-mod-intro",
          style: { margin: "4px 0 0", fontSize: 13, lineHeight: 1.7 },
        }, dgT("help.mod.intro")),
        ...HELP_MODULE_CHAPTERS.map((chapter) => h(HelpModuleChapter, {
          key: "help-chapter-" + chapter,
          chapter,
        })));
    }

    function HelpPromptsTab(props) {
      const state = props.catalogState || {};
      const catalog = state.catalog;
      const entries = (catalog && Array.isArray(catalog.prompts)) ? catalog.prompts : [];
      const hostLang = helpCatalogLanguage(catalog);
      const [pickedLang, setPickedLang] = React.useState(null);
      const [pickedAsset, setPickedAsset] = React.useState("");
      const [asset, setAsset] = React.useState({ status: "idle", text: "", error: "" });
      const lang = pickedLang ?? hostLang;
      const visible = entries.filter((e) => e.lang === lang);
      // 选中项若不在当前语言集合内（首次打开 / 切换语言后）⇒ 回落到该语言的第一项。
      const selected = visible.some((e) => e.name === pickedAsset) ? pickedAsset : ((visible[0] && visible[0].name) || "");
      const selectedEntry = visible.find((e) => e.name === selected) || null;
      React.useEffect(() => {
        if (!selected) return;
        let alive = true;
        setAsset({ status: "loading", text: "", error: "" });
        fetch(HELP_ASSET_URL + selected, { headers: { accept: "text/markdown" } })
          .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
          .then((text) => { if (alive) setAsset({ status: "ready", text, error: "" }); })
          .catch((e) => { if (alive) setAsset({ status: "error", text: "", error: String(e?.message ?? e) }); });
        return () => { alive = false; };
      }, [selected]);
      return h("div", { className: "dg-help-prompts" },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 } },
          h("div", { style: { ...S.meta, marginRight: "auto" } }, dgT("help.prompts.intro")),
          ...["zh", "en"].map((code) => h("button", {
            key: "help-lang-" + code,
            className: "dg-btn" + (code === lang ? " dg-btn-active" : ""),
            style: { ...(code === lang ? S.btnPrimary : S.btn), padding: "2px 10px", fontSize: 12 },
            onClick: () => setPickedLang(code),
          }, dgT("help.lang." + code)))),
        state.status === "loading"
          ? h("div", { className: "dg-help-loading", style: { ...S.meta, padding: "8px 0" } }, dgT("help.prompts.loading"))
          : state.status === "error"
            ? h("div", { className: "dg-help-error", style: { fontSize: 12, padding: "8px 0" } }, dgT("help.prompts.error", { error: String(state.error ?? "") }))
            : h("div", { style: { display: "flex", gap: 12, alignItems: "flex-start", minHeight: 0 } },
          h("div", {
            className: "dg-help-prompt-list",
            style: { flex: "0 0 170px", display: "flex", flexDirection: "column", gap: 4 },
          }, ...visible.map((e) => h("button", {
            key: "help-asset-" + e.name,
            className: "dg-btn" + (e.name === selected ? " dg-btn-active" : ""),
            style: { ...(e.name === selected ? S.btnPrimary : S.btn), textAlign: "left", padding: "4px 10px", fontSize: 12 },
            onClick: () => setPickedAsset(e.name),
          }, helpAssetLabel(e.base)))),
          h("div", { className: "dg-help-prompt-body", style: { flex: "1 1 auto", minWidth: 0 } },
            h("div", { style: { ...S.meta, marginBottom: 6 } },
              (selectedEntry ? helpAssetLabel(selectedEntry.base) + " · " : "") + dgT("help.prompts.source")),
            asset.status === "loading"
              ? h("div", { className: "dg-help-loading", style: { ...S.meta, padding: "8px 0" } }, dgT("help.prompts.loading"))
              : asset.status === "error"
                ? h("div", { className: "dg-help-error", style: { fontSize: 12, padding: "8px 0" } }, dgT("help.prompts.error", { error: asset.error }))
                : h("div", {
                  className: "dg-help-prompt-md",
                  style: { padding: "8px 10px", borderRadius: 6, background: "rgba(128,128,128,.06)" },
                }, h(GoalMarkdown, { text: asset.text })))));
    }

    /** g-489 工具清单页签：按宿主分类真源分**表格**呈现（简称 / 工具名 / 用途），每类一张表。
     *  分类、简称、用途全部来自 `/help/catalog`（本模块零硬编码工具名/分类名/简称）；
     *  宿主的结构守卫（分类表 ≡ 注册真源）报红时，页签顶部显示红条并列出红因。 */
    function HelpToolsTab(props) {
      const state = props.catalogState || {};
      const catalog = state.catalog;
      const tools = (catalog && Array.isArray(catalog.tools)) ? catalog.tools : [];
      const categories = (catalog && Array.isArray(catalog.categories)) ? catalog.categories : [];
      const problems = (catalog && Array.isArray(catalog.taxonomy_problems)) ? catalog.taxonomy_problems : [];
      const lang = helpCatalogLanguage(catalog);
      const thStyle = { textAlign: "left", fontSize: 12, fontWeight: 600, padding: "4px 8px 4px 0", borderBottom: "1px solid rgba(128,128,128,.35)" };
      const tdStyle = { fontSize: 12, lineHeight: 1.6, padding: "5px 8px 5px 0", verticalAlign: "top" };
      // 分类顺序来自宿主（不重排）；每类的行取自同一份 tools 投影。
      const groups = categories.map((c) => ({
        key: c.key,
        label: helpCatalogText(c.label, lang),
        rows: tools.filter((t) => t.category === c.key),
      }));
      // 未归类（分类键缺失/未登记）也必须可见 —— 不许静默丢项。
      const orphan = tools.filter((t) => !categories.some((c) => c.key === t.category));
      if (orphan.length) groups.push({ key: "__orphan__", label: dgT("help.tools.orphan"), rows: orphan });
      const body = state.status === "loading"
        ? [h("div", { key: "help-tools-loading", className: "dg-help-loading", style: { ...S.meta, padding: "8px 0" } }, dgT("help.tools.loading"))]
        : state.status === "error"
          ? [h("div", { key: "help-tools-error", className: "dg-help-error", style: { fontSize: 12, padding: "8px 0" } }, dgT("help.tools.error", { error: String(state.error ?? "") }))]
          : [
            problems.length
              ? h("div", {
                key: "help-tools-problems",
                className: "dg-help-tools-problems",
                style: {
                  fontSize: 12, lineHeight: 1.7, marginBottom: 8, padding: "6px 8px", borderRadius: 4,
                  color: "var(--dsw-alias-state-error-primary, #ff6b6b)",
                  background: "rgba(255,107,107,.12)", border: "1px solid rgba(255,107,107,.45)",
                },
              }, dgT("help.tools.problems") + " " + problems.join("；"))
              : null,
            ...groups.map((g) => h("div", {
              key: "help-tools-group-" + g.key,
              className: "dg-help-tools-group",
              style: { marginBottom: 12 },
            },
              h("div", {
                className: "dg-help-tools-group-title",
                style: { fontWeight: 600, fontSize: 12.5, marginBottom: 4, opacity: 0.95 },
              }, g.label + "（" + g.rows.length + "）"),
              h("table", {
                className: "dg-help-tools-table",
                style: { width: "100%", borderCollapse: "collapse" },
              },
                h("thead", null, h("tr", null,
                  h("th", { style: { ...thStyle, width: 96 } }, dgT("help.tools.colShort")),
                  h("th", { style: { ...thStyle, width: 210 } }, dgT("help.tools.colName")),
                  h("th", { style: thStyle }, dgT("help.tools.colUse")))),
                h("tbody", null, ...g.rows.map((t) => h("tr", {
                  key: "help-tool-" + t.name,
                  className: "dg-help-tool",
                },
                  h("td", {
                    className: "dg-help-tool-short",
                    style: { ...tdStyle, fontWeight: 600 },
                  }, helpCatalogText(t.short, lang)),
                  h("td", { style: tdStyle },
                    h("code", {
                      className: "dg-help-tool-name",
                      style: { fontSize: 12, fontWeight: 600 },
                    }, t.name)),
                  h("td", {
                    className: "dg-help-tool-desc",
                    style: { ...tdStyle, opacity: 0.9 },
                  }, helpCatalogText(t.description, lang)))))))),
          ];
      return h("div", { className: "dg-help-tools" },
        h("div", { style: { ...S.meta, marginBottom: 8 } },
          dgT("help.tools.intro", { count: String(tools.length) }) + " " + dgT("help.tools.langHint", { lang: dgT("help.lang." + lang) })),
        ...body);
    }

    function HelpFaqTab() {
      return h("div", { className: "dg-help-faq" },
        h("div", { style: { ...S.meta, marginBottom: 8 } }, dgT("help.faq.intro")),
        ...HELP_FAQ_ITEMS.map((n) => h("div", {
          key: "help-faq-" + n,
          className: "dg-help-faq-item",
          style: { marginBottom: 10 },
        },
          h("div", { style: { fontWeight: 600, fontSize: 13 } }, dgT("help.faq.q" + n)),
          h("div", { style: { fontSize: 12, lineHeight: 1.7, marginTop: 3, opacity: 0.9 } }, dgT("help.faq.a" + n)))));
    }

    /** Graph 页签：g-462 的设计哲学弹窗内容（notice → roadmap → 图页签 → iframe），只读展示。 */
    function HelpDesignTab() {
      const [tab, setTab] = React.useState("lifecycle");
      const active = DESIGN_DIAGRAM_TABS.find((t) => t.key === tab) ?? DESIGN_DIAGRAM_TABS[0];
      const src = "/api/dsh-graph/diagram/" + active.file;
      return h("div", {
        className: "dg-help-design",
        style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
      },
        // 如实声明（醒目）：暂不支持自定义；后续将开放 graph 语义调整与可视化自定义。
        h("div", {
          className: "dg-design-notice",
          style: {
            padding: "6px 8px", borderRadius: 4, fontSize: 12, flexShrink: 0,
            background: "rgba(224,165,58,.14)", border: "1px solid rgba(224,165,58,.4)",
          },
        }, dgT("design.notice")),
        // 后续路线（尚未实现）：独立小节 —— 不画进图里、也不新增页签。只指路设计哲学文档的
        // **章节名**，不用会随改版漂移的章节序号。
        h("div", {
          className: "dg-design-roadmap",
          style: {
            marginTop: 6, padding: "6px 8px", borderRadius: 4, fontSize: 12, flexShrink: 0,
            opacity: 0.85, border: "1px dashed rgba(128,128,128,.4)",
          },
        }, dgT("design.roadmap")),
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 10, flexShrink: 0 } },
          ...DESIGN_DIAGRAM_TABS.map((t) => h("button", {
            key: "design-tab-" + t.key,
            className: "dg-btn" + (t.key === active.key ? " dg-btn-active" : ""),
            style: { ...(t.key === active.key ? S.btnPrimary : S.btn), padding: "4px 12px", fontSize: 12 },
            onClick: () => setTab(t.key),
          }, dgT(t.labelKey))),
          h("a", {
            className: "dg-design-open",
            href: src,
            target: "_blank",
            rel: "noreferrer",
            style: { ...S.meta, marginLeft: "auto", whiteSpace: "nowrap" },
          }, dgT("design.openNewTab"))),
        h("div", {
          style: {
            flex: "1 1 auto", minHeight: 0, marginTop: 8, borderRadius: 6, overflow: "hidden",
            border: "1px solid rgba(128,128,128,.35)", background: "#fff",
          },
        },
          h("iframe", {
            key: "design-frame-" + active.key,
            className: "dg-design-frame",
            title: dgT("design.title") + " · " + dgT(active.labelKey),
            src,
            style: { display: "block", width: "100%", height: "100%", border: "none" },
          })));
    }

    function HelpModal(props) {
      useLocaleRevision();
      const { onClose } = props;
      // g-181：backdrop 误关保护（与其它弹窗同一 guard）
      const backdropGuard = useBackdropClose(onClose);
      const [tab, setTab] = React.useState("usage");
      const current = HELP_TABS.some((t) => t.key === tab) ? tab : "usage";
      // 目录只取一次，由「提示词模板」「工具清单」两个页签共享（同一份注册真源投影）。
      const catalogState = useHelpCatalog();
      return dgOverlay({ style: S.overlay, ...backdropGuard },
        h("div", {
          className: "dg-help-modal",
          style: {
            ...S.modal, width: "min(1080px, 94vw)", maxWidth: "94vw",
            height: "min(780px, 90vh)", maxHeight: "90vh",
            display: "flex", flexDirection: "column", overflow: "hidden", padding: "14px 16px",
          },
          onClick: (e) => e.stopPropagation(),
        },
          h("span", { className: "dg-close", style: S.close, onClick: onClose }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 15, flexShrink: 0 } }, dgT("help.title")),
          h("div", {
            className: "dg-help-tabs",
            style: { display: "flex", alignItems: "center", gap: 6, marginTop: 10, flexShrink: 0, flexWrap: "wrap" },
          }, ...HELP_TABS.map((t) => h("button", {
            key: "help-tab-" + t.key,
            className: "dg-btn" + (t.key === current ? " dg-btn-active" : ""),
            style: { ...(t.key === current ? S.btnPrimary : S.btn), padding: "4px 12px", fontSize: 12 },
            onClick: () => setTab(t.key),
          }, dgT(t.labelKey)))),
          h("div", {
            className: "dg-help-body",
            style: { flex: "1 1 auto", minHeight: 0, marginTop: 10, overflow: "auto" },
          },
            current === "usage" ? h(HelpUsageTab, { key: "help-tab-body-usage" })
              : current === "prompts" ? h(HelpPromptsTab, { key: "help-tab-body-prompts", catalogState })
                : current === "tools" ? h(HelpToolsTab, { key: "help-tab-body-tools", catalogState })
                  : current === "faq" ? h(HelpFaqTab, { key: "help-tab-body-faq" })
                    : h(HelpDesignTab, { key: "help-tab-body-design" }))));
    }
