import {GameEngine,plainText,textRuns} from './engine.98655b91988440c18163.mjs';
import {LocalSaves} from './storage.5b74a4f0744f59430dec.mjs';
import {ReplayLibrary} from './replay.8c65d485a3c52deff7d1.mjs';
import {AutosaveScheduler} from './autosave.5304eab828526e984afc.mjs';
import {PictureRenderer} from './pictures.287d2f599d1c66db74d5.mjs';
import {DialogueHold} from './dialogue-hold.026726a8a3f493f7affe.mjs';
import {MusicPlayer,nextMusic} from './music.03f9117db9a3671f915f.mjs';
import {WEBMCP_ENABLED} from './config.b7e49eefe77eb1d3aa8d.mjs';
import {registerGameTools} from './webmcp.31eb8431a184ab982384.mjs';

const $ = id => document.getElementById(id);
let story, assets, engine, saved, saves, dialogueHold, replay, autosave;
let typing = null, typeTimer = 0, autoTimer = 0, auto = false, toastTimer = 0;
let started = false, busy = false, storageWarned = false;
let renderedMapId = null, rendering = false, pendingAnnouncement = '', activeSlotsMode = null;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const music = new MusicPlayer({onChange:()=>{if(saved)updateMusic();}});
const sounds = new Set();
const pictureRenderer = new PictureRenderer($('pictures'), {reducedMotion});

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>{$('toast').hidden=true;},3500);
}

function persist(write) {
  const success = write();
  if (!success && !storageWarned) {
    storageWarned = true;
    toast('瀏覽器未能儲存進度；本次仍可繼續遊玩。');
  }
  return success;
}

function entry(snapshot) {
  const state = snapshot.state;
  const recent = [...state.history].reverse().find(item=>!item.choice);
  return {snapshot,time:new Date().toISOString(),chapter:engine.maps.get(state.mapId).title,
    preview:state.current?.kind==='ending' ? (state.current.completed?'已通關：刎頸之交':'可返回上次抉擇') :
      plainText(formatDialogue(recent?.speaker || '',recent?.text || '等待你的抉擇',recent?.interlude).text).trim().slice(0,48)};
}

function saveCurrentProgress() {
  if (!engine.state) return true;
  const snapshot = engine.snapshot();
  replay.record(snapshot);saved.progress = replay.progress;
  saved.auto = entry(snapshot);
  const autoSaved = persist(() => saves.writeAuto(saved.auto));
  const progressSaved = persist(() => saves.writeProgress(replay.progress));
  return autoSaved && progressSaved;
}

function announce(message) {pendingAnnouncement = message;publishAnnouncement();}
function publishAnnouncement() {
  if (rendering) return;
  const region = $('announcement');
  if (dialogueHold?.active) {
    if (region.getAttribute('aria-live') !== 'off') {
      region.setAttribute('aria-live','off');region.textContent = '';
    }
    return;
  }
  region.setAttribute('aria-live','polite');
  if (region.textContent !== pendingAnnouncement) region.textContent = pendingAnnouncement;
}

function assetUrl(key) { return Object.hasOwn(assets,key) ? assets[key]?.src || null : null; }

function syncMusic() {
  const wanted = started ? engine.state?.music : {asset:'BGM/霸气男主出场.mp3',volume:.6};
  const source = wanted && assetUrl(wanted.asset);
  music.update({track:source?{src:source,volume:wanted.volume}:null,muted:saved.settings.muted,hidden:document.hidden,
    next:started?assetUrl(nextMusic(story,engine.state)):null});
}

function playEffects(effects) {
  if (saved.settings.muted || document.hidden) return;
  for (const effect of effects) {
    const src = assetUrl(effect.asset); if (!src) continue;
    const audio = new Audio(src); audio.volume = Math.max(0,Math.min(.85,effect.volume*.65));
    sounds.add(audio);
    audio.addEventListener('ended',()=>sounds.delete(audio),{once:true});
    audio.play().catch(()=>sounds.delete(audio));
  }
}

