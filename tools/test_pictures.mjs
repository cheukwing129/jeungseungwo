import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GameEngine} from '../dist/engine.mjs';
import {PictureRenderer, pictureStyle} from '../dist/pictures.mjs';

const story = JSON.parse(await readFile(new URL('../dist/story.json', import.meta.url), 'utf8'));
const assets = JSON.parse(await readFile(new URL('../dist/assets.json', import.meta.url), 'utf8'));
const dimensions = {width:story.width, height:story.height};

function screen(reducedMotion = false) {
  const frames = [], timers = [], children = [];
  class ImageStub {
    style = {};
    dataset = {};
    listeners = new Map();
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    loaded() { this.listeners.get('load')?.(); }
    remove() { this.removed = true; }
  }
  const renderer = new PictureRenderer({append:image => children.push(image)}, {
    reducedMotion,
    createImage:() => new ImageStub(),
    requestFrame:callback => frames.push(callback),
    setTimer:callback => timers.push(callback),
  });
  return {
    renderer, children,
    flushFrames() { for (const callback of frames.splice(0)) callback(); },
    flushTimers() { for (const callback of timers.splice(0)) callback(); },
  };
}

const scenes = new Map(), queue = [];
const initial = new GameEngine(story); initial.start(); queue.push(initial.snapshot());
while (queue.length) {
  const game = new GameEngine(story); game.restore(queue.shift());
  while (game.state.current.kind === 'text') {
    scenes.set(`${game.state.mapId}:${game.state.current.eventIndex}`, structuredClone(game.state));
    game.advance();
  }
  if (game.state.current.kind === 'choice') {
    for (let index = 0; index < game.state.current.choices.length; index++) {
      const branch = new GameEngine(story); branch.restore(game.snapshot());
      branch.choose(index); queue.push(branch.snapshot());
    }
  }
}
assert.equal(scenes.size, 530);

// Reproduce the reported character with actual pages, including reading a saved hidden state.
for (const reducedMotion of [false, true]) {
  const ui = screen(reducedMotion);
  ui.renderer.render(scenes.get('1:49').pictures, assets, dimensions);
  const miao = ui.renderer.active.get('5');
  ui.renderer.render(scenes.get('1:55').pictures, assets, dimensions);
  assert.equal(miao.style.opacity, '1');
  ui.flushFrames(); miao.loaded();
  assert.equal(miao.style.opacity, '1', 'An earlier hidden page made Miao Xian disappear');

  ui.renderer.render(scenes.get('1:62').pictures, assets, dimensions);
  miao.loaded(); ui.flushFrames();
  assert.equal(miao.style.opacity, '0', 'A late image load resurrected a hidden character');

  const kingScene = [...scenes.values()].find(state => state.current.speaker === '趙惠文王');
  ui.renderer.render(kingScene.pictures, assets, dimensions);
  const king = ui.renderer.active.get('5');
  assert.notEqual(king, miao, 'Replacing the asset reused a pending character image');
  miao.loaded(); ui.flushFrames(); ui.flushTimers();
  assert.equal(king.style.opacity, '1');
  assert(!king.removed, 'Removing an old image also removed the new character');

  ui.renderer.render({}, assets, dimensions);
  king.loaded(); ui.flushFrames(); ui.flushTimers();
  assert.equal(ui.renderer.active.size, 0);
  assert.equal(king.style.opacity, '0', 'A retired image reappeared after loading');
}

const portraits = new Set(), miaoPages = new Set();
const frameWidths = [294, 722, 958, 1102]; // Game widths at 320, 768, 1024 and 1440 px viewports.
for (const state of scenes.values()) {
  const before = JSON.stringify(state);
  for (const [id, picture] of Object.entries(state.pictures)) {
    const asset = assets[picture.asset];
    assert(asset, `Missing picture asset at ${state.mapId}:${state.current.eventIndex}`);
    const style = pictureStyle(picture, asset, dimensions);
    if (!picture.asset.startsWith('Half/')) {
      assert.equal(parseFloat(style.top) / 100 * story.height, picture.y);
      continue;
    }
    portraits.add(picture.asset);
    assert.equal(style.bottom, '0px', 'A portrait leaves a gap above the dialogue frame');
    assert.equal(style.top, 'auto', 'Original portrait top coordinates prevent bottom alignment');
    assert.equal(style.height, 'auto', 'A portrait stretches independently of its original width');
    for (const frameWidth of frameWidths) {
      const imageWidth = parseFloat(style.width) / 100 * frameWidth;
      const imageHeight = imageWidth * asset.height / asset.width;
      assert(imageHeight <= frameWidth * story.height / story.width + 1e-8, 'A portrait is clipped at the top');
      assert(imageWidth > 0);
    }
    if (state.mapId === 1 && state.current.speaker === '繆賢' && picture.opacity > 0) {
      assert.equal(picture.asset, 'Half/1084.png');
      miaoPages.add(state.current.eventIndex);
    }
  }
  assert.equal(JSON.stringify(state), before, 'Rendering changed a saved visual state');
}
assert.equal(portraits.size, 10, 'Not all original portrait assets were checked');
assert.equal(miaoPages.size, 43, 'A spoken Miao Xian page lacks its original portrait');

// Defer every frame until after the next page, as can happen with rapid navigation.
const ui = screen();
let previous;
for (const state of scenes.values()) {
  if (previous) ui.renderer.render(previous.pictures, assets, dimensions);
  ui.renderer.render(state.pictures, assets, dimensions);
  ui.flushFrames(); ui.flushTimers();
  for (const [id, picture] of Object.entries(state.pictures)) {
    const image = ui.renderer.active.get(id);
    assert(image && !image.removed);
    image.loaded();
    assert.equal(image.dataset.asset, assets[picture.asset].src);
    assert.equal(Number(image.style.opacity), Math.max(0, Math.min(255, picture.opacity)) / 255);
  }
  previous = state;
}

console.log(JSON.stringify({dialogue:scenes.size,portraitAssets:portraits.size,miaoChapterOnePages:miaoPages.size,
  viewportWidths:[320,768,1024,1440],bottomAlignment:'passed',rapidNavigation:'passed',lateImageLoads:'passed'}, null, 2));
