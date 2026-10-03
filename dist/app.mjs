import {GameEngine,plainText,textRuns} from './engine.mjs';
import {LocalSaves} from './storage.mjs';

const $ = id => document.getElementById(id);
let story, assets, engine, saved, saves;
let typing = null, typeTimer = 0, autoTimer = 0, auto = false, toastTimer = 0;
let started = false, busy = false, storageWarned = false;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const music = new Audio(); music.preload = 'none'; music.loop = true;
let musicKey = ''; const sounds = new Set();
const activePictures = new Map();

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>{$('toast').hidden=true;},3500);
}

function persist() {
  if (!saves.write(saved) && !storageWarned) {
    storageWarned = true;
    toast('瀏覽器未能儲存進度；本次仍可繼續遊玩。');
  }
}

function entry(snapshot) {
  const state = snapshot.state;
  const recent = [...state.history].reverse().find(item=>!item.choice);
  return {snapshot,time:new Date().toISOString(),chapter:engine.maps.get(state.mapId).title,
    preview:plainText(recent?.text || '等待你的抉擇').trim().slice(0,48)};
}

function autosave() {
  if (!engine.state || engine.state.ended) return;
  saved.auto = entry(engine.snapshot()); persist();
}

function assetUrl(key) { return assets[key]?.src || null; }

function syncMusic() {
  const wanted = started ? engine.state?.music : {asset:'BGM/霸气男主出场.mp3',volume:.6};
  const source = wanted && assetUrl(wanted.asset);
  if (!source || saved.settings.muted || document.hidden) {music.pause();return;}
  if (musicKey !== wanted.asset) {musicKey=wanted.asset;music.src=source;}
  music.volume = Math.max(0,Math.min(.85,(wanted.volume || .6)*.75));
  music.play().catch(()=>{});
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

function renderPictures(pictures) {
  const layer = $('pictures');
  for (const [id,img] of activePictures) {
    if (pictures[id]) continue;
    img.style.opacity = '0'; activePictures.delete(id);
    setTimeout(()=>img.remove(),reducedMotion?0:250);
  }
  for (const [id,picture] of Object.entries(pictures)) {
    const asset = assets[picture.asset]; if (!asset) continue;
    let img = activePictures.get(id);
    const newImage = !img;
    if (!img) {img=new Image();img.alt='';img.style.opacity='0';activePictures.set(id,img);layer.append(img);}
    const src = asset.src;
    if (img.dataset.asset !== src) {img.src=src;img.dataset.asset=src;}
    img.style.left = `${picture.x/960*100}%`;
    img.style.top = `${picture.y/540*100}%`;
    img.style.width = `${asset.width*picture.sx/100/960*100}%`;
    img.style.height = `${asset.height*picture.sy/100/540*100}%`;
    img.style.zIndex = String(Number(id) || 0);
    img.style.transform = picture.mirror ? 'scaleX(-1)' : 'none';
    const opacity = String(Math.max(0,Math.min(255,picture.opacity))/255);
    if (newImage && !reducedMotion) requestAnimationFrame(()=>{if(activePictures.get(id)===img)img.style.opacity=opacity;});
    else img.style.opacity = opacity;
  }
}

function stopTyping() { clearInterval(typeTimer); typeTimer=0; typing=null; }
function completeText() {
  if (!typing) return;
  const {spans,runs} = typing;
  runs.forEach((run,i)=>{spans[i].textContent=run.text;});
  stopTyping(); scheduleAuto();
}

function renderText(speaker,text,animate) {
  stopTyping();
  $('speaker').textContent = speaker || '旁白';
  $('announcement').textContent = `${speaker || '旁白'}：${plainText(text)}`;
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
  if (!animate || reducedMotion) {scheduleAuto();return;}
  const characters=runs.map(run=>Array.from(run.text));
  let runIndex=0,position=0;
  typing={spans,runs};
  typeTimer=setInterval(()=>{
    if (!typing) return;
    if (runIndex>=characters.length) {stopTyping();scheduleAuto();return;}
    spans[runIndex].textContent+=characters[runIndex][position++] || '';
    if(position>=characters[runIndex].length){runIndex++;position=0;}
  },26);
}

function scheduleAuto() {
  clearTimeout(autoTimer);
  if (!auto || !started || $('menu-dialog').open || document.hidden || engine.state.current.kind!=='text') return;
  const length=plainText(engine.state.current.text).length;
  autoTimer=setTimeout(next,Math.max(1500,Math.min(6000,length*40)));
}

function render(result,{animate=true}={}) {
  clearTimeout(autoTimer);
  const state=result.state,current=state.current;
  started=true;
  $('title-screen').hidden=true;
  $('return-button').hidden=false;
  $('dialogue').hidden=current.kind==='ending';
  $('ending').hidden=current.kind!=='ending';
  $('choices').hidden=current.kind!=='choice';
  $('scene-prompt').hidden=current.kind!=='choice';
  $('next-button').hidden=current.kind!=='text';
  $('auto-button').hidden=current.kind!=='text';
  $('save-button').disabled=current.kind==='ending';
  $('history-button').disabled=false;
  for(const label of document.querySelectorAll('.chapter')) {
    label.classList.toggle('current',Number(label.dataset.map)===state.mapId);
    if(Number(label.dataset.map)===state.mapId)label.setAttribute('aria-current','step');else label.removeAttribute('aria-current');
  }
  renderPictures(state.pictures);
  if(current.kind==='text') {
    renderText(current.speaker,current.text,animate);
    $('instruction').textContent='點擊畫面或按空白鍵繼續；文字顯示時點一下可立即看完整段。';
  } else if(current.kind==='choice') {
    const last=[...state.history].reverse().find(item=>!item.choice);
    renderText(last?.speaker || '',last?.text || '',false);
    const choices=$('choices');choices.replaceChildren();
    current.choices.forEach((choice,index)=>{
      const button=document.createElement('button');button.className='choice-button';
      const badge=document.createElement('span');badge.className='choice-number';badge.textContent=String(index+1);badge.setAttribute('aria-hidden','true');
      const label=document.createElement('span');label.textContent=choice.text;
      button.append(badge,label);button.addEventListener('click',()=>choose(index));choices.append(button);
    });
    $('instruction').textContent='選擇你的下一步。亦可按數字鍵 1、2、3 選擇。';
    requestAnimationFrame(()=>choices.querySelector('button')?.focus({preventScroll:true}));
  } else {
    stopTyping();
    $('ending-text').textContent=plainText(current.conclusion).trim();
    $('ending-title').textContent=current.completed?'全劇終':'本段劇情結束';
    $('retry-button').hidden=!engine.lastChoice;
    $('instruction').textContent='可以回到上一個選擇，探索另一條劇情。';
    $('announcement').textContent=`本段劇情結束。${plainText(current.conclusion)}`;
  }
  syncMusic();playEffects(result.effects || []);
  if(!state.ended)autosave();
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
  try{render(engine.choose(index));}catch(error){handleError(error);}finally{busy=false;}
}
function start() {auto=false;updateAuto();render(engine.start());}
function resume(item) {
  try{auto=false;updateAuto();render(engine.restore(item.snapshot),{animate:false});closeDialog();}
  catch(error){handleError(error);}
}

function updateAuto() {$('auto-button').textContent=`自動：${auto?'開':'關'}`;$('auto-button').setAttribute('aria-pressed',String(auto));}
function updateMusic() {$('music-button').textContent=`音樂：${saved.settings.muted?'關':'開'}`;$('music-button').setAttribute('aria-pressed',String(saved.settings.muted));}

function openDialog(title) {
  completeText();clearTimeout(autoTimer);
  $('dialog-title').textContent=title;$('dialog-body').replaceChildren();
  if(!$('menu-dialog').open)$('menu-dialog').showModal();
}
function closeDialog() {$('menu-dialog').close();scheduleAuto();}
function paragraph(className,text) {const p=document.createElement('p');p.className=className;p.textContent=text;return p;}

function saveSlot(index) {
  saved.slots[index]=entry(engine.snapshot());persist();
  if(saves.error)return;
  toast(`已儲存至存檔 ${index+1}`);showSlots('save');
}

function showSlots(mode) {
  if(!engine)return;
  openDialog(mode==='save'?'儲存進度':'讀取進度');
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
    action.textContent=mode==='load'?'讀取':slot.value?'覆寫':'儲存';
    action.setAttribute('aria-label',`${action.textContent}${slot.label}`);
    action.disabled=mode==='load'?!slot.value:!started || engine.state.ended;
    action.addEventListener('click',()=>mode==='load'?resume(slot.value):saveSlot(slot.index));
    card.append(text,action);body.append(card);
  }
}

