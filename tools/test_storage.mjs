import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GameEngine} from '../dist/engine.mjs';
import {ReplayLibrary} from '../dist/replay.mjs';
import {LocalSaves,STORAGE_KEY,STORAGE_PREFIX} from '../dist/storage.mjs';

const story=JSON.parse(await readFile(new URL('../dist/story.json',import.meta.url),'utf8'));
const routes=new ReplayLibrary(story).routes, options={sourceHash:story.sourceHash,endingIds:routes.map(route=>route.id)};
const memory=new Map(), writes=[];
const storage={getItem:key=>memory.get(key) ?? null,setItem:(key,value)=>{writes.push(key);memory.set(key,value);}};
const a=new LocalSaves(storage,options), b=new LocalSaves(storage,options);
const game=new GameEngine(story);game.start();
const item=preview=>({snapshot:game.snapshot(),time:'2026-10-03T12:00:00.000Z',chapter:'完璧歸趙',preview});
const first=item('分頁甲'), second=item('分頁乙'), legacy=item('舊版進度');
const progress=(ids,completed=false)=>({sourceHash:story.sourceHash,completed,endings:ids});

// Both tabs begin stale. Their unrelated fields and discoveries must survive interleaved writes.
a.read();b.read();
assert(a.writeSlot(0,first));assert(a.writeProgress(progress([routes[0].id])));
assert(b.writeAuto(second));assert(b.writeMuted(true));assert(b.writeSlot(1,second));
assert(b.writeProgress(progress([routes[1].id])));
const merged=a.read();
assert.deepEqual(merged.auto,second);assert.deepEqual(merged.slots,[first,second,null]);
assert.equal(merged.settings.muted,true);
assert.deepEqual(new Set(merged.progress.endings),new Set([routes[0].id,routes[1].id]));
const completed=routes.find(route=>route.completed);
assert(a.writeProgress(progress([completed.id],true)));
assert(b.writeProgress(progress([routes[2].id],false)));
assert.equal(b.read().progress.completed,true,'A stale tab erased completion');
assert.equal(b.read().progress.endings.length,4);
const written=writes.length;assert(b.writeProgress(b.read().progress));
assert.equal(writes.length,written,'Unchanged progress wrote every discovery again');

// An explicitly overwritten slot and the one shared autosave use last-writer semantics.
assert(b.writeSlot(0,second));assert.deepEqual(a.read().slots[0],second);
assert(a.writeAuto(first));assert.deepEqual(b.read().auto,first);
assert.equal(a.writeSlot(-1,first),false);assert.equal(a.writeSlot(3,first),false);
assert(a.relevantKey(STORAGE_PREFIX+'slot:0'));assert(a.relevantKey(STORAGE_KEY));assert(a.relevantKey(null));
assert.equal(a.relevantKey('another-game'),false);

// Read-only fallback avoids copying a stale v1 document over a v2 field during startup.
memory.clear();writes.length=0;
const old={auto:legacy,slots:[legacy,null,legacy],settings:{muted:true},progress:progress([routes[0].id])};
const raw=JSON.stringify(old);memory.set(STORAGE_KEY,raw);
assert.deepEqual(a.read(),old);assert.equal(writes.length,0);
assert(a.writeSlot(0,first));
old.slots[0]=second;old.slots[1]=second;memory.set(STORAGE_KEY,JSON.stringify(old));
const migrated=b.read();
assert.deepEqual(migrated.slots,[first,second,legacy]);
assert(a.writeMuted(false));assert.equal(b.read().settings.muted,false);
assert(a.writeAuto(null));assert.equal(b.read().auto,null,'An intentionally empty field fell back to legacy');
const untouchedLegacy=memory.get(STORAGE_KEY);
assert(a.writeProgress(progress([routes[1].id])));assert.equal(memory.get(STORAGE_KEY),untouchedLegacy);

// Damage is isolated to the affected field; old and unrelated data stay available.
memory.set(STORAGE_PREFIX+'slot:0','{broken');
const damaged=a.read();assert.equal(damaged.slots[0],null);assert.deepEqual(damaged.slots[1],second);assert(a.error);
memory.set(STORAGE_PREFIX+'slot:0','null');memory.set(STORAGE_KEY,'{broken');
assert.deepEqual(a.read().slots[1],null);assert.equal(a.read().settings.muted,false);assert(a.error);
assert(a.writeSlot(1,second));assert.deepEqual(b.read().slots[1],second);
memory.set(STORAGE_KEY,JSON.stringify({...old,progress:{...old.progress,sourceHash:'other-story'}}));
const other=new LocalSaves(storage,{sourceHash:'new-story',endingIds:options.endingIds});
assert.deepEqual(other.read().progress.endings,[]);assert.equal(other.read().progress.completed,false);
assert(other.writeProgress(progress([completed.id],true)));
assert.equal(memory.get(other.progressKey('completed')),undefined);

// A quota failure may interrupt a group of discoveries. Retrying completes the union.
let remaining=1;
const flaky=new LocalSaves({getItem:storage.getItem,setItem(key,value){
  if(remaining--===0)throw new Error('quota');storage.setItem(key,value);
}},options);
memory.clear();
assert.equal(flaky.writeProgress(progress([routes[0].id,routes[1].id])),false);assert(flaky.error);
assert.equal(a.read().progress.endings.length,1);
remaining=10;assert(flaky.writeProgress(progress([routes[0].id,routes[1].id])));
assert.equal(a.read().progress.endings.length,2);
const blocked=new LocalSaves({getItem(){throw new Error('unavailable');},setItem(){throw new Error('unavailable');}},options);
assert.equal(blocked.read().auto,null);assert(blocked.error);
assert.equal(blocked.writeAuto(first),false);assert.equal(blocked.writeSlot(0,first),false);assert.equal(blocked.writeMuted(true),false);

console.log(JSON.stringify({interleavedTabs:'passed',independentSlotsAndSettings:'passed',discoveryUnion:'passed',
  completionNeverRegresses:'passed',legacyFallbackWithoutBulkWrites:'passed',corruptFieldIsolation:'passed',
  sourceIsolation:'passed',partialWriteRetry:'passed',sameSlotLastWriter:'passed'},null,2));
