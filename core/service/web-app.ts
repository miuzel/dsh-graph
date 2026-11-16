/**
 * g-623：内置只读 Web App（**静态资源**，零构建、零依赖、零磁盘访问）。
 *
 * 判据 1 / 8：
 * - 浏览器**不直接读写磁盘**：页面只通过同 origin 的 `/api/*` 读取服务端投影；
 * - 静态 bundle 里**不含任何秘密**：token 只由人在本地 UI 粘贴后经同 origin API 换取
 *   HttpOnly 会话 Cookie，页面自身的 JS **不**接触 token（不写 localStorage/sessionStorage、不进 URL）；
 * - 设置页只展示，写控件禁用并说明原因（MVP 只读）。
 *
 * 所有字符串在这里是常量，不含 `${}` 拼接（便于守卫断言「bundle 无 secret 插值」）。
 */

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>dsh-graph 本地只读看板</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="bar">
  <h1>dsh-graph 本地看板</h1>
  <span id="mode" class="badge">只读</span>
  <button id="lock" type="button" hidden>锁定</button>
</header>
<section id="login" class="card">
  <h2>本地登录</h2>
  <p class="hint">粘贴本机私有凭据文件中的 token（仅经本页同 origin 请求换会话 Cookie，不进入 URL、不写入浏览器存储）。</p>
  <form id="login-form" autocomplete="off">
    <input id="token" type="password" name="token" placeholder="本地 token" aria-label="本地 token" required>
    <button type="submit">登录</button>
  </form>
  <p id="login-error" class="error" role="alert"></p>
</section>
<main id="app" hidden>
  <nav class="tabs" role="tablist">
    <button class="tab" data-tab="goals" type="button">目标</button>
    <button class="tab" data-tab="versions" type="button">版本</button>
    <button class="tab" data-tab="settings" type="button">设置</button>
  </nav>
  <section id="panel-goals" class="panel">
    <ul id="goal-list" class="list"></ul>
    <article id="goal-detail" class="card" hidden></article>
  </section>
  <section id="panel-versions" class="panel" hidden>
    <ul id="version-list" class="list"></ul>
  </section>
  <section id="panel-settings" class="panel" hidden>
    <p class="hint" id="settings-note">设置只读展示（真源为看板内的既有项目配置，本页不复制、不回写）。</p>
    <pre id="settings-body" class="mono"></pre>
  </section>
