import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {guideSections,guideGlossary,locateGuideSection} from '../dist/guide.mjs';

const story=JSON.parse(await readFile(new URL('../dist/story.json',import.meta.url),'utf8'));
const text=guideSections.map(section=>section.text).join('');
assert.equal(guideSections.length,10);
assert.equal(new Set(guideSections.map(section=>section.id)).size,guideSections.length);
assert(text.startsWith('廉頗者，趙之良將也。'));
assert(text.endsWith('為刎頸之交。'));
for(const section of guideSections)assert(section.text.trim());

let positions=0;
for(const map of story.maps)for(let event=0;event<map.events.length;event++) {
  const anchors=guideSections.filter(section=>section.mapId===map.id && event>=section.eventStart && event<=section.eventEnd);
  assert.equal(anchors.length,1,`Position ${map.id}:${event} must have exactly one guide anchor`);
  assert.equal(guideSections[locateGuideSection(map.id,event)],anchors[0]);
  positions++;
}
for(const [map,event,id] of [[1,51,'miao-xian'],[1,287,'mission'],[1,686,'qin-court'],
  [1,991,'return-jade'],[2,199,'mianchi'],[3,293,'national-interest'],[3,371,'national-interest'],[3,461,'apology']]) {
  assert.equal(guideSections[locateGuideSection(map,event)].id,id,`Wrong guide at ${map}:${event}`);
}
assert.equal(locateGuideSection('3','420'),9);
assert.equal(locateGuideSection(99,0),0);

const terms=new Set();
for(const gloss of guideGlossary) {
  assert(!terms.has(gloss.term),`Duplicate glossary term: ${gloss.term}`);terms.add(gloss.term);
  assert(text.includes(gloss.term),`Glossary term absent from original text: ${gloss.term}`);
  assert(gloss.definition.trim());
  assert(['edb','supplement'].includes(gloss.source));
}
console.log(JSON.stringify({guideSections:guideSections.length,guideGlossary:guideGlossary.length,
  anchoredGameCommands:positions,choiceAndEndingPositions:'passed',distinctGlossarySources:'passed'},null,2));
