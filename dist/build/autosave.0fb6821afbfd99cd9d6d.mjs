/** Keep the latest running state in memory and snapshot it only at a bounded interval or a checkpoint. */
export class AutosaveScheduler {
  constructor(save,{
    interval = 2000,
    // Native browser timers must receive Window, never the scheduler instance.
    setTimer = (callback,delay) => globalThis.setTimeout(callback,delay),
    clearTimer = timer => globalThis.clearTimeout(timer),
  } = {}) {
    this.save = save;
    this.interval = interval;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = 0;
    this.dirty = false;
  }

  mark({immediate = false} = {}) {
    this.dirty = true;
    if (immediate) this.flush();
    else if (!this.timer) this.timer = this.setTimer(() => this.flush(),this.interval);
  }

  flush() {
    this.clearTimer(this.timer);
    this.timer = 0;
    if (!this.dirty) return;
    this.dirty = false;
    if (this.save() === false) this.dirty = true;
  }
}
