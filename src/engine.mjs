const copy = value => structuredClone(value);
const key = value => String(value || '').replaceAll('\\', '/');

/** Original Orange command interpreter. Rendering and storage are separate. */
export class GameEngine {
  constructor(story) {
    this.story = story;
    this.maps = new Map(story.maps.map(map => [map.id, map]));
    this.textPages = new Map();
    for (const map of story.maps) for (const [eventIndex, event] of map.events.entries()) {
      if (event.code !== 100 || event.skipText) continue;
      const page = {mapId:map.id,eventIndex,speaker:event.p[0] || '',text:event.p[2] || '',interlude:Boolean(event.interlude)};
      for (const text of [page,event.legacy].filter(Boolean)) {
        const identity = `${text.speaker}\0${text.text}`;
        if (!this.textPages.has(identity)) this.textPages.set(identity,page);
      }
    }
    this.state = null;
    this.lastChoice = null;
  }

  start(mapId = this.story.startMap) {
    if (!this.maps.has(mapId)) throw new Error('找不到此章節。');
    this.lastChoice = null;
    this.state = {
      mapId, pc: 0, pictures: {}, music: null, variables: {},
      current: null, history: [], decisions: [], ended: false, hypothetical: false,
    };
    return this.advance();
  }

  snapshot() {
    return copy({schema: 1, sourceHash: this.story.sourceHash, revision:this.story.revision,
      state: this.state, lastChoice: this.lastChoice});
  }

  restore(snapshot) {
    if (!snapshot || snapshot.schema !== 1 || snapshot.sourceHash !== this.story.sourceHash) {
      throw new Error('這個存檔不適用於目前的遊戲版本。');
    }
    const state = copy(snapshot.state), lastChoice = copy(snapshot.lastChoice);
    this.validateState(state);
    if (lastChoice) this.validateState(lastChoice);
    const legacy = snapshot.revision !== this.story.revision;
    this.refreshState(state,legacy);
    if (lastChoice) this.refreshState(lastChoice,legacy);
    this.state = state; this.lastChoice = lastChoice;
    if (this.state.current.kind === 'text' && this.maps.get(this.state.mapId).events[this.state.current.eventIndex].skipText) {
      return this.advance();
    }
    return {state: this.state, effects: []};
  }

  refreshState(state, legacy) {
    for (const decision of state.decisions) {
      const choice = this.maps.get(decision.mapId)?.events[decision.event]?.choices?.[decision.index];
      if (choice) {decision.text = choice.text; decision.hypothetical = Boolean(choice.hypothetical);}
    }
    state.hypothetical = Boolean(state.decisions.at(-1)?.hypothetical);
    let choiceIndex = Math.max(0,state.decisions.length - state.history.filter(item=>item.choice).length);
    let hypothetical = Boolean(state.decisions[choiceIndex-1]?.hypothetical);
    state.history = state.history.map(item => {
      if (item.choice) {
        const decision = state.decisions[choiceIndex++];
        if (decision) hypothetical = Boolean(decision.hypothetical);
        return decision ? {...item,text:decision.text,mapId:decision.mapId,eventIndex:decision.event,hypothetical} : item;
      }
      const event = this.maps.get(item.mapId)?.events[item.eventIndex];
      const page = event?.code === 100 ? {mapId:item.mapId,eventIndex:item.eventIndex,
        speaker:event.p[0] || '',text:event.p[2] || '',interlude:Boolean(event.interlude)} :
        this.textPages.get(`${item.speaker}\0${item.text}`);
      return page ? {...item,...page,hypothetical} : item;
    });
    if (legacy) state.history = state.history.filter((item,index,all)=>!(item.mapId === 1 && item.eventIndex === 864 &&
      all[index-1]?.mapId === 1 && all[index-1]?.eventIndex === 864));
    const current = state.current, map = this.maps.get(state.mapId), event = map.events[current.eventIndex];
    if (current.kind === 'text') {
      Object.assign(current,{speaker:event.p[0] || '',text:event.p[2] || '',interlude:Boolean(event.interlude)});
      // Old autosaves stopped at the end card rather than retaining completion.
      if (legacy && !current.speaker && /^(?:完|全劇終)[。.!！]?$/.test(plainText(current.text).replace(/\s/g,''))) {
        let end = current.eventIndex + 1;
        while (end < map.events.length && ![100,101,206,208].includes(map.events[end].code)) end++;
        if (map.events[end]?.code === 208) {
          state.pc = end + 1; state.ended = true;
          state.current = this.endingFor(state,end);
        }
      }
    } else if (current.kind === 'choice') {
      current.choices = copy(event.choices); current.prompt = event.prompt || '';
    } else state.current = this.endingFor(state,current.eventIndex);
  }

