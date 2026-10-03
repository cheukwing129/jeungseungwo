import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {MusicPlayer,nextMusic} from '../dist/music.mjs';
import {GameEngine} from '../dist/engine.mjs';

class AudioStub extends EventTarget {
  src='';paused=true;error=null;loads=0;requests=[];
  play() {
    this.paused=false;
    return new Promise((resolve,reject)=>this.requests.push({resolve,reject}));
  }
  pause(){const playing=!this.paused;this.paused=true;if(playing)this.dispatchEvent(new Event('pause'));}
  load(){this.loads++;this.error=null;}
  removeAttribute(name){if(name==='src')this.src='';}
  playing(){this.dispatchEvent(new Event('playing'));this.requests.at(-1).resolve();}
}
const tick=()=>Promise.resolve();
const audio=[], changes=[];
let preload=true;
const music=new MusicPlayer({createAudio:()=>{const item=new AudioStub();audio.push(item);return item;},
  onChange:status=>changes.push(status),canPreload:()=>preload});
const first={src:'first.mp3',volume:.6}, second={src:'second.mp3',volume:0};

// No sound or preload until a gesture. Rejected autoplay stays blocked without per-page retries.
music.update({track:first,next:'second.mp3'});
assert.equal(music.status,'waiting');assert.equal(audio.length,0);
music.unlock();const current=music.current;
assert.equal(music.status,'loading');assert.equal(current.preload,'auto');assert.equal(current.requests.length,1);
current.paused=true;current.requests[0].reject(Object.assign(new Error('gesture'),{name:'NotAllowedError'}));await tick();
assert.equal(music.status,'blocked');
for(let page=0;page<50;page++)music.update({track:first,next:'second.mp3'});
assert.equal(current.requests.length,1);assert.equal(music.warm.src,'second.mp3');
assert.equal(music.warm.audio.loads,1,'Repeated renders restarted the warm download');
music.retry();assert.equal(current.requests.length,2);current.playing();await tick();assert.equal(music.status,'playing');
assert(Math.abs(current.volume-.45)<1e-12);

// Promote the preloaded element, abandon obsolete downloads and preserve explicit zero volume.
const preloaded=music.warm.audio;
music.update({track:second,next:'third.mp3'});
assert.equal(music.current,preloaded);assert.equal(music.current.volume,0);
assert.equal(current.src,'');assert.equal(current.paused,true);
preloaded.playing();await tick();assert.equal(music.status,'playing');
preloaded.dispatchEvent(new Event('waiting'));assert.equal(music.status,'loading');
preloaded.dispatchEvent(new Event('playing'));assert.equal(music.status,'playing');
const third=music.warm.audio;
preload=false;music.update({track:second,next:'third.mp3'});assert.equal(music.warm,null);assert.equal(third.src,'');
preload=true;

// Muting, hidden pages and late promises cannot claim that audio is still playing.
music.update({track:first,next:'second.mp3'});const pending=music.current;
music.update({track:first,muted:true});assert.equal(music.status,'off');assert.equal(pending.paused,true);
pending.requests[0].resolve();await tick();assert.equal(music.status,'off');
music.update({track:first});assert.equal(music.status,'loading');
music.update({track:first,hidden:true});assert.equal(music.status,'paused');
pending.requests.at(-1).resolve();await tick();assert.equal(music.status,'paused');
music.update({track:first});pending.playing();await tick();assert.equal(music.status,'playing');
music.update({track:first,next:'second.mp3'});assert(music.warm);
music.update({track:first,hidden:true});assert.equal(music.warm,null);
music.update({track:first});

// A failed track loads again on retry; a stale response from a replaced track is ignored.
pending.error={code:2};pending.dispatchEvent(new Event('error'));assert.equal(music.status,'error');
const loads=pending.loads;music.retry();assert.equal(pending.loads,loads+1);assert.equal(music.status,'loading');
const stale=pending.requests.at(-1);music.update({track:second});
stale.reject(Object.assign(new Error('old'),{name:'NotAllowedError'}));await tick();assert.equal(music.status,'loading');
music.current.playing();await tick();assert.equal(music.status,'playing');
music.update({track:null});assert.equal(music.status,'idle');assert.equal(music.current.paused,true);
assert(changes.includes('blocked'));assert(changes.includes('error'));

// Lookahead keeps the engine untouched, follows real chapter jumps and stops before uncertain decisions.
const story=JSON.parse(await readFile(new URL('../dist/story.json',import.meta.url),'utf8'));
const game=new GameEngine(story);game.start();
const before=JSON.stringify(game.snapshot());
const actual=nextMusic(story,game.state);
assert.equal(JSON.stringify(game.snapshot()),before);
const future=new GameEngine(story);future.restore(game.snapshot());let expected=null;
for(let guard=0;guard<2000;guard++) {
  future.advance();
  if(future.state.music?.asset!==game.state.music?.asset){expected=future.state.music.asset;break;}
  if(future.state.current.kind!=='text')break;
}
assert.equal(actual,expected);
const sample={maps:[{id:1,events:[{code:206,p:['2']}]},{id:2,events:[{code:501,p:['BGM\\next.mp3']}]}]};
const state={mapId:1,pc:0,current:{kind:'text'},music:{asset:'BGM/old.mp3'}};
assert.equal(nextMusic(sample,state),'BGM/next.mp3');
sample.maps[0].events[0]={code:101,choices:[]};assert.equal(nextMusic(sample,state),null);
assert.equal(nextMusic(story,{...game.state,current:{kind:'choice'}}),null);
console.log(JSON.stringify({noPregestureAudio:'passed',blockedPlaybackStatus:'passed',boundedPreload:'passed',
  preloadedElementReused:'passed',mutedAndHidden:'passed',stalePromises:'ignored',zeroVolume:'preserved',
  networkErrorRetry:'passed',branchSafeLookahead:'passed'},null,2));
