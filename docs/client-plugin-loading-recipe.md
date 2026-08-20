# 第三方 client-plugin 加载进 DSH Web GUI —— 实机验证配方

验证环境：Node v26.7.0 · DSH 安装 `~/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/`
· 隔离 `DSH_HOME=tmp/client-probe/home` + 端口 4299（**未触碰** `~/.dsh/profiles/web`，实测其 package.json 无插件痕迹）
· 对照项目：github.com/StruggleYang/dsh-project-kanban v0.8.3（已克隆到 `tmp/dsh-project-kanban/`）。

可复现验证台：`tmp/client-probe/dsh-hello-client/`（最小双半插件，手写、零构建）。清理：`rm -rf tmp/client-probe`。

---

## 1. host 如何发现并 serving client bundle

**机制**（`@deepseek-ai/dsh-client-modules/lib/index.js`，`ClientModuleRegistry`，由 dsh-web-app 组合挂载）：

1. 扫描宿主 cordis Loader 的**已启用条目**（`entry.fiber !== void 0 && !entry.disabled`）——即 client 插件的**宿主半边必须先作为普通插件激活**（经 bundle patch / insert 任一 host 路径）；
2. 按条目名 `require.resolve('<name>/package.json')`（基准 `ctx.baseUrl` = profile 目录），读 `dsh.client` 声明；`platform !== 'web'` 或无声明 → 跳过（结果永久缓存，**改包集要重启**）；
3. 解析 `exports["./client"]`（字符串或 `{default}` 条件形），读文件算 sha1-12 作为 `rev`；
4. `tapIndex` 往 index.html `<head>` 注入：`__ModuleLoader__` 排队门面 → modules/runtime 两个 parser-blocking `<script src>` → `<script>window.__DSH_BOOT__ = {rev, entries:[{id,url,rev,inject,immediately,external}]}</script>`；
5. `webServer.register({kind:'prefix', path:'/plugins', handler})` 服务 `/plugins/<id>/client.js[.map]`，**原样读文件**，`content-type: text/javascript`，`cache-control: no-cache`。

**格式无构建门禁**：serving 层不认 tsdown 产物——唯一契约在浏览器侧（classic script 调 `__ModuleLoader__.load`）。**手写纯 JS、不用 React 语法的 client.js 实测可 serving 且格式正确**（见 §3 证据）。

实测输出（`dsh web --port 4299 --no-open`，隔离 home）：

```
$ curl -s http://127.0.0.1:4299/ | grep -o '{"id":"dsh-hello-client"[^}]*}'
{"id":"dsh-hello-client","url":"/plugins/dsh-hello-client/client.js?rev=090ad458c28a","rev":"090ad458c28a","inject":["@deepseek-ai/dsh-client-runtime"]}
$ curl -sI http://127.0.0.1:4299/plugins/dsh-hello-client/client.js
HTTP/1.1 200 OK · content-type: text/javascript; charset=utf-8 · cache-control: no-cache
```

负向：未知 id → 404；无 `client.js.map` → 404（浏览器静默忽略，无害）；`dsh.client` 声明了但 bundle 文件缺失 → 激活期 `MissingClientBundleError` 聚合抛出，**整个 web 启动失败**。

## 2. 手写 client.js 最小骨架契约

**加载模型**（`dsh-client-modules/lib/client.js`，惰性 CJS 表）：

- bundle 是 **classic script**（不是 ESM！不得用 `import/export` 顶层语法）；执行时只做一件事：
  `window.__ModuleLoader__.load({ id: '<包名>', factory })`——只注册，不跑副作用；
- `factory(require)` 在 cordis 条目物化时同步执行，`return` 插件面（CJS 风格 exports 对象）：
  `{ name, inject: ['slots', ...], apply(ctx) }`——**`inject` 是客户端 cordis 服务名**；
