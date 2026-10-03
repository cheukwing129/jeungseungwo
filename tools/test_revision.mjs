import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GameEngine,plainText} from '../dist/engine.mjs';

const story=JSON.parse(await readFile(new URL('../dist/story.json',import.meta.url),'utf8'));
// Trimmed actual saves captured before the text review, without new revision metadata.
const legacy=JSON.parse(await readFile(new URL('./fixtures/legacy-saves.json',import.meta.url),'utf8'));
const game=new GameEngine(story);
const untouched=JSON.stringify(legacy);
game.restore(legacy.thirdChapterChoice);
assert(game.state.history.at(-1).text.includes('避讓廉將軍'));
assert.deepEqual(game.state.current.choices.map(x=>x.text),['害怕廉頗，不敢與他相爭','先公後私，避免內鬥削弱趙國']);
game.choose(0);
while(game.state.current.kind==='text')game.advance();
assert.equal(game.state.current.category,'理解回饋');
assert(game.state.current.feedback.includes('並非害怕廉頗'));
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
  legacyEnding:'passed',rejectedSavePreservesState:'passed',feedbackRoutes:18,uniqueCompletedEnding:1},null,2));