</main>
<footer class="foot"><span id="status" class="mono"></span></footer>
<script src="/app.js"></script>
</body>
</html>
`;

const APP_CSS = `:root{color-scheme:light dark;--fg:#1c1c1e;--bg:#fafafa;--card:#fff;--line:#d8d8dc;--accent:#0a6cff;--err:#c0392b}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8ea;--bg:#161618;--card:#1f1f22;--line:#33333a;--accent:#5b9dff;--err:#ff7b6b}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}
.bar{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)}
.bar h1{font-size:16px;margin:0}
.badge{margin-left:auto;padding:2px 8px;border:1px solid var(--line);border-radius:999px;font-size:12px}
main{padding:16px;max-width:980px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:12px 0}
#login{max-width:520px;margin:24px auto}
.hint{opacity:.75;font-size:13px}
.error{color:var(--err);min-height:1.4em;margin:6px 0 0}
input[type=password]{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit}
button{padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:inherit;cursor:pointer}
button:hover{border-color:var(--accent)}
.tabs{display:flex;gap:8px;margin-bottom:8px}
.tab[aria-selected=true]{border-color:var(--accent);color:var(--accent)}
.list{list-style:none;padding:0;margin:0}
.list li{padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;cursor:pointer;background:var(--card)}
.list li:hover{border-color:var(--accent)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word}
.foot{padding:10px 16px;border-top:1px solid var(--line)}
.disabled{opacity:.55;cursor:not-allowed}
.criteria{margin:0;padding-left:20px}
.verified{color:#2e7d32}
`;

const APP_JS = `"use strict";
// g-623：只读 Web App。所有数据经同 origin 的 /api/* 读取；本文件**不**接触 token 字符串，
// 也**不**写入 localStorage/sessionStorage（会话在 HttpOnly Cookie 里）。
(function () {
  var state = { tab: "goals", goalId: null };
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text !== undefined) n.textContent = String(text);
    return n;
  }
  function setStatus(text) { $("status").textContent = text || ""; }
  function loginError(text) { $("login-error").textContent = text || ""; }

  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: "same-origin", headers: { accept: "application/json" } }, opts || {}))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) {
            var err = new Error((body && (body.message || body.error)) || ("HTTP " + res.status));
            err.status = res.status; err.code = body && body.code;
            throw err;
          }
          return body;
        });
      });
  }

  function showApp(loggedIn) {
    $("login").hidden = loggedIn;
    $("app").hidden = !loggedIn;
    $("lock").hidden = !loggedIn;
  }

  function switchTab(name) {
    state.tab = name;
    ["goals", "versions", "settings"].forEach(function (t) {
      $("panel-" + t).hidden = t !== name;
    });
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
      b.setAttribute("aria-selected", String(b.getAttribute("data-tab") === name));
    });
    if (name === "goals") loadGoals();
    if (name === "versions") loadVersions();
    if (name === "settings") loadSettings();
  }

  function loadGoals() {
    setStatus("读取目标…");
    return api("/api/goals").then(function (rows) {
      var list = $("goal-list");
      list.textContent = "";
      if (!rows.length) list.appendChild(el("li", { class: "disabled" }, "（没有目标）"));
      rows.forEach(function (g) {
        var item = el("li", { "data-goal": g.id }, (g.id || "") + " · " + (g.title || "") + " · " + (g.status || ""));
        item.addEventListener("click", function () { loadGoal(g.id); });
        list.appendChild(item);
      });
      setStatus("目标 " + rows.length + " 个");
    }).catch(fail);
  }

  function loadGoal(id) {
    state.goalId = id;
    setStatus("读取目标 " + id + "…");
    return api("/api/goal?goal=" + encodeURIComponent(id)).then(function (d) {
      var box = $("goal-detail");
      box.textContent = "";
      box.hidden = false;
      box.appendChild(el("h2", null, (d.meta && d.meta.id ? d.meta.id : id) + " · " + (d.meta && d.meta.title ? d.meta.title : "")));
      box.appendChild(el("p", null, "状态：" + ((d.meta && d.meta.status) || "未知")));
      box.appendChild(el("h3", null, "目标描述"));
      box.appendChild(el("pre", { class: "mono" }, d.description || "（空）"));
      box.appendChild(el("h3", null, "质量判据"));
      var ul = el("ul", { class: "criteria" });
      (d.criteria_items || []).forEach(function (c) {
        ul.appendChild(el("li", { class: /✅已验\\s*$/.test(c) ? "verified" : "" }, c));
      });
      box.appendChild(ul);
      var cards = d.cards || [];
      box.appendChild(el("h3", null, "卡片（" + cards.length + "）"));
      cards.forEach(function (c) {
        box.appendChild(el("div", { class: "card" }, (c.id || "") + " · " + (c.title || "") + " · " + (c.status || "")));
      });
      setStatus("已读取 " + id);
    }).catch(fail);
  }

  function loadVersions() {
    setStatus("读取版本…");
    return api("/api/versions").then(function (rows) {
      var list = $("version-list");
      list.textContent = "";
      if (!rows.length) list.appendChild(el("li", { class: "disabled" }, "（没有版本）"));
      rows.forEach(function (v) {
        list.appendChild(el("li", null, (v.slug || "") + " · " + (v.name || "") + " · " + (v.status || "") + " · " + (v.goals_count || 0) + " 个目标"));
      });
      setStatus("版本 " + rows.length + " 个");
    }).catch(fail);
  }

  function loadSettings() {
    setStatus("读取设置…");
    return api("/api/settings").then(function (s) {
      $("settings-note").textContent = s.writeDisabledReason || "设置只读展示。";
      $("settings-body").textContent = JSON.stringify(s, null, 2);
      setStatus("设置只读");
    }).catch(fail);
  }

  function fail(err) {
    if (err && err.status === 401) { showApp(false); loginError("会话已失效，请重新登录。"); return; }
    setStatus("错误：" + (err && err.message ? err.message : String(err)));
  }

  $("login-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    loginError("");
    var input = $("token");
    var value = input.value;
    input.value = "";
    api("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: value }) })
      .then(function () { showApp(true); switchTab("goals"); })
      .catch(function (err) {
        showApp(false);
        loginError(err && err.status === 401 ? "token 不正确。" : ("登录失败：" + (err && err.message ? err.message : "")));
      });
  });

  $("lock").addEventListener("click", function () {
    api("/api/session", { method: "DELETE" }).then(function () { showApp(false); }).catch(function () { showApp(false); });
  });

  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
    b.addEventListener("click", function () { switchTab(b.getAttribute("data-tab")); });
  });

  showApp(false);
  api("/api/session").then(function (s) {
    if (s && s.authenticated) { showApp(true); switchTab("goals"); }
  }).catch(function () { showApp(false); });
})();
`;

export const STATIC_ROUTES: Readonly<Record<string, { contentType: string; body: string }>> = Object.freeze({
  "/": { contentType: "text/html; charset=utf-8", body: INDEX_HTML },
  "/app.js": { contentType: "text/javascript; charset=utf-8", body: APP_JS },
  "/app.css": { contentType: "text/css; charset=utf-8", body: APP_CSS },
});