function playbackRate() { return dialogueHold?.active ? 5 : 1; }
function updatePlayback() {
  $('hold-status').hidden=!dialogueHold.active;
  clearTimeout(autoTimer);
  if (typing) {
    clearTimeout(typeTimer);
    typeTimer=setTimeout(typing.tick,26/playbackRate());
  } else scheduleAuto();
  publishAnnouncement();
}

function stopTyping() { clearTimeout(typeTimer); typeTimer=0; typing=null; }
function completeText() {
  if (!typing) return;
  const {spans,runs} = typing;
  runs.forEach((run,i)=>{spans[i].textContent=run.text;});
  stopTyping(); scheduleAuto();
}

function formatDialogue(speaker,text,interlude=false) {
  const visible=plainText(text),compact=visible.replace(/[ \t\u3000]+/g,'').trim();
  const centered=!speaker && (interlude || /^[ \t\u3000]{2,}/.test(visible) ||
    /^(?:序章(?:完)?|第[一二三]章(?:完|完璧歸趙|澠池之會|負荊請罪)|秦國‧章台|澠池會宴|全劇終|完)[。.!！]?$/.test(compact));
  // Normalize at presentation time so older saves receive the same layout.
  return {text:centered ? String(text).replaceAll('\\n','\n').replace(/[ \t\u3000]+/g,'').trim() : text,centered};
}

function renderText(speaker,text,animate,interlude=false) {
  stopTyping();
  const presentation=formatDialogue(speaker,text,interlude);text=presentation.text;
  $('dialogue').classList.toggle('interlude',presentation.centered);
  $('speaker').hidden=presentation.centered;
  $('speaker').textContent = `${speaker || '旁白'}${engine.state?.hypothetical?' · 假設情節':''}`;
  announce((engine.state?.hypothetical?'假設情節。':'')+
    (presentation.centered ? plainText(text) : `${speaker || '旁白'}：${plainText(text)}`));
  const target = $('story-text'); target.replaceChildren();
  const runs=textRuns(text),spans=[];
  for (const run of runs) {
    const span=document.createElement('span');
    if (run.color) {
      const [r,g,b]=run.color.split(',').map(Number);
      if (r>180 && g<80 && b<80) {span.style.color='#a82f20';span.className='color-emphasis';}
      else if (b>150 && r<100) {span.style.color='#283b98';span.className='color-emphasis';}
      else if (r+g+b<240) span.style.color='#282a22';
    }
    span.textContent=animate && !reducedMotion ? '' : run.text;
    target.append(span);spans.push(span);
  }
  if (!animate || reducedMotion) {
    // Static text uses only its five-speed presentation time, without a separate page pause.
    scheduleAuto({fastTextDuration:Array.from(plainText(text)).length*26});
    return;
  }
  const characters=runs.map(run=>Array.from(run.text));
  let runIndex=0,position=0;
  const tick=()=>{
    if (!typing) return;
    if (runIndex>=characters.length) {stopTyping();scheduleAuto();return;}
    spans[runIndex].textContent+=characters[runIndex][position++] || '';
    if(position>=characters[runIndex].length){runIndex++;position=0;}
    if(runIndex>=characters.length) {stopTyping();scheduleAuto();return;}
    typeTimer=setTimeout(tick,26/playbackRate());
  };
  typing={spans,runs,tick};
  if(dialogueHold?.active)tick();
  else typeTimer=setTimeout(tick,26/playbackRate());
}

function scheduleAuto({fastTextDuration=0}={}) {
  clearTimeout(autoTimer);
  if ((!auto && !dialogueHold?.active) || typing || !started || $('menu-dialog').open || document.hidden || engine.state.current.kind!=='text') return;
  const current=engine.state.current;
  const length=plainText(formatDialogue(current.speaker,current.text).text).length;
  const delay=dialogueHold?.active ? fastTextDuration/playbackRate() : Math.max(1500,Math.min(6000,length*40));
  autoTimer=setTimeout(next,delay);
}

