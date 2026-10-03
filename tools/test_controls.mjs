import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {DialogueHold} from '../dist/dialogue-hold.mjs';
import {GameEngine, plainText, textRuns} from '../dist/engine.mjs';
import {LocalSaves} from '../dist/storage.mjs';
import {PictureRenderer} from '../dist/pictures.mjs';

class Clock {
  now = 0;
  serial = 0;
  tasks = new Map();
  set = (callback, delay = 0) => {
    const id = ++this.serial;
    this.tasks.set(id, {callback, due:this.now + delay});
    return id;
  };
  clear = id => this.tasks.delete(id);
  advance(milliseconds) {
    const target = this.now + milliseconds;
    for (let guard = 0; guard < 10000; guard++) {
      const next = [...this.tasks].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > target) { this.now = target; return; }
      this.now = next[1].due;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
    throw new Error('A timer failed to settle');
  }
  remaining(id) { return this.tasks.get(id)?.due - this.now; }
}

class NodeStub extends EventTarget {
  constructor(ownerDocument, tag = 'div') {
    super();
    this.ownerDocument = ownerDocument;
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.classList = {toggle(){}};
    this.open = false;
    this.captured = new Set();
  }
  get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this.text || ''; }
  set textContent(text) { this.text = String(text); this.children = []; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.text = ''; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  closest(selector) { return selector.split(',').includes(this.tag) ? this : this.parent?.closest(selector) || null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelector(selector) { return this.children.find(child => child.closest(selector)) || null; }
  focus() {}
  setPointerCapture(id) { this.captured.add(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
}

function surfaces() {
  const owner = new EventTarget();
  owner.hidden = false;
  owner.defaultView = new EventTarget();
  const element = new NodeStub(owner);
  return {owner, element};
}

function emit(target, type, properties = {}) {
  const event = new Event(type, {cancelable:true});
  for (const [name, value] of Object.entries(properties)) Object.defineProperty(event, name, {value});
  target.dispatchEvent(event);
  return event;
}
const pointer = (id = 1, extra = {}) => ({pointerId:id, button:0, isPrimary:true, clientX:100, clientY:100, ...extra});

// Distinguish a single tap, a hold, scrolling, multi-touch and lifecycle cancellation.
{
  const clock = new Clock(), {owner, element} = surfaces();
  let allowed = true, clicks = 0;
  const changes = [];
  const hold = new DialogueHold(element, {canStart:() => allowed, onChange:value => changes.push(value),
    onClick:() => clicks++, setTimer:clock.set, clearTimer:clock.clear});
  emit(element, 'pointerdown', pointer()); clock.advance(299);
  emit(element, 'pointerup', pointer()); emit(element, 'click'); clock.advance(1000);
  assert.equal(clicks, 1); assert.equal(hold.active, false); assert.deepEqual(changes, []);

  emit(element, 'pointerdown', pointer()); clock.advance(300);
  assert.equal(hold.active, true);
  emit(element, 'pointerdown', pointer(2, {isPrimary:false}));
  emit(element, 'pointerup', pointer(2)); assert.equal(hold.active, true);
  emit(owner, 'pointerup', pointer());
  assert.equal(hold.active, false);
  assert(emit(element, 'click').defaultPrevented);
  assert.equal(clicks, 1, 'Releasing a hold also clicked through a page');
  emit(element, 'pointerdown', pointer()); emit(element, 'pointerup', pointer()); emit(element, 'click');
  assert.equal(clicks, 2, 'A hold suppressed the next ordinary tap');

  for (const signal of ['pointercancel', 'lostpointercapture', 'scroll', 'blur', 'pagehide', 'hidden', 'choice']) {
    allowed = true; owner.hidden = false;
    emit(element, 'pointerdown', pointer()); clock.advance(300);
    assert(hold.active);
    if (signal === 'scroll') emit(element, 'pointermove', pointer(1, {clientY:120}));
    else if (signal === 'blur' || signal === 'pagehide') emit(owner.defaultView, signal);
    else if (signal === 'hidden') { owner.hidden = true; emit(owner, 'visibilitychange'); }
    else if (signal === 'choice') { allowed = false; hold.cancel(); }
    else emit(element, signal, pointer());
    assert.equal(hold.active, false, signal);
    clock.advance(1000); emit(element, 'click');
    assert.equal(clicks, 2, signal + ' generated an unintended click');
  }
  allowed = false; owner.hidden = false;
  emit(element, 'pointerdown', pointer()); clock.advance(1000);
  assert.equal(hold.active, false);
}

const story = JSON.parse(await readFile(new URL('../dist/story.json', import.meta.url), 'utf8'));
const assets = JSON.parse(await readFile(new URL('../dist/assets.json', import.meta.url), 'utf8'));
const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../dist/app.mjs', import.meta.url), 'utf8');

// Execute the actual application handlers against deterministic input and timers.
const clock = new Clock(), {owner:document} = surfaces(), nodes = new Map();
for (const match of html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)) nodes.set(match[2], new NodeStub(document, match[1]));
document.getElementById = id => nodes.get(id);
document.createElement = tag => new NodeStub(document, tag);
const chapters = story.maps.map(map => { const node = new NodeStub(document); node.dataset.map = String(map.id); return node; });
document.querySelectorAll = () => chapters;
class ImageStub extends NodeStub { constructor() { super(document, 'img'); } }
class AudioStub extends EventTarget { play() { return Promise.resolve(); } pause() {} }
class HoldWithClock extends DialogueHold {
  constructor(element, options) { super(element, {...options, setTimer:clock.set, clearTimer:clock.clear}); }
}
class PicturesWithClock extends PictureRenderer {
  constructor(layer, options) { super(layer, {...options, createImage:() => new ImageStub(),
    requestFrame:callback => clock.set(callback, 0), setTimer:clock.set}); }
}
const memory = new Map(), logs = [];
const context = vm.createContext({
  document, GameEngine, plainText, textRuns, LocalSaves, DialogueHold:HoldWithClock, PictureRenderer:PicturesWithClock,
  structuredClone, matchMedia:() => ({matches:false}), Audio:AudioStub,
  localStorage:{getItem:key => memory.get(key) || null, setItem:(key, value) => memory.set(key, value)},
  fetch:async url => ({ok:true, json:async() => url.includes('story.json') ? story : assets}),
  setTimeout:clock.set, clearTimeout:clock.clear, requestAnimationFrame:callback => clock.set(callback, 0),
  addEventListener:document.defaultView.addEventListener.bind(document.defaultView),
  console:{error:error => logs.push(error)},
});
vm.runInContext(app.replace(/^import .*;\n/gm, '').replace(/\ninit\(\);\s*$/, '\nglobalThis.ready=init();'), context);
await context.ready;
assert.deepEqual(logs, [], 'Application initialization failed');
const read = expression => vm.runInContext(expression, context);
const box = nodes.get('dialogue');
function tap() { emit(box, 'pointerdown', pointer()); emit(box, 'pointerup', pointer()); emit(box, 'click'); }
function hold() { emit(box, 'pointerdown', pointer()); clock.advance(300); assert.equal(read('playbackRate()'), 2); }
function release() { emit(box, 'pointerup', pointer()); emit(box, 'click'); }
const position = () => read('`${engine.state.mapId}:${engine.state.current.eventIndex}`');
const pause = () => read('Math.max(1500,Math.min(6000,plainText(engine.state.current.text).length*40))');

emit(nodes.get('start-button'), 'click');
const first = position();
tap(); assert.equal(position(), first); assert.equal(read('typing'), null);
tap(); assert.notEqual(position(), first); tap();
const beforeHold = position();
hold(); assert.equal(nodes.get('hold-status').hidden, false);
assert.equal(read('auto'), false, 'Temporary hold changed the normal auto setting');
assert.equal(clock.remaining(read('autoTimer')), pause() / 2);
clock.advance(pause() / 2 - 1); assert.equal(position(), beforeHold);
release(); assert.equal(position(), beforeHold);
assert.equal(nodes.get('hold-status').hidden, true);
clock.advance(8000); assert.equal(position(), beforeHold, 'Dialogue advanced after releasing');

hold(); clock.advance(pause() / 2);
assert.notEqual(position(), beforeHold, 'Holding did not automatically advance the dialogue');
assert.equal(clock.remaining(read('typeTimer')), 13, 'Text did not run at twice the normal speed');
const fastPage = position();
clock.advance(13); assert.equal(Array.from(nodes.get('story-text').textContent).length, 1);
release(); assert.equal(position(), fastPage);
assert.equal(clock.remaining(read('typeTimer')), 26, 'Releasing did not restore the normal text speed');
clock.advance(8000); assert.equal(position(), fastPage);

// An already-enabled auto mode resumes its normal speed after the hold ends.
emit(nodes.get('auto-button'), 'click');
assert.equal(read('auto'), true); assert.equal(clock.remaining(read('autoTimer')), pause());
hold(); assert.equal(clock.remaining(read('autoTimer')), pause() / 2);
release(); assert.equal(read('auto'), true); assert.equal(clock.remaining(read('autoTimer')), pause());
emit(nodes.get('auto-button'), 'click');

// A real story choice interrupts the hold and requires an explicit choice.
const sourceGame = new GameEngine(story); sourceGame.start();
let precedingChoice;
while (sourceGame.state.current.kind === 'text') {
  const snapshot = sourceGame.snapshot(); sourceGame.advance();
  if (sourceGame.state.current.kind === 'choice') { precedingChoice = snapshot; break; }
}
assert(precedingChoice);
context.testSnapshot = precedingChoice;
read('render(engine.restore(testSnapshot),{animate:false})');
hold(); clock.advance(pause() / 2);
assert.equal(read('engine.state.current.kind'), 'choice');
assert.equal(read('dialogueHold.active'), false); release(); clock.advance(10000);
assert.equal(read('engine.state.current.kind'), 'choice');
assert.equal(read('engine.state.decisions.length'), 0, 'Fast playback selected a branch');
emit(box, 'pointerdown', pointer()); clock.advance(1000);
assert.equal(read('dialogueHold.active'), false); emit(box, 'pointerup', pointer());

read('render(engine.restore(testSnapshot),{animate:false})'); hold();
emit(nodes.get('history-button'), 'click');
assert.equal(read('dialogueHold.active'), false); assert(nodes.get('menu-dialog').open);
const menuPage = position(); clock.advance(10000); assert.equal(position(), menuPage);
emit(nodes.get('dialog-close'), 'click');
hold(); document.hidden = true; emit(document, 'visibilitychange');
assert.equal(read('dialogueHold.active'), false); clock.advance(10000); assert.equal(position(), menuPage);
document.hidden = false; emit(document, 'visibilitychange');

const endingGame = new GameEngine(story); endingGame.start();
for (let guard = 0; !endingGame.state.ended && guard < 2000; guard++) {
  if (endingGame.state.current.kind === 'choice') endingGame.choose(0);
  else endingGame.advance();
}
assert(endingGame.state.ended);
context.endingSnapshot = endingGame.snapshot();
hold(); read('render(engine.restore(endingSnapshot))');
assert.equal(read('dialogueHold.active'), false);
assert.equal(read('typing'), null); assert.equal(nodes.get('dialogue-panel').hidden, true);
release(); clock.advance(10000);
assert.equal(read('engine.state.current.kind'), 'ending');
assert.deepEqual(logs, [], 'A dialogue interaction threw an error');

console.log(JSON.stringify({shortTap:'passed',holdThreshold:'300 ms',textSpeed:'26 ms → 13 ms',
  pageWait:'halved',releaseWithoutExtraPage:'passed',normalAutoResume:'passed',choiceStop:'passed',
  scrollAndLifecycleCancellation:'passed',menuAndVisibilityStop:'passed',endingStop:'passed'}, null, 2));
