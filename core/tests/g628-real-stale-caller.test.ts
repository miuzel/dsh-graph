import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoal, setCriteria, setGoalDescription, transition } from '../ops.ts';
import { readEvents } from '../events.ts';
import { CRITERIA_VERIFIED_MARK } from '../ops.ts';
import { makeRealHost } from './_g610-real-host.ts';
import { readChildCatalogCompat } from '../../dist/index.js';
import { execFileSync } from 'node:child_process';

// Exact live identity is a real rc.3 authorization requirement; a stale Agent object
// retaining the same session header must not create an attempt or deliver a message.
test('g628 real rc3 rejects stale caller before side effects', async () => {
  const h = await makeRealHost({ sessionQuery: true });
  try {
    const goal = createGoal(h.root, { title: 'stale caller', version: 'v1.0', type: 'task', actor: 'human:gui' });
    setCriteria(h.root, goal, [`criterion ${CRITERIA_VERIFIED_MARK}`], 'human:gui');
    setGoalDescription(h.root, goal, 'real host authorization regression', 'human:gui');
    transition(h.root, goal, 'ready', { actor: 'human:gui' });
    const stale = Object.create(h.parent);
    const gate = h.fake.hold();
    const started = await h.startChild('stale-caller');
    const beforeEvents = readEvents(h.root).length;
    const beforeRegistry = new Set(h.reg.list().map((a: any) => String(a.id)));
    const catalogBefore = await readChildCatalogCompat({ subagents: h.subagents, sessionQuery: h.ctx.get('sessionQuery') }, h.parent.id);
    assert.equal(catalogBefore.ok, true, 'catalog must actually be available');
    const worktreesBefore = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: h.ws, encoding: 'utf8' });
    let sends = 0;
    const send = h.subagents.sendMessage.bind(h.subagents);
    h.subagents.sendMessage = (...args: any[]) => { sends++; return send(...args); };
    let result: Promise<any> | undefined;
    const fire = () => {
      if (result || h.reg.get(started.childId)?.status !== 'idle') return;
      result = Promise.resolve().then(() => h.tools.get('graph_start_attempt').execute(
        { goal, attempt_brief: 'reject stale caller', worktree: false, child_id: started.childId },
        { agent: stale, signal: new AbortController().signal },
      )).then(value => ({ value }), error => ({ error }));
    };
    h.ctx.on('agent/status', ({status}: any = {}) => { if (status === 'idle') fire(); });
    gate.resolve();
    for (let i = 0; i < 4000 && !result; i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(result, 'real idle window must be observed');
    const outcome = await result!;
    assert.match(String(outcome.error?.message ?? ''), /无法确认|不属于|授权|主管/);
    assert.equal(sends, 0);
    assert.equal(h.attempts(goal).length, 0);
    assert.equal(readEvents(h.root).length, beforeEvents);
    assert.deepEqual(new Set(h.reg.list().map((a: any) => String(a.id))), beforeRegistry);
    const catalogAfter = await readChildCatalogCompat({ subagents: h.subagents, sessionQuery: h.ctx.get('sessionQuery') }, h.parent.id);
    assert.equal(catalogAfter.ok, true);
    assert.deepEqual(catalogAfter.rows, catalogBefore.rows, 'full catalog is unchanged');
    assert.equal(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: h.ws, encoding: 'utf8' }), worktreesBefore);
  } finally {
    h.fake.releaseAll();
    await h.shutdown();
  }
});
