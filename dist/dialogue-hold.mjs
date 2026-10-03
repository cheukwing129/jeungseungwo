/** A short press clicks once; holding temporarily enables fast playback. */
export class DialogueHold {
  constructor(element, {
    canStart, onChange, onClick,
    holdDelay = 300,
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer),
  }) {
    this.element = element;
    this.canStart = canStart;
    this.onChange = onChange;
    this.onClick = onClick;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.holdDelay = holdDelay;
    this.pointer = null;
    this.active = false;
    this.blockClick = false;
    this.timer = 0;

    element.addEventListener('pointerdown', event => this.begin(event));
    element.addEventListener('pointerup', event => {
      if (event.pointerId === this.pointer?.id) this.cancel(this.active);
    });
    for (const name of ['pointercancel', 'lostpointercapture']) {
      element.addEventListener(name, event => {
        if (event.pointerId === this.pointer?.id) this.cancel();
      });
    }
    element.addEventListener('pointermove', event => {
      if (event.pointerId !== this.pointer?.id) return;
      if (this.pointer.type === 'mouse') {
        if (event.buttons !== undefined && !(event.buttons & 1)) this.cancel();
      } else if (Math.hypot(event.clientX - this.pointer.x, event.clientY - this.pointer.y) > 12) this.cancel();
    });
    element.addEventListener('click', event => {
      if (this.blockClick && event.detail !== 0) {
        this.blockClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (this.accepts(event.target) && this.canStart()) this.onClick();
    }, {capture:true});
    const owner = element.ownerDocument;
    // Avoid treating compatibility mouse events after a touch release as a new press.
    element.addEventListener('mousedown', event => {
      if (!owner.defaultView.PointerEvent && !this.pointer) this.begin({pointerId:-1, pointerType:'mouse', isPrimary:true,
        button:event.button, clientX:event.clientX, clientY:event.clientY, target:event.target});
    });
    element.addEventListener('contextmenu', event => {
      if (this.pointer || this.canStart()) event.preventDefault();
    });
    // Also observe release outside the element when pointer capture is unavailable.
    owner.addEventListener('pointerup', event => {
      if (event.pointerId === this.pointer?.id) this.cancel(this.active);
    });
    owner.addEventListener('pointercancel', event => {
      if (event.pointerId === this.pointer?.id) this.cancel();
    });
    owner.addEventListener('mouseup', event => {
      if (event.button === 0 && this.pointer?.type === 'mouse') this.cancel(this.active);
    });
    owner.addEventListener('mousemove', event => {
      if (this.pointer?.type === 'mouse' && event.buttons !== undefined && !(event.buttons & 1)) this.cancel();
    });
    owner.addEventListener('visibilitychange', () => { if (owner.hidden) this.cancel(); });
    for (const name of ['blur', 'pagehide']) owner.defaultView.addEventListener(name, () => this.cancel());
  }

  accepts(target) {
    return !target.closest('button,a,input,select,textarea') || Boolean(target.closest('[data-fast-read]'));
  }

  begin(event) {
    if (this.pointer || event.isPrimary === false || event.button !== 0) return;
    this.blockClick = false;
    if (!this.accepts(event.target) || !this.canStart()) return;
    this.pointer = {id:event.pointerId, type:event.pointerType || 'mouse', x:event.clientX, y:event.clientY};
    try { this.element.setPointerCapture(event.pointerId); } catch {}
    this.timer = this.setTimer(() => {
      this.timer = 0;
      if (!this.pointer || !this.canStart()) { this.cancel(); return; }
      this.active = true;
      this.onChange(true);
    }, this.holdDelay);
  }

  cancel(suppressClick = true) {
    this.clearTimer(this.timer);
    this.timer = 0;
    const pointer = this.pointer, wasActive = this.active;
    this.pointer = null;
    this.active = false;
    // Ignore the compatibility click generated when a long press is released.
    if (pointer) this.blockClick ||= suppressClick || wasActive;
    if (pointer) try { this.element.releasePointerCapture(pointer.id); } catch {}
    if (wasActive) this.onChange(false);
  }
}