function showHistory() {
  if(!engine.state)return;
  openDialog('劇情紀錄');const body=$('dialog-body');
  for(const item of engine.state.history) {
    const node=document.createElement('div');node.className=`history-item${item.choice?' choice':''}`;
    const speaker=document.createElement('strong');speaker.textContent=item.speaker || '旁白';
    node.append(speaker,paragraph('',plainText(item.text)));body.append(node);
  }
  requestAnimationFrame(()=>{$('menu-dialog').scrollTop=$('menu-dialog').scrollHeight;});
}

function home() {
  stopTyping();clearTimeout(autoTimer);auto=false;updateAuto();started=false;
  $('title-screen').hidden=false;$('dialogue').hidden=true;$('ending').hidden=true;$('scene-prompt').hidden=true;
  $('return-button').hidden=true;$('save-button').disabled=true;$('history-button').disabled=true;
  $('continue-button').disabled=!saved.auto;
  $('continue-button').hidden=!saved.auto;
  $('instruction').textContent='點擊「開始遊戲」，走進藺相如的故事。';
  syncMusic();closeDialog();$('start-button').focus({preventScroll:true});
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
  const context=document.modelContext;
  if(!context?.registerTool)return;
  const lifecycle=new AbortController();
  const tools=[
    {name:'read_game_state',title:'讀取目前劇情',description:'Read the visible dialogue, current chapter and choices without changing the game.',annotations:{readOnlyHint:true,untrustedContentHint:false},
      inputSchema:{type:'object',properties:{},additionalProperties:false},execute(input){if(!input || Object.keys(input).length)throw new Error('不需要輸入參數。');return {started,chapter:started?engine.maps.get(engine.state.mapId).title:null,current:started?engine.state.current:null};}},
    {name:'advance_game_dialogue',title:'繼續劇情',description:'Finish the current text animation, or advance to the next dialogue using the same action as the Continue button.',annotations:{readOnlyHint:false,untrustedContentHint:false},
      inputSchema:{type:'object',properties:{},additionalProperties:false},execute(input){if(!input || Object.keys(input).length)throw new Error('不需要輸入參數。');if(!started || engine.state.current.kind!=='text' || $('menu-dialog').open)throw new Error('目前不能繼續對話。');next();return {current:engine.state.current};}},
    {name:'choose_story_option',title:'選擇劇情選項',description:'Choose one of the currently visible numbered story options, following its original branch.',annotations:{readOnlyHint:false,untrustedContentHint:false},
      inputSchema:{type:'object',properties:{option:{type:'integer',minimum:1,maximum:3}},required:['option'],additionalProperties:false},execute(input){if(!input || Object.keys(input).some(k=>k!=='option') || !Number.isInteger(input.option) || engine.state?.current.kind!=='choice' || !engine.state.current.choices[input.option-1] || $('menu-dialog').open)throw new Error('請提供目前選項的編號。');choose(input.option-1);return {current:engine.state.current};}}
  ];
  for(const tool of tools)try{Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}
  addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}

