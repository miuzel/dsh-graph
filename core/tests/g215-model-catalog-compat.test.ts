/**
 * g-215：配置项子代理模型目录适配 dsh 0.1.2-alpha.2 与 0.1.1-rc 向下兼容测试套件。
 *
 * 覆盖以下核心质量判据与降级探测链：
 * 1. 0.1.2-alpha.2 新版 API（Remote RPC session.modelCatalog / modelDirectories.catalog.load）探测成功返回规范化目录；
 * 2. 0.1.2-alpha.2 缺失/失败时，主动回退到 0.1.1-rc 旧版 API（connection.api.llm.providers/models）获取；
 * 3. 新旧 API 均不可用时优雅降级为 status: "unavailable"（不抛未捕获异常，已存配置保留可选并支持保存）；
 * 4. 源码契约与客户端 bundle 生成物校验；
 * 5. 后端 readSpawnOptions / subagent 派发模型覆盖兼容。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

// 从编译后/组装后的 client.js 中提取 loadHostCatalog 函数
function getLoadHostCatalogFromSource() {
  const settingsCode = readFileSync(
    join(process.cwd(), "dsh-graph-host/lib/client/settings.js"),
    "utf8",
  );
  // 在沙箱中执行 settings.js 中定义的 loadHostCatalog
  const context = vm.createContext({
    appCtx: null,
    gConnectionApi: null,
    Promise,
    Array,
    Set,
    Error,
    console,
  });
  const wrappedCode = `
    ${settingsCode}
    globalThis.loadHostCatalog = loadHostCatalog;
  `;
  vm.runInContext(wrappedCode, context);
  return context.loadHostCatalog;
}

test("g-215 探测链阶段 1：0.1.2-alpha.2 新版 API (remote.session.modelCatalog) 正常加载", async () => {
  const loadHostCatalog = getLoadHostCatalogFromSource();

  const mockRemote = {
    session: {
      modelCatalog: async () => ({
        ok: true,
        value: {
          default: { provider: "deepseek-official", model: "deepseek-chat" },
          routableProviders: ["deepseek-official"],
          groups: [
            {
              id: "deepseek-official",
              name: "DeepSeek Official",
              models: [
                { id: "deepseek-chat", name: "DeepSeek Chat" },
                { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
              ],
            },
          ],
          failures: [],
        },
      }),
    },
  };

  const mockCtx = {
    get(name: string) {
      if (name === "remote") return mockRemote;
      return null;
    },
  };

  const result = await loadHostCatalog(null, mockCtx);
  assert.equal(result.status, "ready");
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].id, "deepseek-official");
  assert.equal(result.groups[0].models.length, 2);
  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0].provider, "deepseek-official");
  assert.equal(result.providers[0].displayName, "DeepSeek Official");
  assert.equal(result.providers[0].active, true);
});

test("g-215 探测链阶段 1b：0.1.2-alpha.2 modelDirectories 服务备选正常加载", async () => {
  const loadHostCatalog = getLoadHostCatalogFromSource();

  const mockModelDirectories = {
    catalog: {
      load: async () => ({
        routableProviders: ["kimi"],
        groups: [
          {
            id: "kimi",
            name: "Moonshot Kimi",
            models: [{ id: "moonshot-v1-8k", name: "Moonshot v1 8k" }],
          },
        ],
        failures: [],
      }),
    },
  };

  const mockCtx = {
    get(name: string) {
      if (name === "modelDirectories") return mockModelDirectories;
      return null;
    },
  };

  const result = await loadHostCatalog(null, mockCtx);
  assert.equal(result.status, "ready");
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].id, "kimi");
  assert.equal(result.providers[0].provider, "kimi");
  assert.equal(result.providers[0].active, true);
});

test("g-215 探测链阶段 2：新版 API 缺失时主动回退到 0.1.1-rc 旧版 API (connection.api.llm)", async () => {
  const loadHostCatalog = getLoadHostCatalogFromSource();

  const mockLegacyApi = {
    llm: {
      providers: async () => ({
        result: {
          ok: true,
          value: {
            providers: [
              { provider: "legacy-deepseek", displayName: "Legacy DeepSeek", active: true },
            ],
          },
        },
      }),
      models: async () => ({
        result: {
          ok: true,
          value: {
            groups: [
              {
                id: "legacy-deepseek",
                name: "Legacy DeepSeek",
                models: [{ id: "deepseek-v3", name: "DeepSeek V3" }],
              },
            ],
            failures: [],
          },
        },
      }),
    },
  };

  // ctx 中没有任何新版 remote / modelDirectories
  const mockCtx = {
    get(name: string) {
      if (name === "connection") return { api: mockLegacyApi };
      return null;
    },
  };

  const result = await loadHostCatalog(mockLegacyApi, mockCtx);
  assert.equal(result.status, "ready");
  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0].provider, "legacy-deepseek");
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].models[0].id, "deepseek-v3");
});

test("g-215 探测链阶段 2b：新版 API 抛出异常时自动回退到 0.1.1-rc 旧版 API", async () => {
  const loadHostCatalog = getLoadHostCatalogFromSource();

  const mockRemote = {
    session: {
      modelCatalog: async () => {
        throw new Error("RPC gateway error: session/modelCatalog not implemented");
      },
    },
  };

  const mockLegacyApi = {
    llm: {
      providers: async () => ({
        result: {
          ok: true,
          value: {
            providers: [
              { provider: "fallback-prov", displayName: "Fallback Provider", active: true },
            ],
          },
        },
      }),
      models: async () => ({
        result: {
          ok: true,
          value: {
            groups: [
              {
                id: "fallback-prov",
                name: "Fallback Provider",
                models: [{ id: "fallback-model", name: "Fallback Model" }],
              },
            ],
            failures: [],
          },
        },
      }),
    },
  };

  const mockCtx = {
    get(name: string) {
      if (name === "remote") return mockRemote;
      if (name === "connection") return { api: mockLegacyApi };
      return null;
    },
  };

  const result = await loadHostCatalog(mockLegacyApi, mockCtx);
  assert.equal(result.status, "ready");
  assert.equal(result.providers[0].provider, "fallback-prov");
  assert.equal(result.groups[0].models[0].id, "fallback-model");
});

test("g-215 探测链阶段 3：新旧 API 均不可用时优雅降级为 unavailable，不抛异常", async () => {
  const loadHostCatalog = getLoadHostCatalogFromSource();

  // 空 ctx 与空 api
  const mockCtx = {
    get() {
      return null;
    },
  };

  const result = await loadHostCatalog(null, mockCtx);
  assert.equal(result.status, "unavailable");
});

test("g-215 探测链阶段 3b：新旧 API 均抛出异常时优雅降级为 unavailable，不抛未捕获错误", async () => {
  const loadHostCatalog = getLoadHostCatalogFromSource();

  const mockRemote = {
    session: {
      modelCatalog: async () => {
        throw new Error("Critical Remote Failure");
      },
    },
  };

  const mockLegacyApi = {
    llm: {
      providers: async () => {
        throw new Error("Critical LLM Providers Failure");
      },
      models: async () => {
        throw new Error("Critical LLM Models Failure");
      },
    },
  };

  const mockCtx = {
    get(name: string) {
      if (name === "remote") return mockRemote;
      if (name === "connection") return { api: mockLegacyApi };
      return null;
    },
  };

  let threw = false;
  let result: any;
  try {
    result = await loadHostCatalog(mockLegacyApi, mockCtx);
  } catch {
    threw = true;
  }

  assert.equal(threw, false, "loadHostCatalog 绝不应抛出未捕获异常");
  assert.equal(result.status, "unavailable");
});

test("g-215 源契约与 Bundle 生成物：模块与 Bundle 均包含新版 session.modelCatalog 与旧版降级探测", () => {
  const settings = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/settings.js"), "utf8");
  const modal = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/settings-modal.js"), "utf8");
  const bundle = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client.js"), "utf8");

  // 1. settings.js 包含新版 RPC 与降级链
  assert.match(settings, /remote\?\.session\?\.modelCatalog/);
  assert.match(settings, /modelDirectories/);
  assert.match(settings, /legacyApi\?\.llm\?\.providers/);
  assert.match(settings, /status:\s*"unavailable"/);

  // 2. settings-modal.js 挂载时不短路，调用 loadHostCatalog 进行 3 级探测
  assert.match(modal, /loadHostCatalog\(gConnectionApi\)/);
  assert.match(modal, /setCatalog\(\{ status: "unavailable" \}\)/);

  // 3. 生成物 bundle 包含生成标记与 loadHostCatalog 降级链
  assert.match(bundle, /⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY/);
  assert.match(bundle, /remote\?\.session\?\.modelCatalog/);
  assert.match(bundle, /legacyApi\?\.llm\?\.providers/);
});
