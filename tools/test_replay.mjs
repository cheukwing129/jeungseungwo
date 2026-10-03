import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GameEngine} from '../dist/engine.mjs';
import {LocalSaves} from '../dist/storage.mjs';
import {ReplayLibrary} from '../dist/replay.mjs';

const story=JSON.parse(await readFile(new URL('../dist/story.json',import.meta.url),'utf8'));
const edits=JSON.parse(await readFile(new URL('./story_edits.json',import.meta.url),'utf8'));
const legacy=JSON.parse(await readFile(new URL('./fixtures/legacy-saves.json',import.meta.url),'utf8'));
const library=new ReplayLibrary(story), endings=[], queue=[], first=new GameEngine(story);
assert.equal(library.unlocked,false);
assert.equal(library.record({sourceHash:story.sourceHash}),false);
assert.throws(()=>library.startChapter(3));
assert.throws(()=>library.replayRoute('3:461'));
first.start();queue.push(first.snapshot());
while (queue.length) {
  const game=new GameEngine(story);game.restore(queue.shift());
  while (game.state.current.kind==='text') game.advance();
  if (game.state.current.kind==='choice') {
    for (let index=0;index<game.state.current.choices.length;index++) {
      const branch=new GameEngine(story);branch.restore(game.snapshot());branch.choose(index);queue.push(branch.snapshot());
    }
  } else endings.push(game.snapshot());
}
assert.equal(endings.length,19);
assert.deepEqual(new Set(library.routes.map(route=>route.id)),
  new Set(endings.map(snapshot=>`${snapshot.state.mapId}:${snapshot.state.current.eventIndex}`)));
for (const snapshot of endings.filter(snapshot=>!snapshot.state.current.completed)) library.record(snapshot);
assert.equal(library.progress.endings.length,18);
assert.equal(library.unlocked,false,'An incomplete route unlocked chapter selection');
const completed=endings.find(snapshot=>snapshot.state.current.completed);
assert.equal(library.record(completed),true);
assert.equal(library.record(completed),false,'Revisiting an ending duplicated its entry');
assert.equal(library.unlocked,true);
assert.equal(library.progress.endings.length,19);

// Independently follow the answer manifest to verify each generated chapter boundary.
const answers=new Map(edits.choices.map(choice=>[`${choice.map}:${choice.event}`,choice.correct]));
const canonical=new GameEngine(story), boundaries=new Map();canonical.start();
for (let guard=0;guard<2000;guard++) {
  if (!boundaries.has(canonical.state.mapId)) boundaries.set(canonical.state.mapId,canonical.snapshot());
  if (canonical.state.current.kind==='ending') break;
  if (canonical.state.current.kind==='choice') canonical.choose(answers.get(`${canonical.state.mapId}:${canonical.state.current.eventIndex}`));
  else canonical.advance();
}
assert.equal(canonical.state.current.completed,true);
for (const map of story.maps) {
  const checkpoint=library.startChapter(map.id), expected=boundaries.get(map.id).state;
  assert.equal(checkpoint.state.mapId,map.id);
  assert.deepEqual(checkpoint.state.current,expected.current);
  for (const field of ['pc','pictures','music','variables','decisions']) assert.deepEqual(checkpoint.state[field],expected[field]);
  assert.equal(checkpoint.state.history.length,1);
  assert.equal(checkpoint.lastChoice,null);
  const restored=new GameEngine(story);restored.restore(checkpoint);
  while (restored.state.current.kind==='text') restored.advance();
  assert.equal(restored.state.mapId,map.id);
  assert.equal(restored.state.current.kind,'choice');
  checkpoint.state.pictures={};checkpoint.state.current.text='mutated';
  assert.deepEqual(library.startChapter(map.id).state.pictures,expected.pictures,'Cached chapter state was mutated by a replay');
}
assert.throws(()=>library.startChapter(99));

// Each catalog action returns to the real final decision and can reproduce its ending.
for (const route of library.routes) {
  const checkpoint=library.replayRoute(route.id), game=new GameEngine(story);
  game.restore(checkpoint);
  assert.equal(game.state.current.kind,'choice');
  assert.equal(game.state.current.eventIndex,route.path.at(-1).eventIndex);
  game.choose(route.path.at(-1).index);
  while (game.state.current.kind==='text') game.advance();
  assert.equal(`${game.state.mapId}:${game.state.current.eventIndex}`,route.id);
  assert.equal(game.state.current.kind,'ending');
  assert.equal(game.state.current.completed,route.completed);
}

const oldGame=new GameEngine(story);oldGame.restore(legacy.oldFinalCard);
const migrated=new ReplayLibrary(story);migrated.record(oldGame.snapshot());
assert.equal(migrated.unlocked,true);
assert.equal(migrated.progress.endings.length,1);
assert.throws(()=>migrated.replayRoute(library.routes[0].id),'An undiscovered route can be opened');
assert.equal(migrated.record(first.snapshot()),false);
assert.equal(migrated.unlocked,true,'Starting a new game erased completion');
assert.equal(new ReplayLibrary(story,{...migrated.progress,sourceHash:'different'}).unlocked,false);
const damaged=new ReplayLibrary(story,{sourceHash:story.sourceHash,endings:[null,'missing','3:461','3:461']});
assert.equal(damaged.unlocked,true);assert.deepEqual(damaged.progress.endings,['3:461']);
assert.equal(new ReplayLibrary(story,{sourceHash:story.sourceHash,endings:'bad'}).unlocked,false);

const memory=new Map(), storage={getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value)};
const saves=new LocalSaves(storage), item={snapshot:first.snapshot(),time:new Date().toISOString(),chapter:'完璧歸趙',preview:'序章'};
saves.write({auto:item,slots:[item,null,null],settings:{muted:true},progress:migrated.progress});
const readback=saves.read();assert.deepEqual(readback.slots,[item,null,null]);assert.equal(readback.settings.muted,true);
assert.equal(new ReplayLibrary(story,readback.progress).unlocked,true);
assert.deepEqual(new ReplayLibrary(story,readback.progress).progress,migrated.progress);
console.log(JSON.stringify({catalogRoutes:19,lockedUntilCompletion:'passed',chapterBoundaries:3,
  inheritedSceneAndMusic:'passed',replayLastDecisions:19,oldCompletionUpgrade:'passed',stickyUnlock:'passed',
  progressPersistence:'passed',manualSlotsPreserved:'passed',unknownProgressCleanup:'passed'},null,2));
