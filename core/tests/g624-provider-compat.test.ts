import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeContinuableProvider } from '../../dist/index.js';

// g-627：宿主下限 >=0.2.2-rc.1，`subagents.list()`（provider 枚举）已删除 ⇒ 只保留具名查询。
// 明确保留：缺 API / 查询抛错 / 两个默认名都无能力 ⇒ 一律「不可确认」（provider=null + 可读 error）。
const ready = { prepareContinuable() {} };

test('具名查询命中 spawn / fork（默认 provider 名固定）', () => {
  for (const name of ['spawn', 'fork']) {
    assert.equal(probeContinuableProvider({ getProvider: (n: string) => n === name ? ready : undefined }).provider, name);
  }
});

test('两个默认名都无 prepareContinuable ⇒ 不可确认，且如实说明自定义 provider 无法枚举', () => {
  // 负向对照：即便宿主**还**带着 list()（旧开集的枚举 API），也不得再读它
  const legacy = { list: () => ['custom'], getProvider: () => undefined };
  assert.equal(probeContinuableProvider(legacy).provider, null);
  assert.match(probeContinuableProvider({ getProvider: () => undefined }).error, /自定义 provider 无法枚举/);
});

test('list() 枚举分支已删除：只有 list() 没有 getProvider 的宿主判为不可确认', () => {
  const only = { list: () => ['custom'], getProvider: undefined };
  assert.equal(probeContinuableProvider(only as any).provider, null);
  assert.match(probeContinuableProvider(only as any).error, /API 不可用/);
});

test('缺 API 与查询异常仍是 unknown（fail-closed，不猜）', () => {
  assert.match(probeContinuableProvider({}).error, /API 不可用/);
  assert.match(probeContinuableProvider({ getProvider: () => { throw Error('boom'); } }).error, /查询异常.*boom/);
  // 宿主若仍带 list()，其异常也绝不能影响具名查询结果
  assert.equal(probeContinuableProvider({ list: () => { throw Error('bad list'); }, getProvider: () => ready }).provider, 'spawn');
});
