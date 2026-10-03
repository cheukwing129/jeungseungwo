import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {DialogueHold} from '../dist/dialogue-hold.mjs';
import {GameEngine, plainText, textRuns} from '../dist/engine.mjs';
import {LocalSaves} from '../dist/storage.mjs';
import {PictureRenderer} from '../dist/pictures.mjs';
import {ReplayLibrary} from '../dist/replay.mjs';
import {AutosaveScheduler} from '../dist/autosave.mjs';

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
  runNext() {
    const next = [...this.tasks].sort((a, b) => a[1].due - b[1].due)[0];
    assert(next, 'No pending timer');
    this.now = next[1].due;
    this.tasks.delete(next[0]);
    next[1].callback();
  }
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
    this.classes = new Set();
    this.classList = {
      toggle:(name, force) => {
        const add = force === undefined ? !this.classes.has(name) : force;
        if (add) this.classes.add(name); else this.classes.delete(name);
        return Boolean(add);
      },
      contains:name => this.classes.has(name),
    };
    this.open = false;
    this.captured = new Set();
    this.captureListeners = new Map();
  }
  get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this.text || ''; }
  set textContent(text) { this.text = String(text); this.children = []; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.text = ''; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      if (part.startsWith('[')) return Object.hasOwn(this.attributes, part.slice(1, -1));
      if (part.startsWith('#')) return this.attributes.id === part.slice(1);
      return part === this.tag;
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const descendant = child.querySelector(selector);
      if (descendant) return descendant;
    }
    return null;
  }
  focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; }
  addEventListener(type, callback, options) {
    if (options === true || options?.capture) {
      const listeners = this.captureListeners.get(type) || [];
      listeners.push(callback); this.captureListeners.set(type, listeners);
    } else super.addEventListener(type, callback, options);
  }
  setPointerCapture(id) { this.captured.add(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
}

function surfaces(pointerEvents = true) {
  const owner = new NodeStub(null,'document');
  owner.hidden = false;
  owner.defaultView = new EventTarget();
  if (pointerEvents) owner.defaultView.PointerEvent = class {};
  const element = new NodeStub(owner);
  return {owner, element};
}

function emit(target, type, properties = {}) {
  const event = new Event(type, {cancelable:true, bubbles:true});
  Object.defineProperty(event, 'target', {value:target});
  if (type === 'click') Object.defineProperty(event, 'detail', {value:1, configurable:true});
  for (const [name, value] of Object.entries(properties)) Object.defineProperty(event, name, {value});
  let stopped = false;
  const stop = event.stopImmediatePropagation.bind(event);
  event.stopImmediatePropagation = () => { stopped = true; stop(); };
  const path = [];
  for (let node = target; node; node = node.parent) path.push(node);
  if (target.ownerDocument && !path.includes(target.ownerDocument)) path.push(target.ownerDocument);
  for (const node of [...path].reverse()) {
    for (const callback of node.captureListeners?.get(type) || []) {
      callback(event);
      if (stopped) return event;
    }
  }
  for (const node of path) {
    node.dispatchEvent(event);
    if (stopped) break;
  }
  return event;
}
const pointer = (id = 1, extra = {}) => ({pointerId:id, pointerType:'mouse', button:0, buttons:1, isPrimary:true, clientX:100, clientY:100, ...extra});

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
    emit(element, 'pointerdown', pointer(1, {pointerType:signal === 'scroll' ? 'touch' : 'mouse'})); clock.advance(300);
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

// Mouse movement remains a hold, while a lost release and mouse-only browsers still stop safely.
{
  const clock = new Clock(), {owner, element} = surfaces();
  let clicks = 0;
  const hold = new DialogueHold(element, {canStart:() => true, onChange(){}, onClick:() => clicks++,
    setTimer:clock.set, clearTimer:clock.clear});
  emit(element, 'pointerdown', pointer());
  emit(element, 'mousedown', {button:0, buttons:1, clientX:100, clientY:100});
  assert.equal(clock.tasks.size, 1, 'Mouse compatibility events started a second hold');
  emit(element, 'pointermove', pointer(1, {clientX:250, clientY:230})); clock.advance(300);
  assert(hold.active, 'Moving the mouse interrupted a hold');
  emit(owner, 'mousemove', {buttons:0}); assert.equal(hold.active, false);
  assert(emit(element, 'click').defaultPrevented);

  emit(element, 'pointerdown', pointer(1, {pointerType:'touch'})); clock.advance(300);
  emit(element, 'pointerup', pointer(1, {pointerType:'touch', buttons:0}));
  emit(element, 'mousedown', {button:0, clientX:100, clientY:100}); emit(owner, 'mouseup', {button:0});
  assert(emit(element, 'click').defaultPrevented, 'A touch compatibility click advanced an extra page');
  assert.equal(clicks, 0);

  delete owner.defaultView.PointerEvent;
  emit(element, 'mousedown', {button:0, clientX:100, clientY:100}); clock.advance(300);
  assert(hold.active, 'A mouse-only browser cannot hold');
  emit(owner, 'mouseup', {button:0}); assert.equal(hold.active, false);
  assert(emit(element, 'click').defaultPrevented);
  emit(element, 'mousedown', {button:0}); emit(owner, 'mouseup', {button:0}); emit(element, 'click');
  assert.equal(clicks, 1, 'A short mouse-only click was lost');
  emit(element, 'mousedown', {button:0}); clock.advance(300); emit(owner, 'mouseup', {button:0});
  emit(element, 'click', {detail:0}); assert.equal(clicks, 2, 'A pending release blocked a keyboard click');
  assert(emit(element, 'click').defaultPrevented, 'A keyboard click cleared the mouse release guard');
}

const story = JSON.parse(await readFile(new URL('../dist/story.json', import.meta.url), 'utf8'));
const assets = JSON.parse(await readFile(new URL('../dist/assets.json', import.meta.url), 'utf8'));
const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../dist/app.mjs', import.meta.url), 'utf8');

// Execute the actual application handlers against deterministic input and timers.
async function application(reducedMotion = false, pointerEvents = true, savedValue = null, sharedMemory = new Map(), testStory = story) {
  const clock = new Clock(), {owner:document} = surfaces(pointerEvents), nodes = new Map(), stack = [];
  const voidTags = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)(\s[^<>]*?)?>/gi)) {
    const [, closing, tag, attributes = ''] = match;
    if (closing) { assert.equal(stack.pop()?.tag, tag, 'HTML elements are not balanced'); continue; }
    const node = new NodeStub(document, tag);
    for (const attr of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], attr[2] || '');
    if (node.attributes.id) nodes.set(node.attributes.id, node);
    stack.at(-1)?.append(node);
    if (!voidTags.has(tag)) stack.push(node);
  }
  assert.equal(stack.length, 0);
  document.getElementById = id => nodes.get(id);
  document.createElement = tag => new NodeStub(document, tag);
  const chapters = story.maps.map(map => { const node = new NodeStub(document); node.dataset.map = String(map.id); return node; });
  document.querySelectorAll = () => chapters;
  class ImageStub extends NodeStub { constructor() { super(document, 'img'); } }
  class AudioStub extends EventTarget { play() { return Promise.resolve(); } pause() {} }
  const registeredTools=new Map();
  document.modelContext={registerTool:tool=>registeredTools.set(tool.name,tool)};
  class HoldWithClock extends DialogueHold {
    constructor(element, options) { super(element, {...options, setTimer:clock.set, clearTimer:clock.clear}); }
  }
  class AutosaveWithClock extends AutosaveScheduler {
    constructor(save, options) { super(save, {...options, setTimer:clock.set, clearTimer:clock.clear}); }
  }
  class PicturesWithClock extends PictureRenderer {
    constructor(layer, options) { super(layer, {...options, createImage:() => new ImageStub(),
      requestFrame:callback => clock.set(callback, 0), setTimer:clock.set}); }
  }
  const memory = sharedMemory, logs = [], writes = [];
  if(savedValue)memory.set('lianpo-story-v1',JSON.stringify(savedValue));
  const context = vm.createContext({
    document, GameEngine, plainText, textRuns, LocalSaves, ReplayLibrary, AutosaveScheduler:AutosaveWithClock, DialogueHold:HoldWithClock, PictureRenderer:PicturesWithClock,
    structuredClone, AbortController, matchMedia:() => ({matches:reducedMotion}), Audio:AudioStub,
    localStorage:{getItem:key => memory.get(key) || null, setItem:(key, value) => {writes.push({key,value});memory.set(key, value);}},
    fetch:async url => ({ok:true, json:async() => url.includes('story.json') ? testStory : assets}),
    setTimeout:clock.set, clearTimeout:clock.clear, requestAnimationFrame:callback => clock.set(callback, 0),
    addEventListener:document.defaultView.addEventListener.bind(document.defaultView),
    console:{error:error => logs.push(error)},
  });
  vm.runInContext(app.replace(/^import .*;\n/gm, '').replace(/\ninit\(\);\s*$/, '\nglobalThis.ready=init();'), context);
  await context.ready;
  assert.deepEqual(logs, [], 'Application initialization failed');
  const read = expression => vm.runInContext(expression, context);
  return {clock, document, nodes, context, read, logs, memory, writes, registeredTools};
}

