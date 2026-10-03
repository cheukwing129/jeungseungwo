import assert from 'node:assert/strict';
import {AutosaveScheduler} from '../dist/autosave.mjs';

let now=0,serial=0,state=0;
const tasks=new Map(),saved=[];
const scheduler=new AutosaveScheduler(()=>{saved.push({time:now,state});}, {
  setTimer(callback,delay){const id=++serial;tasks.set(id,{callback,due:now+delay});return id;},
  clearTimer(id){tasks.delete(id);},
});
function advance(duration) {
  const target=now+duration;
  while(tasks.size) {
    const [id,task]=[...tasks].sort((a,b)=>a[1].due-b[1].due)[0];
    if(task.due>target)break;
    now=task.due;tasks.delete(id);task.callback();
  }
  now=target;
}

// Continuous fast pages get a bounded save, rather than postponing forever or snapshotting every page.
for(state=1;state<=100;state++) {scheduler.mark();advance(20);}
assert.deepEqual(saved,[{time:2000,state:100}]);assert.equal(tasks.size,0);
for(state=101;state<=200;state++) {scheduler.mark();advance(20);}
assert.deepEqual(saved.at(-1),{time:4000,state:200});assert.equal(saved.length,2);

// Checkpoints save the latest page immediately and cancel a pending stale timer.
state=201;scheduler.mark();advance(100);state=202;scheduler.mark({immediate:true});
assert.deepEqual(saved.at(-1),{time:4100,state:202});assert.equal(tasks.size,0);
advance(2000);assert.equal(saved.length,3);

// A lifecycle flush persists dirty state once. Idle tabs do not rewrite the shared auto slot.
state=203;scheduler.mark();advance(50);scheduler.flush();
assert.equal(saved.at(-1).state,203);assert.equal(tasks.size,0);
scheduler.flush();scheduler.flush();advance(3000);assert.equal(saved.length,4);

let attempts=0,fail=true;
const retry=new AutosaveScheduler(()=>{attempts++;return !fail;});
retry.mark({immediate:true});assert.equal(retry.dirty,true);
fail=false;retry.flush();assert.equal(retry.dirty,false);assert.equal(attempts,2);
retry.flush();assert.equal(attempts,2);

console.log(JSON.stringify({continuousRead:'100 pages → 1 save per 2 seconds',latestState:'passed',
  immediateCheckpoint:'passed',cancelPendingTimer:'passed',lifecycleFlushOnce:'passed',failureRetry:'passed'},null,2));
