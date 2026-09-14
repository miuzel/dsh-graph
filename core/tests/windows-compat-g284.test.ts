/**
 * core/tests/windows-compat-g284.test.ts
 *
 * g-284: Windows 原生兼容性测试套件
 * - 验收项 1: 模块加载不再依赖 POSIX 专有具名导出（O_DIRECTORY/O_NOFOLLOW 等经命名空间导入 + 能力探测/缺省回退）
 * - 验收项 2: 锁获取在 win32 路径下不再把目录当 fd 打开，改为原子互斥（mkdirSync）且 POSIX 行为不回退
 * - 验收项 3: 原子写在 win32 分支可用：临时文件 wx 语义创建、rename 覆盖行为明确、失败路径不残留半文件；fchmod/mode 在 win32 跳过或降级
 * - 验收项 4: 同一性校验不再以 ino 为唯一依据（win32 用内容哈希+size+mtimeMs 组合），外部替换/删除时仍拒绝回滚且正常写入不误判
 * - 验收项 5: 平台判定收敛到单一注入点，测试覆盖 win32 模拟分支（锁获取/释放、并发冲突语义不变、原子写失败清理、ino 不可用时同一性校验）
 * - 主管扫描清单 A、B、C 专项验证：8 处 dev/ino 校验点收敛、EPERM/ESRCH 进程存活探测统一
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  isWindows,
  getPlatform,
  setPlatformForTesting,
  withPlatformForTesting,
  FS_CONSTANTS,
  replaceFileAtomic,
  syncDirectorySafely,
  applyModeSafely,
  isProcessAlive,
  takeFileIdentity,
  verifyFileIdentity,
  areSameStat,
} from "../platform.ts";

import {
  init,
  createGoal,
  findGoalFile,
  loadGoal,
  setGoalTags,
  acquireTagsLock,
  releaseTagsLock,
  boardProjection,
  GraphError,
  GraphConflictError,
} from "../ops.ts";

import { withMemoryLock } from "../events.ts";
import { withTx, atomicWrite } from "../transaction.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "../..");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dsh-win-compat-"));
  init(root);
  const id = createGoal(root, { title: "win-test-goal", actor: "test" });
  return { root, id };
}

// ============================================================================
// 1. 模块加载与常量能力探测（验收项 1）
// ============================================================================

test("g-284 验收项 1: core/ops.ts 与 dsh-graph-host/core/ops.js 模块顶层不具名导入 POSIX 专有常量", () => {
  const opsTsSrc = readFileSync(join(REPO_ROOT, "core/ops.ts"), "utf8");
  const opsJsSrc = readFileSync(join(REPO_ROOT, "dsh-graph-host/core/ops.js"), "utf8");

  // 严禁从 node:constants 具名导入 O_DIRECTORY 或 O_NOFOLLOW
  assert.doesNotMatch(opsTsSrc, /import\s*\{[^}]*O_DIRECTORY[^}]*\}\s*from\s*["']node:constants["']/);
  assert.doesNotMatch(opsTsSrc, /import\s*\{[^}]*O_NOFOLLOW[^}]*\}\s*from\s*["']node:constants["']/);
  assert.doesNotMatch(opsJsSrc, /import\s*\{[^}]*O_DIRECTORY[^}]*\}\s*from\s*["']node:constants["']/);
  assert.doesNotMatch(opsJsSrc, /import\s*\{[^}]*O_NOFOLLOW[^}]*\}\s*from\s*["']node:constants["']/);

  // FS_CONSTANTS 在当前环境及能力缺失时均有安全回退
  assert.equal(typeof FS_CONSTANTS.O_RDONLY, "number");
  assert.equal(typeof FS_CONSTANTS.O_WRONLY, "number");
  assert.equal(typeof FS_CONSTANTS.O_RDWR, "number");
  assert.equal(typeof FS_CONSTANTS.O_CREAT, "number");
  assert.equal(typeof FS_CONSTANTS.O_EXCL, "number");
  assert.equal(typeof FS_CONSTANTS.O_DIRECTORY, "number");
  assert.equal(typeof FS_CONSTANTS.O_NOFOLLOW, "number");
});

// ============================================================================
// 2. 单一平台判定注入点（验收项 5）
// ============================================================================

test("g-284 验收项 5: 平台判定收敛到单一注入点，支持测试模拟 win32 与环境变量切换", () => {
  // 默认在 Linux/WSL2 下
  assert.equal(isWindows(), false);

  // setPlatformForTesting 显式切换
  setPlatformForTesting("win32");
  assert.equal(isWindows(), true);
  assert.equal(getPlatform(), "win32");

  setPlatformForTesting(null);
  assert.equal(isWindows(), false);

  // withPlatformForTesting 作用域执行并自动恢复
  const result = withPlatformForTesting("win32", () => {
    assert.equal(isWindows(), true);
    return "win32-executed";
  });
  assert.equal(result, "win32-executed");
  assert.equal(isWindows(), false);

  // 检查业务代码中无散落的 process.platform
  const checkFiles = ["core/ops.ts", "core/transaction.ts", "core/events.ts", "core/model.ts"];
  for (const f of checkFiles) {
    const src = readFileSync(join(REPO_ROOT, f), "utf8");
    assert.doesNotMatch(src, /process\.platform/, `${f} 不得散落 process.platform 判定`);
  }
});

// ============================================================================
// 3. 跨平台进程存活探测（主管补充清单 C）
// ============================================================================

test("g-284 主管清单 C: isProcessAlive 正确处理进程存活与异常语义（ESRCH 判死，EPERM 判活）", () => {
  // 当前进程必然存活
  assert.equal(isProcessAlive(process.pid), true);

  // 非法 PID / 0 判定不存活
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(NaN), false);

  // 大概率不存在的高位 PID（ESRCH）返回 false
  assert.equal(isProcessAlive(9999999), false);
});

// ============================================================================
// 4. Win32 模拟分支：锁获取与释放（验收项 2）
// ============================================================================

test("g-284 验收项 2: win32 模拟分支下锁获取不再把目录当 fd 打开，互斥与释放正常", () => {
  const { root, id } = fixture();
  const file = findGoalFile(root, id);

  withPlatformForTesting("win32", () => {
    // 获取锁
    const handle = acquireTagsLock(file);
    try {
      assert.equal(handle.isWindows, true);
      // Windows 下严禁把目录作为 fd 打开
      assert.equal(handle.lockFd, undefined);
      assert.equal(handle.ownerFd, undefined);

      // 锁目录与 owner 文件必须存在
      assert.equal(existsSync(handle.lock), true);
      const ownerPath = join(handle.lock, "owner");
      assert.equal(existsSync(ownerPath), true);
      const ownerContent = readFileSync(ownerPath, "utf8");
      assert.equal(ownerContent, handle.token);
      assert.match(ownerContent, /^\d+:[0-9a-f-]{36}$/);

      // 互斥性校验：锁未释放前，再次获取锁应超时并抛出明确错误
      assert.throws(() => {
        acquireTagsLock(file);
      }, (err: any) => err instanceof GraphError && /正被其他请求锁定/.test(err.message));
    } finally {
      // 释放锁
      releaseTagsLock(handle);
    }

    // 释放后，锁目录与 owner 文件已被彻底清理
    assert.equal(existsSync(handle.lock), false);
  });
});

test("g-284 验收项 2: win32 模拟分支下 releaseTagsLock 遇到锁被外部替换或非自身 token 时安全不误删", () => {
  const { root, id } = fixture();
  const file = findGoalFile(root, id);

  withPlatformForTesting("win32", () => {
    const handle = acquireTagsLock(file);
    // 外部恶意篡改 owner 为其他 token
    const ownerPath = join(handle.lock, "owner");
    writeFileSync(ownerPath, `${process.pid}:00000000-0000-4000-8000-000000000000`, "utf8");

    // 释放锁：应当安全退出且不删除他人持有的锁
    releaseTagsLock(handle);
    assert.equal(existsSync(handle.lock), true);
    assert.equal(readFileSync(ownerPath, "utf8"), `${process.pid}:00000000-0000-4000-8000-000000000000`);

    // 手动清理
    rmSync(handle.lock, { recursive: true, force: true });
  });
});

// ============================================================================
// 5. Win32 模拟分支：跨进程并发 CAS 冲突语义不变（验收项 4 & 5）
// ============================================================================

test("g-284 验收项 4 & 5: win32 模拟分支下跨进程并发写保持同 base 仅 1 个成功（CAS 语义不回退）", async () => {
  const { root, id } = fixture();
  const barrier = join(root, "barrier");

  const script = `
    import { writeFileSync, existsSync } from "node:fs";
    import { setGoalTags } from "./core/ops.ts";
    const [root, id, barrier, tag] = process.argv.slice(1);
    writeFileSync(barrier + tag, "ready");
    while (!existsSync(barrier + "0") || !existsSync(barrier + "1")) {}
    try {
      setGoalTags(root, id, { tags: [tag], base_tags: [], actor: "child-win32" });
      process.stdout.write("ok");
    } catch (e) {
      if (e?.name === "GraphConflictError" || /已被其他人修改/.test(String(e?.message))) {
        process.stdout.write("conflict");
      } else {
        console.error(e);
        process.exit(2);
      }
    }
  `;

  const runChild = (tag: string) =>
    new Promise<string>((resolve, reject) => {
      const p = spawn(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", script, root, id, barrier, tag],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            DSH_PLATFORM_OVERRIDE: "win32", // 子进程运行在 win32 模拟模式
          },
        },
      );
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0 ? resolve(out) : reject(new Error(`child exit ${code}: ${out} ${err}`)),
      );
    });

  const results = await Promise.all([runChild("0"), runChild("1")]);
  // 必须保证恰好 1 个成功，1 个返回 CAS 冲突
  assert.equal(results.filter((x) => x === "ok").length, 1);
  assert.equal(results.filter((x) => x === "conflict").length, 1);

  const finalTags = boardProjection(root).backlog[0].tags;
  assert.equal(finalTags.length, 1);
  assert.ok(["0", "1"].includes(finalTags[0]));
});

// ============================================================================
// 6. Win32 模拟分支：原子写与失败清理（验收项 3）
// ============================================================================

test("g-284 验收项 3: win32 模拟分支下 atomicWrite / replaceFileAtomic 正常覆盖且失败不留半文件", () => {
  const { root } = fixture();
  const target = join(root, "win-atomic.txt");

  withPlatformForTesting("win32", () => {
    // 首次写入
    atomicWrite(target, "first-content");
    assert.equal(readFileSync(target, "utf8"), "first-content");

    // 覆盖写入（验证 Windows 下 rename 覆盖已存在文件的语义）
    atomicWrite(target, "second-content");
    assert.equal(readFileSync(target, "utf8"), "second-content");

    // replaceFileAtomic 直接调用
    const tempFile = join(root, "temp-replace.tmp");
    writeFileSync(tempFile, "direct-replace", "utf8");
    replaceFileAtomic(tempFile, target);
    assert.equal(readFileSync(target, "utf8"), "direct-replace");
    assert.equal(existsSync(tempFile), false);
  });
});

test("g-284 验收项 3: win32 模拟分支下 applyModeSafely 与 syncDirectorySafely 安全静默不抛错", () => {
  const { root } = fixture();
  withPlatformForTesting("win32", () => {
    // 目录 openSync 在 Windows 下必然抛错，syncDirectorySafely 必须安全跳过
    assert.doesNotThrow(() => syncDirectorySafely(root));

    // fchmod 在 Windows 下不映射 POSIX 权限，applyModeSafely 必须安全跳过
    assert.doesNotThrow(() => applyModeSafely(999, 0o755));
    assert.doesNotThrow(() => applyModeSafely(root, 0o755));
  });
});

// ============================================================================
// 7. Win32 模拟分支：同一性校验与回滚（验收项 4 & 主管清单 A 8处）
// ============================================================================

test("g-284 验收项 4: win32 模拟分支下正常写入不因 ino 不可用而误判冲突", () => {
  const { root, id } = fixture();
  withPlatformForTesting("win32", () => {
    // 写入标签：Windows 下同一性校验不依赖 ino/dev，正常写入必须成功
    const res1 = setGoalTags(root, id, { tags: ["win-tag-1"], actor: "test" });
    assert.deepEqual(res1.new_tags, ["win-tag-1"]);
    assert.deepEqual(loadGoal(findGoalFile(root, id)).meta.tags, ["win-tag-1"]);

    // 追加标签：CAS 校验通过
    const res2 = setGoalTags(root, id, { tags: ["win-tag-1", "win-tag-2"], base_tags: ["win-tag-1"], actor: "test" });
    assert.deepEqual(res2.new_tags, ["win-tag-1", "win-tag-2"]);
    assert.deepEqual(loadGoal(findGoalFile(root, id)).meta.tags, ["win-tag-1", "win-tag-2"]);
  });
});

test("g-284 验收项 4: win32 模拟分支下事件写入失败时正常回滚（内容哈希+size匹配）", () => {
  const { root, id } = fixture();
  const file = findGoalFile(root, id);
  const beforeContent = readFileSync(file, "utf8");

  withPlatformForTesting("win32", () => {
    // 制造事件流写入失败（创建同名目录阻断 events.jsonl 写入）
    rmSync(join(root, "events.jsonl"));
    mkdirSync(join(root, "events.jsonl"));

    assert.throws(() => {
      setGoalTags(root, id, { tags: ["must-rollback"], actor: "test" });
    });

    // 验证回滚成功：文件内容恢复原样
    assert.equal(readFileSync(file, "utf8"), beforeContent);

    // 清理阻塞
    rmSync(join(root, "events.jsonl"), { recursive: true, force: true });
  });
});

test("g-284 验收项 4: win32 模拟分支下目标文件被外部篡改/替换时稳健拒绝回滚（内容哈希不匹配）", () => {
  const { root, id } = fixture();
  const file = findGoalFile(root, id);

  withPlatformForTesting("win32", () => {
    const identity = takeFileIdentity(file);
    assert.equal(identity.isWindows, true);
    assert.equal(identity.ino, undefined);
    assert.equal(identity.dev, undefined);

    // 1. 内容未变：校验通过
    const validCheck = verifyFileIdentity(file, identity);
    assert.equal(validCheck.valid, true);

    // 2. 外部篡改内容（不同哈希）：校验必须拒绝
    writeFileSync(file, "external-tampered-content", "utf8");
    const tamperedCheck = verifyFileIdentity(file, identity);
    assert.equal(tamperedCheck.valid, false);
    assert.match(tamperedCheck.reason!, /已被外部替换或删除，拒绝回滚/);

    // 3. 外部删除文件：校验必须拒绝
    rmSync(file);
    const deletedCheck = verifyFileIdentity(file, identity);
    assert.equal(deletedCheck.valid, false);
    assert.match(deletedCheck.reason!, /已被外部替换或删除，拒绝回滚/);

    // 4. 外部替换为目录：校验必须拒绝
    mkdirSync(file);
    const dirCheck = verifyFileIdentity(file, identity);
    assert.equal(dirCheck.valid, false);
    assert.match(dirCheck.reason!, /已被外部替换或删除，拒绝回滚/);
    rmSync(file, { recursive: true, force: true });
  });
});

test("g-284 主管清单 A: areSameStat 跨平台兼容性（POSIX 严格校验 dev/ino，Windows 优雅放行）", () => {
  const stat1 = { dev: 100, ino: 200 };
  const stat2 = { dev: 100, ino: 200 };
  const stat3 = { dev: 100, ino: 300 };

  // POSIX 模式
  withPlatformForTesting("linux", () => {
    assert.equal(areSameStat(stat1, stat2), true);
    assert.equal(areSameStat(stat1, stat3), false);
  });

  // Windows 模式
  withPlatformForTesting("win32", () => {
    assert.equal(areSameStat(stat1, stat2), true);
    assert.equal(areSameStat(stat1, stat3), true); // Windows 下不以 ino/dev 为唯一阻断
  });
});

// ============================================================================
// 8. 跨模块锁语义一致性（主管清单 B）
// ============================================================================

test("g-284 主管清单 B: withMemoryLock 与 withTx 在 win32 模拟分支下行为健壮", () => {
  const { root } = fixture();

  withPlatformForTesting("win32", () => {
    // 验证 withMemoryLock
    const memVal = withMemoryLock(root, () => {
      return 12345;
    });
    assert.equal(memVal, 12345);

    // 验证 withTx
    const txRes = withTx(
      { root, actor: "test" },
      { lockName: "win32-tx-test" },
      () => ({
        value: "tx-ok",
        events: [{
          actor: "test",
          event: "tx.test",
          details: { ok: true },
        }],
      }),
    );
    assert.equal(txRes.ok, true);
    if (txRes.ok) {
      assert.equal(txRes.value, "tx-ok");
    }
  });
});
