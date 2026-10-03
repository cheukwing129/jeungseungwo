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
      if (Math.hypot(event.clientX - this.pointer.x, event.clientY - this.pointer.y) > 12) this.cancel();
    });
    element.addEventListener('click', event => {
      if (this.blockClick) {
        this.blockClick = false;
        event.preventDefault();
        return;
      }
      if (!event.target.closest('button,a,input,select,textarea') && this.canStart()) this.onClick();
    });
    element.addEventListener('contextmenu', event => {
      if (this.pointer || this.canStart()) event.preventDefault();
    });
    const owner = element.ownerDocument;
    // Also observe release outside the element when pointer capture is unavailable.
    owner.addEventListener('pointerup', event => {
      if (event.pointerId === this.pointer?.id) this.cancel(this.active);
    });
    owner.addEventListener('pointercancel', event => {
      if (event.pointerId === this.pointer?.id) this.cancel();
    });
    owner.addEventListener('visibilitychange', () => { if (owner.hidden) this.cancel(); });
    for (const name of ['blur', 'pagehide']) owner.defaultView.addEventListener(name, () => this.cancel());
  }

  begin(event) {
    if (this.pointer || event.isPrimary === false || event.button !== 0 ||
        event.target.closest('button,a,input,select,textarea') || !this.canStart()) return;
    this.blockClick = false;
    this.pointer = {id:event.pointerId, x:event.clientX, y:event.clientY};
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