async function init() {
  try {
    const responses=await Promise.all([fetch('./story.json'),fetch('./assets.json')]);
    if(responses.some(response=>!response.ok))throw new Error('遊戲資料未能載入。');
    [story,assets]=await Promise.all(responses.map(response=>response.json()));
    engine=new GameEngine(story);
    let local;try{local=localStorage;}catch{local={getItem(){return null;},setItem(){throw new Error('Storage unavailable');}};}
    saves=new LocalSaves(local);saved=saves.read();
    if(saves.error)toast('之前的存檔未能讀取，你仍可以開始新遊戲。');
    if(saved.auto?.snapshot?.sourceHash!==story.sourceHash)saved.auto=null;
    saved.slots=Array.from({length:3},(_,i)=>saved.slots[i] || null);
    $('start-button').disabled=false;$('start-button').textContent='開始遊戲';
    $('continue-button').disabled=!saved.auto;updateMusic();
    $('continue-button').hidden=!saved.auto;
    $('start-button').addEventListener('click',start);
    $('continue-button').addEventListener('click',()=>saved.auto && resume(saved.auto));
    $('next-button').addEventListener('click',next);
    $('stage').addEventListener('click',event=>{if(!event.target.closest('button') && started)next();});
    $('dialogue').addEventListener('click',event=>{if(!event.target.closest('button'))next();});
    $('auto-button').addEventListener('click',()=>{auto=!auto;updateAuto();if(auto)completeText();scheduleAuto();});
    $('music-button').addEventListener('click',()=>{
      saved.settings.muted=!saved.settings.muted;persist();updateMusic();syncMusic();
      if(saved.settings.muted){for(const sound of sounds)sound.pause();sounds.clear();}
    });
    $('fullscreen-button').addEventListener('click',async()=>{
      try{if(document.fullscreenElement)await document.exitFullscreen();else if($('game-frame').requestFullscreen)await $('game-frame').requestFullscreen();else toast('此瀏覽器未提供全螢幕，可將裝置橫向遊玩。');}catch{toast('暫時未能進入全螢幕。');}
    });
    $('save-button').addEventListener('click',()=>showSlots('save'));
    $('load-button').addEventListener('click',()=>showSlots('load'));
    $('history-button').addEventListener('click',showHistory);
    $('retry-button').addEventListener('click',()=>{auto=false;updateAuto();render(engine.retry(),{animate:false});});
    $('home-button').addEventListener('click',home);
    $('return-button').addEventListener('click',confirmHome);
    $('dialog-close').addEventListener('click',closeDialog);
    $('menu-dialog').addEventListener('close',scheduleAuto);
    document.addEventListener('keydown',event=>{
      if($('menu-dialog').open || event.altKey || event.ctrlKey || event.metaKey || event.repeat)return;
      if(event.target.closest('input,select,textarea,a'))return;
      if(started && engine.state.current.kind==='choice' && /^[1-3]$/.test(event.key)){event.preventDefault();choose(Number(event.key)-1);}
      else if(!event.target.closest('button') && started && (event.code==='Space' || event.key==='Enter')){event.preventDefault();next();}
    });
    document.addEventListener('visibilitychange',()=>{if(document.hidden){music.pause();clearTimeout(autoTimer);for(const sound of sounds)sound.pause();}else{syncMusic();scheduleAuto();}});
    registerTools();
  } catch(error) {
    console.error(error);$('load-error').hidden=false;
    $('start-button').textContent='未能載入';$('continue-button').disabled=true;
  }
}

init();
