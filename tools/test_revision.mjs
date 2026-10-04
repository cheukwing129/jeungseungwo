import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GameEngine,plainText} from '../dist/engine.mjs';
import {ReplayLibrary} from '../dist/replay.mjs';

const story=JSON.parse(await readFile(new URL('../dist/story.json',import.meta.url),'utf8'));
// Trimmed actual saves captured before the text review, without new revision metadata.
const legacy=JSON.parse(await readFile(new URL('./fixtures/legacy-saves.json',import.meta.url),'utf8'));
// Actual snapshots from the published 20261003-text-flow release, with short histories.
const previous=JSON.parse(await readFile(new URL('./fixtures/text-flow-saves.json',import.meta.url),'utf8'));
const game=new GameEngine(story);
const untouched=JSON.stringify(legacy);
game.restore(legacy.thirdChapterChoice);
assert(game.state.history.at(-1).text.includes('避讓廉將軍'));
assert.deepEqual(game.state.current.choices.map(x=>x.text),['暫時退讓，日後報復廉頗','先公後私，避免內鬥削弱趙國']);
game.choose(0);
while(game.state.current.kind==='text')game.advance();
assert.equal(game.state.current.category,'理解回饋');
assert(game.state.current.feedback.includes('並非留待日後報復'));
assert(!game.state.current.conclusion.includes('怨亦終不得解'));
game.retry();game.choose(1);
assert.equal(game.state.current.kind,'text');

game.restore(legacy.mianchiHistory);
const reward=game.state.history.find(x=>x.text.includes('好好賞賜'));
assert.equal(reward.speaker,'趙惠文王');
assert(!reward.text.includes('功績'));
game.restore(legacy.punctuatedFailure);
assert(game.state.current.conclusion.includes('命喪秦地'));
assert(game.state.current.feedback.includes('尚未取回璧'));
assert.equal(game.state.current.completed,false);
game.restore(legacy.oldCompleted);
assert.equal(game.state.current.completed,true);
assert(game.state.current.conclusion.includes('刎頸之交'));
assert(!game.state.current.conclusion.includes('長平'));
game.restore(legacy.oldFinalCard);
assert.equal(game.state.ended,true);
assert.equal(game.state.current.kind,'ending');
assert.equal(game.state.current.completed,true);
assert.equal(JSON.stringify(legacy),untouched,'Loading a save mutated the supplied fixture');

const previousUntouched=JSON.stringify(previous), library=new ReplayLibrary(story);
for (const snapshot of Object.values(previous)) {
  const restored=new GameEngine(story);restored.restore(snapshot);
  assert.equal(restored.state.mapId,snapshot.state.mapId);
  assert.equal(restored.state.pc,snapshot.state.pc,'Text review moved a saved command position');
  assert.equal(restored.state.current.eventIndex,snapshot.state.current.eventIndex);
  for (const field of ['pictures','music','variables']) assert.deepEqual(restored.state[field],snapshot.state[field]);
  for (const item of restored.state.history) {
    const event=restored.maps.get(item.mapId)?.events[item.eventIndex];
    if (item.choice) assert(event.choices.some(choice=>choice.text===item.text));
    else {assert.equal(item.speaker,event.p[0]);assert.equal(item.text,event.p[2]);}
  }
  if (restored.state.current.kind==='ending') {
    const route=library.byId.get(`${restored.state.mapId}:${restored.state.current.eventIndex}`);
    assert.equal(restored.state.current.conclusion,route.conclusion,'Save and route catalog disagree');
    assert.equal(restored.state.current.feedback,route.feedback);
    library.record(restored.snapshot());
    assert(library.hasRoute(route.id));
  }
}
assert(library.unlocked,'The text review lost previous completion');
assert.equal(JSON.stringify(previous),previousUntouched,'Loading a previous-release save mutated the fixture');
game.restore(previous.banquetEnding);game.retry();
assert.equal(game.state.current.kind,'choice');
assert.equal(game.state.current.eventIndex,94);
game.choose(1);
assert.equal(game.state.current.kind,'text','A previous-release failed ending could not be retried');

const stable=game.snapshot(),broken=structuredClone(stable);broken.state.pc=-1;
assert.throws(()=>game.restore(broken));
assert.deepEqual(game.snapshot(),stable,'A rejected save changed the running game');

const endings=[],queue=[],initial=new GameEngine(story);initial.start();queue.push(initial.snapshot());
while(queue.length) {
  const route=new GameEngine(story);route.restore(queue.shift());
  while(route.state.current.kind==='text')route.advance();
  if(route.state.current.kind==='choice') {
    for(let i=0;i<route.state.current.choices.length;i++) {
      const branch=new GameEngine(story);branch.restore(route.snapshot());branch.choose(i);queue.push(branch.snapshot());
    }
  } else endings.push(route.state.current);
}
assert.equal(endings.length,19);
assert.equal(endings.filter(x=>x.completed).length,1);
for(const ending of endings) {
  assert(!/^(?:完|全劇終)[。.!！]?$/.test(plainText(ending.conclusion).trim()));
  if(!ending.completed)assert(ending.feedback.length>20,'An incomplete route lacks useful original-text feedback');
}
assert(story.maps[2].events.some(e=>e.code===100&&e.p[2].includes('先國家之急而後私讎')));
assert(story.maps[1].events.some(e=>e.code===100&&e.p[0]==='廉頗'&&e.p[2].includes('三十日')));
assert.equal(story.maps[1].events[375].p[2],'澠池會宴');
for(const index of [387,400,437,439,542,544])assert.equal(story.maps[1].events[index].p[0],'趙惠文王');
console.log(JSON.stringify({legacyChoice:'passed',legacyDialogueHistory:'passed',legacyFinalCard:'passed',
  legacyEnding:'passed',previousReleaseSaves:Object.keys(previous).length,previousCompletionAndRetry:'passed',
  currentRouteCatalogFeedback:'passed',rejectedSavePreservesState:'passed',feedbackRoutes:18,uniqueCompletedEnding:1},null,2));