const {clock, document, nodes, context, read, logs} = await application();
const box = nodes.get('dialogue');
function tap() { emit(box, 'pointerdown', pointer()); emit(box, 'pointerup', pointer()); emit(box, 'click'); }
function hold() { emit(box, 'pointerdown', pointer()); clock.advance(300); assert.equal(read('playbackRate()'), 5); }
function release() { emit(box, 'pointerup', pointer()); emit(box, 'click'); }
const position = () => read('`${engine.state.mapId}:${engine.state.current.eventIndex}`');
const pause = () => read('Math.max(1500,Math.min(6000,plainText(engine.state.current.text).length*40))');

// Original interludes and chapter cards render without spacing used as layout padding.
const interludePages = new Set(['1:30','1:226','1:229','1:446','1:512','1:597','1:605','1:708','1:728',
  '1:882','1:969','1:1012','1:1177','2:1','2:252','2:316','2:343','2:375','2:479','2:554',
  '3:1','3:136','3:301','3:379','3:460','3:509']);
let centeredPages = 0;
for (const map of story.maps) for (const [index, event] of map.events.entries()) {
  if (event.code !== 100) continue;
  context.testSpeaker = event.p[0]; context.testText = event.p[2];
  const presentation = read('formatDialogue(testSpeaker,testText)');
  const centered = interludePages.has(`${map.id}:${index}`);
  assert.equal(presentation.centered, centered, `Wrong alignment for ${map.id}:${index}`);
  if (centered) {
    centeredPages++;
    read('renderText(testSpeaker,testText,false)');
    assert(nodes.get('dialogue').classList.contains('interlude'));
    assert.equal(nodes.get('speaker').hidden, true);
    assert.equal(nodes.get('story-text').textContent, plainText(event.p[2]).replace(/\s/g, ''));
    assert.equal(nodes.get('announcement').textContent, nodes.get('story-text').textContent);
  } else assert.equal(presentation.text, event.p[2], 'Ordinary dialogue text changed');
}
assert.equal(centeredPages, 26);
const intro = story.maps[0].events.find(event => event.code === 100);
context.testSpeaker = intro.p[0]; context.testText = intro.p[2]; read('renderText(testSpeaker,testText,false)');
assert.equal(nodes.get('dialogue').classList.contains('interlude'), false, 'Centering leaked into the next dialogue');
assert.equal(nodes.get('speaker').hidden, false);

