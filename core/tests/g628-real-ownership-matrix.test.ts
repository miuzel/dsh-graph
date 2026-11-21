import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRealHost } from './_g610-real-host.ts';
import { ownershipProbeOf, readChildCatalogCompat, startSubagentCompat } from '../../dist/index.js';
import { createGoal, setCriteria, setGoalDescription, transition, CRITERIA_VERIFIED_MARK } from '../ops.ts';
import { readEvents } from '../events.ts';
import { execFileSync } from 'node:child_process';

test('g628 real rc3 resident ancestry and cross-tree identity', async () => {
  const h = await makeRealHost({ sessionQuery: true });
  try {
    h.fake.hold();
    const direct = await h.startChild('matrix-direct');
    const directAgent = h.reg.get(direct.childId);
    assert.ok(directAgent, 'direct child is resident');
    const probe = ownershipProbeOf(h.reg, h.subagents);
    assert.equal(probe.ownsId(direct.childId, h.parent), 'yes', 'direct managed child');
    const nested = await startSubagentCompat(h.subagents, {
      provider: 'spawn', parent: directAgent, label: 'matrix-nested',
      prompt: [{ type: 'text', text: 'matrix nested' }], signal: new AbortController().signal,
    });
    const nestedAgent = h.reg.get(nested.childId);
    assert.ok(nestedAgent, 'nested child is resident');
    assert.equal(h.subagents.rootOf(nestedAgent), h.subagents.rootOf(h.parent), 'nested child and root share exact runtime root');
    assert.equal(probe.ownsId(nested.childId, h.parent), 'no', 'same tree but different direct parent');
    assert.equal(probe.ownsId(nested.childId, directAgent), 'yes', 'nested direct parent');
    const other = await h.ctx.get('agentLoop').create('matrix-other-root', {provider: 'fake', model: 'fake-model'}, {cwd: h.ws});
    assert.notEqual(h.subagents.rootOf(other), h.subagents.rootOf(h.parent));
    assert.equal(probe.ownsId(direct.childId, other), 'no', 'cross tree');
    // Reproduce the public fork controller's seed/create path using the genuine host
    // functions and a live child session, not a fabricated Agent or ownership stub.
    const sourceEvents = directAgent.session.snapshotEvents();
    assert.ok(sourceEvents.length > 0, 'fork source has real events');
    const boundary = sourceEvents[sourceEvents.length - 1].seq;
    const seed = h.modules.session.buildForkSeed(sourceEvents, boundary);
    await h.reg.create({sessionId: 'matrix-ordinary-fork', seed, inheritedEventCount: boundary + 1,
      meta: {cwd: h.ws, isSeeded: true}, agentOptions: {provider: 'fake', model: 'fake-model'}});
    const fork = h.reg.get('matrix-ordinary-fork');
    assert.ok(fork, 'fork agent is genuinely resident');
    assert.equal(h.subagents.rootOf(fork), fork, 'ordinary fork is an independent root');
    assert.equal(probe.ownsId(fork.id, h.parent), 'no', 'ordinary fork is not a managed child');
    const goal = createGoal(h.root, {title: 'matrix rejection', version: 'v1.0', type: 'task', actor: 'human:gui'});
    setCriteria(h.root, goal, [`criterion ${CRITERIA_VERIFIED_MARK}`], 'human:gui');
    setGoalDescription(h.root, goal, 'real host ownership rejection matrix', 'human:gui');
    transition(h.root, goal, 'ready', {actor: 'human:gui'});
    const getCatalog = async (id: string) => {
      const data = await readChildCatalogCompat({subagents: h.subagents, sessionQuery: h.ctx.get('sessionQuery')}, id);
      assert.equal(data.ok, true, `catalog available for ${id}`);
      return data.rows;
    };
    let sends = 0;
    const send = h.subagents.sendMessage.bind(h.subagents);
    h.subagents.sendMessage = (...args: any[]) => { sends++; return send(...args); };
    for (const [label, caller, childId] of [
      ['same-tree-other-parent', h.parent, nested.childId],
      ['cross-tree', other, direct.childId],
      ['ordinary-fork-public-create-path', h.parent, fork.id],
    ] as const) {
      const eventsBefore = readEvents(h.root).length;
      const registryBefore = new Set(h.reg.list().map((a: any) => String(a.id)));
      const catalogsBefore = await Promise.all([getCatalog(h.parent.id), getCatalog(directAgent.id), getCatalog(nestedAgent.id), getCatalog(other.id), getCatalog(fork.id)]);
      const worktreesBefore = execFileSync('git', ['worktree', 'list', '--porcelain'], {cwd: h.ws, encoding: 'utf8'});
      const sendsBefore = sends;
      await assert.rejects(async () => h.tools.get('graph_start_attempt').execute(
        {goal, attempt_brief: label, worktree: false, child_id: childId},
        {agent: caller, signal: new AbortController().signal}), /不属于当前主管/);
      assert.equal(sends, sendsBefore, `${label}: no message`);
      assert.equal(h.attempts(goal).length, 0, `${label}: no attempt`);
      assert.equal(readEvents(h.root).length, eventsBefore, `${label}: no event`);
      assert.deepEqual(new Set(h.reg.list().map((a: any) => String(a.id))), registryBefore, `${label}: registry`);
      assert.deepEqual(await Promise.all([getCatalog(h.parent.id), getCatalog(directAgent.id), getCatalog(nestedAgent.id), getCatalog(other.id), getCatalog(fork.id)]), catalogsBefore, `${label}: catalogs`);
      assert.equal(execFileSync('git', ['worktree', 'list', '--porcelain'], {cwd: h.ws, encoding: 'utf8'}), worktreesBefore, `${label}: worktrees`);
    }
  } finally {
    h.fake.releaseAll();
    await h.shutdown();
  }
});