function render(result,options={}) {
  rendering = true;
  try {renderState(result,options);}
  finally {rendering = false;publishAnnouncement();}
}

function renderState(result,{animate=true,saveNow=false}={}) {
  clearTimeout(autoTimer);
  const state=result.state,current=state.current;
  const chapterChanged = !started || renderedMapId !== state.mapId;
  renderedMapId = state.mapId;
  if(current.kind!=='text')dialogueHold?.cancel();
  started=true;
  $('title-screen').hidden=true;
  $('return-button').hidden=false;
  $('dialogue-panel').hidden=current.kind==='ending';
  $('ending').hidden=current.kind!=='ending';
  $('choices').hidden=current.kind!=='choice';
  $('dialogue-actions').hidden=current.kind==='ending';
  $('scene-choices').hidden=current.kind!=='choice';
  $('next-button').hidden=current.kind!=='text';
  $('auto-button').hidden=current.kind!=='text';
  $('save-button').disabled=current.kind==='ending';
  $('history-button').disabled=false;
  for(const label of document.querySelectorAll('.chapter')) {
    label.classList.toggle('current',Number(label.dataset.map)===state.mapId);
    if(Number(label.dataset.map)===state.mapId)label.setAttribute('aria-current','step');else label.removeAttribute('aria-current');
  }
  pictureRenderer.render(state.pictures, assets, {width:story.width, height:story.height});
  if(current.kind==='text') {
    renderText(current.speaker,current.text,animate,current.interlude);
    $('instruction').textContent=(state.hypothetical?'假設情節，並非史實。':'')+'點擊或按空白鍵繼續；按住場景、對話框、「繼續」或空白鍵可五倍速快讀，放開停止。';
  } else if(current.kind==='choice') {
    const last=[...state.history].reverse().find(item=>!item.choice);
    renderText(last?.speaker || '',last?.text || '',false,last?.interlude);
    $('choice-heading').textContent=current.prompt || '按原文，請作出你的抉擇';
    const choices=$('choices');choices.replaceChildren();
    current.choices.forEach((choice,index)=>{
      const button=document.createElement('button');button.className='choice-button';
      const badge=document.createElement('span');badge.className='choice-number';badge.textContent=String(index+1);badge.setAttribute('aria-hidden','true');
      const label=document.createElement('span');label.textContent=choice.text;
      button.append(badge,label);button.addEventListener('click',()=>choose(index));choices.append(button);
    });
    const shortcuts=current.choices.slice(0,9).map((_,index)=>index+1).join('、');
    $('instruction').textContent=`按原文作選擇。亦可按數字鍵 ${shortcuts} 選擇。`;
    announce(`${$('choice-heading').textContent}。${current.choices.map((choice,index)=>`${index+1}：${choice.text}`).join('。')}`);
    requestAnimationFrame(()=>{if(!$('scene-choices').hidden)choices.querySelector('button')?.focus({preventScroll:true});});
  } else {
    stopTyping();
    $('ending-text').textContent=plainText(current.conclusion).trim();
    $('ending-feedback').textContent=current.feedback || '';
    $('ending-feedback').hidden=!current.feedback;
    $('ending-title').textContent=current.completed?'全劇終':current.category==='理解回饋'?'再想一想':'偏離原文走向';
    $('ending-eyebrow').textContent=current.category || (current.completed?'故事落幕':'假設情節');
    $('retry-button').hidden=current.completed || !engine.lastChoice;
    $('ending-chapters-button').hidden=!current.completed;
    $('ending-routes-button').hidden=!current.completed;
    $('instruction').textContent=current.completed?'已解鎖章節選擇與路線圖鑑，可重玩指定章節。':'可以回到上一個選擇，重新作出抉擇。';
    announce(`${$('ending-title').textContent}。${plainText(current.conclusion)} ${current.feedback || ''}`);
    requestAnimationFrame(()=>{
      if(engine.state.current.kind==='ending')endingAction().focus({preventScroll:true});
    });
  }
  syncMusic();playEffects(result.effects || []);
  autosave.mark({immediate:saveNow || chapterChanged || current.kind!=='text'});
}