// Old saves keep their original source text while receiving the corrected visible layout.
const prologueGame = new GameEngine(story); prologueGame.start();
while (prologueGame.state.current.eventIndex < 30) prologueGame.advance();
assert.equal(prologueGame.state.current.eventIndex, 30);
context.oldInterludeSnapshot = JSON.parse(JSON.stringify(prologueGame.snapshot()));
read('render(engine.restore(oldInterludeSnapshot),{animate:false})');
assert.equal(nodes.get('story-text').textContent, '序章');
assert(nodes.get('dialogue').classList.contains('interlude'));
emit(nodes.get('history-button'), 'click');
const historyInterlude = nodes.get('dialog-body').children.at(-1);
assert(historyInterlude.className.includes('interlude'));
assert.equal(historyInterlude.children[0].hidden, true);
assert.equal(historyInterlude.children[1].textContent, '序章');
emit(nodes.get('dialog-close'), 'click');

emit(nodes.get('start-button'), 'click');
const first = position();
tap(); assert.equal(position(), first); assert.equal(read('typing'), null);
tap(); assert.notEqual(position(), first); tap();
const beforeHold = position();
hold(); assert.equal(nodes.get('hold-status').hidden, false);
assert.equal(read('auto'), false, 'Temporary hold changed the normal auto setting');
assert.notEqual(position(), beforeHold, 'Holding did not automatically advance the dialogue');
assert.equal(Array.from(nodes.get('story-text').textContent).length, 1, 'A new page starts blank');
assert(Math.abs(clock.remaining(read('typeTimer')) - 26 / 5) < 1e-7, 'Text did not run at five times the normal speed');
const fastPage = position();
clock.advance(26 / 5); assert.equal(Array.from(nodes.get('story-text').textContent).length, 2);
release(); assert.equal(position(), fastPage);
assert.equal(nodes.get('hold-status').hidden, true);
assert.equal(clock.remaining(read('typeTimer')), 26, 'Releasing did not restore the normal text speed');
clock.advance(8000); assert.equal(position(), fastPage);
const stableSnapshot = read('engine.snapshot()');

// The final glyph schedules the next page without any reading pause or blank first frame.
hold();
while (read('typing')) clock.runNext();
const completedPage = position(), completedAt = clock.now;
assert.equal(nodes.get('story-text').textContent, read('plainText(engine.state.current.text)'));
assert.equal(clock.remaining(read('autoTimer')), 0, 'Fast playback still waits after the final glyph');
clock.advance(0);
assert.notEqual(position(), completedPage);
assert.equal(clock.now, completedAt, 'A page transition consumed extra waiting time');
assert(nodes.get('story-text').textContent.length > 0, 'The next page left the dialogue frame empty');
release();

// Release can cancel even a ready-to-run page transition, without an extra click.
context.stableSnapshot = stableSnapshot;
read('render(engine.restore(stableSnapshot),{animate:false})'); hold();
while (read('typing')) clock.runNext();
const releasedPage = position();
assert.equal(clock.remaining(read('autoTimer')), 0);
release(); clock.advance(8000);
assert.equal(position(), releasedPage, 'A queued page transition ran after releasing');

// An already-enabled auto mode resumes its normal speed after the hold ends.
emit(nodes.get('auto-button'), 'click');
assert.equal(read('auto'), true); assert.equal(clock.remaining(read('autoTimer')), pause());
hold(); release(); assert.equal(read('auto'), true);
if (read('typing')) tap();
assert.equal(clock.remaining(read('autoTimer')), pause());
emit(nodes.get('auto-button'), 'click');

