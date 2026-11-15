import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeContinuableProvider } from '../../dist/index.js';

const ready = { prepareContinuable() {} };
test('rc1 enumeration preserves custom provider and distinguishes empty', () => {
  assert.equal(probeContinuableProvider({ list: () => ['custom'], getProvider: () => ready }).provider, 'custom');
  assert.match(probeContinuableProvider({ list: () => [], getProvider: () => undefined }).error, /已注册：无/);
});
test('rc3 named queries find spawn or fork and do not assert global emptiness', () => {
  for (const name of ['spawn', 'fork']) assert.equal(probeContinuableProvider({ getProvider: (n: string) => n === name ? ready : undefined }).provider, name);
  assert.match(probeContinuableProvider({ getProvider: () => undefined }).error, /自定义 provider 无法枚举/);
});
test('missing API and query exceptions remain unknown', () => {
  assert.match(probeContinuableProvider({}).error, /API 不可用/);
  assert.match(probeContinuableProvider({ getProvider: () => { throw Error('boom'); } }).error, /查询异常.*boom/);
  assert.match(probeContinuableProvider({ list: () => { throw Error('bad list'); }, getProvider: () => ready }).error, /查询异常.*bad list/);
  assert.match(probeContinuableProvider({ list: () => undefined, getProvider: () => ready }).error, /查询异常/);
});