function handleError(error) {console.error(error);toast(error.message || '暫時未能繼續，請讀取存檔或重新開始。');}
function next() {
  if(!started || busy || $('menu-dialog').open) return;
  if(typing){completeText();return;}
  if(engine.state.current.kind!=='text') return;
  busy=true;
  try{render(engine.advance());}catch(error){handleError(error);}finally{busy=false;}
}
function choose(index) {
  if(busy || $('menu-dialog').open) return;
  busy=true;
  try{
    render(engine.choose(index),{saveNow:true});
    if(engine.state.current.kind==='text')$('next-button').focus({preventScroll:true});
    else if(engine.state.current.kind==='ending')endingAction().focus({preventScroll:true});
  }catch(error){handleError(error);}finally{busy=false;}
}
function start() {auto=false;dialogueHold?.cancel();updateAuto();render(engine.start(),{saveNow:true});}
function resume(item) {
  try{auto=false;dialogueHold?.cancel();updateAuto();render(engine.restore(item.snapshot),{animate:false,saveNow:true});closeDialog();return true;}
  catch(error){handleError(error);return false;}
}

function updateAuto() {$('auto-button').textContent=`自動：${auto?'開':'關'}`;$('auto-button').setAttribute('aria-pressed',String(auto));}
function updateMusic() {
  const labels={off:'關',waiting:'待啟動',blocked:'待啟動',loading:'載入中',playing:'開',paused:'暫停',idle:'待播放',error:'未能播放'};
  const label=saved.settings.muted?'關':labels[music.status];
  $('music-button').textContent=`音樂：${label}`;
  $('music-button').setAttribute('aria-pressed',String(saved.settings.muted));
  $('music-button').setAttribute('aria-label',saved.settings.muted?'開啟音樂':
    ['blocked','waiting','error'].includes(music.status)?'啟動音樂':'關閉音樂');
}
function endingAction() {return engine.state.current.completed ? $('ending-chapters-button') :
  $('retry-button').hidden ? $('home-button') : $('retry-button');}

function openDialog(title) {
  dialogueHold?.cancel();
  completeText();clearTimeout(autoTimer);
  autosave.flush();activeSlotsMode = null;
  $('dialog-title').textContent=title;$('dialog-body').replaceChildren();
  $('menu-dialog').scrollTop=0;
  if(!$('menu-dialog').open)$('menu-dialog').showModal();
}
function closeDialog() {activeSlotsMode = null;$('menu-dialog').close();scheduleAuto();}
function paragraph(className,text) {const p=document.createElement('p');p.className=className;p.textContent=text;return p;}

function beginReplay(snapshot) {
  auto=false;dialogueHold?.cancel();updateAuto();closeDialog();
  render(engine.restore(snapshot),{animate:false,saveNow:true});
  (engine.state.current.kind==='choice' ? $('choices').querySelector('button') : $('next-button'))?.focus({preventScroll:true});
}

function replayChapter(mapId) {
  try {beginReplay(replay.startChapter(mapId));} catch(error) {handleError(error);}
}