// Both the scene and the Continue button use the same single-click and mouse-hold controls.
for (const target of [nodes.get('stage'), nodes.get('next-button').querySelector('span')]) {
  read('render(engine.restore(stableSnapshot),{animate:false})');
  const expected = new GameEngine(story); expected.restore(read('engine.snapshot()')); expected.advance();
  emit(target, 'pointerdown', pointer()); emit(target, 'pointerup', pointer()); emit(target, 'click');
  assert.equal(position(), `${expected.state.mapId}:${expected.state.current.eventIndex}`, 'A click advanced twice');
  emit(target, 'pointerdown', pointer()); emit(target, 'mousedown', {button:0}); clock.advance(300);
  assert.equal(read('playbackRate()'), 5);
  emit(target, 'pointermove', pointer(1, {clientX:300, clientY:250}));
  assert.equal(read('dialogueHold.active'), true, 'Mouse movement stopped scene/button fast reading');
  emit(document, 'mouseup', {button:0}); emit(target, 'click');
  assert.equal(read('dialogueHold.active'), false);
}
read('render(engine.restore(stableSnapshot),{animate:false})');
emit(nodes.get('auto-button'), 'pointerdown', pointer()); clock.advance(300);
assert.equal(read('dialogueHold.active'), false, 'The Auto button started a hold');
emit(document, 'pointerup', pointer());

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
emit(box, 'pointerdown', pointer()); clock.advance(300);
assert.equal(read('engine.state.current.kind'), 'choice');
assert.equal(read('dialogueHold.active'), false);
assert.equal(nodes.get('scene-choices').hidden, false);
assert.equal(nodes.get('scene-choices').parent, nodes.get('stage'), 'Choices are outside the scene');
assert.equal(nodes.get('dialogue-actions').hidden, false, 'Opening choices changed the frame height');
assert.equal(nodes.get('choices').children.length, read('engine.state.current.choices.length'));
assert.equal(document.activeElement, nodes.get('choices').children[0]);
assert.equal(document.activeElement.focusOptions.preventScroll, true);
// Capture blocks the release click before it reaches a newly appeared choice button.
const firstChoice = nodes.get('choices').children[0];
emit(firstChoice, 'pointerup', pointer());
assert(emit(firstChoice.querySelector('span'), 'click').defaultPrevented);
clock.advance(10000);
assert.equal(read('engine.state.current.kind'), 'choice');
assert.equal(read('engine.state.decisions.length'), 0, 'Fast playback selected a branch');
emit(box, 'pointerdown', pointer()); clock.advance(1000);
assert.equal(read('dialogueHold.active'), false); emit(box, 'pointerup', pointer());
emit(firstChoice, 'pointerdown', pointer()); emit(firstChoice, 'pointerup', pointer()); emit(firstChoice, 'click');
assert.equal(read('engine.state.decisions.length'), 1, 'An explicit popup choice was ignored');
assert.equal(nodes.get('scene-choices').hidden, true);
assert.equal(document.activeElement, nodes.get('next-button'));
assert.equal(document.activeElement.focusOptions.preventScroll, true);

// Every reachable choice renders its original buttons inside the scene popup.
const choicePoints = new Set(), choiceOptions = new Set(), routeQueue = [], routeEndings = [], routeStart = new GameEngine(story);
routeStart.start(); routeQueue.push(routeStart.snapshot());
while (routeQueue.length) {
  const game = new GameEngine(story); game.restore(routeQueue.shift());
  while (game.state.current.kind === 'text') game.advance();
  if (game.state.current.kind !== 'choice') { routeEndings.push(game.snapshot()); continue; }
  const key = `${game.state.mapId}:${game.state.current.eventIndex}`;
  if (!choicePoints.has(key)) {
    context.popupSnapshot = game.snapshot(); read('render(engine.restore(popupSnapshot),{animate:false})');
    assert.equal(nodes.get('scene-choices').hidden, false);
    assert.deepEqual(nodes.get('choices').children.map(button => button.children[1].textContent), game.state.current.choices.map(choice => choice.text));
    choicePoints.add(key);
  }
  game.state.current.choices.forEach((_, index) => {
    choiceOptions.add(`${key}:${index}`);
    const branch = new GameEngine(story); branch.restore(game.snapshot()); branch.choose(index); routeQueue.push(branch.snapshot());
  });
}
assert.equal(choicePoints.size, 14); assert.equal(choiceOptions.size, 32);

read('render(engine.restore(stableSnapshot),{animate:false})'); hold();
emit(nodes.get('history-button'), 'click');
assert.equal(read('dialogueHold.active'), false); assert(nodes.get('menu-dialog').open);
const menuPage = position(); clock.advance(10000); assert.equal(position(), menuPage);
emit(nodes.get('dialog-close'), 'click');
hold(); const visibilityPage = position(); document.hidden = true; emit(document, 'visibilitychange');
assert.equal(read('dialogueHold.active'), false); clock.advance(10000); assert.equal(position(), visibilityPage);
document.hidden = false; emit(document, 'visibilitychange');
release();

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

// Incomplete routes offer another attempt; completion unlocks chapter and route replay.
assert.equal(routeEndings.length, 19);
assert.equal(routeEndings.filter(snapshot => snapshot.state.current.completed).length, 1);
for (const snapshot of routeEndings) {
  context.routeEndingSnapshot = snapshot;
  read('render(engine.restore(routeEndingSnapshot))'); clock.advance(0);
  const completed = snapshot.state.current.completed;
  assert.equal(nodes.get('retry-button').hidden, completed);
  assert.equal(document.activeElement, nodes.get(completed ? 'ending-chapters-button' : 'retry-button'));
  assert.equal(nodes.get('ending-chapters-button').hidden,!completed);
  assert.equal(nodes.get('ending-routes-button').hidden,!completed);
  assert.equal(document.activeElement.focusOptions.preventScroll, true);
  assert.equal(nodes.get('ending-eyebrow').textContent, snapshot.state.current.category);
  if (completed) {
    assert.equal(nodes.get('ending-title').textContent, '全劇終');
    assert.equal(nodes.get('instruction').textContent, '已解鎖章節選擇與路線圖鑑，可重玩指定章節。');
  }
  emit(nodes.get('retry-button'), 'click');
  assert.equal(read('engine.state.current.kind'), completed ? 'ending' : 'choice', 'Ending retry control has the wrong behavior');
}
context.completedSnapshot = routeEndings.find(snapshot => snapshot.state.current.completed);
read('render(engine.restore(completedSnapshot))');
emit(nodes.get('home-button'), 'click');
assert.equal(read('started'), false); assert.equal(nodes.get('title-screen').hidden, false);
assert.deepEqual(logs, [], 'An ending interaction threw an error');

