import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GameEngine,plainText,textRuns} from '../dist/engine.mjs';
import {LocalSaves,STORAGE_KEY} from '../dist/storage.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const story=JSON.parse(await readFile(path.join(root,'dist/story.json'),'utf8'));
const assets=JSON.parse(await readFile(path.join(root,'dist/assets.json'),'utf8'));
const coveredTexts=new Set(),coveredChoices=new Set(),coveredOptions=new Set();
const leaves=[],queue=[];
const initial=new GameEngine(story);initial.start();queue.push(initial.snapshot());

// Walk every route from the actual start, including nested choices and chapter jumps.
while(queue.length) {
  const game=new GameEngine(story);game.restore(queue.shift());
  let steps=0;
  while(game.state.current.kind==='text') {
    const {mapId,current}=game.state;
    coveredTexts.add(`${mapId}:${current.eventIndex}`);
    const copy=new GameEngine(story);
    copy.restore(JSON.parse(JSON.stringify(game.snapshot())));
    assert.deepEqual(copy.state,game.state,'Save/restore changed a dialogue or visual state');
    game.advance();
    if(++steps>2000)throw new Error('A route failed to terminate');
  }
  if(game.state.current.kind==='ending') {
    leaves.push(game.snapshot());
    if(game.lastChoice) {
      const retry=game.retry();
      assert.equal(retry.state.current.kind,'choice');
      assert.equal(retry.state.ended,false);
    }
    continue;
  }
  const {mapId,current}=game.state;
  coveredChoices.add(`${mapId}:${current.eventIndex}`);
  const event=game.maps.get(mapId).events[current.eventIndex];
  assert.deepEqual(current.choices.map(x=>x.text),event.p,'Choice text or order differs from the source');
  for(let i=0;i<current.choices.length;i++) {
    coveredOptions.add(`${mapId}:${current.eventIndex}:${i}`);
    const branch=new GameEngine(story);branch.restore(game.snapshot());
    branch.choose(i);queue.push(branch.snapshot());
  }
}

assert.equal(coveredTexts.size,529,'Some reviewed dialogue is unreachable');
assert.equal(coveredChoices.size,14,'Some original choice points are unreachable');
assert.equal(coveredOptions.size,32,'Some original options were dropped');
assert.equal(leaves.length,19,'Unexpected number of terminal routes');
assert.equal(leaves.filter(x=>x.state.current.completed).length,1,'The successful historical ending is missing');
assert(leaves.find(x=>x.state.current.completed).state.history.some(x=>plainText(x.text).includes('刎頸')),'The historical reconciliation is missing');

for(const key of story.assets) {
  assert(assets[key],`Missing asset mapping: ${key}`);
  const local=path.resolve(root,'dist',assets[key].src);
  assert(local.startsWith(path.resolve(root,'dist')+path.sep),'Asset escapes public directory');
  assert((await stat(local)).size>0,`Empty asset: ${key}`);
}

assert.deepEqual(textRuns('甲\\c[255,0,0]乙\\c[50,50,50]丙\\n丁'),[
  {text:'甲',color:''},{text:'乙',color:'255,0,0'},{text:'丙\n丁',color:'50,50,50'},
]);
const game=new GameEngine(story);game.start();
assert.throws(()=>game.choose(0));
assert.throws(()=>game.restore({...game.snapshot(),sourceHash:'invalid'}));
const bad=game.snapshot();bad.state.pc=-1;assert.throws(()=>game.restore(bad));

const memory=new Map();
const storage={getItem:k=>memory.get(k) || null,setItem:(k,v)=>memory.set(k,v)};
const saves=new LocalSaves(storage);
const savedEntry={snapshot:game.snapshot(),time:new Date().toISOString(),chapter:'完璧歸趙',preview:'春秋戰國時期'};
assert(saves.writeAuto(savedEntry));assert(saves.writeSlot(0,savedEntry));assert(saves.writeMuted(true));
const readback=saves.read();assert.deepEqual(readback.auto,savedEntry);assert.equal(readback.settings.muted,true);
memory.clear();memory.set(STORAGE_KEY,'{broken');assert.equal(saves.read().auto,null);
memory.set(STORAGE_KEY,JSON.stringify({auto:{time:'bad'},slots:[42,savedEntry],settings:{muted:'false'}}));
const partial=saves.read();assert.equal(partial.slots[0],null);assert.deepEqual(partial.slots[1],savedEntry);assert.equal(partial.settings.muted,false);
assert.equal(new LocalSaves({getItem(){return null;},setItem(){throw new Error('quota');}}).writeAuto(savedEntry),false);

console.log(JSON.stringify({dialogue:coveredTexts.size,choicePoints:coveredChoices.size,options:coveredOptions.size,terminalRoutes:leaves.length,assets:story.assets.length,saveRestore:'passed',corruptStorage:'passed'},null,2));