function showChapters() {
  if (!replay.unlocked) return;
  openDialog('章節選擇');const body=$('dialog-body');
  body.append(paragraph('modal-note','從所選章節開頭重玩，並接續後續章節。會更新自動存檔；手動存檔及已探索路線會保留。'));
  story.maps.forEach((map,index)=>{
    const card=document.createElement('div');card.className='save-slot chapter-slot';
    const copy=document.createElement('div');copy.className='slot-copy';
    const heading=document.createElement('h3');heading.textContent=`第${['一','二','三'][index] || index+1}章 · ${map.title}`;
    const routes=replay.routes.filter(route=>route.mapId===map.id);
    copy.append(heading,paragraph('',`已探索 ${routes.filter(route=>replay.hasRoute(route.id)).length}／${routes.length} 條路線`));
    const action=document.createElement('button');action.textContent='重玩本章';
    action.setAttribute('aria-label',`重玩${map.title}`);action.addEventListener('click',()=>replayChapter(map.id));
    card.append(copy,action);body.append(card);
  });
}

function discoveredRoute(route,index) {
  const card=document.createElement('details');card.className='route-card';
  const summary=document.createElement('summary');
  const title=document.createElement('span');title.className='route-title';
  title.textContent=`路線 ${String(index+1).padStart(2,'0')} · ${route.completed?'刎頸之交':route.path.at(-1)?.text || '故事落幕'}`;
  const status=document.createElement('span');status.className='route-state';status.textContent=route.completed?'成功通關':'已探索';
  summary.append(title,status);card.append(summary);
  const content=document.createElement('div');content.className='route-content';
  content.append(paragraph('route-category',route.category),paragraph('route-conclusion',plainText(route.conclusion)));
  if (route.feedback) content.append(paragraph('route-feedback',`原文回饋：${route.feedback}`));
  const trail=document.createElement('details');trail.className='route-trail';
  const trailHeading=document.createElement('summary');trailHeading.textContent='查看本章抉擇順序';
  const steps=document.createElement('ol');
  for (const decision of route.path.filter(step=>step.mapId===route.mapId)) {
    const step=document.createElement('li');step.textContent=`${decision.prompt} → ${decision.text}`;steps.append(step);
  }
  trail.append(trailHeading,steps);content.append(trail);
  const action=document.createElement('button');action.textContent='返回最後抉擇';
  action.setAttribute('aria-label',`重玩路線 ${index+1}，返回最後抉擇`);
  action.addEventListener('click',()=>{
    try {beginReplay(replay.replayRoute(route.id));} catch(error) {handleError(error);}
  });
  content.append(action);card.append(content);return card;
}

function showRoutes() {
  if (!replay.unlocked) return;
  openDialog('路線圖鑑');const body=$('dialog-body');
  body.append(paragraph('library-progress',`已探索 ${replay.progress.endings.length}／${replay.routes.length} 條路線`),
    paragraph('modal-note','展開已探索路線可查看結局、原文回饋與抉擇順序；未探索路線保留驚喜。重玩會更新自動存檔，手動存檔及圖鑑會保留。'));
  story.maps.forEach((map,index)=>{
    const section=document.createElement('section');section.className='route-chapter';
    const header=document.createElement('div');header.className='route-chapter-heading';
    const heading=document.createElement('h3');heading.textContent=`第${['一','二','三'][index] || index+1}章 · ${map.title}`;
    const action=document.createElement('button');action.textContent='重玩本章';
    action.setAttribute('aria-label',`重玩${map.title}`);action.addEventListener('click',()=>replayChapter(map.id));
    header.append(heading,action);section.append(header);
    replay.routes.forEach((route,routeIndex)=>{
      if (route.mapId!==map.id) return;
      if (replay.hasRoute(route.id)) section.append(discoveredRoute(route,routeIndex));
      else {
        const card=document.createElement('div');card.className='route-card unexplored';
        card.append(paragraph('route-title',`路線 ${String(routeIndex+1).padStart(2,'0')}`),paragraph('route-state','尚未探索'));
        section.append(card);
      }
    });
    body.append(section);
  });
}

function saveSlot(index) {
  autosave.flush();
  const value=entry(engine.snapshot());
  if(!persist(()=>saves.writeSlot(index,value)))return;
  saved.slots[index]=value;
  toast(`已儲存至存檔 ${index+1}`);showSlots('save');
}