  validateState(state) {
    const map = this.maps.get(state?.mapId);
    if (!map || !Number.isInteger(state.pc) || state.pc < 0 || state.pc > map.events.length ||
        !Array.isArray(state.history) || !Array.isArray(state.decisions) ||
        !state.pictures || typeof state.pictures !== 'object' || !state.variables || typeof state.variables !== 'object') {
      throw new Error('存檔內容不完整，請選擇另一個存檔。');
    }
    const c = state.current;
    if (!c || !['text','choice','ending'].includes(c.kind)) throw new Error('存檔的劇情位置無效。');
    if (c.kind === 'text' && (typeof c.text !== 'string' || typeof c.speaker !== 'string')) throw new Error('存檔的文字內容無效。');
    if (c.kind === 'text' && (map.events[c.eventIndex]?.code !== 100 || state.pc !== c.eventIndex + 1)) {
      throw new Error('存檔的對話位置無效。');
    }
    if (c.kind === 'choice') {
      const event = map.events[c.eventIndex];
      if (!event || event.code !== 101 || state.pc !== c.eventIndex + 1) throw new Error('存檔的選項位置無效。');
      // Use the authoritative choices, never stored arbitrary jump targets.
      c.choices = copy(event.choices);
    }
    for (const picture of Object.values(state.pictures)) {
      if (!picture || typeof picture.asset !== 'string' || ![picture.x,picture.y,picture.sx,picture.sy,picture.opacity].every(Number.isFinite)) {
        throw new Error('存檔的畫面內容無效。');
      }
    }
  }

  choose(index) {
    const current = this.state?.current;
    if (current?.kind !== 'choice') throw new Error('目前沒有需要選擇的選項。');
    const event = this.maps.get(this.state.mapId).events[current.eventIndex];
    if (!Number.isInteger(index) || !event.choices[index]) throw new Error('請選擇有效的選項。');
    const selected = event.choices[index];
    this.state.decisions.push({mapId:this.state.mapId,event:current.eventIndex,index,text:selected.text,hypothetical:Boolean(selected.hypothetical)});
    this.state.history.push({speaker:'你的選擇',text:selected.text,choice:true,mapId:this.state.mapId,eventIndex:current.eventIndex,hypothetical:Boolean(selected.hypothetical)});
    this.state.hypothetical = Boolean(selected.hypothetical);
    this.state.pc = selected.target;
    this.state.current = null;
    return this.advance();
  }

  retry() {
    if (!this.lastChoice) throw new Error('目前沒有可重新選擇的位置。');
    this.state = copy(this.lastChoice);
    return {state:this.state,effects:[]};
  }