// Reduced motion presents static text at the same rate, without a chapter-skipping timer loop.
const reduced = await application(true), reducedBox = reduced.nodes.get('dialogue');
emit(reduced.nodes.get('start-button'), 'click');
emit(reducedBox, 'pointerdown', pointer()); reduced.clock.advance(300);
assert.equal(reduced.read('playbackRate()'), 5);
assert.equal(reduced.read('typing'), null);
const displayTime = reduced.read('Array.from(plainText(engine.state.current.text)).length*26/5');
assert(Math.abs(reduced.clock.remaining(reduced.read('autoTimer')) - displayTime) < 1e-7);
assert(reduced.nodes.get('story-text').textContent.length > 0);
const staticPage = reduced.read('engine.state.current.eventIndex');
reduced.clock.advance(displayTime);
assert.notEqual(reduced.read('engine.state.current.eventIndex'), staticPage);
emit(reducedBox, 'pointerup', pointer()); emit(reducedBox, 'click');
const staticRelease = reduced.read('engine.state.current.eventIndex');
reduced.clock.advance(10000); assert.equal(reduced.read('engine.state.current.eventIndex'), staticRelease);

// The actual app also works when only native mouse events are available.
const mouseOnly = await application(false, false), mouseScene = mouseOnly.nodes.get('stage');
emit(mouseOnly.nodes.get('start-button'), 'click');
emit(mouseScene, 'mousedown', {button:0, clientX:100, clientY:100}); mouseOnly.clock.advance(300);
assert.equal(mouseOnly.read('playbackRate()'), 5);
emit(mouseOnly.document, 'mousemove', {buttons:1, clientX:250});
assert.equal(mouseOnly.read('dialogueHold.active'), true);
emit(mouseOnly.document, 'mouseup', {button:0}); emit(mouseScene, 'click');
assert.equal(mouseOnly.read('playbackRate()'), 1);
const mouseRelease = mouseOnly.read('engine.state.current.eventIndex');
mouseOnly.clock.advance(10000); assert.equal(mouseOnly.read('engine.state.current.eventIndex'), mouseRelease);

console.log(JSON.stringify({shortTap:'passed',holdThreshold:'300 ms',textSpeed:'26 ms → 5.2 ms',
  pageWait:'none',immediateFirstGlyph:'passed',releaseWithoutExtraPage:'passed',normalAutoResume:'passed',choiceStop:'passed',
  centeredInterludes:centeredPages,oldSaveInterlude:'passed',completedEndingWithoutRetry:'passed',incompleteRouteRetry:'passed',
  popupChoicePoints:choicePoints.size,popupOptions:choiceOptions.size,mouseSceneAndContinue:'passed',mouseFallback:'passed',
  mouseMovement:'passed',touchCompatibility:'passed',scrollAndLifecycleCancellation:'passed',menuAndVisibilityStop:'passed',endingStop:'passed',reducedMotion:'passed'}, null, 2));