function showSlots(mode) {
  if(!engine)return;
  openDialog(mode==='save'?'儲存進度':'讀取進度');
  refreshSaved();activeSlotsMode = mode;
  const body=$('dialog-body');
  body.append(paragraph('modal-note','進度只儲存在目前的瀏覽器；讀檔會回到儲存時的對話或選項。'));
  const entries=mode==='load'?[{label:'自動存檔',value:saved.auto,index:-1}]:[];
  for(let i=0;i<3;i++)entries.push({label:`存檔 ${i+1}`,value:saved.slots[i],index:i});
  for(const slot of entries) {
    const card=document.createElement('div');card.className='save-slot';
    const text=document.createElement('div');text.className='slot-copy';
    const title=document.createElement('strong');title.textContent=slot.label;text.append(title);
    if(slot.value) {
      text.append(paragraph('',slot.value.chapter),paragraph('',slot.value.preview));
      const time=document.createElement('time');time.dateTime=slot.value.time;
      time.textContent=new Intl.DateTimeFormat('zh-HK',{timeZone:'Asia/Hong_Kong',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(slot.value.time));text.append(time);
    } else text.append(paragraph('','尚未儲存'));
    const action=document.createElement('button');
    action.dataset.slot=String(slot.index);
    action.textContent=mode==='load'?'讀取':slot.value?'覆寫':'儲存';
    action.setAttribute('aria-label',`${action.textContent}${slot.label}`);
    action.disabled=mode==='load'?!slot.value:!started || engine.state.ended;
    action.addEventListener('click',()=>{
      if(mode!=='load'){saveSlot(slot.index);return;}
      refreshSaved();
      const value=slot.index===-1?saved.auto:saved.slots[slot.index];
      if(value)resume(value);
      else {toast('這個欄位目前沒有可讀取的存檔。');showSlots(mode);}
    });
    card.append(text,action);body.append(card);
  }
}

function showHistory() {
  if(!engine.state)return;
  openDialog('劇情紀錄');const body=$('dialog-body');
  for(const item of engine.state.history) {
    const presentation=formatDialogue(item.speaker,item.text,item.interlude);
    const node=document.createElement('div');node.className=`history-item${item.choice?' choice':''}${presentation.centered?' interlude':''}`;
    const speaker=document.createElement('strong');speaker.textContent=`${item.speaker || '旁白'}${item.hypothetical?' · 假設情節':''}`;
    speaker.hidden=presentation.centered;
    node.append(speaker,paragraph('',plainText(presentation.text)));body.append(node);
  }
  requestAnimationFrame(()=>{$('menu-dialog').scrollTop=$('menu-dialog').scrollHeight;});
}

function home() {
  dialogueHold?.cancel();
  autosave.flush();
  stopTyping();clearTimeout(autoTimer);auto=false;updateAuto();started=false;
  $('title-screen').hidden=false;$('dialogue-panel').hidden=true;$('ending').hidden=true;$('scene-choices').hidden=true;
  $('return-button').hidden=true;$('save-button').disabled=true;$('history-button').disabled=true;
  updateContinue();
  $('instruction').textContent='點擊「開始遊戲」，走進藺相如的故事。';
  syncMusic();closeDialog();$('start-button').focus({preventScroll:true});
}

function updateContinue() {
  const current=saved.auto?.snapshot?.state?.current;
  $('continue-button').disabled=!saved.auto;
  $('continue-button').hidden=!saved.auto;
  $('continue-button').textContent=current?.kind==='ending' ?
    (current.completed?'查看通關結局':'返回上次抉擇'):'接續上次進度';
  $('replay-menu').hidden=!replay.unlocked;
  $('title-screen').classList.toggle('replay-unlocked',replay.unlocked);
}

function resumeAuto() {
  refreshSaved();
  if(!saved.auto)return;
  if(!resume(saved.auto))return;
  if(engine.state?.current.kind==='ending' && !engine.state.current.completed && engine.lastChoice) {
    render(engine.retry(),{animate:false,saveNow:true});
  }
}

function confirmHome() {
  openDialog('回到首頁');
  $('dialog-body').append(paragraph('confirm-copy','目前進度已自動儲存。回到首頁後，可按「接續上次進度」繼續。'));
  const actions=document.createElement('div');actions.className='confirm-actions';
  const cancel=document.createElement('button');cancel.textContent='繼續遊玩';cancel.addEventListener('click',closeDialog);
  const confirm=document.createElement('button');confirm.className='primary';confirm.textContent='回到首頁';confirm.addEventListener('click',home);
  actions.append(cancel,confirm);$('dialog-body').append(actions);
}

function registerTools() {
  if(!WEBMCP_ENABLED)return;
  const maximumOptions=Math.max(1,...story.maps.flatMap(map=>map.events.filter(event=>event.code===101).map(event=>event.choices.length)));
  registerGameTools(document.modelContext,{
    getState:()=>({started,chapter:started?engine.maps.get(engine.state.mapId).title:null,current:started?engine.state.current:null}),
    menuOpen:()=>$('menu-dialog').open,advance:next,choose,maximumOptions,listen:addEventListener,
  });
}

function refreshSaved() {
  saved=saves.read();replay.merge(saved.progress);saved.progress=replay.progress;
  if(saved.auto?.snapshot?.sourceHash!==story.sourceHash)saved.auto=null;
  updateContinue();updateMusic();
}

function syncSaved(event) {
  if(event && !saves.relevantKey(event.key))return;
  const mode=activeSlotsMode, focusedSlot=document.activeElement?.dataset?.slot;
  refreshSaved();syncMusic();
  if(saved.settings.muted){for(const sound of sounds)sound.pause();sounds.clear();}
  if(mode && $('menu-dialog').open) {
    showSlots(mode);
    for(const card of $('dialog-body').children) {
      const action=card.querySelector('button');
      if(focusedSlot!==undefined && action?.dataset.slot===focusedSlot && !action.disabled)action.focus({preventScroll:true});
    }
  }
}

async function init() {
  try {
    const responses=await Promise.all([
      fetch(new URL('./story.3e9c79a2e09a599eb9c7.json',import.meta.url)),
      fetch(new URL('./assets.1a8cc86a10662ca79de1.json',import.meta.url)),
    ]);
    if(responses.some(response=>!response.ok))throw new Error('遊戲資料未能載入。');
    [story,assets]=await Promise.all(responses.map(response=>response.json()));
    engine=new GameEngine(story);
    let local;try{local=localStorage;}catch{local={getItem(){return null;},setItem(){throw new Error('Storage unavailable');}};}
    replay=new ReplayLibrary(story);
    saves=new LocalSaves(local,{sourceHash:story.sourceHash,endingIds:replay.routes.map(route=>route.id)});saved=saves.read();
    replay.merge(saved.progress);
    autosave=new AutosaveScheduler(saveCurrentProgress);
    if(saves.error)toast('之前的存檔未能讀取，你仍可以開始新遊戲。');
    if(saved.auto?.snapshot?.sourceHash!==story.sourceHash)saved.auto=null;
    saved.slots=Array.from({length:3},(_,i)=>saved.slots[i] || null);
    // Refresh old text and choice labels, retaining unchanged original command positions.
    for(const item of [saved.auto,...saved.slots].filter(Boolean)) {
      try {
        if(item.snapshot.sourceHash!==story.sourceHash)continue;
        engine.restore(item.snapshot);item.snapshot=engine.snapshot();
        item.preview=entry(item.snapshot).preview;
        replay.record(item.snapshot);
      } catch { /* A damaged manual save is reported when the player selects it. */ }
    }
    saved.progress=replay.progress;persist(()=>saves.writeProgress(replay.progress));
    $('start-button').disabled=false;$('start-button').textContent='開始遊戲';
    updateContinue();syncMusic();updateMusic();
    $('start-button').addEventListener('click',start);
    $('continue-button').addEventListener('click',resumeAuto);
    $('chapter-select-button').addEventListener('click',showChapters);
    $('route-library-button').addEventListener('click',showRoutes);
    $('ending-chapters-button').addEventListener('click',showChapters);
    $('ending-routes-button').addEventListener('click',showRoutes);
    dialogueHold=new DialogueHold($('game-frame'), {
      canStart:()=>started && !busy && !document.hidden && !$('menu-dialog').open && engine.state?.current.kind==='text',
      onChange:updatePlayback,
      onClick:next,
    });
    $('game-frame').addEventListener('dragstart',event=>event.preventDefault());
    $('auto-button').addEventListener('click',()=>{auto=!auto;updateAuto();if(auto)completeText();scheduleAuto();});
    $('music-button').addEventListener('click',()=>{
      refreshSaved();
      if(!saved.settings.muted && ['waiting','blocked','error'].includes(music.status)) {
        music.retry();syncMusic();updateMusic();return;
      }
      saved.settings.muted=!saved.settings.muted;
      persist(()=>saves.writeMuted(saved.settings.muted));updateMusic();syncMusic();
      if(saved.settings.muted){for(const sound of sounds)sound.pause();sounds.clear();}
    });
    $('fullscreen-button').addEventListener('click',async()=>{
      try{if(document.fullscreenElement)await document.exitFullscreen();else if($('game-frame').requestFullscreen)await $('game-frame').requestFullscreen();else toast('此瀏覽器未提供全螢幕，可將裝置橫向遊玩。');}catch{toast('暫時未能進入全螢幕。');}
    });
    $('save-button').addEventListener('click',()=>showSlots('save'));
    $('load-button').addEventListener('click',()=>showSlots('load'));
    $('history-button').addEventListener('click',showHistory);
    $('retry-button').addEventListener('click',()=>{
      if(engine.state.current.kind!=='ending' || engine.state.current.completed || !engine.lastChoice)return;
      auto=false;updateAuto();render(engine.retry(),{animate:false,saveNow:true});
    });
    $('home-button').addEventListener('click',home);
    $('return-button').addEventListener('click',confirmHome);
    $('dialog-close').addEventListener('click',closeDialog);
    $('menu-dialog').addEventListener('close',()=>{activeSlotsMode=null;scheduleAuto();});
    document.addEventListener('keydown',event=>{
      if(event.defaultPrevented || $('menu-dialog').open || event.altKey || event.ctrlKey || event.metaKey || event.repeat)return;
      if(event.target.closest('input,select,textarea,a'))return;
      if(started && engine.state.current.kind==='choice' && /^[1-9]$/.test(event.key)){
        event.preventDefault();
        const index=Number(event.key)-1;if(engine.state.current.choices[index])choose(index);
      }
      else if(!event.target.closest('button') && started && event.key==='Enter'){event.preventDefault();next();}
    });
    document.addEventListener('click',()=>{music.retry();syncMusic();});
    document.addEventListener('keydown',event=>{
      if(!event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey && (event.code==='Space' || event.key==='Enter')) {
        music.retry();syncMusic();
      }
    });
    document.addEventListener('visibilitychange',()=>{if(document.hidden){autosave.flush();syncMusic();clearTimeout(autoTimer);for(const sound of sounds)sound.pause();}else{syncSaved();scheduleAuto();}});
    addEventListener('pagehide',()=>{
      autosave.flush();music.update({track:music.track,muted:saved.settings.muted,hidden:true});
      for(const sound of sounds)sound.pause();
    });
    addEventListener('pageshow',()=>syncSaved());
    addEventListener('storage',syncSaved);
    registerTools();
  } catch(error) {
    console.error(error);$('load-error').hidden=false;
    $('start-button').textContent='未能載入';$('continue-button').disabled=true;
  }
}

init();