  advance() {
    if (!this.state) throw new Error('請先開始遊戲。');
    if (this.state.current?.kind === 'choice' || this.state.ended) return {state:this.state,effects:[]};
    const effects = [];
    const state = this.state;
    state.current = null;
    for (let guard = 0; guard < 10000; guard++) {
      const map = this.maps.get(state.mapId);
      if (state.pc >= map.events.length) return this.finish(effects);
      const eventIndex = state.pc++;
      const e = map.events[eventIndex], p = e.p;
      switch (e.code) {
        case 100:
          if (e.skipText) break;
          state.current = {kind:'text',speaker:p[0] || '',text:p[2] || '',eventIndex,interlude:Boolean(e.interlude)};
          state.history.push({speaker:state.current.speaker,text:state.current.text,mapId:state.mapId,eventIndex,interlude:Boolean(e.interlude),hypothetical:state.hypothetical});
          state.history = state.history.slice(-600);
          return {state,effects};
        case 101:
          state.current = {kind:'choice',choices:copy(e.choices),eventIndex,prompt:e.prompt || ''};
          this.lastChoice = copy(state);
          return {state,effects};
        case 108:
          // A sibling branch marks the end of the selected branch.
          if (!Number.isInteger(e.skip)) throw new Error('劇情分支資料不完整。');
          state.pc = e.skip;
          break;
        case 102: case 107: case 109: case 210:
          break;
        case 206:
          if (!this.maps.has(Number(p[0]))) throw new Error('找不到下一章。');
          state.mapId = Number(p[0]); state.pc = 0;
          break;
        case 207: {
          const name = p[4]?.match(/\[\d+:([^\]]+)\]/)?.[1] || `var${p[1]}`;
          const amount = Number(p[3]) || 0;
          const previous = state.variables[name] || 0;
          state.variables[name] = p[4]?.includes('+=') ? previous + amount : amount;
          break;
        }
        case 208:
          return this.finish(effects);
        case 400:
        case 402: {
          const id = String(p[0]);
          if (e.code === 402 && !state.pictures[id]) break;
          state.pictures[id] = {
            asset:key(p[1]),x:Number(p[3]) || 0,y:Number(p[4]) || 0,
            sx:Number(p[5]) || 100,sy:Number(p[6]) || 100,
            opacity:Number(p[7]),mirror:p[8] === '1',
          };
          break;
        }
        case 401:
          delete state.pictures[String(p[0])];
          break;
        case 501:
          state.music = {asset:key(p[0]),volume:Number(p[1]) / 100,loop:true};
          break;
        case 502:
          effects.push({type:'sound',asset:key(p[0]),volume:Number(p[1])/100});
          break;
        default:
          throw new Error(`不支援的劇情指令：${e.code}`);
      }
    }
    throw new Error('劇情跳轉次數異常。');
  }

  finish(effects) {
    this.state.ended = true;
    this.state.current = this.endingFor(this.state,this.state.pc-1);
    return {state:this.state,effects};
  }

  endingFor(state,eventIndex) {
    const ending = this.maps.get(state.mapId).events[eventIndex]?.ending;
    if (ending) return {kind:'ending',...copy(ending),eventIndex};
    const completed = plainText(state.history.at(-1)?.text || '').trim() === '全劇終';
    const conclusion = [...state.history].reverse().find(x=>!x.choice && !x.speaker &&
      !/^(?:完|全劇終)[。.!！]?$/.test(plainText(x.text).replace(/\s/g,'')));
    return {kind:'ending',completed,conclusion:conclusion?.text || '',feedback:'',category:completed?'故事落幕':'假設情節',eventIndex};
  }
}

export function textRuns(text) {
  const input = String(text).replaceAll('\\n','\n');
  const runs = [];
  const pattern = /\\c\[(\d+),(\d+),(\d+)\]/g;
  let color = '', start = 0;
  for (const match of input.matchAll(pattern)) {
    if (match.index > start) runs.push({text:input.slice(start,match.index),color});
    const values = match.slice(1).map(n => Math.max(0,Math.min(255,Number(n))));
    color = values.join(','); start = match.index + match[0].length;
  }
  if (start < input.length) runs.push({text:input.slice(start),color});
  return runs;
}

export function plainText(text) { return textRuns(text).map(run=>run.text).join(''); }
