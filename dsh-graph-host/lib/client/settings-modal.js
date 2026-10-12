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
        supervisor: {
          automation: auto,
          // g-440：Agent Teams 开关三态归一——真布尔 true/false 保留；null/未配置/畸形一律归一为
          // null（＝off）。归一后同态不产生假脏（判据 2），且绝不会把畸形值回填成「开启」。
          agent_teams: form?.supervisor?.agent_teams === true ? true : form?.supervisor?.agent_teams === false ? false : null,
        },
        prompt_overrides: { subagent: normalizePromptOverrideDraft(po) },
        modules: Object.fromEntries(MODULE_SWITCH_KEYS.map((k) => [k, normalizeModuleSwitchDraft(form?.modules?.[k])])),
        review: {
          policy: normalizeReviewPolicyDraft(form?.review?.policy),
          // g-442：三项评审条件列表的规范化——畸形（invalid_fields 命中 / 段级 config_malformed /
          // 含非字符串元素）一律归一为 null（只读展示、绝不回填提交）；未配置 null 保持 null；
          // 显式列表（**含 `[]`**）原样保留 ⇒ 「显式空列表」与「未配置」天然可区分。
          regions: normalizeReviewListDraft(form, "regions"),
          contract_paths: normalizeReviewListDraft(form, "contract_paths"),
          non_product_prefixes: normalizeReviewListDraft(form, "non_product_prefixes"),
        },
        refreshInterval: String(refreshIntervalInput ?? ""),
      };
    }
    function settingsDraftIsDirty(baseline, form, refreshIntervalInput) {
      if (!baseline || !form) return false;
      return JSON.stringify(normalizeSettingsDraft(form, refreshIntervalInput)) !== JSON.stringify(baseline);
    }
    // ===== g-480：harness 模块开关（workspace 级，五个模块默认全开）=====
    // 与 core `HARNESS_MODULE_IDS` 同源同序（客户端是独立打包的浏览器 bundle，无法 import core 常量，
    // 故此处是**副本**；两边一致性由 core/tests/g480-modules.test.ts 的前后端对账断言钉住，
    // 改一边不改另一边必红）。
    // 位置要求：本段必须落在 `function normalizeSettingsDraft(` 之后 —— 既有 vm 渲染测试从该函数起
    // 截取源码求值（g479-settings-tabs.test.ts 的 sandbox 切片），声明放在切片之前会 ReferenceError。
    const MODULE_SWITCH_KEYS = ["tags", "memory", "shared_cards", "automation_prompts", "attachments"];
    // 三态归一（与 core 同口径）：只有**真布尔**算显式；未配置/缺失/畸形一律归一为 null（＝开启）。
    // 归一后同态不产生假脏，也绝不会把畸形值回填成「关闭」。
    const normalizeModuleSwitchDraft = (v) => (v === true ? true : v === false ? false : null);
    /** g-480：模块开关的展示文案键（标签 + 一句话说明）。与 MODULE_SWITCH_KEYS 同序、同长，由
     *  core/tests/g480-modules.test.ts 的对账断言钉住（缺一个键或两语不对称即红）。 */
    const MODULE_LABEL_KEYS = {
      tags: "settings.module.tags",
      memory: "settings.module.memory",
      shared_cards: "settings.module.sharedCards",
      automation_prompts: "settings.module.automationPrompts",
      attachments: "settings.module.attachments",
    };
    const MODULE_HINT_KEYS = {
      tags: "settings.moduleHint.tags",
      memory: "settings.moduleHint.memory",
      shared_cards: "settings.moduleHint.sharedCards",
      automation_prompts: "settings.moduleHint.automationPrompts",
      attachments: "settings.moduleHint.attachments",
    };
    /** g-480（att-002）：宿主**不支持真裁剪**（缺 `agent/created` 事件或 `tools.restrict`）时的
     *  唯一一行提示键。服务端 `/api/dsh-graph/settings` 的 `trim_supported === false` 才渲染 →
     *  支持真裁剪的宿主（当前本机）上**该行不存在**，绝不改变既有页面的默认可见性；zh/en 对称、
     *  en 侧零 CJK（由 core/tests/g480-modules.test.ts 的对账断言钉住）。 */
    const MODULE_TRIM_UNSUPPORTED_HINT_KEY = "settings.modulesTrimUnsupported";
    // ===== g-333：override + 空文本 ≡ disable =====
    // core 已显式定义该语义（writeProjectConfig 用 JSON.stringify 编码：空串写回 `""`，结构化读取器
    // 读回即 disable；「空 override」在存储层不可表示）。这里把同一语义前移到**草稿归一化**与
    // **提交载荷**，避免弹窗提交一个存储层无法表示的状态——否则界面显示「覆盖」而实际生效为「禁用」，
    // 正是本目标要消灭的「看起来能配、实际不生效」。合法 state 闭集与 core 一致：default/override/disable。
    function normalizePromptOverrideDraft(po) {
      const state = (po?.state === "override" || po?.state === "disable") ? po.state : "default";
      const value = po?.value === null || po?.value === undefined ? "" : String(po.value);
      if (state === "override" && value === "") return { state: "disable", value: "" };
      return { state, value: state === "override" ? value : "" };
    }
    // ===== g-442：评审条件（review.regions / contract_paths / non_product_prefixes）=====
    // 真源：服务端读侧投影 `review.effective[key] = {value, source, malformed, allow_empty}`
    //（由 core 的 REVIEW_LIST_FIELDS 同源下发）——客户端**不自备**默认值副本，也就不会与策略层漂移。
    // 显式性判据是 `Array.isArray(form.review[key])`：显式 `[]` 与未配置 `null` 天然可区分。
    const REVIEW_LIST_KEYS = ["regions", "contract_paths", "non_product_prefixes"];
    const REVIEW_LIST_LABEL_KEYS = {
      regions: "settings.reviewRegionsLabel",
      contract_paths: "settings.reviewContractPathsLabel",
      non_product_prefixes: "settings.reviewNonProductPrefixesLabel",
    };
    const REVIEW_LIST_ARIA_KEYS = {
      regions: "settings.reviewRegionsAria",
      contract_paths: "settings.reviewContractPathsAria",
      non_product_prefixes: "settings.reviewNonProductPrefixesAria",
    };
    const REVIEW_LIST_HINT_KEYS = {
      regions: "settings.reviewRegionsHint",
      contract_paths: "settings.reviewContractPathsHint",
      non_product_prefixes: "settings.reviewNonProductPrefixesHint",
    };
    /** 畸形态 ⇒ 只读展示「非法/需修 project.yaml」，既不回填原始值，也不提供任何编辑入口
     *  （回填提交必被写侧 400 拒绝）。判定口径：
     *  - `invalid_fields` 有逐字段归因（core 的正常形态）⇒ 只锁命中字段；段级键 `review`（整档
     *    语法错误 / review 段不是映射）⇒ 三个字段一并锁；
     *  - 只有段级 `config_malformed` 而无归因（防御性）⇒ 无法判定具体字段，保守地一并锁。 */
    function isReviewFieldMalformed(form, key) {
      const rv = form?.review;
      if (!rv || typeof rv !== "object") return false;
      const inv = rv.invalid_fields;
      const hasInvalidMap = !!inv && typeof inv === "object" && Object.keys(inv).length > 0;
      if (hasInvalidMap) return Boolean(inv[key]) || Boolean(inv.review);
      return rv.config_malformed === true;
    }
    /** 服务端只读投影（唯一真源，客户端不自备默认值副本）。缺失（未下发的宿主/旧响应）时返回 null：
     *  UI 省略生效值行并回退 core 既有口径（`regions` 不允许空列表），仍可编辑，不伪造生效值。 */
    function reviewListEffective(form, key) {
      const eff = form?.review?.effective?.[key];
      if (!eff || !Array.isArray(eff.value)) return null;
      return eff;
    }
    /** 草稿归一化：畸形/未配置 → null；显式列表（含 `[]`）→ 逐项字符串化。 */
    function normalizeReviewListDraft(form, key) {
      if (isReviewFieldMalformed(form, key)) return null;
      const raw = form?.review?.[key];
      if (!Array.isArray(raw)) return null;
      if (raw.some((item) => typeof item !== "string")) return null;
      return raw.map((item) => String(item));
    }
    /**
     * g-442 保存前校验（与 core `validateStringList` 同口径，由 g-442 套件做行为等价对照）：
     * 空串 / 绝对路径（含 Windows 盘符）/ `..` 路径段 / 归一后重复 / 尾随斜杠 / 内部保留前缀 `invalid:`，
     * 以及 `regions: []`（allowEmpty=false）⇒ 可读错误并**拒绝提交**。
     * 返回错误描述数组（i18n key + params），不抛异常、无任何副作用。
     */
    function validateReviewListItems(key, items, allowEmpty) {
      const errs = [];
      if (!Array.isArray(items)) return errs;
      if (items.length === 0) {
        if (!allowEmpty) errs.push({ key: "settings.reviewEmptyForbidden", params: { field: key } });
        return errs;
      }
      const seen = new Set();
      for (let i = 0; i < items.length; i++) {
        const item = String(items[i]);
        const trimmed = item.trim();
        const at = { index: i + 1, item: trimmed, field: key };
        if (trimmed === "") { errs.push({ key: "settings.reviewInvalidEmpty", params: at }); continue; }
        if (trimmed.startsWith("invalid:")) { errs.push({ key: "settings.reviewInvalidReserved", params: at }); continue; }
        const norm = trimmed.replace(/\\/g, "/");
        if (norm.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) { errs.push({ key: "settings.reviewInvalidAbsolute", params: at }); continue; }
        if (norm.endsWith("/")) { errs.push({ key: "settings.reviewInvalidTrailingSlash", params: at }); continue; }
        if (norm.split("/").includes("..")) { errs.push({ key: "settings.reviewInvalidDotDot", params: at }); continue; }
        const canonical = norm.replace(/^\.\//, "").replace(/\/+$/, "");
        if (seen.has(canonical)) { errs.push({ key: "settings.reviewInvalidDuplicate", params: at }); continue; }
        seen.add(canonical);
      }
      return errs;
    }
    /** 全量草稿校验：畸形字段跳过（本就不提交，**不连带阻断**其它字段的合法保存）。 */
    function collectReviewListErrors(form) {
      const out = [];
      for (const key of REVIEW_LIST_KEYS) {
        if (isReviewFieldMalformed(form, key)) continue;
        const eff = reviewListEffective(form, key);
        // 约束来自服务端投影（唯一真源）；投影缺失时退回 core 既有口径（regions 不允许空列表）
        const allowEmpty = eff ? eff.allow_empty !== false : key !== "regions";
        const items = normalizeReviewListDraft(form, key);
        if (items === null) continue; // 未配置：不提交，无需校验
        for (const e of validateReviewListItems(key, items, allowEmpty)) out.push({ ...e, field: key });
      }
      return out;
    }
    /** 稀疏 patch 的叶子写入。 */
    function setLeafPatch(patch, path, value) {
      let cur = patch;
      for (let i = 0; i < path.length - 1; i++) {
        if (!cur[path[i]] || typeof cur[path[i]] !== "object") cur[path[i]] = {};
        cur = cur[path[i]];
      }
      cur[path[path.length - 1]] = value;
    }
    function getLeafPath(obj, path) {
      let cur = obj;
      for (const p of path) {
        if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
        cur = cur[p];
      }
      return cur;
    }
    // ===== g-442：设置弹窗的提交载荷改为**稀疏（叶子级 dirty diff）patch** =====
    // 为什么必须稀疏：core 的 `setScalarAtPath` 会重新格式化收到的叶子行、并补建缺失键 ⇒ 全表 payload
    // 即使值未变也可能重写 project.yaml 的其它段（注释/未知键）。故只提交**相对加载基线变化了的叶子**：
    //   · 改回原值 ⇒ 无差异 ⇒ 不提交该叶子；
    //   · 全部无差异 ⇒ 空 patch（save 直接跳过 POST，零副作用）；
    //   · 只改 review ⇒ 其余段连行都不进 payload ⇒ 逐字节不变。
    // `baseline` 省略（无已知基线）时所有叶子视为变化，等价旧全表语义（既有 g-333 契约测试仍驱动
    // 真实函数）；列表叶子仅在确有显式列表时输出，避免无中生有。
    function buildSettingsPatch(form, baseline) {
      const draft = normalizeSettingsDraft(form, "");
      const base = baseline ? normalizeSettingsDraft(baseline, "") : {};
      const patch = {};
      const leaf = (path, wire) => {
        const to = getLeafPath(draft, path);
        const from = getLeafPath(base, path);
        if (JSON.stringify(to) === JSON.stringify(from)) return;
        setLeafPatch(patch, path, wire ? wire(to) : to);
      };
      for (const f of ["provider", "model", "reasoning_effort", "mode"]) leaf(["executor", f]);
      // g-488：以下四键**界面上已不可编辑**（原「高级设置」的四个输入框已移除），但叶子清单**保留** ——
      // 配置读兼容：文件里既有的值照样归一、照样参与 diff（不可编辑 ⇒ 恒等于基线 ⇒ 永不出现在 patch），
      // 从而「不是我们改的键，一个字节都不动」，也不会误伤其它叶子。
      leaf(["defaults", "review", "reviewer"]);
      // 空串与 null 在存储层同义（都清空该字段），统一按 null 提交（与旧实现逐字一致）
      leaf(["defaults", "review", "prompt"], (v) => (v === "" || v === null || v === undefined ? null : v));
      leaf(["defaults", "pk", "lanes"]);
      leaf(["defaults", "pk", "sandbox"]);
      const autoKeys = new Set([...Object.keys(base.supervisor?.automation ?? {}), ...Object.keys(draft.supervisor?.automation ?? {})]);
      for (const k of autoKeys) leaf(["supervisor", "automation", k]);
      // g-440：`null` = 未配置（off）。无基线（旧客户端全表语义）且草稿也是 null ⇒ **无话可说**，
      // 不提交该叶子（避免把「未配置」实体化进 project.yaml、产生无谓的行改写）；只有在
      // 「草稿是布尔」或「基线是布尔而草稿回 null（= 显式清空）」时才提交。
      {
        const to = getLeafPath(draft, ["supervisor", "agent_teams"]);
        const from = getLeafPath(base, ["supervisor", "agent_teams"]);
        if (to === true || to === false || from === true || from === false) leaf(["supervisor", "agent_teams"]);
      }
      leaf(["prompt_overrides", "subagent"]);
      // g-480：模块开关同 agent_teams 口径——「无基线且草稿为 null」= 无话可说（不把「未配置」实体化
      // 进 project.yaml）；只有草稿是布尔、或基线是布尔而草稿回 null（显式清空回到默认开启）时才提交。
      for (const k of MODULE_SWITCH_KEYS) {
        const to = getLeafPath(draft, ["modules", k]);
        const from = getLeafPath(base, ["modules", k]);
        if (to === true || to === false || from === true || from === false) leaf(["modules", k]);
      }
      leaf(["review", "policy"], (v) => (v === "" ? null : v));
      for (const key of REVIEW_LIST_KEYS) {
        const to = getLeafPath(draft, ["review", key]);
        const from = getLeafPath(base, ["review", key]);
        if (Array.isArray(to) || Array.isArray(from)) leaf(["review", key]);
      }
      return patch;
    }
    function settingsPatchIsEmpty(patch) {
      return !patch || Object.keys(patch).length === 0;
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

    // ===== g-479：分类页签（唯一真源）=====
    // 现状单列滚动 + 「高级设置」折叠 → 分类页签结构。这里把**页签集合**与**配置项归属**写在一处，
    // 供渲染（页签栏/面板）与结构守卫（core/tests/g479-settings-tabs.test.ts）共用：
    // 每个可编辑配置项**恰好**归属一个页签，漏项（任何配置项无归属）与重复（多项挂同一键或
    // 同一项出现在两个页签）都必须判红——这就是「配置项 → 页签归属」结构守卫的真源。
    // 键名与 project.yaml / localStorage 的叶子路径同名；`local.*` 前缀明确标注为**本地偏好**
    // （只写 localStorage，不写 project.yaml）。
    // g-488：删「关于」页签（tab 集合 6 → 5）。配置文件路径展示移入页脚一行（见文末 footer），
    // 故 `config.project_yaml` 不再是「页签归属的配置项」——它是**只读展示**，不是可编辑配置项，
    // 从归属表中移除（其渲染与双语键由 g479 的专门断言钉住）。
    const SETTINGS_TAB_KEYS = ["executor", "review", "ui", "modules", "advanced"];
    const SETTINGS_DEFAULT_TAB = "executor";
    const SETTINGS_TAB_LABEL_KEYS = {
      executor: "settings.tab.executor",
      review: "settings.tab.review",
      ui: "settings.tab.ui",
      modules: "settings.tab.modules",
      advanced: "settings.tab.advanced",
    };
    const SETTINGS_TAB_ITEMS = {
      // g-488：`supervisor.agent_teams` 自「评审与质量」归位到「模型与执行」——它与 executor.mode
      // 同属**派发链路真实消费**的执行面（core `resolveAgentTeamsInjection`），归属页签只影响
      // 渲染位置：默认 off / 三态归一 / 派发语义（off 时提示词 diff=0）**逐字未动**。
      executor: ["executor.provider", "executor.model", "executor.reasoning_effort", "executor.mode", "supervisor.agent_teams"],
      review: ["review.policy", "review.regions", "review.contract_paths", "review.non_product_prefixes"],
      ui: ["local.refresh_interval", "local.live_display"],
      // g-480：harness 模块开关（workspace 级）——五个模块默认全开，关闭 = 真裁剪（工具从模型可选集
      // 移除 + 相关 systemPrompt 段不再注入），只隐藏能力、**不删除任何数据**。
      modules: [
        "modules.tags",
        "modules.memory",
        "modules.shared_cards",
        "modules.automation_prompts",
        "modules.attachments",
      ],
      // g-488：四项默认值键（`defaults.review.reviewer` / `defaults.review.prompt` /
      // `defaults.pk.lanes` / `defaults.pk.sandbox`）**只从界面移除**，配置读兼容全部保留：
      // schema / `readProjectConfig` / `normalizeSettingsDraft` / `buildSettingsPatch` 的叶子清单
      // 一字未动（不可编辑 ⇒ 永不判脏，也不会误伤其它键）；故这里不再登记归属 ——
      // 「页签归属表」只描述**界面上可编辑的配置项**。
      advanced: [
        "supervisor.automation.scope_planning",
        "supervisor.automation.integration_decision",
        "supervisor.automation.rework",
        "supervisor.automation.memory_promotion",
        "supervisor.automation.skill_proposal",
        "supervisor.automation.release",
        "prompt_overrides.subagent",
      ],
    };

    /** g-479：评审条件校验错误文案的**唯一**构造点——save 的拒绝提交与「错误定位到所属页签」
     *  共用它，避免两处各写一遍（也就不会再漂移）。 */
    function reviewConditionErrorText(form) {
      return collectReviewListErrors(form)
        .map((e) => dgT(e.key, { ...e.params, field: dgT(REVIEW_LIST_LABEL_KEYS[e.field] ?? e.field) }))
        .join("；");
    }

    // ===== g-488：说明性文字 tooltip 化（标题行只留主体）=====
    // 小标题右侧的 `(?)` 图标：说明性文字从正文搬进 `(?)` 承载层。
    // ===== g-490：承载层由**原生 `title`** 改为**自绘浮层**（负责人原话：「不要用title，用点击或
    // hover后显示的类title浮层显示。title的延时和触屏不友好不适合这个场景」）：
    //   · hover（mouseenter）即时显示（无原生 title 的 ~1s 延时）、离开关闭；
    //   · 点击/触摸可**切换**显示与关闭（触屏是重点）；
    //   · 键盘 Tab 聚焦（focus）即可见；
    //   · Esc / 点击浮层外 / 失焦（blur）/ 滚动 关闭；
    //   · 同一时刻**至多一个**浮层（唯一 `openHint` 状态）；
    //   · 浮层 `position: fixed` + 触发器矩形定位 + 视口边界翻转 ⇒ **不被弹窗的
    //     `overflowY:auto` / `maxHeight` 裁剪**（fixed 盒子不参与祖先 overflow 裁剪）；
    //   · **保留 `aria-label`**（说明全文＝可读名，说明信息零丢失）并建立语义关联：
    //     浮层 `role="tooltip"` + 稳定 id，触发器在打开时挂 `aria-describedby`；
    //     浮层自身 `aria-hidden="true"` ⇒ 不再被读屏**重复朗读**（文案已在可读名上）。
    // 分界（柱石，g-488 未变）：进浮层的只有**静态说明**（这个控件/小节是什么、怎么用、作用范围）；
    // **状态类读数**（生效值、来源徽标「显式/缺省」、加载/不可用状态、校验错误、只读目录建议、
    // 能力告警、未保存提示）一律留在正文——它们必须一眼可见，且随状态变化，塞进浮层会撒谎。
    const SETTINGS_HINT_ICON = "(?)";
    /** g-490：说明全文 → **稳定**浮层 id（同一文案跨次渲染得到同一 id ⇒ `aria-describedby` 可靠；
     *  不依赖渲染顺序/计数器，条件渲染导致的顺序漂移也不会换 id）。 */
    const settingsHintIdFor = (text) => {
      let hash = 0;
      for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
      return "dg-settings-tip-" + (hash >>> 0).toString(36);
    };

    /** g-488：`supervisor.automation` 六键的**逐键**说明键（与键名一一对应：管什么 + human/ai 含义）。
     *  键集完整性由 g479 结构守卫逐个对上键名（漏一键即红）。 */
    const AUTOMATION_HINT_KEYS = {
      scope_planning: "settings.automationWhat.scope_planning",
      integration_decision: "settings.automationWhat.integration_decision",
      rework: "settings.automationWhat.rework",
      memory_promotion: "settings.automationWhat.memory_promotion",
      skill_proposal: "settings.automationWhat.skill_proposal",
      release: "settings.automationWhat.release",
    };

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
      // g-479：第 5 个 useState 槽位由「高级折叠开关」升级为「当前激活页签」——**槽位数与顺序一字不变**
      // （既有 vm 渲染测试按 hook 调用序覆写 0..10 槽位；新状态只能追加在第 10 槽位之后）。
      // `showAdvanced`（原折叠是否展开）在 g-488 已删除：高级设置本身即页签，页签内不再有第二层显隐。
      const [activeTab, setActiveTab] = React.useState(SETTINGS_DEFAULT_TAB);
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
          if (!window.confirm(dgT("settings.discardDirtyConfirm"))) return;
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
          // g-480（att-002）：宿主是否支持真裁剪（服务端 apply 期能力探测的唯一结果）——
          // 明确 false 才渲染「本版本 DSH 不支持真裁剪」那一行；true/缺失 ⇒ null（不渲染）。
          setTrimSupported(data.trim_supported === true ? true : data.trim_supported === false ? false : null);
          // g-442：按当前项目目录结构的**只读**建议（服务端下发；本面板绝不自动写入 project.yaml）
          setSuggestedRegions(Array.isArray(data.review_suggested_regions) ? data.review_suggested_regions : null);
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
      // g-442：评审条件的只读目录建议（服务端按 workspace 一级目录计算；仅展示，不自动写入）
      const [suggestedRegions, setSuggestedRegions] = React.useState(null);
      // g-480（att-002）：宿主真裁剪能力（服务端 `trim_supported`）——**三态** true/false/null。
      // 只有服务端**明确**为 false 才在「模块」页签渲染那一行提示；true/缺失（未知）一律**不渲染**
      // （缺字段不等于「不支持」，绝不据此对用户谎报能力）。
      // 位置要求（g-479）：必须**追加**在既有 useState 槽位之后——测试夹具按 0..10 槽位覆写初值。
      const [trimSupported, setTrimSupported] = React.useState(null);
      // ===== g-490：`(?)` 自绘浮层的唯一状态与几何 =====
      // 位置要求（与既有一致）：**追加**在既有 useState 槽位之后（0..11 已被既有夹具覆写）。
      // `openHint` 是**唯一**的浮层状态 ⇒ 同一时刻至多一个浮层；`hintGeomRef` 存触发器的
      // viewport 矩形（fixed 定位 + 边界翻转依据），`hintLastEnterRef` 记录最近一次 mouseenter
      // 时刻（抑制触屏上 emulated mouseenter→click 的「开了又立刻被切关」）。
      const [openHint, setOpenHint] = React.useState(null);
      const hintGeomRef = React.useRef(null);
      const hintLastEnterRef = React.useRef(0);
      /** 触发器矩形 → 浮层定位（fixed；上方空间不足则**翻到下方**，左侧不越出视口）。 */
      const hintGeometryOf = (el) => {
        const rect = el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
        if (!rect) return null;
        const vw = (typeof window !== "undefined" && window.innerWidth) || 0;
        const left = Math.max(8, Math.min(rect.left, vw > 16 ? vw - 16 : rect.left));
        return { left, top: rect.top, bottom: rect.bottom };
      };
      const hintPlacementStyle = (open) => {
        const geom = hintGeomRef.current;
        const vh = (typeof window !== "undefined" && window.innerHeight) || 0;
        // 边界翻转：触发器上方空间足够（>180px）⇒ 浮层放上方，否则放下方。
        const above = geom ? (geom.top > 180 || vh === 0) : true;
        const base = {
          position: "fixed", zIndex: 100001, left: geom ? geom.left : 8, maxWidth: 320,
          background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)",
          border: "1px solid rgba(128,128,128,.45)", borderRadius: 6, padding: "6px 8px",
          fontSize: 11, lineHeight: 1.5, fontWeight: 400, whiteSpace: "pre-wrap", wordBreak: "break-word",
          boxShadow: "0 4px 16px rgba(0,0,0,.45)", display: open ? "block" : "none", pointerEvents: "none",
        };
        if (!geom) return { ...base, top: 0, bottom: undefined };
        return above
          ? { ...base, bottom: Math.max(0, vh - geom.top + 6), top: undefined }
          : { ...base, top: geom.bottom + 6, bottom: undefined };
      };
      const openHintAt = (id, el) => { hintGeomRef.current = hintGeometryOf(el); setOpenHint(id); };
      const closeHintIf = (id) => { if (openHint === id) setOpenHint(null); };
      /** Esc / 点击浮层外 / 滚动 ⇒ 关闭（只在有浮层打开时挂监听，卸载即摘除）。 */
      React.useEffect(() => {
        if (!openHint) return undefined;
        const onKey = (e) => { if (e && e.key === "Escape") setOpenHint(null); };
        const onDown = (e) => {
          const t = e && e.target;
          if (t && typeof t.closest === "function" && t.closest(".dg-settings-tip")) return;
          setOpenHint(null);
        };
        const onScroll = () => setOpenHint(null);
        if (typeof document !== "undefined" && document.addEventListener) {
          document.addEventListener("keydown", onKey);
          document.addEventListener("mousedown", onDown);
        }
        if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("scroll", onScroll, true);
        return () => {
          if (typeof document !== "undefined" && document.removeEventListener) {
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("mousedown", onDown);
          }
          if (typeof window !== "undefined" && window.removeEventListener) window.removeEventListener("scroll", onScroll, true);
        };
      }, [openHint]);
      /** g-490：`(?)` 图标——**唯一构造点**。返回「触发器 + 可选浮层」的包裹层。
       *  触发器保留 `aria-label`（说明全文，零丢失）与 `tabIndex=0`（键盘可达）；**绝不输出 `title`**。 */
      const settingsHintIcon = (text) => {
        const tipId = settingsHintIdFor(text);
        const open = openHint === tipId;
        return h("span", { className: "dg-settings-tip", style: { display: "inline-flex", flexShrink: 0 } },
          h("span", {
            className: "dg-settings-hint",
            role: "img",
            tabIndex: 0,
            "aria-label": text,
            "aria-describedby": open ? tipId : undefined,
            style: { fontSize: 11, cursor: "help", opacity: 0.75, flexShrink: 0, lineHeight: 1.2 },
            onMouseEnter: (e) => { hintLastEnterRef.current = Date.now(); openHintAt(tipId, e.currentTarget); },
            onMouseLeave: () => closeHintIf(tipId),
            onClick: (e) => {
              e.stopPropagation();
              // 触屏（触屏点击会先派发 emulated mouseenter）刚被 hover 打开 ⇒ 同一次轻触不再切关。
              if (open && Date.now() - (hintLastEnterRef.current || 0) < 700) return;
              if (open) { setOpenHint(null); return; }
              openHintAt(tipId, e.currentTarget);
            },
            onFocus: (e) => openHintAt(tipId, e.currentTarget),
            onBlur: () => closeHintIf(tipId),
            onKeyDown: (e) => { if (e.key === "Escape") setOpenHint(null); },
          }, SETTINGS_HINT_ICON),
          open
            ? h("span", {
                className: "dg-settings-tip-popover",
                role: "tooltip",
                id: tipId,
                "aria-hidden": "true",
                style: hintPlacementStyle(true),
              }, text)
            : null);
      };
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

      // g-479：错误定位到所属页签——save 因评审条件校验拒绝提交时，note.text 正是
      // reviewConditionErrorText(form)（同一个字符串，非文本匹配猜测）；此时把「评审与质量」
      // 页签切到前台，使用户在当前可见页面上就能看到出错字段。只在**保存被拒**后触发
      // （note 是保存路径的产物，输入期不触发，不会在编辑时把用户从别的页签拽走）。
      React.useEffect(() => {
        if (note?.kind === "err" && note.text === reviewConditionErrorText(form)) setActiveTab("review");
      }, [note]);

      const save = async () => {
        if (!form) return;
        setSaving(true); setNote(null); setError(null);
        // g-488：原 `defaults.pk.lanes` 整数前置校验随该输入框一并移除——它不是「放宽校验」而是
        // 「校验对象已不存在」：界面上再无 lanes 输入，而文件里既有的非法值不该**永久阻断保存**
        // （否则一个手改坏的 project.yaml 会让整个设置面板只读）。core 侧读取/规整语义未动。
        // g-442：保存前校验评审条件（空串 / 绝对路径 / `..` / 重复 / 尾随斜杠 / regions 显式空列表）。
        // 失败即拒绝提交：不发 POST、不改基线、不写 localStorage ⇒ 零副作用、不留半保存状态。
        const reviewErrors = collectReviewListErrors(form);
        if (reviewErrors.length > 0) {
          // g-479：文案走唯一构造点 reviewConditionErrorText——它与渲染期「错误定位到所属页签」
          // 共用同一个字符串，页签切换只依赖既有 note 状态，绝不改本函数的副作用与提交语义。
          setNote({ kind: "err", text: reviewConditionErrorText(form) });
          setSaving(false); return;
        }
        // g-442：稀疏 patch——只提交相对加载基线变化了的叶子；改回原值不提交、全部未改则为空 patch。
        const patch = buildSettingsPatch(form, baselineRef.current);
        const intervalDirty = String(refreshIntervalInput ?? "") !== String(baselineRef.current?.refreshInterval ?? "");
        if (settingsPatchIsEmpty(patch) && !intervalDirty) {
          // 无任何变化：不 POST（空 patch 无意义），也不产生任何本地副作用，直接关闭
          setSaving(false);
          props.onClose?.();
          return;
        }
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
          // g-490：POST 回填的 `config` 是**项目配置本体**，不含服务端下发的展示元数据
          // `automation_unset_scope`——必须显式保留，否则保存一次后「未配置」项的默认值/口径来源标注
          // 会退回「未配置：保持既有指导」（纯显示层回归）。`normalizeSettingsDraft` 只取已知叶子，
          // 多出的顶层键不参与判脏。
          setForm(data.config
            ? { ...data.config, automation_unset_scope: data.automation_unset_scope ?? form.automation_unset_scope }
            : form); // 用服务端回填的最新配置刷新
          setSuggestedRegions(Array.isArray(data.review_suggested_regions) ? data.review_suggested_regions : suggestedRegions);
          // g-246：保存成功即归位基线（刷新间隔取纠偏后值），随后直接关闭跳过拦截
          baselineRef.current = normalizeSettingsDraft(data.config ?? form, String(correctedInterval));
          props.onSaved?.();
          props.onClose?.();
        } catch (e) {
          setNote({ kind: "err", text: dgT("settings.saveFail") + String(e?.message ?? e) });
        } finally { setSaving(false); }
      };

      if (loading) {
        return dgOverlay({ style: S.overlay, ...backdropGuard },
          h("div", { style: { ...S.modal, maxWidth: 520 }, onClick: (e) => e.stopPropagation() },
            h("span", { className: "dg-close", style: S.close, onClick: requestClose }, "✕"),
            h("div", { style: S.modalH }, dgT("settings.title")),
            h("div", { style: { ...S.meta, marginTop: 8 } }, dgT("settings.loading"))));
      }
      if (!form) {
        return dgOverlay({ style: S.overlay, ...backdropGuard },
          h("div", { style: { ...S.modal, maxWidth: 520 }, onClick: (e) => e.stopPropagation() },
            h("span", { className: "dg-close", style: S.close, onClick: requestClose }, "✕"),
            h("div", { style: S.modalH }, dgT("settings.title")),
            error ? h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-error-primary, #f08080)", marginTop: 8 } }, error) : null,
            h("button", { style: { ...S.btn, marginTop: 10 }, className: "dg-btn", onClick: load }, dgT("common.retry"))));
      }

      const auto = form.supervisor?.automation ?? {};
      // g-490（负责人 2026-10-12 裁决：**诚实口径、不编默认值**）：六键**未配置**时的**显示口径来源**
      // ——**只**消费服务端下发的 `automation_unset_scope`（引擎 `AUTOMATION_UNSET_SCOPE` 是唯一真源；
      // 客户端**不留** human/ai 的键级副本）。该表**不是**引擎解析默认值：它只登记「哪两键的**动作**
      // 落在既有某类人工 gate 的**范围**内」+ 该 gate 的既有要求，面板显示「默认：<gate 要求>」时
      // **必须**同屏标注 `settings.automationDefaultScopeNote*` 的口径来源与「非引擎解析默认值」。
      // 表外键（含缺该字段的旧服务端）唯一口径 = `settings.automationUnsetKeep`
      //（引擎未配置即返回 null、不输出该键指导行 ⇒「未配置：保持既有指导」）——**绝不**编出 human/ai。
      const automationUnsetScope = form.automation_unset_scope ?? {};
      const automationOptions = (val, unsetScope) => [
        h("option", { value: "", style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } },
          unsetScope ? dgT("settings.automationDefaultPrefix") + unsetScope.gate_requires : dgT("settings.automationUnsetKeep")),
        h("option", { value: "human", style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, "human (" + dgT("settings.human") + ")"),
        h("option", { value: "ai", style: { background: "var(--dsw-alias-bg-layer-3, #2a2b31)", color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, "ai (" + dgT("settings.ai") + ")"),
      ];
      // g-490：**同屏口径来源标注**（恰好一处构造点，只读文本、非控件）——只要该键的未配置项显示
      // 具体 human/ai（= 服务端下发了它的 gate 范围来源），就**无条件**紧邻渲染这条标注；
      // 它把「默认：<gate 要求>」与 `(?)` 里的「未配置 = 沿用既有指导」显式对齐（不是两套口径），
      // 并点明「非引擎解析默认值」。
      const automationUnsetScopeNote = (unsetScope) => h(
        "div",
        { className: "dg-settings-automation-scope-note", style: { ...S.meta, fontSize: 10, marginTop: 2 } },
        dgT("settings.automationDefaultScopeNotePrefix")
          + dgT("settings.gateScope." + unsetScope.gate_scope)
          + dgT("settings.automationDefaultScopeNoteSuffix"),
      );
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
      // ===== g-442：单个评审条件列表字段的渲染（查看生效值 + 来源；显式模式可编辑）=====
      // 三态互斥且可区分：
      //   ① 未配置（null）：只读展示**服务端下发的生效值**并标注「缺省（普适）」，不写进可写草稿；
      //      用户主动点「改为显式配置」才把生效值复制为草稿起点（显式值等于缺省值仍报「显式配置」）。
      //   ② 显式配置（含 `[]`）：可编辑；「清空」得到 `[]`（**不等于** null）；「恢复未配置」提交 null。
      //   ③ 畸形（invalid_fields 命中）：只显示「非法/需修 project.yaml」，**不回填**原始值、不提供编辑。
      const reviewListField = (key) => {
        const eff = reviewListEffective(form, key);
        const malformed = isReviewFieldMalformed(form, key);
        const items = malformed ? null : normalizeReviewListDraft(form, key);
        const explicit = Array.isArray(items);
        const allowEmpty = eff ? eff.allow_empty !== false : key !== "regions";
        const label = dgT(REVIEW_LIST_LABEL_KEYS[key]);
        const aria = dgT(REVIEW_LIST_ARIA_KEYS[key]);
        const errStyle = { ...S.meta, color: "var(--dsw-alias-state-error-primary, #f08080)", fontSize: 11 };
        const metaStyle = { ...S.meta, fontSize: 11, marginTop: 2 };
        const smallBtn = (text, onClick, title) => h("button", {
          className: "dg-btn", style: { ...S.btn, fontSize: 11, padding: "2px 8px", cursor: "pointer" }, title, onClick,
        }, text);
        // P2①：文件里已有 `regions: []` 时规格不允许（写侧拒收 + 引擎 fail-closed 升 strict）
        // ⇒ 必须如实标「非法取值」，不得渲染成合法的「显式空列表」生效态。
        const illegalEmpty = eff?.illegal_empty === true;
        const sourceBadge = malformed
          ? dgT("settings.reviewSourceMalformed")
          : illegalEmpty
            ? dgT("settings.reviewSourceIllegalEmpty")
            : (explicit ? dgT("settings.reviewSourceExplicit") : dgT("settings.reviewSourceDefault"));
        // 生效值逐条可见；空串条目如实标注（畸形数组原样透出时可能出现）
        const showValue = (list) => list.map((v) => (v === "" ? dgT("settings.reviewEffectiveBlank") : v)).join(", ");
        // g-490：生效值**输入框同构**的呈现（与 S.promptInput 同一组边框/底色 token、全不透明、
        // 等宽字体），与相邻说明文字（S.meta，opacity .65）在视觉上一眼可分——负责人原话：
        // 「review条件中的生效值没有可视化，要突出显示或增加输入框同构的边框底色」。
        const effectiveStyle = {
          fontSize: 11, marginTop: 2, padding: "3px 7px", borderRadius: 4, display: "block",
          background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,.25))",
          border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))",
          color: "inherit", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          wordBreak: "break-all", whiteSpace: "pre-wrap",
        };
        // 生效值行只在服务端给了投影时渲染——缺投影绝不伪造（不写「（空）」冒充生效值）
        const effectiveView = eff
          ? h("div", { className: "dg-settings-effective-value", style: effectiveStyle },
              dgT("settings.reviewEffectiveLabel") + "：" +
                (eff.value.length > 0 ? showValue(eff.value) : dgT("settings.reviewEffectiveEmpty")))
          : null;
        const body = malformed
          ? h("div", null,
              h("div", { style: errStyle },
                dgT("settings.reviewMalformedField") + "：" +
                  String(form.review?.invalid_fields?.[key] ?? form.review?.invalid_fields?.review ?? "")),
              effectiveView)
          : explicit
            ? h("div", null,
                h("textarea", {
                  "aria-label": aria,
                  style: { ...S.promptInput, width: "100%", minHeight: 54, resize: "vertical", boxSizing: "border-box" },
                  value: items.join("\n"),
                  placeholder: dgT("settings.reviewItemsPlaceholder"),
                  // 逐行一个条目；空行/纯空白行不构成条目（清空全部行 ⇒ 显式空列表 `[]`）
                  onChange: (e) => set(["review", key], e.target.value.split("\n").map((s) => s.trim()).filter((s) => s !== "")),
                }),
                h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 4 } },
                  items.length === 0 && allowEmpty ? h("span", { style: metaStyle }, dgT("settings.reviewExplicitEmpty")) : null,
                  items.length > 0 ? smallBtn(dgT("settings.reviewClear"), () => set(["review", key], []), dgT("settings.reviewClearTitle")) : null,
                  smallBtn(dgT("settings.reviewResetUnset"), () => set(["review", key], null), dgT("settings.reviewResetUnsetTitle")),
                  !allowEmpty && items.length > 0 ? h("span", { style: metaStyle }, dgT("settings.reviewEmptyForbidden")) : null),
                // 显式空列表 + 规格不允许 ⇒ 错误态（非「显式空」标签）：既覆盖文件既有 `regions: []`，
                // 也覆盖用户在草稿里清空 regions 的情形——保存前校验同样会拦下。
                !allowEmpty && items.length === 0
                  ? h("div", { style: errStyle }, dgT("settings.reviewIllegalEmpty"))
                  : null)
            : h("div", null,
                effectiveView,
                h("div", { style: metaStyle }, dgT("settings.reviewUnsetHint")),
                h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 4 } },
                  smallBtn(dgT("settings.reviewMakeExplicit"), () => set(["review", key], [...(eff?.value ?? [])]), dgT("settings.reviewMakeExplicitTitle")),
                  key === "regions" && !allowEmpty ? h("span", { style: metaStyle }, dgT("settings.reviewEmptyForbidden")) : null));
        return h("div", { key, style: { marginBottom: 10 } },
          h("div", { style: { display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" } },
            h("span", { style: { fontWeight: 600, fontSize: 12 } }, label),
            // g-488：逐列表的说明（每行一个条目 / 允许的写法）搬到标题行右侧 `(?)`，文案一字未改；
            // 相邻的「来源：显式/缺省」是**状态读数**，仍留在正文。
            settingsHintIcon(dgT(REVIEW_LIST_HINT_KEYS[key])),
            h("span", { style: { ...S.meta, fontSize: 11 } }, dgT("settings.reviewSourceLabel") + "：" + sourceBadge)),
          body,
          key === "regions" && Array.isArray(suggestedRegions) && suggestedRegions.length > 0
            ? h("div", { style: metaStyle }, dgT("settings.reviewSuggestedRegions") + suggestedRegions.join(", "))
            : null);
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

      // ===== g-479：分类页签（页签 → 面板；配置项归属表见模块级 SETTINGS_TAB_ITEMS）=====
      // g-488：原「折叠是否展开」派生显示开关（及其一族 inline `display` 三元表达式）**已删除**
      // ——「高级设置」本身就是一个页签，页签内再挂一层「显示/隐藏高级设置」既是重复控件，也让
      // 「高级页签激活但内容被隐藏」成为可能。高级页签内容现在**恒显**（可见性只由页签选择决定）。
      // ② 页签按钮：选中页签与下方面板同底色、下移 1px 覆盖分隔线（沿用 goal-modal 的页签视觉）。
      const tabButton = (tabKey) => h("button", {
        key: tabKey,
        className: "dg-btn dg-settings-tab" + (activeTab === tabKey ? " dg-settings-tab-active" : ""),
        role: "tab",
        "aria-selected": activeTab === tabKey,
        style: {
          fontSize: 12, padding: "4px 12px", cursor: "pointer",
          marginBottom: -1, borderRadius: "6px 6px 0 0",
          border: "1px solid " + (activeTab === tabKey ? "rgba(128,128,128,.35)" : "transparent"),
          borderBottom: "none",
          background: activeTab === tabKey ? "rgba(128,128,128,.10)" : "transparent",
          fontWeight: activeTab === tabKey ? 700 : 400,
          color: activeTab === tabKey ? "var(--dsw-alias-label-primary, #8ab4ff)" : "inherit",
          opacity: activeTab === tabKey ? 1 : 0.7,
        },
        onClick: () => setActiveTab(tabKey),
      }, dgT(SETTINGS_TAB_LABEL_KEYS[tabKey]));
      // ③ 面板**无条件渲染**、只用 display 切可见性：所有编辑态共用同一个 `form` 草稿 ⇒ 跨页签不丢
      //    编辑、脏状态与关闭拦截（baselineRef + settingsDraftIsDirty）零改动；同时既有 vm 渲染树
      //    测试（nodesOfType / textareaByAria 遍历全树）仍能找到每个控件——条件渲染会让非当前页签
      //    的控件整棵消失，直接打断 8 个测试文件的结构锚点。
      const tabPanel = (tabKey, items) => h("div", {
        key: tabKey,
        className: "dg-settings-panel dg-settings-panel-" + tabKey,
        role: "tabpanel",
        style: { display: activeTab === tabKey ? "block" : "none" },
      }, ...items);

      // ===== g-490：`project.yaml` 行从**页脚**迁到**标题栏右侧（关闭按钮左侧）** =====
      // 负责人原话：「project.yaml这块放到标题栏右侧，关闭按钮左边」。信息与入口逐字复用
      //（📄 project.yaml 标签 + 打开 + 复制路径 + 绝对路径全文），**只改位置**：
      //   · 行 `marginLeft:auto` 顶到标题栏右端、`justifyContent:flex-end`；
      //   · 外层标题栏 `paddingRight:34` 给**绝对定位**的 `.dg-close`（top:14/right:16/26px）留位，
      //     窄宽度换行后第二行同样内缩 ⇒ 不会压在 ✕ 上；
      //   · 行 `flexWrap:wrap` + 路径 span `wordBreak:break-all` + `minWidth:0` ⇒ 窄宽度/超长路径
      //     换行而不撑破弹窗（绝不省略号截断隐藏信息）。
      const projectYamlRow = configFile
        ? h("div", {
            className: "dg-settings-configfile",
            style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", justifyContent: "flex-end", marginLeft: "auto", minWidth: 0 },
          },
            h("span", { style: { fontSize: 11, opacity: 0.7, whiteSpace: "nowrap" } }, dgT("settings.projectYaml")),
            // g-490 增量（判据 7 扩写）：本行说明（settings.editHint）原为标题下方**常驻平铺**的一行，
            // 现收进本行内的**自绘 `(?)` 浮层**（与其余 `(?)` 同一交互契约：悬停/点击/键盘聚焦、
            // Esc·浮层外点击·滚动关闭、同屏至多一个、`aria-label` 保留全文）。文案**一字未改** ⇒
            // 信息零丢失，只是不再占常驻正文。落点选在 📄 project.yaml 标签旁（紧邻其描述对象）。
            settingsHintIcon(dgT("settings.editHint")),
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
              // g-490 增量（负责人 2026-10-12 现场反馈）：绝对路径过长，正文**不再平铺**该路径
              // （反正可一键复制）⇒ 该行恒为单行；全文仍在**本按钮的既有 title 提示**里（悬停可见，
              // 不在 `(?)` 路径内）⇒ 信息零丢失，只是不再占常驻空间。
              title: dgT("settings.copyProjectPath") + "：" + configFile,
              onClick: async (e) => { e.stopPropagation(); const ok = await copyText(configFile); if (ok) showToast(dgT("tab.pathCopied")); },
            }, dgT("tab.copyPath")))
        : null;

      return dgOverlay({ style: S.overlay, ...backdropGuard },
        h("div", { style: { ...S.modal, maxWidth: 640 }, onClick: (e) => e.stopPropagation() },
          h("span", { className: "dg-close", style: S.close, onClick: requestClose }, "✕"),
          // g-490：标题栏 = 标题 + （右端）project.yaml 行。增量（判据 7 扩写）：原先「标题下方常驻
          // 一行」的 editHint 说明已折叠进该行内的 `(?)` ⇒ 正文里**不再有**这一行（负向守卫钉住，
          // 回退成常驻平铺即判红）。增量（负责人 2026-10-12 现场反馈）：绝对路径也不再平铺（见
          // projectYamlRow 注释）⇒ 标题栏恒为单行「标题 + 📄 project.yaml (?) 打开 复制路径」。
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingRight: 34 } },
            h("div", { style: { ...S.modalH, marginBottom: 0, flex: "0 0 auto" } }, dgT("settings.title")),
            projectYamlRow),
          // g-479：分类页签切换栏——用页签取代原「单列滚动 + 高级设置折叠」。点击只切 activeTab，
          // 面板内容常驻（同一 form 草稿）⇒ 跨页签不丢编辑；保存链路/关闭确认一字未改。
          h("div", {
            className: "dg-tab dg-settings-tabs",
            role: "tablist",
            "aria-label": dgT("settings.tabsAria"),
            style: { display: "flex", alignItems: "flex-end", flexWrap: "wrap", gap: 2, marginTop: 10, borderBottom: "1px solid rgba(128,128,128,.35)" },
          },
            ...SETTINGS_TAB_KEYS.map((k) => tabButton(k))),
          tabPanel("executor", [
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
              h("div", { style: { display: "flex", alignItems: "center", gap: 4, marginBottom: 2 } },
                h("label", { style: { fontSize: 11, opacity: 0.8 } }, dgT("settings.reasoningEffort")),
                // g-488：说明性文字 tooltip 化——文案本身（含目录三态各自的说法）一字未改，只换承载位置。
                settingsHintIcon(
                  catReady
                    ? (effortChoices.length > 0
                      ? dgT("settings.effortHint")
                      : dgT("settings.effortHintNone"))
                    : dgT("profileSettings.effortHintWaiting"))),
              h("select", {
                "aria-label": dgT("settings.reasoningEffortAria"),
                style: { ...S.promptInput, width: "100%", boxSizing: "border-box" },
                value: curEffort,
                onChange: (e) => set(["executor", "reasoning_effort"], e.target.value),
              }, ...effortOptions)),
            // g-191：执行模式受控下拉
            h("div", { style: { minWidth: 0, marginBottom: 6 } },
              h("div", { style: { display: "flex", alignItems: "center", gap: 4, marginBottom: 2 } },
                h("label", { htmlFor: modeId, style: { display: "block", marginBottom: 2, fontSize: 11, opacity: 0.8 } }, dgT("settings.modeLabel")),
                // g-490 增量（判据 7 扩写）：本面板最长的一段常驻平铺说明（catalogReady，讲目录来源与
                // 三项派生规则）折叠进标签右侧 `(?)`——与相邻「推理档位」同一承载方式。**状态门控**：
                // 只有目录就绪态才渲染该 `(?)`；加载中/不可用仍按原文案常驻正文（见下方状态行）⇒
                // 不存在「静态 tooltip 撒谎」，降级读数依旧一眼可见。
                catReady ? settingsHintIcon(dgT("settings.catalogReady")) : null),
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
            // g-490 增量：就绪态的长句说明已进上方 `(?)`；正文只留**瞬态/降级**状态读数（必读警示）。
            catReady
              ? null
              : h("div", { style: { ...S.meta, marginTop: 4 } },
                  catalog.status === "loading" ? dgT("settings.catalogLoadingMsg") : dgT("settings.catalogUnavailableMsg")),
            // ===== g-488：Agent Teams 契约开关（自「评审与质量」页签**归位**到「模型与执行」）=====
            // g-440 契约逐字不变：**默认 off**；off 时派发提示词逐字不变（diff=0），on 才把 discipline
            // 资产中的契约段注入派发提示词（core `resolveAgentTeamsInjection`）。三态归一（null/未配置
            // = off）与派发链路的双态注入语义均由 core 侧守卫，归位只改渲染页签，不动任何读写路径。
            h("hr", { style: { border: "none", borderTop: "1px solid rgba(128,128,128,.25)", margin: "10px 0" } }),
            h("div", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
              h("input", {
                id: "dg-agent-teams",
                type: "checkbox",
                checked: form.supervisor?.agent_teams === true,
                onChange: (e) => set(["supervisor", "agent_teams"], e.target.checked),
                style: { flexShrink: 0 },
              }),
              h("label", { htmlFor: "dg-agent-teams", style: { fontWeight: 700, fontSize: 12, flexShrink: 0, cursor: "pointer" } }, dgT("settings.agentTeams")),
              settingsHintIcon(dgT("settings.agentTeamsHint"))),
          ]),
          tabPanel("review", [
            // g-342：顶层 review.policy 四态下拉（继承未配置 / auto / strict / none）。
            // 渲染方式（label htmlFor + select + meta 提示）与选项 style 比照上方 executor.mode 与
            // supervisor.automation；脏状态由 normalizeSettingsDraft 统一覆盖（判据 2）。
            // 归属主区而非「高级设置」：该字段被 core/review-policy.ts 的受理门禁真实消费。
            h("div", { style: { minWidth: 0 } },
              h("div", { style: { display: "flex", alignItems: "center", gap: 4, marginBottom: 2 } },
                h("label", { htmlFor: reviewPolicyId, style: { fontSize: 11, opacity: 0.8 } }, dgT("settings.reviewPolicyLabel")),
                // g-488：四态含义说明（含「未配置时怎么推导」）搬进标题右侧 `(?)`，文案一字未改。
                settingsHintIcon(dgT("settings.reviewPolicyHint"))),
              h("select", {
                id: reviewPolicyId,
                "aria-label": dgT("settings.reviewPolicyAria"),
                style: { ...S.promptInput, width: "100%", boxSizing: "border-box" },
                value: curReviewPolicy,
                onChange: (e) => set(["review", "policy"], e.target.value),
              },
                h("option", { value: "", style: policyOptionStyle }, dgT("settings.reviewPolicyInherit")),
                ...REVIEW_POLICY_VALUES.map((p) => h("option", { key: p, value: p, style: policyOptionStyle }, dgT(REVIEW_POLICY_LABEL_KEYS[p]))))),

            // ===== g-442：评审条件区块（regions / contract_paths / non_product_prefixes）=====
            // 位置：紧随既有 review.policy 四态下拉之后（同属「真实生效」主区，而非「高级设置」）。
            // 未配置时只读展示服务端生效值并标注「缺省（普适）」——绝不让用户误以为已按本项目校准，
            // 也绝不把缺省值物化为显式配置；目录建议为只读提示，不自动写入。
            h("hr", { style: { border: "none", borderTop: "1px solid rgba(128,128,128,.25)", margin: "10px 0" } }),
            // g-488：小节说明（「主管按项目目录结构设置」）与 g-435 指南指引（《Review 严格度校准》）
            // 两条静态说明合并挂到小节标题的 `(?)`，文案逐字保留（两者都是「怎么用」，非状态读数）。
            h("div", { style: { display: "flex", alignItems: "center", gap: 4, marginBottom: 6 } },
              h("div", { style: { fontWeight: 700 } }, dgT("settings.reviewConditions")),
              settingsHintIcon(dgT("settings.reviewConditionsHint") + " " + dgT("settings.reviewCalibrationGuide"))),
            form.review?.config_malformed
              ? h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-error-primary, #f08080)", marginBottom: 6, fontSize: 11 } }, dgT("settings.reviewConfigMalformed"))
              : null,
            ...REVIEW_LIST_KEYS.map((key) => reviewListField(key)),
          ]),
          tabPanel("ui", [
            // g-479：本页两项都是**浏览器本地偏好**（只写 localStorage），不写 project.yaml、
            // 不随配置同步——如实标注，避免用户误以为它们会随项目配置共享。
            // g-488：这条页级说明搬进页首标题右侧的 `(?)`（页首标题复用页签标签键，不新增文案）。
            h("div", { style: { display: "flex", alignItems: "center", gap: 4, marginBottom: 6 } },
              h("div", { style: { fontWeight: 700 } }, dgT(SETTINGS_TAB_LABEL_KEYS.ui)),
              settingsHintIcon(dgT("settings.tabLocalNote"))),
            h("div", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
              h("span", { style: { fontWeight: 700, fontSize: 12, flexShrink: 0 } }, dgT("settings.autoRefresh")),
              // g-488：「（下限 5 秒）」是静态规则说明 ⇒ 标题行 `(?)`。
              settingsHintIcon(dgT("settings.minInterval")),
              h("input", {
                style: { ...S.promptInput, width: 38, flex: "none", padding: "2px 4px", textAlign: "center", fontSize: 12, boxSizing: "border-box" },
                type: "number",
                min: MIN_REFRESH_INTERVAL,
                step: 1,
                value: refreshIntervalInput,
                onChange: (e) => handleIntervalChange(e.target.value),
              }),
              h("span", { style: { ...S.meta, fontSize: 11, flexShrink: 0 } }, dgT("settings.seconds"))),
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
              settingsHintIcon(dgT("settings.liveDisabledHint"))),
          ]),
          // g-480：harness 模块开关（**workspace 级**：写 project.yaml 的 `modules` 段，随项目配置共享）。
          // 关闭 = **真裁剪**：该模块的 `graph_*` 工具从模型可见的工具清单里移除，且相关 systemPrompt
          // 段不再注入；只隐藏能力、**不删除任何数据**（记忆/卡片/附件一律原样保留，重新开启即恢复）。
          // 五个模块**默认全开**：未配置时与改造前逐字节一致。
          tabPanel("modules", [
            // g-488：两条页级说明（本页写 project.yaml / 作用范围与默认全开）合并挂到页首标题的 `(?)`，
            // 文案逐字保留（`settings.modulesNote` + `settings.modulesScopeNote`，顺序与改造前一致）。
            h("div", { style: { display: "flex", alignItems: "center", gap: 4, marginBottom: 6 } },
              h("div", { style: { fontWeight: 700 } }, dgT(SETTINGS_TAB_LABEL_KEYS.modules)),
              settingsHintIcon(dgT("settings.modulesNote") + " " + dgT("settings.modulesScopeNote"))),
            h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 } },
              MODULE_SWITCH_KEYS.map((k) =>
                h("div", { key: k, style: { display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0 } },
                  h("input", {
                    id: `dg-module-${k}`,
                    type: "checkbox",
                    // 未配置/null ⇒ 勾选（默认开启）；只有显式 false 才取消勾选
                    checked: form.modules?.[k] !== false,
                    onChange: (e) => set(["modules", k], e.target.checked),
                    style: { flexShrink: 0, marginTop: 2 },
                  }),
                  h("div", { style: { minWidth: 0 } },
                    h("div", { style: { display: "flex", alignItems: "center", gap: 4 } },
                      h("label", { htmlFor: `dg-module-${k}`, style: { fontWeight: 700, fontSize: 12, cursor: "pointer" } }, dgT(MODULE_LABEL_KEYS[k])),
                      // g-488：逐模块说明（关闭后会发生什么）搬到标签右侧 `(?)`，文案一字未改。
                      settingsHintIcon(dgT(MODULE_HINT_KEYS[k]))))))),
            // g-480（att-002）：宿主**不支持真裁剪**时（服务端 `trim_supported === false`）的**唯一一行**
            // 提示——如实说明「开关只记录配置、不改变工具与提示词面」。支持真裁剪的宿主上该行**不存在**；
            // 文案 zh/en 对称、en 侧零 CJK（对账断言在 core/tests/g480-modules.test.ts）。
            // g-488：这是**能力状态读数**（随服务端 `trim_supported` 变化），不进 tooltip、仍留正文。
            trimSupported === false
              ? h("div", {
                "data-dg-module-trim-unsupported": "1",
                style: { ...S.meta, marginTop: 6, fontSize: 11, color: "var(--dsw-alias-state-warn-primary, #e0b060)" },
              }, dgT(MODULE_TRIM_UNSUPPORTED_HINT_KEY))
              : null,
          ]),
          tabPanel("advanced", [
            // g-488：本页内容**恒显**（原「折叠是否展开」一族 inline `display` 三元已删——高级设置
            // 本身即页签，页签内再挂折叠开关是重复控件）。
            h("div", { style: { fontWeight: 700, marginBottom: 4 } }, dgT("settings.advanced")),
            // g-488：原 `defaults.review.reviewer` / `defaults.review.prompt` / `defaults.pk.lanes` /
            // `defaults.pk.sandbox` 四个输入框**只从界面移除**：四键均已被主管提示词与派发链路按固定
            // 缺省真实消费，界面上可编辑反而制造「改了也没用」的错觉。配置读兼容（core/ops.ts 的
            // needStr/整数校验、readProjectConfig、normalize/patch 叶子清单）**全部保留**。
            h("hr", { style: { border: "none", borderTop: "1px solid rgba(128,128,128,.25)", margin: "10px 0" } }),
            h("div", { style: { display: "flex", alignItems: "center", gap: 4, marginBottom: 4 } },
              h("div", { style: { fontWeight: 700 } }, dgT("settings.supervisorAutomation")),
              // g-488：六键的**总说明**（只影响主管提示、不构成引擎强制）搬到小节标题 `(?)`；
              // g-439 口径逐字保留（六键由主管提示真实消费）。
              settingsHintIcon(dgT("settings.automationHint"))),
            h("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 } },
              // g-272 att-002：原 Object.keys({...中文标签}) 的中文值从未被渲染（label 直接用 key），改为纯 key 数组消除死代码中文残留。
              ["scope_planning", "integration_decision", "rework", "memory_promotion", "skill_proposal", "release"].map((k) =>
                h("div", { key: k },
                  h("div", { style: { display: "flex", alignItems: "center", gap: 4, marginBottom: 2 } },
                    h("label", { style: { fontSize: 11, opacity: 0.8 } }, k),
                    // g-488：**逐键** `(?)`——每键一条，讲清「管什么 + human/ai 两种取值的含义」。
                    settingsHintIcon(dgT(AUTOMATION_HINT_KEYS[k]))),
                  h("select", { style: { ...S.promptInput, width: "100%" }, value: auto[k] ?? "", onChange: (e) => set(["supervisor", "automation", k], e.target.value === "" ? null : e.target.value) },
                    ...automationOptions(auto[k], automationUnsetScope[k] ?? null)),
                  // g-490：只要该键的未配置项显示具体 human/ai（= 服务端下发了它的 gate 范围来源），
                  // 就必须**同屏**渲染口径来源标注——绝不出现无来源的具体 human/ai。
                  automationUnsetScope[k] ? automationUnsetScopeNote(automationUnsetScope[k]) : null))),

            h("hr", { style: { border: "none", borderTop: "1px solid rgba(128,128,128,.25)", margin: "10px 0" } }),
            h("div", { style: { fontWeight: 700, marginBottom: 4 } }, dgT("settings.promptOverride")),
            promptOverride("subagent", dgT("settings.subagentPrompt")),
          ]),
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 6 } },
            h("button", { style: { ...S.btn, padding: "6px 16px", fontSize: 13 }, className: "dg-btn", disabled: saving, onClick: save },
              saving ? dgT("common.saving") : dgT("settings.saveBtn")),
            h("button", { style: { ...S.btn, padding: "6px 12px", fontSize: 12 }, className: "dg-btn", onClick: requestClose }, dgT("settings.closeBtn")),
            note ? h("span", { style: { ...S.meta, color: note.kind === "ok" ? "var(--dsw-alias-label-primary, #6ee7a0)" : "var(--dsw-alias-state-error-primary, #f08080)", marginLeft: 8 } }, note.text) : null),
          // g-490：`project.yaml` 行**已迁到标题栏右侧（关闭按钮左边）**——见 `projectYamlRow`。
          // 页脚不再有第二份（信息与入口零丢失，只是位置变更；绝不留双份）。
          error ? h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-error-primary, #f08080)", marginTop: 6 } }, error) : null));
    }

    // Source-contract compatibility: 保留未知键与注释; legacy inherited option "（继承父会话）".
    // g-246 close guard contract: window.confirm(dgT("settings.discardDirtyConfirm"))
    //   → zh「有未保存的修改，确认放弃？」/ en "You have unsaved changes. Discard them?"
    // g-488: 原「显示高级设置」折叠按钮及其 showAdvanced / hideAdvanced 两个 i18n 键已删除
    //   （高级设置本身即页签，页签内不再有第二层显隐开关）。
    // Contract text: if (saving) { setNote({ kind: "err", text: "正在保存，请稍候…" }); return; }
    // Contract text: "✅ 已打开 project.yaml"
