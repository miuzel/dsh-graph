import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createGoal, setCriteria, setGoalDescription, transition, CRITERIA_VERIFIED_MARK } from '../ops.ts';
import { readEvents } from '../events.ts';
import { makeRealHost } from './_g610-real-host.ts';
import { ownershipProbeOf, readChildCatalogCompat } from '../../dist/index.js';

const until = async (fn: () => boolean) => {
  for (let i = 0; i < 4000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('real host state not reached');
};

test('g628 rc3 cold child rejects; independently resumed child root is unauthorized', async () => {
  const h = await makeRealHost({sessionQuery: true});
  try {
    const goal = createGoal(h.root, {title: 'cold child', version:'v1.0', type:'task', actor:'human:gui'});
    setCriteria(h.root, goal, [`criterion ${CRITERIA_VERIFIED_MARK}`], 'human:gui');
    setGoalDescription(h.root, goal, 'real cold child rejection', 'human:gui');
    transition(h.root, goal, 'ready', {actor:'human:gui'});
    const gate = h.fake.hold();
    const child = await h.startChild('cold');
    await until(() => h.childLive(child.childId) === 'running');
    const oldAgent = h.reg.get(child.childId);
    gate.resolve();
    await until(() => h.childLive(child.childId) === 'gone');
    assert.throws(() => h.subagents.rootOf(oldAgent), /exact live|UNAUTHORIZED/);
    const beforeEvents = readEvents(h.root).length;
    const beforeRegistry = new Set(h.reg.list().map((a: any) => String(a.id)));
    const beforeCatalog = await readChildCatalogCompat({subagents:h.subagents, sessionQuery:h.ctx.get('sessionQuery')}, h.parent.id);
    assert.equal(beforeCatalog.ok, true);
    const beforeTrees = execFileSync('git', ['worktree','list','--porcelain'], {cwd:h.ws, encoding:'utf8'});
    let sends = 0;
    const send = h.subagents.sendMessage.bind(h.subagents);
    h.subagents.sendMessage = (...args: any[]) => { sends++; return send(...args); };
    await assert.rejects(async () => h.dispatch(goal, 'cold reject', {child_id:child.childId}), /不在 live registry/);
    assert.equal(sends, 0);
    assert.equal(h.attempts(goal).length, 0);
    assert.equal(readEvents(h.root).length, beforeEvents);
    assert.deepEqual(new Set(h.reg.list().map((a: any) => String(a.id))), beforeRegistry);
    const afterCatalog = await readChildCatalogCompat({subagents:h.subagents, sessionQuery:h.ctx.get('sessionQuery')}, h.parent.id);
    assert.equal(afterCatalog.ok, true);
    assert.deepEqual(afterCatalog.rows, beforeCatalog.rows);
    assert.equal(execFileSync('git', ['worktree','list','--porcelain'], {cwd:h.ws, encoding:'utf8'}), beforeTrees);
    await h.reg.resume({resumeSessionId:child.childId, agentOptions:{provider:'fake',model:'fake-model'}});
    const resumed = h.reg.get(child.childId);
    assert.ok(resumed);
    assert.equal(resumed.session.header.parentSession, h.parent.id);
    assert.throws(() => h.subagents.rootOf(resumed), /active runtime owner|UNAUTHORIZED/);
    assert.equal(ownershipProbeOf(h.reg, h.subagents).ownsId(child.childId, h.parent), 'yes', 'release fallback admits independently resumed child');
    assert.equal(resumed.status, 'idle', 'independently resumed child reaches the reuse idle admission');
    const resumedEvents = readEvents(h.root).length;
    const resumedRegistry = new Set(h.reg.list().map((a: any) => String(a.id)));
    const resumedCatalog = await readChildCatalogCompat({subagents:h.subagents, sessionQuery:h.ctx.get('sessionQuery')}, h.parent.id);
    assert.equal(resumedCatalog.ok, true);
    const resumedTrees = execFileSync('git', ['worktree','list','--porcelain'], {cwd:h.ws, encoding:'utf8'});
    await assert.rejects(async () => h.dispatch(goal, 'stale child reject', {child_id:child.childId}), /无法确认|不属于/);
    assert.equal(sends, 0);
    assert.equal(h.attempts(goal).length, 0);
    assert.equal(readEvents(h.root).length, resumedEvents);
    assert.deepEqual(new Set(h.reg.list().map((a: any) => String(a.id))), resumedRegistry);
    const finalCatalog = await readChildCatalogCompat({subagents:h.subagents, sessionQuery:h.ctx.get('sessionQuery')}, h.parent.id);
    assert.equal(finalCatalog.ok, true);
    assert.deepEqual(finalCatalog.rows, resumedCatalog.rows);
    assert.equal(execFileSync('git', ['worktree','list','--porcelain'], {cwd:h.ws, encoding:'utf8'}), resumedTrees);
  } finally { h.fake.releaseAll(); await h.shutdown(); }
});