- `require(spec)` 应答顺序：平台种子词 → 已物化模块 → 已注册 factory → 否则抛错。
  **种子词**（外壳 `staticModules`，见 dsh-web-frontend dist）：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`；
  其余包（如 `@deepseek-ai/dsh-client-runtime[/client]`）走 `__DSH_BOOT__` 图行动态到达；
- 包间依赖：在 `dsh.client.external` 声明精确 specifier，宿主排序成「提供方先于消费者」；`dsh.client.inject`（包名）进 wire row 仅作名录/校验，**boot 不消费它**（服务等待靠模块 `exports.inject`——dsh-project-kanban 把它填成服务名也能跑，官方约定是包名，建议照官方）。

**apply(ctx) 可用的客户端服务**（实测/官方 bundle 佐证）：`slots`（SlotRegistry）、`sessions`、`workspaces`、`remote`（`ctx.remote.$on/$dispatch` + 领域 facade 如 `remote.goals`）、`locale`、`conversationEvents`、`conversationViews`、`modules`（ClientModuleLoader）、`loader`（vendored cordis Loader）、`logger`；通用 `ctx.get(name)`/`ctx.effect()`/`ctx.on()`。

**UI 注册**（dsh-project-kanban 与本探针同款）：

```js
ctx.slots.inject('conversation.view', () =>           // 声明存在即同步跑，否则等待；随 fiber 拆卸
  ctx.slots.register(
    { name: 'conversation.view', id: 'hello-client', order: 90, label: 'Hello' },
    (props) => h(MyView, props)))                     // component 必须是 React 组件