// Actual UI handlers ignore a non-existent option and persist both kinds of ending.
{
  const ui=await application();
  assert.equal(ui.nodes.get('replay-menu').hidden,true);
  ui.read('showChapters();showRoutes()');assert.equal(ui.nodes.get('menu-dialog').open,false,'Replay opened before completion');
  const first=new GameEngine(story);first.start();
  while(first.state.current.kind==='text')first.advance();
  ui.context.choiceSnapshot=first.snapshot();ui.read('render(engine.restore(choiceSnapshot),{animate:false})');
  assert(ui.nodes.get('instruction').textContent.includes('1、2 選擇'));
  emit(ui.nodes.get('game-frame'),'keydown',{key:'3',code:'Digit3'});
  assert.equal(ui.read('engine.state.current.kind'),'choice');assert.equal(ui.logs.length,0);
  assert.equal(ui.nodes.get('toast').textContent,'');

  const edits=JSON.parse(await readFile(new URL('./story_edits.json',import.meta.url),'utf8'));
  ui.context.answers=Object.fromEntries(edits.choices.map(x=>[`${x.map}:${x.event}`,x.correct]));
  ui.read('start()');
  for(let guard=0; !ui.read('engine.state.ended') && guard<2000; guard++) {
    if(ui.read('engine.state.current.kind')==='choice')ui.read('choose(answers[`${engine.state.mapId}:${engine.state.current.eventIndex}`])');
    else ui.read('render(engine.advance(),{animate:false})');
  }
  assert.equal(ui.read('saves.read().auto.snapshot.state.current.completed'),true);
  assert.equal(ui.read('saves.read().auto.snapshot.state.ended'),true);
  assert(ui.nodes.get('ending-text').textContent.includes('刎頸之交'));
  assert.equal(ui.nodes.get('ending-feedback').hidden,true);
  emit(ui.nodes.get('home-button'),'click');assert.equal(ui.nodes.get('continue-button').textContent,'查看通關結局');
  emit(ui.nodes.get('continue-button'),'click');assert.equal(ui.read('engine.state.current.kind'),'ending');
  assert.equal(ui.nodes.get('retry-button').hidden,true);

  // The new replay entry points use actual button handlers and keep manual slots intact.
  const slotsBefore=ui.read('JSON.stringify(saved.slots)');
  emit(ui.nodes.get('ending-chapters-button'),'click');
  assert.equal(ui.nodes.get('dialog-title').textContent,'章節選擇');
  assert.equal(ui.nodes.get('menu-dialog').open,true);
  const chapterCards=ui.nodes.get('dialog-body').children.slice(1);
  assert.equal(chapterCards.length,3);
  emit(chapterCards[2].querySelector('button'),'click');
  assert.equal(ui.nodes.get('menu-dialog').open,false);
  assert.equal(ui.read('engine.state.mapId'),3);
  assert.equal(ui.read('engine.state.current.eventIndex'),1);
  assert.equal(ui.read('auto'),false);
  assert.equal(ui.read('engine.lastChoice'),null);
  assert.equal(ui.read('JSON.stringify(saved.slots)'),slotsBefore);
  assert.equal(ui.read('saved.progress.completed'),true);
  assert.equal(ui.document.activeElement,ui.nodes.get('next-button'));
  emit(ui.nodes.get('home-button'),'click');
  assert.equal(ui.nodes.get('replay-menu').hidden,false);
  assert.equal(ui.nodes.get('continue-button').textContent,'接續上次進度');

  emit(ui.nodes.get('route-library-button'),'click');
  const routeBody=ui.nodes.get('dialog-body');
  assert.equal(ui.nodes.get('dialog-title').textContent,'路線圖鑑');
  assert(routeBody.textContent.includes('已探索 1／19 條路線'));
  assert(!routeBody.textContent.includes('原文回饋：'),'An unexplored route revealed its feedback');
  assert(!routeBody.textContent.includes('繆賢和藺相如逃到燕國'),'An unexplored ending was revealed');
  const completedCard=routeBody.children.at(-1).children.find(node=>node.tag==='details');
  assert(completedCard.textContent.includes('刎頸之交'));
  emit(completedCard.querySelector('button'),'click');ui.clock.advance(0);
  assert.equal(ui.read('engine.state.current.kind'),'choice');
  assert.equal(ui.read('engine.state.current.eventIndex'),371);
  assert.equal(ui.read('engine.state.mapId'),3);
  assert.equal(ui.document.activeElement,ui.nodes.get('choices').children[0]);
  assert.equal(ui.read('saved.progress.completed'),true);
  assert.equal(ui.read('JSON.stringify(saved.slots)'),slotsBefore);

  // Unlock survives a new game, reload, and an incomplete route replacing the autosave.
  ui.read('home()');emit(ui.nodes.get('start-button'),'click');ui.read('home()');
  assert.equal(ui.nodes.get('replay-menu').hidden,false);
  const reloaded=await application(false,true,null,ui.memory);
  assert.equal(reloaded.nodes.get('replay-menu').hidden,false);
  assert.equal(reloaded.read('replay.progress.endings.length'),1);

  const fixtures=JSON.parse(await readFile(new URL('./fixtures/legacy-saves.json',import.meta.url),'utf8'));
  ui.context.failure=fixtures.punctuatedFailure;ui.read('render(engine.restore(failure),{animate:false})');
  assert.equal(ui.nodes.get('ending-feedback').hidden,false);
  emit(ui.nodes.get('home-button'),'click');assert.equal(ui.nodes.get('continue-button').textContent,'返回上次抉擇');
  emit(ui.nodes.get('continue-button'),'click');assert.equal(ui.read('engine.state.current.kind'),'choice');
  assert.equal(ui.read('engine.state.current.eventIndex'),686);
  assert.equal(ui.read('saved.progress.completed'),true);
  assert.equal(ui.read('saved.progress.endings.length'),2);
  assert.equal(ui.logs.length,0);

  const oldEntry={snapshot:fixtures.oldFinalCard,time:'2026-10-03T12:00:00.000Z',chapter:'負荊請罪',preview:'全劇終'};
  const restored=await application(false,true,{auto:oldEntry,slots:[null,null,null],settings:{muted:false}});
  assert.equal(restored.nodes.get('continue-button').textContent,'查看通關結局');
  assert.equal(restored.nodes.get('replay-menu').hidden,false,'Old completed autosave did not unlock replay');
  emit(restored.nodes.get('continue-button'),'click');
  assert.equal(restored.read('engine.state.current.completed'),true);
  assert.equal(restored.nodes.get('retry-button').hidden,true);
  assert.equal(restored.logs.length,0);
  const manualOnly=await application(false,true,{auto:null,slots:[oldEntry,null,null],settings:{muted:false}});
  assert.equal(manualOnly.nodes.get('replay-menu').hidden,false,'An old completed manual save did not unlock replay');
  assert.equal(manualOnly.read('saved.slots.filter(Boolean).length'),1);
}
console.log(JSON.stringify({twoOptionShortcut:'passed',completedAutosave:'passed',homeCompletedResume:'passed',
  failureResumeAtChoice:'passed',oldCompletedAutosaveUpgrade:'passed',chapterReplay:'passed',discoveredRouteReplay:'passed',
  unexploredSpoilers:'hidden',permanentUnlock:'passed',oldManualSaveUnlock:'passed'},null,2));

