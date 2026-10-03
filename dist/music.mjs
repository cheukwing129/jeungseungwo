const normalKey=value=>String(value || '').replaceAll('\\','/');

/** Only preload a track known before the next decision; no speculative branch is chosen. */
export function nextMusic(story,state) {
  if(!state || state.current?.kind!=='text')return null;
  const maps=new Map(story.maps.map(map=>[map.id,map]));
  let mapId=state.mapId, pc=state.pc;
  const visited=new Set();
  for(let guard=0;guard<10000;guard++) {
    const location=`${mapId}:${pc}`, event=maps.get(mapId)?.events[pc++];
    if(!event || visited.has(location))return null;
    visited.add(location);
    if(event.code===101 || event.code===208)return null;
    if(event.code===501 && normalKey(event.p[0])!==state.music?.asset)return normalKey(event.p[0]);
    if(event.code===108)pc=event.skip;
    if(event.code===206){mapId=Number(event.p[0]);pc=0;}
  }
  return null;
}

/** Report actual playback, retry blocked starts on a gesture, and reuse a single preloaded track. */
export class MusicPlayer {
  constructor({createAudio=()=>new Audio(),onChange=()=>{},canPreload=()=>!globalThis.navigator?.connection?.saveData}={}) {
    this.createAudio=createAudio;this.onChange=onChange;this.canPreload=canPreload;
    this.current=null;this.currentSrc='';this.warm=null;this.track=null;
    this.muted=false;this.hidden=false;this.unlocked=false;
    this.status='waiting';this.pending=false;this.request=0;
  }

  setStatus(status) {
    if(this.status===status)return;
    this.status=status;this.onChange(status);
  }

  releaseWarm() {
    if(!this.warm)return;
    const audio=this.warm.audio;this.warm=null;
    audio.pause();audio.removeAttribute('src');audio.load();
  }

  update({track,muted=false,hidden=false,next=null}) {
    this.track=track;this.muted=muted;this.hidden=hidden;
    this.reconcile();
    if(muted || hidden || !this.unlocked || !this.canPreload()){this.releaseWarm();return;}
    if(!next || next===this.currentSrc){this.releaseWarm();return;}
    if(this.warm?.src===next)return;
    this.releaseWarm();
    const audio=this.createAudio();audio.preload='auto';audio.src=next;audio.load();
    this.warm={src:next,audio};
  }

  unlock() {this.unlocked=true;this.reconcile();}

  eligible(audio,request=this.request) {
    return this.current===audio && request===this.request && !this.muted && !this.hidden && Boolean(this.track?.src);
  }

  select(src) {
    this.request++;this.pending=false;
    const previous=this.current;this.current=null;
    if(previous){previous.pause();previous.removeAttribute('src');previous.load();}
    const audio=this.warm?.src===src && !this.warm.audio.error?this.warm.audio:this.createAudio();
    if(this.warm?.audio===audio)this.warm=null;
    this.current=audio;this.currentSrc=src;audio.loop=true;audio.preload='auto';this.setStatus('waiting');
    if(!audio.src)audio.src=src;
    audio.addEventListener('playing',()=>{if(this.eligible(audio))this.setStatus('playing');});
    for(const name of ['waiting','stalled'])audio.addEventListener(name,()=>{
      if(this.eligible(audio))this.setStatus('loading');
    });
    audio.addEventListener('error',()=>{if(this.eligible(audio)){this.request++;this.pending=false;this.setStatus('error');}});
    audio.addEventListener('pause',()=>{
      if(this.current!==audio)return;
      if(this.muted)this.setStatus('off');
      else if(this.hidden)this.setStatus('paused');
      else if(!this.pending)this.setStatus('waiting');
    });
  }

  reconcile() {
    if(this.muted || this.hidden || !this.track?.src) {
      this.request++;this.pending=false;this.current?.pause();
      this.setStatus(this.muted?'off':this.hidden?'paused':'idle');return;
    }
    if(!this.unlocked){this.setStatus('waiting');return;}
    if(this.currentSrc!==this.track.src)this.select(this.track.src);
    const audio=this.current;
    audio.volume=Math.max(0,Math.min(.85,(this.track.volume ?? .6)*.75));
    if(this.pending || (!audio.paused && ['playing','loading'].includes(this.status)))return;
    // A failed start is retried only by unlock(), never by every fast-read page.
    if(this.status==='error' || this.status==='blocked')return;
    const request=++this.request;this.pending=true;this.setStatus('loading');
    let result;
    try {result=audio.play();}catch(error){this.failed(audio,request,error);return;}
    Promise.resolve(result).then(()=>{
      if(!this.eligible(audio,request))return;
      this.pending=false;if(!audio.paused)this.setStatus('playing');
    },error=>this.failed(audio,request,error));
  }

  failed(audio,request,error) {
    if(!this.eligible(audio,request))return;
    this.pending=false;
    this.setStatus(error?.name==='NotAllowedError'?'blocked':error?.name==='AbortError'?'waiting':'error');
  }

  retry() {
    if(this.status==='error')this.current?.load();
    if(['blocked','error','waiting','paused'].includes(this.status))this.setStatus('waiting');
    this.unlock();
  }
}
