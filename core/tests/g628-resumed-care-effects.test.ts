import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { makeRealHost } from './_g610-real-host.ts';
import { createGoal, setCriteria, setGoalDescription, transition, startAttempt, bindAttemptChild, CRITERIA_VERIFIED_MARK, getCachedBoardPayload, readProjectConfig, readSupervisorSession } from '../ops.ts';
import { readEvents, appendEvent } from '../events.ts';
import { createCareRuntime, createKeepAliveRuntime, ownershipProbeOf } from '../../dist/index.js';

const until = async (f: () => boolean) => { for (let i=0;i<2000;i++) { if (f()) return; await new Promise(r=>setTimeout(r,5)); } assert.fail('state timeout'); };

// Real reachability: managed child terminates, registry resumes its persisted session independently,
// then its own Agent.send starts a new turn. Header still names the original parent, while the real
// SubagentRuntime denies rootOf. A persisted attempt binding can outlive that runtime relationship.
// Expected invariant: unverified runtime ownership cannot count as a live child, cause care sampling,
// timer delivery or mutate inspection/outcome, budget, lock, or the supervisor inbox.
test('g628 independently resumed running child cannot drive care or keepalive', async () => {
  const h = await makeRealHost({sessionQuery:true});
  let care: any, keep: any;
  let now = Date.now(); let seq = 0;
  const timers = new Map<number,{at:number,fn:()=>any}>();
  const setTimer = (fn:()=>any, ms:number) => { const id=++seq; timers.set(id,{at:now+Math.max(0,Number(ms)||0),fn}); return id; };
  const clearTimer = (id:number) => { timers.delete(id); };
  const advance = async (target:number) => { for(let i=0;i<100;i++){ const due=[...timers.entries()].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at); if(!due.length) break; const [id,v]=due[0]; timers.delete(id); now=v.at; await v.fn(); } now=target; await new Promise(r=>setImmediate(r)); };
  try {
    const hostVersion=JSON.parse(readFileSync(join(h.modules.S,'..','..','package.json'),'utf8')).version;
    assert.equal(hostVersion,'0.2.2-rc.3','real host must be pinned to rc.3');
    const gate=h.fake.hold();
    const child=await h.startChild('real-resume');
    await until(()=>h.childLive(child.childId)==='running');
    gate.resolve();
    await until(()=>h.childLive(child.childId)==='gone');
    await h.reg.resume({resumeSessionId:child.childId,agentOptions:{provider:'fake',model:'fake-model'}});
    const resumed=h.reg.get(child.childId);
    assert.ok(resumed);
    assert.equal(resumed.session.header.parentSession,h.parent.id);
    assert.throws(()=>h.subagents.rootOf(resumed),/active runtime owner|UNAUTHORIZED/);
    h.fake.hold('RESUMED-HOLD');
    resumed.send(h.modules.llm.createUserMessage({content:[{type:'text',text:'RESUMED-HOLD'}],source:{kind:'user'}}),'next-turn',true);
    await until(()=>resumed.status==='running');
    assert.throws(()=>h.subagents.rootOf(resumed),/active runtime owner|UNAUTHORIZED/);
    const goal=createGoal(h.root,{title:'persisted binding',version:'v1.0',type:'task',actor:'human:gui'});
    setCriteria(h.root,goal,[`criterion ${CRITERIA_VERIFIED_MARK}`],'human:gui');
    setGoalDescription(h.root,goal,'persisted binding after independent resume','human:gui');
    transition(h.root,goal,'ready',{actor:'human:gui'});
    transition(h.root,goal,'in_progress',{actor:'human:gui'});
    const attempt=startAttempt(h.root,goal,{executor:'spawn',actor:'human:gui'});
    bindAttemptChild(h.root,goal,attempt,child.childId,'human:gui',h.parent.id);
    const ctx={on:(name:string,fn:any)=>h.ctx.on(name,fn),get:(name:string)=>name==='agents'?h.reg:name==='llm'?h.llm:name==='subagents'?h.subagents:undefined};
    const common={ctx,resolveRoot:(ws:string)=>join(ws,'.dsh-graph'),defaultWorkspace:()=>h.ws,readSupervisorSessionFn:readSupervisorSession,now:()=>now,setTimeoutFn:setTimer,clearTimeoutFn:clearTimer,log:()=>{}};
    care=createCareRuntime({...common,readGlobal:()=>({enabled:true,thresholdSeconds:null,recheckSeconds:null,malformed:false,available:true,raw:'on'}),readProjectConfigFn:()=>({supervisor:{care:true,care_threshold_seconds:30,care_recheck_seconds:300}}),readBoardPayload:(root:string)=>getCachedBoardPayload(root,{lazy:true})?.payload??null,appendEventFn:appendEvent,makeInspectionId:()=>`g628-${++seq}`});
    keep=createKeepAliveRuntime({...common,readGlobal:()=>({enabled:true,malformed:false,available:true,raw:'on'}),readProjectConfigFn:readProjectConfig});
    const sent:any[]=[]; const send=h.parent.send.bind(h.parent); h.parent.send=(m:any,...rest:any[])=>{sent.push(m);return send(m,...rest)};
    care.start(); keep.start(); care.armForRoot(h.root);
    h.parent.send(h.modules.llm.createUserMessage({content:[{type:'text',text:'supervisor baseline'}],source:{kind:'user'}}),'next-turn',true);
    await until(()=>h.parent.status==='idle');
    const ownership=ownershipProbeOf(h.reg,h.subagents,{requireLiveTree:true}).ownsId(child.childId,h.parent);
    const keepStatus=keep.statusFor(h.root); const status=care.statusFor(h.root);
    const beforeEvents=readEvents(h.root).filter((e:any)=>String(e.event).startsWith('care.')).length;
    const beforeInbox=sent.length;
    const beforeTimerCount=timers.size;
    await advance(now+120_000);
    const after=care.statusFor(h.root);
    const inspection=after?.pending_inspections?.[0]?.id ?? 'unissued';
    const result=care.submitOutcome({root:h.root,supervisor:h.parent.id,inspection,goal,attempt,child:child.childId,outcome:'progress',evidence:'observed test progress'});
    const finalStatus=care.statusFor(h.root);
    const afterEvents=readEvents(h.root).filter((e:any)=>String(e.event).startsWith('care.'));
    assert.notEqual(ownership,'yes','independent runtime must not inherit ownership from historical header');
    assert.equal(keepStatus?.active?.children_running,null, 'unknown ownership must not be misreported as zero');
    assert.equal(status?.tasks?.length,0);
    assert.equal(status?.next_due_at,null, 'no budget deadline can be established');
    assert.deepEqual(status?.pending_inspections,[]);
    assert.equal(after?.next_due_at,null);
    assert.deepEqual(after?.tasks,[]);
    assert.deepEqual(after?.pending_inspections,[]);
    assert.equal(after?.awaiting_human,false, 'no human lock may be created');
    assert.deepEqual(result,{ok:false,code:'ownership_unknown'});
    assert.equal(finalStatus?.last_outcome,null);
    assert.equal(sent.length,beforeInbox);
    assert.equal(afterEvents.length,beforeEvents);
    assert.equal(timers.size,beforeTimerCount, 'only the same periodic recheck timers remain');
  } finally { care?.dispose(); keep?.dispose(); h.fake.releaseAll(); await h.shutdown(); }
});
