import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
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

// Browser timers accept Window (or an unqualified call), not a scheduler instance.
// Exercise the default timers: injected test clocks bypass the native receiver check.
const browser={tasks:new Map(),saved:[],serial:0,latest:1,cleared:[]};
const source=await readFile(new URL('../dist/autosave.mjs',import.meta.url),'utf8');
vm.createContext(browser);
vm.runInContext(`'use strict';
  const browserWindow=globalThis;
  function checkWindow(receiver,name) {
    if (receiver!==undefined && receiver!==browserWindow) {
      throw new TypeError(name+" called on an object that does not implement interface Window.");
    }
  }
  globalThis.setTimeout=function(callback,delay) {
    checkWindow(this,'setTimeout');
    const id=++serial;tasks.set(id,{callback,delay});return id;
  };
  globalThis.clearTimeout=function(id) {
    checkWindow(this,'clearTimeout');cleared.push(id);tasks.delete(id);
  };
  ${source.replace('export class AutosaveScheduler','class AutosaveScheduler')}
  globalThis.scheduler=new AutosaveScheduler(()=>saved.push(latest));
`,browser);
const run=code=>vm.runInContext(code,browser);
run('scheduler.mark()');
assert.equal(browser.tasks.size,1);
assert.equal(browser.tasks.get(1).delay,2000);
browser.latest=2;run('scheduler.mark()');
assert.equal(browser.tasks.size,1,'The default timer postponed an existing save');
const callback=browser.tasks.get(1).callback;browser.tasks.delete(1);callback();
assert.deepEqual(browser.saved,[2]);assert.equal(browser.tasks.size,0);
browser.latest=3;run('scheduler.mark()');
browser.latest=4;run('scheduler.mark({immediate:true})');
assert.deepEqual(browser.saved,[2,4]);assert.equal(browser.tasks.size,0);
run('scheduler.flush()');
assert.deepEqual(browser.saved,[2,4]);
assert(browser.cleared.includes(2),'A checkpoint did not cancel its native timer');

console.log(JSON.stringify({continuousRead:'100 pages → 1 save per 2 seconds',latestState:'passed',
  immediateCheckpoint:'passed',cancelPendingTimer:'passed',lifecycleFlushOnce:'passed',failureRetry:'passed',
  defaultBrowserTimerReceiver:'passed',nativeCheckpointCancellation:'passed'},null,2));