// Keyboard holds consume repeat events and the release across a transition into a choice.
{
  const clock=new Clock(), {owner,element}=surfaces();
  let allowed=true, clicks=0;
  const hold=new DialogueHold(element,{canStart:()=>allowed,onChange(){},onClick:()=>clicks++,setTimer:clock.set,clearTimer:clock.clear});
  const space={key:' ',code:'Space',repeat:false};
  assert(emit(element,'keydown',space).defaultPrevented);clock.advance(299);
  assert(emit(element,'keyup',space).defaultPrevented);assert.equal(clicks,1);assert.equal(hold.active,false);
  emit(element,'keydown',space);clock.advance(200);
  assert(emit(element,'keydown',{...space,repeat:true}).defaultPrevented);clock.advance(100);assert(hold.active);
  const option=new NodeStub(owner,'button');allowed=false;hold.cancel();
  assert(emit(option,'keydown',{...space,repeat:true}).defaultPrevented);
  assert(emit(option,'keyup',space).defaultPrevented);assert.equal(clicks,1);
  assert.equal(emit(option,'keydown',space).defaultPrevented,false,'A new press could not activate a choice normally');
  allowed=true;
  for(const modifier of ['altKey','ctrlKey','metaKey','shiftKey']) {
    assert.equal(emit(element,'keydown',{...space,[modifier]:true}).defaultPrevented,false);
    clock.advance(500);assert.equal(hold.active,false);
  }
  emit(element,'keydown',space);clock.advance(300);assert(hold.active);
  emit(owner.defaultView,'blur');assert.equal(hold.active,false);
  assert(emit(element,'keydown',{...space,repeat:true}).defaultPrevented);
  emit(element,'keydown',space);emit(element,'keyup',space);assert.equal(clicks,2,'A lost keyup blocked a new physical press');
}

// App fast-read suppresses page announcements, then exposes the latest page or the reached question once.
{
  const ui=await application(), space={key:' ',code:'Space',repeat:false};
  emit(ui.nodes.get('start-button'),'click');
  const next=ui.nodes.get('next-button'), region=ui.nodes.get('announcement');
  const initial=ui.read('engine.state.current.eventIndex');
  emit(next,'keydown',space);emit(next,'keyup',space);
  assert.equal(ui.read('engine.state.current.eventIndex'),initial,'A short Space skipped the unfinished page');
  emit(next,'keydown',space);emit(next,'keyup',space);
  assert.notEqual(ui.read('engine.state.current.eventIndex'),initial);
  emit(next,'keydown',space);ui.clock.advance(300);
  assert.equal(ui.read('playbackRate()'),5);assert.equal(region.getAttribute('aria-live'),'off');assert.equal(region.textContent,'');
  ui.clock.advance(250);assert.equal(region.textContent,'');
  emit(next,'keyup',space);
  assert.equal(region.getAttribute('aria-live'),'polite');assert.equal(region.textContent,ui.read('pendingAnnouncement'));
  assert(region.textContent.length>0);
  const released=ui.read('engine.state.current.eventIndex');ui.clock.advance(10000);
  assert.equal(ui.read('engine.state.current.eventIndex'),released);

  emit(next,'keydown',space);ui.clock.advance(300);ui.clock.advance(30000);
  assert.equal(ui.read('engine.state.current.kind'),'choice');assert.equal(ui.read('dialogueHold.active'),false);
  assert.equal(region.getAttribute('aria-live'),'polite');assert(region.textContent.includes(ui.nodes.get('choice-heading').textContent));
  assert(region.textContent.includes('1：'));assert(region.textContent.includes('2：'));
  const choice=ui.nodes.get('choices').children[0];
  assert(emit(choice,'keydown',{...space,repeat:true}).defaultPrevented);
  assert(emit(choice,'keyup',space).defaultPrevented);assert.equal(ui.read('engine.state.current.kind'),'choice');
  assert.equal(emit(choice,'keydown',space).defaultPrevented,false);
  assert.equal(ui.nodes.get('scene-choices').getAttribute('aria-modal'),null);
  assert.equal(ui.nodes.get('choices').parent.getAttribute('role'),null,'An untrapped choice area still claims to be a modal dialog');
  assert.deepEqual(ui.logs,[]);
}

// Full engine snapshots happen at the throttle boundary and checkpoints, never at each ordinary render.
{
  const ui=await application();ui.read('start()');
  ui.read('globalThis.snapshotCalls=0;const originalSnapshot=engine.snapshot.bind(engine);engine.snapshot=()=>{snapshotCalls++;return originalSnapshot();};');
  const autoWrites=()=>ui.writes.filter(write=>write.key==='lianpo-story-v2:auto').length;
  const baseline=autoWrites();
  for(let index=0;index<8;index++)ui.read('render(engine.advance(),{animate:false})');
  assert.equal(ui.read('snapshotCalls'),0);assert.equal(autoWrites(),baseline);
  ui.clock.advance(1999);assert.equal(ui.read('snapshotCalls'),0);
  ui.clock.advance(1);assert.equal(ui.read('snapshotCalls'),1);assert.equal(autoWrites(),baseline+1);
  assert.equal(ui.read('saves.read().auto.snapshot.state.current.eventIndex'),ui.read('engine.state.current.eventIndex'));
  ui.read('render(engine.advance(),{animate:false})');ui.document.hidden=true;emit(ui.document,'visibilitychange');
  assert.equal(autoWrites(),baseline+2);assert.equal(ui.read('autosave.dirty'),false);
  emit(ui.document.defaultView,'pagehide');assert.equal(autoWrites(),baseline+2,'An idle tab overwrote the shared autosave');
  ui.document.hidden=false;emit(ui.document,'visibilitychange');
  ui.read('render(engine.advance(),{animate:false})');emit(ui.document.defaultView,'pagehide');
  assert.equal(autoWrites(),baseline+3);assert.equal(ui.read('autosave.dirty'),false);
  ui.clock.advance(2000);assert.equal(autoWrites(),baseline+3,'A flushed timer wrote the page again');
  const first=new GameEngine(story);first.start();while(first.state.current.kind==='text')first.advance();
  ui.context.firstChoice=first.snapshot();ui.read('render(engine.restore(firstChoice),{animate:false})');
  assert.equal(autoWrites(),baseline+4,'A question was not saved immediately');
  ui.read('choose(0)');assert.equal(autoWrites(),baseline+5,'An answer was not saved immediately');
  assert.deepEqual(ui.logs,[]);
}