```

**React 问题**：slot 渲染器是 React（ui-renderer），**注册进 slot 的组件必须返回 React 元素**；但组件内部可以 `useRef`+`useEffect` 里做纯 DOM 操作。完全不要 React 的唯一路径是不进 slot、直接在 `apply` 里 `document.body.appendChild`（失去布局/生命周期管理，不推荐）。JSX 不必要——`require('react')` 的 `createElement` 即可（dsh-project-kanban 全量如此）。

## 3. 最小骨架文件清单（已实机通过）

`tmp/client-probe/dsh-hello-client/`（4 个文件，全文即验证台）：

- `package.json`：`"main":"index.js"`；`exports` 含 `"."`、`"./client":"./lib/client.js"`、`"./cordis.patch.yml"`、`"./package.json"`；
  `"dsh":{"bundle":{"patch":"./cordis.patch.yml"},"client":{"platform":"web","inject":["@deepseek-ai/dsh-client-runtime"]}}`
- `cordis.patch.yml`：`- insert: [{ id: dsh-hello-client, name: dsh-hello-client }]`（裸包名）
- `index.js`（host 半）：`export const name/inject=['webServer']`；`apply` 里 `ctx.effect(() => ctx.webServer.register({kind:'exact', path:'/api/hello-client', handler:(req,res)=>…JSON…}))`；**禁止 export default**
- `lib/client.js`（浏览器半）：§2 的 `__ModuleLoader__.load({id, factory})` 骨架；`require('react')`；`inject:['slots']`；`apply` 里 `slots.inject('conversation.view', …)`

**安装与验证**（命令实机跑过；`dsh` = `node $D/dsh/lib/bin.js`）：

```sh
export DSH_HOME=$PWD/tmp/client-probe/home          # 隔离；真实环境省略
dsh --profile web --dump-default-config >/dev/null  # 首用自动初始化 web profile 模板
dsh plugin --profile web add <插件路径> --store-dir <可写store>   # 自动进 bundles（dsh.bundle.patch 生效）
dsh --profile web --dump-config | tail -4           # 看到 "# == dsh-hello-client" 归属行
dsh web --port 4299 --no-open                       # 后台启动
curl -s http://127.0.0.1:4299/ | grep -o '__DSH_BOOT__.*'        # 图里有本插件行
curl -sI http://127.0.0.1:4299/plugins/dsh-hello-client/client.js # 200 text/javascript
curl -s http://127.0.0.1:4299/api/hello-client      # {"ok":true,"marker":"dsh-hello-client-alive",…}
```

Node 侧模拟浏览器契约（无浏览器 smoke）：`new Function('window', code)({__ModuleLoader__:{load(r){…}}})` 收集注册 → `factory(require桩)` → 断言导出 `{name,inject,apply}` → 用假 `ctx.slots` 跑 `apply`。探针实测输出：`registered id: dsh-hello-client · exports keys: name,inject,apply · apply calls: [["slots.inject","conversation.view"],["slots.register","conversation.view","hello-client","Hello"]] · SMOKE OK`。

## 4. 数据通道（client ↔ host）

**host 侧**（`dsh-host-webserver`）：`ctx.webServer.register({kind:'exact'|'prefix', path, handler(req,res)})`（裸 node:http handler，返回 disposer，走 `ctx.effect`）；同表重复 path 抛错；`registerUpgrade` 做 WS；`registerFallback`/`tapIndex` 另有主。服务名 `webServer`，**host 插件直接 `inject:['webServer']` 即可**（dsh-project-kanban 因要兼容无 webserver 的组合才用 `ctx.get`+轮询，纯 web 场景不必）。

**client 侧**：同源 `fetch('/api/hello-client')` 即可（页面与 API 同端口，无 CORS）。POST JSON 约定自定（kanban 用 `{method, args}` 单端点分发）。WS 实时推送则用 `registerUpgrade` 自建，或升级走 `ctx.remote` 领域通道（重，先不必）。

## 5. 坑与限制（实测）

1. **client bundle 缺失/声明畸形 = 整个 web 启动失败**（`ClientPackageCompositionError` 聚合抛出）；浏览器侧任一插件激活失败 = 整个 GUI 停在 "Failed to load plugins" 页（shell `assertEntriesActive`）。第三方插件出错爆炸半径是全局的。
2. bundle 必须是 classic script：顶层 `import/export` 会直接 SyntaxError；`load()` 的 `id` 必须与包名一致（`stripClientSuffix` 归一 `<id>/client`→`<id>`）；重复注册同一 id 抛错。
3. 包元数据（是否 client 包）**激活期缓存且永不过期**：增删 client 插件必须重启 host；bundle 内容变更只有 HMR watcher（源码 checkout 的 `pnpm run dev:web`）调 `rebuilt()` 才更新 rev——无 watcher 时改 `client.js` 后**刷新页面即可拿到新内容**（no-cache + 每次读文件），但 URL 上的 rev 不变、无热替换。
4. 客户端 `loader.unload` 是 stub——client 插件运行时不可卸载，调试用刷新/重启。
5. 从 `@deepseek-ai/dsh-client-runtime` 导入值必须 `require('@deepseek-ai/dsh-client-runtime/client')`（图行别名到包行）；裸包名不在种子表时会走图行同一份，但官方警告：不在 externals 表的裸名会内联第二实例（scope-tag Symbol 失配）。
6. 本沙箱：pnpm 需 `--store-dir` 可写目录；`/tmp` 跨 bash 调用不保留（探针台放工作区 `tmp/`，已 gitignore）。

## 6. 给 dsh-graph-client 的结构建议

```
dsh-graph-client/                # 单包双半（对照 kanban，不必拆两包）
  package.json                   # dsh.bundle.patch + dsh.client{platform:web, inject:["@deepseek-ai/dsh-client-runtime"]}
  cordis.patch.yml               # insert 自己
  index.js                       # host 半：inject:['webServer']（要工具再加 'tools'）
                                 #   register exact 路由 /api/dsh-graph → 读 .dsh-graph 返回 JSON
  lib/client.js                  # 手写 __ModuleLoader__ 骨架；require('react') 种子
                                 #   apply: slots.inject('conversation.view', register({id:'graph', label:'图谱', order}, View))
                                 #   View 内 fetch('/api/dsh-graph') 渲染二维泳道卡片墙
```

- **不需要会话功能**：仍建议用 `conversation.view`（会话头标签页挂点，声明式注入、随 fiber 生命周期）；看板数据与会话无关就在 host 端直接读 `.dsh-graph` 目录，client 不碰 `ctx.sessions`。
- 泳道看板渲染：先 React.createElement 直写（kanban 已证明 200+ 行 UI 可行）；交互重再在组件内挂 DOM/SVG。
- 数据通道：单端点 `{method, args}` JSON POST（kanban 模式，易加方法）；只读场景 GET 即可。
- host 半若要复用 `core/`（零依赖 TS 库）：保持「host 薄适配层 + core 纯逻辑」，`core/` 可被 Node 26 直跑。
- 演进路径：手写 bundle 验证 → 需要 CSS 管线/多文件时再上 tsdown（`exports["./client"]` 指产物即可，宿主无构建要求）。

## 运维事实补充（发现#17）

- client 半边（lib/client.js）变更：浏览器刷新即生效；
- host 半边（index.js，如注册的 HTTP 端点）变更：**需重启 dsh web** 才会重新执行 apply；
  症状是旧端点/旧字段继续服务。开发与验收时务必区分两边。
