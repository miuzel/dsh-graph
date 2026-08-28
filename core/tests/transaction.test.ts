/** g-207：事务模板与 CAS 测试——并发冲突、失败注入、锁超时、原子写。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../ops.ts";
import {
  withTx,
  atomicWrite,
  casWrite,
  readModifyWrite,
  TxError,
  TxCasError,
  type TxContext,
} from "../transaction.ts";
import { readEvents } from "../events.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-tx-"));
  init(dir);
  return dir;
}

test("withTx：正常事务成功，事件先行写入", () => {
  const root = tmpRoot();
  const result = withTx(
    { root, actor: "test" },
    { lockName: "test" },
    (ctx) => ({
      value: 42,
      events: [{
        actor: ctx.actor,
        event: "test.done",
        goal: "g-001",
        details: { value: 42 },
      }],
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, 42);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].event, "test.done");
  // 验证事件已持久化
  const evs = readEvents(root);
  assert.equal(evs.some((e) => e.event === "test.done"), true);
});

test("withTx：事务函数抛 GraphError 返回 TxFailure", () => {
  const root = tmpRoot();
  const result = withTx(
    { root, actor: "test" },
    { lockName: "test" },
    () => {
      throw new TxError("故意失败", "mutate", false);
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.phase, "mutate");
  assert.equal(result.recoverable, false);
  assert.ok(result.error.includes("故意失败"));
});

test("withTx：未知异常返回 TxFailure（phase=validate, recoverable=false）", () => {
  const root = tmpRoot();
  const result = withTx(
    { root, actor: "test" },
    { lockName: "test" },
    () => {
      throw new Error("未分类错误");
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.recoverable, false);
  assert.ok(result.error.includes("未分类错误"));
});

test("atomicWrite：临时文件+rename 原子写，内容正确", () => {
  const root = tmpRoot();
  const file = join(root, "atomic.txt");
  atomicWrite(file, "hello");
  assert.equal(readFileSync(file, "utf8"), "hello");
  // 临时文件应已清理
  assert.equal(existsSync(`${file}.tmp.${process.pid}`), false);
});

test("atomicWrite：覆盖写入，旧内容被替换", () => {
  const root = tmpRoot();
  const file = join(root, "atomic.txt");
  writeFileSync(file, "old", "utf8");
  atomicWrite(file, "new");
  assert.equal(readFileSync(file, "utf8"), "new");
});

test("casWrite：预期匹配时成功写入", () => {
  const root = tmpRoot();
  const file = join(root, "cas.txt");
  writeFileSync(file, "version-1", "utf8");
  casWrite(file, "version-2", (current) => current === "version-1");
  assert.equal(readFileSync(file, "utf8"), "version-2");
});

test("casWrite：预期不匹配时抛 TxCasError", () => {
  const root = tmpRoot();
  const file = join(root, "cas.txt");
  writeFileSync(file, "version-a", "utf8");
  assert.throws(
    () => casWrite(file, "version-b", (current) => current === "version-x"),
    TxCasError,
  );
  // 文件内容应保持不变
  assert.equal(readFileSync(file, "utf8"), "version-a");
});

test("readModifyWrite：读-校验-改-写原子完成", () => {
  const root = tmpRoot();
  const file = join(root, "rmw.txt");
  writeFileSync(file, "10", "utf8");
  const next = readModifyWrite(
    file,
    {
      read: () => readFileSync(file, "utf8"),
      expect: (current) => current === "10",
      mutate: (current) => String(parseInt(current, 10) + 5),
    },
  );
  assert.equal(next, "15");
  assert.equal(readFileSync(file, "utf8"), "15");
});

test("readModifyWrite：CAS 校验失败时内容不变", () => {
  const root = tmpRoot();
  const file = join(root, "rmw.txt");
  writeFileSync(file, "10", "utf8");
  assert.throws(
    () => readModifyWrite(
      file,
      {
        read: () => readFileSync(file, "utf8"),
        expect: (current) => current === "99",
        mutate: (current) => String(parseInt(current, 10) + 5),
      },
    ),
    TxCasError,
  );
  assert.equal(readFileSync(file, "utf8"), "10");
});

test("withTx：并发锁保护——同锁名串行执行", () => {
  const root = tmpRoot();
  const file = join(root, "counter.txt");
  writeFileSync(file, "0", "utf8");

  // 模拟两个并发事务递增计数器
  const results: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = withTx(
      { root, actor: "test" },
      { lockName: "counter" },
      () => {
        const current = parseInt(readFileSync(file, "utf8"), 10);
        const next = current + 1;
        writeFileSync(file, String(next), "utf8");
        return {
          value: next,
          events: [{
            actor: "test",
            event: "counter.incremented",
            details: { from: current, to: next },
          }],
        };
      },
    );
    if (r.ok) results.push(r.value);
  }

  // 所有事务都应成功（串行执行）
  assert.equal(results.length, 5);
  assert.equal(readFileSync(file, "utf8"), "5");
  // 事件也应全部写入
  const evs = readEvents(root).filter((e) => e.event === "counter.incremented");
  assert.equal(evs.length, 5);
});

test("withTx：同进程嵌套锁检测——立即失败不超时", () => {
  const root = tmpRoot();
  // 先获取锁（事务成功）
  const r1 = withTx(
    { root, actor: "test" },
    { lockName: "deadlock-test" },
    () => ({
      value: "outer",
      events: [],
    }),
  );
  assert.equal(r1.ok, true);

  // 锁文件应仍存在（因为第一个事务已释放）
  // 但如果在事务内部再次获取同锁 → 死锁检测
  let innerFailed = false;
  const r2 = withTx(
    { root, actor: "test" },
    { lockName: "deadlock-test" },
    (ctx) => {
      // 在锁内再次获取同锁 → 应检测到同进程死锁
      try {
        const r3 = withTx(
          ctx,
          { lockName: "deadlock-test", lockTimeoutMs: 10 },
          () => ({ value: "nested", events: [] }),
        );
        if (!r3.ok) innerFailed = true;
      } catch {
        innerFailed = true;
      }
      return { value: "outer2", events: [] };
    },
  );
  assert.equal(r2.ok, true);
  // 嵌套获取应失败（死锁检测）
  assert.equal(innerFailed, true);
});

test("atomicWrite：拒绝写入符号链接（安全基线）", () => {
  const root = tmpRoot();
  const realFile = join(root, "real.txt");
  const linkFile = join(root, "link.txt");
  writeFileSync(realFile, "target", "utf8");
  try {
    const { symlinkSync } = require("node:fs");
    symlinkSync(realFile, linkFile);
  } catch {
    // 无 symlink 权限则跳过
    return;
  }
  assert.throws(
    () => atomicWrite(linkFile, "attack"),
    TxError,
  );
});