// Two live apps see remote saves and settings without restoring another tab's running story.
{
  const memory=new Map(), a=await application(false,true,null,memory), b=await application(false,true,null,memory);
  a.read('start();render(engine.advance(),{animate:false});saveSlot(0);closeDialog()');
  const running=a.read('engine.state.current.eventIndex');
  b.read('start()');emit(b.nodes.get('music-button'),'click');
  emit(a.document.defaultView,'storage',{key:'lianpo-story-v2:muted'});
  assert.equal(a.read('engine.state.current.eventIndex'),running);assert.equal(a.read('saved.settings.muted'),true);
  assert.equal(a.nodes.get('music-button').textContent,'音樂：關');assert(a.read('saved.slots[0]')!==null);
  a.read("showSlots('load')");
  const oldLoadAction=a.nodes.get('dialog-body').children[2].querySelector('button');oldLoadAction.focus();
  b.read('saveSlot(1)');emit(a.document.defaultView,'storage',{key:'lianpo-story-v2:slot:1'});
  assert.equal(a.read('saved.slots.filter(Boolean).length'),2);
  assert.equal(a.document.activeElement.dataset.slot,'0','Refreshing slots lost the active slot button');
  const currentLoad=a.document.activeElement;
  b.read('saveSlot(0)');emit(currentLoad,'click');
  assert.equal(a.read('engine.state.current.eventIndex'),b.read('engine.state.current.eventIndex'),'The load button used a stale captured snapshot');
  const beforeCompletion=a.read('engine.state.current.eventIndex');
  b.context.complete=routeEndings.find(snapshot=>snapshot.state.current.completed);
  b.read('closeDialog();render(engine.restore(complete),{animate:false})');
  const completionKey=b.writes.find(write=>write.key.endsWith(':completed')).key;
  emit(a.document.defaultView,'storage',{key:completionKey});
  assert.equal(a.read('replay.unlocked'),true);assert.equal(a.nodes.get('replay-menu').hidden,false);
  assert.equal(a.read('engine.state.current.eventIndex'),beforeCompletion,'A remote completion jumped the running scene');
  a.read('render(engine.advance(),{animate:false});autosave.flush()');
  assert.equal(b.read('saves.read().progress.completed'),true);
  const lastAuto=memory.get('lianpo-story-v2:auto');
  b.document.hidden=true;emit(b.document,'visibilitychange');assert.equal(memory.get('lianpo-story-v2:auto'),lastAuto);
  assert.deepEqual(a.logs,[]);assert.deepEqual(b.logs,[]);
}

// Fourth and later choices use their real count; keyboard digits and the agent schema agree.
{
  const expanded=structuredClone(story), map=expanded.maps.find(map=>map.events.some(event=>event.choices?.length===3));
  const eventIndex=map.events.findIndex(event=>event.choices?.length===3), event=map.events[eventIndex];
  event.choices.push({...event.choices[0],text:'第四項測試選項'});
  const ui=await application(false,true,null,new Map(),expanded);
  const initial=new GameEngine(expanded);initial.start();
  const checkpoint=initial.snapshot();checkpoint.state.mapId=map.id;checkpoint.state.pc=eventIndex+1;
  checkpoint.state.current={kind:'choice',eventIndex,choices:event.choices,prompt:event.prompt};
  checkpoint.state.ended=false;ui.context.fourOptions=checkpoint;
  ui.read('render(engine.restore(fourOptions),{animate:false})');
  assert.equal(ui.nodes.get('choices').children.length,4);assert(ui.nodes.get('instruction').textContent.includes('1、2、3、4'));
  assert.equal(ui.registeredTools.get('choose_story_option').inputSchema.properties.option.maximum,4);
  emit(ui.nodes.get('game-frame'),'keydown',{key:'4',code:'Digit4'});
  assert.equal(ui.read('engine.state.decisions.at(-1).index'),3);assert.deepEqual(ui.logs,[]);
}
console.log(JSON.stringify({keyboardTapAndHold:'passed',repeatCannotAnswerChoice:'passed',lostKeyupRecovery:'passed',
  fastReadAnnouncements:'suppressed until release or checkpoint',autosaveSnapshots:'throttled',
  hideAndPagehideFlush:'passed',twoLiveApps:'passed',freshSlotLoad:'passed',fourthChoiceShortcutAndSchema:'passed'},null,2));
