import {GameEngine} from './engine.98655b91988440c18163.mjs';

// Derive routes from the existing command graph without changing jump positions.
function routesFrom(story) {
  const maps = new Map(story.maps.map(map => [map.id,map])), routes = [];
  function walk(mapId,pc,path,visited) {
    for (let guard = 0; guard < 10000; guard++) {
      const location = `${mapId}:${pc}`, map = maps.get(mapId), event = map?.events[pc];
      if (!event || visited.has(location)) throw new Error('路線資料不完整。');
      visited.add(location);
      if (event.code === 101) {
        event.choices.forEach((choice,index) => walk(mapId,choice.target,[...path,
          {mapId,eventIndex:pc,index,text:choice.text,prompt:event.prompt || '請作出你的抉擇'}],new Set(visited)));
        return;
      }
      if (event.code === 108) pc = event.skip;
      else if (event.code === 206) {mapId = Number(event.p[0]);pc = 0;}
      else if (event.code === 208) {
        if (!event.ending) throw new Error('找不到路線結尾。');
        routes.push({id:location,mapId,eventIndex:pc,...structuredClone(event.ending),path});
        return;
      } else pc++;
    }
    throw new Error('路線跳轉次數異常。');
  }
  walk(story.startMap,0,[],new Set());
  const order = new Map(story.maps.map((map,index) => [map.id,index]));
  return routes.sort((a,b) => order.get(a.mapId)-order.get(b.mapId) || a.eventIndex-b.eventIndex);
}

export class ReplayLibrary {
  constructor(story,stored = null) {
    this.story = story;
    this.routes = routesFrom(story);
    this.byId = new Map(this.routes.map(route => [route.id,route]));
    this.completedRoute = this.routes.find(route => route.completed);
    if (!this.completedRoute) throw new Error('找不到通關路線。');
    const compatible = stored?.sourceHash === story.sourceHash;
    const endings = compatible && Array.isArray(stored.endings) ?
      [...new Set(stored.endings.filter(id => typeof id === 'string' && this.byId.has(id)))] : [];
    const completed = (compatible && stored.completed === true) || endings.includes(this.completedRoute.id);
    if (completed && !endings.includes(this.completedRoute.id)) endings.push(this.completedRoute.id);
    this.progress = {sourceHash:story.sourceHash,completed,endings};
    this.chapterCache = new Map();
  }

  get unlocked() {return this.progress.completed;}
  hasRoute(id) {return this.progress.endings.includes(id);}

  merge(progress) {
    if (progress?.sourceHash !== this.story.sourceHash) return;
    if (Array.isArray(progress.endings)) for (const id of progress.endings) {
      if (this.byId.has(id) && !this.hasRoute(id)) this.progress.endings.push(id);
    }
    if (progress.completed === true || this.hasRoute(this.completedRoute.id)) {
      this.progress.completed = true;
      if (!this.hasRoute(this.completedRoute.id)) this.progress.endings.push(this.completedRoute.id);
    }
  }

  record(snapshot) {
    const state = snapshot?.state, current = state?.current;
    if (snapshot?.sourceHash !== this.story.sourceHash || !state?.ended || current?.kind !== 'ending') return false;
    const id = `${state.mapId}:${current.eventIndex}`, route = this.byId.get(id);
    if (!route) return false;
    let changed = false;
    if (!this.hasRoute(id)) {this.progress.endings.push(id);changed = true;}
    if (route.completed && !this.unlocked) {this.progress.completed = true;changed = true;}
    return changed;
  }

  checkpoint(path,at) {
    const game = new GameEngine(this.story);
    game.start();
    for (let guard = 0; guard < 3000; guard++) {
      if (at(game.state)) return game;
      if (game.state.current.kind === 'choice') {
        const decision = path.find(step => step.mapId === game.state.mapId && step.eventIndex === game.state.current.eventIndex);
        if (!decision) break;
        game.choose(decision.index);
      } else if (game.state.current.kind === 'text') game.advance();
      else break;
    }
    throw new Error('找不到可重玩的劇情位置。');
  }

  startChapter(mapId) {
    if (!this.unlocked) throw new Error('成功通關後即可選擇章節。');
    if (!this.story.maps.some(map => map.id === mapId)) throw new Error('找不到此章節。');
    if (!this.chapterCache.has(mapId)) {
      // Carry forward the original background, music and variables at the chapter boundary.
      const game = this.checkpoint(this.completedRoute.path,state => state.mapId === mapId);
      game.state.history = game.state.history.slice(-1);
      game.lastChoice = null;
      this.chapterCache.set(mapId,game.snapshot());
    }
    return structuredClone(this.chapterCache.get(mapId));
  }

  replayRoute(id) {
    if (!this.unlocked) throw new Error('成功通關後即可重玩路線。');
    const route = this.byId.get(id);
    if (!route || !this.hasRoute(id)) throw new Error('這條路線尚未探索。');
    const last = route.path.at(-1);
    if (!last) return this.startChapter(route.mapId);
    return this.checkpoint(route.path,state => state.mapId === last.mapId &&
      state.current.kind === 'choice' && state.current.eventIndex === last.eventIndex).snapshot();
  }
}
