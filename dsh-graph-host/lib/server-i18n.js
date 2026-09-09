// Server-side bilingual strings for graph_* tool metadata and host prompts.
// Keep keys symmetric so adding a language is an additive operation.
const zh = Object.freeze({
  reportStatus: "汇报当前 attempt 的一句最新工作状态（会显示在看板卡片上）；state 必须使用 working/blocked/done/error。",
  promptLanguage: "提示词语言：follow/zh/en；follow 跟随 DSH locale，解析失败回退中文。",
  stateWorking: "进行中",
  stateBlocked: "阻塞",
  stateDone: "完成",
  stateError: "错误",
});
const en = Object.freeze({
  reportStatus: "Report the latest attempt status shown on the board; state must be working/blocked/done/error.",
  promptLanguage: "Prompt language: follow/zh/en; follow uses the DSH locale and falls back to Chinese when unavailable.",
  stateWorking: "working",
  stateBlocked: "blocked",
  stateDone: "done",
  stateError: "error",
});

export const SERVER_I18N = Object.freeze({ zh, en });
export const SERVER_I18N_KEYS = Object.freeze(Object.keys(zh));
export function sT(key, language = "zh") {
  const lang = language === "en" ? "en" : "zh";
  return SERVER_I18N[lang][key] ?? SERVER_I18N.zh[key] ?? SERVER_I18N.en[key] ?? key;
}

export function assertServerI18nParity() {
  const a = Object.keys(zh).sort();
  const b = Object.keys(en).sort();
  if (a.length !== b.length || a.some((key, i) => key !== b[i])) throw new Error("server i18n dictionaries are not symmetric");
  return true;
}
