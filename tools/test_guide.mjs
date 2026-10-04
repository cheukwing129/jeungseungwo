import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {guideSections,guideGlossary,locateGuideSection,guideAnnotations,guideNotesAt,guideTextRuns,
  guideBasicWords,guideContextWords,guideGrammar,guideAnnotationStats} from '../dist/guide.mjs';

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

// Every source anchor must be unique and resolve to the intended word, independent of overlapping glosses.
const basicTerms=new Set();
for(const note of guideBasicWords) {
  assert(!basicTerms.has(note.term),`Duplicate basic headword: ${note.term}`);basicTerms.add(note.term);
  assert(text.includes(note.term));assert(note.partOfSpeech);assert(note.definition);
}
const contextKeys=new Set();
for(const note of guideContextWords) {
  const section=guideSections.find(section=>section.id===note.sectionId);
  const start=section.text.indexOf(note.context);
  assert(start>=0);assert.equal(section.text.indexOf(note.context,start+1),-1,`Ambiguous context: ${note.context}`);
  assert.equal(section.text.slice(start+note.offset,start+note.offset+note.term.length),note.term);
  const key=`${note.sectionId}:${start+note.offset}:${note.term}`;
  assert(!contextKeys.has(key),`Repeated context: ${key}`);contextKeys.add(key);
  assert(note.partOfSpeech);assert(['edb','supplement'].includes(note.source));
  if(note.source==='edb')assert(Number.isInteger(note.edbNote) && note.edbNote>=1 && note.edbNote<=79);
}

let clickableRuns=0,wordPositions=0;
for(const section of guideSections) {
  const annotations=guideAnnotations(section.id),runs=guideTextRuns(section.id);
  assert.equal(runs.map(run=>run.text).join(''),section.text,'Annotations changed the original passage');
  assert.equal(runs[0].start,0);assert.equal(runs.at(-1).end,section.text.length);
  for(const [index,run] of runs.entries()) {
    if(index)assert.equal(run.start,runs[index-1].end);
    assert.equal(run.text,section.text.slice(run.start,run.end));
    if(run.annotations.length) {
      clickableRuns++;
      assert(run.annotations.some(note=>note.kind!=='sentence'));
      assert(!/^[，。；：？！「」『』、]+$/.test(run.text),'Punctuation became a vocabulary button');
    }
  }
  for(const note of annotations) {
    assert.equal(section.text.slice(note.start,note.end),note.term);
    assert(note.definition.trim());assert(['word','phrase','sentence'].includes(note.kind));
    if(note.kind==='word')wordPositions++;
  }
}

function wordAt(id,quote,term,occurrence=0) {
  const section=guideSections.find(section=>section.id===id),anchor=section.text.indexOf(quote);
  assert(anchor>=0,quote);
  let relative=-1;
  for(let n=0;n<=occurrence;n++)relative=quote.indexOf(term,relative+1);
  assert(relative>=0);
  const start=anchor+relative,notes=guideNotesAt(id,start,start+term.length);
  const word=notes.find(note=>note.kind==='word' && note.term===term);
  assert(word,`Missing local word: ${id}:${quote}:${term}`);
  return {word,notes,start};
}
for(const [id,quote,term,pos,meaning,occurrence=0] of [
  ['miao-xian','臣嘗有罪','嘗','副詞','曾經'],
  ['return-jade','未嘗有堅明約束者也','嘗','副詞','不曾'],
  ['miao-xian','計未定','計','名詞','計策'],
  ['miao-xian','竊計欲亡走燕','計','動詞','計劃'],
  ['miao-xian','臣從其計','計','名詞','計策'],
  ['mianchi','廉頗、藺相如計曰','計','動詞','商議'],
  ['miao-xian','使人遺趙王書','使','動詞','派遣'],
  ['miao-xian','藺相如可使','使','動詞','出使'],
  ['mission','奉璧往使','使','動詞','出使'],
  ['mianchi','秦王使使者告趙王','使','動詞','派遣',0],
  ['mianchi','秦王使使者告趙王','使','名詞','使者',1],
  ['return-jade','一介之使','使','名詞','使者'],
  ['return-jade','使不辱於諸侯','使','動詞','出使'],
  ['miao-xian','徒見欺','見','助詞','被'],
  ['qin-court','見臣列觀','見','動詞','接見'],
  ['rank-dispute','我見相如','見','動詞','碰見'],
  ['qin-court','負其彊','負','動詞','倚仗'],
  ['qin-court','負約不償城','負','動詞','違背'],
  ['return-jade','負趙','負','動詞','辜負'],
  ['apology','肉袒負荊','負','動詞','背'],
  ['miao-xian','今君乃亡趙走燕','乃','副詞','竟然'],
  ['qin-court','臣乃敢上璧','乃','副詞','才'],
  ['mianchi','相如顧召趙御史','顧','動詞','回頭'],
  ['national-interest','顧吾念之','顧','連詞','不過'],
  ['miao-xian','君幸於趙王','幸','動詞','受寵'],
  ['miao-xian','則幸得脫矣','幸','副詞','僥倖'],
  ['qin-court','布衣之交','衣','名詞','衣服'],
  ['qin-court','衣褐','衣','名詞作動詞','穿着'],
  ['qin-court','持璧卻立','立','動詞','站立'],
  ['return-jade','趙立奉璧來','立','副詞','立即'],
  ['mianchi','立太子為王','立','動詞','擁立'],
  ['qin-court','拜送書於庭','拜','動詞','行禮'],
  ['mianchi','為好會','好','形容詞','友好'],
  ['mianchi','好音','好','動詞','喜愛'],
  ['mianchi','為一擊缻','為','介詞','替'],
]) {
  const {word}=wordAt(id,quote,term,occurrence);
  assert.equal(word.partOfSpeech,pos,`${quote}: wrong POS for ${term}`);
  assert(word.definition.includes(meaning),`${quote}: wrong meaning for ${term}`);
}

const planned=wordAt('miao-xian','竊計欲亡走燕','計');
assert(planned.notes.some(note=>note.kind==='phrase' && note.term==='竊計'),'The original phrase note was lost');
const planRun=guideTextRuns('miao-xian').find(run=>run.start<=planned.start && run.end>planned.start);
assert.equal(planRun.annotations[0].term,'計','A long phrase still hides the basic word');
const question=wordAt('miao-xian','何以知之','以');
assert(question.notes.some(note=>note.kind==='sentence' && note.definition.includes('以何知之')));

const grammarKeys=new Set();
for(const note of guideGrammar) {
  const key=`${note.sectionId}:${note.term}:${note.label}`;assert(!grammarKeys.has(key));grammarKeys.add(key);
  assert(guideSections.find(section=>section.id===note.sectionId).text.includes(note.term));
  assert.equal(note.source,'supplement');assert(note.definition);
}
assert.equal(guideGrammar.length,50);
for(const label of ['判斷句','賓語前置','定語後置','被動句','省略','兼語','使動','意動','名詞作動詞','古今異義']) {
  assert(guideGrammar.some(note=>note.label.includes(label)),`Missing learning category: ${label}`);
}
console.log(JSON.stringify({annotationDefinitions:guideAnnotationStats,wordPositions,clickableRuns,
  originalTextPreserved:'passed',polysemousPosAndMeanings:'passed',overlappingWordsAndSentences:'passed',
  anchoredContextUniqueness:'passed',grammarCategories:'passed'},null,2));
