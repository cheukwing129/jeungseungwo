export const STORAGE_KEY = 'lianpo-story-v1';
export const STORAGE_PREFIX = 'lianpo-story-v2:';

const empty = () => ({auto:null,slots:[null,null,null],settings:{muted:false},progress:null});

export class LocalSaves {
  constructor(storage,{sourceHash = '',endingIds = []} = {}) {
    this.storage = storage;
    this.sourceHash = sourceHash;
    this.endingIds = new Set(endingIds);
    this.error = null;
  }

  normalize(item) {
    if (!item) return null;
    if (typeof item !== 'object' || typeof item.chapter !== 'string' || typeof item.preview !== 'string' ||
        !Number.isFinite(Date.parse(item.time)) || item.snapshot?.schema !== 1 || !item.snapshot?.state) {
      this.error = new Error('部分存檔資料損壞');
      return null;
    }
    return item;
  }

  legacy() {
    const raw = this.storage.getItem(STORAGE_KEY);
    if (!raw) return empty();
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || !Array.isArray(value.slots)) throw new Error('存檔資料損壞');
      return value;
    } catch (error) {this.error = error;return empty();}
  }

  value(key,fallback) {
    const raw = this.storage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    try {return JSON.parse(raw);}
    catch (error) {this.error = error;return null;}
  }

  progressKey(name) {return `${STORAGE_PREFIX}progress:${this.sourceHash}:${name}`;}

  read() {
    this.error = null;
    try {
      // Old data remains a read-only fallback. No stale full-object migration can overwrite a new slot.
      const old = this.legacy();
      const compatible = old.progress?.sourceHash === this.sourceHash;
      const endings = new Set(compatible && Array.isArray(old.progress.endings) ?
        old.progress.endings.filter(id => this.endingIds.has(id)) : []);
      if (this.sourceHash) for (const id of this.endingIds) {
        if (this.storage.getItem(this.progressKey(`ending:${id}`)) === '1') endings.add(id);
      }
      return {
        auto:this.normalize(this.value('auto',old.auto)),
        slots:Array.from({length:3},(_,index) => this.normalize(this.value(`slot:${index}`,old.slots[index]))),
        settings:{muted:this.value('muted',old.settings?.muted) === true},
        progress:this.sourceHash ? {sourceHash:this.sourceHash,
          completed:(compatible && old.progress.completed === true) || this.storage.getItem(this.progressKey('completed')) === '1',
          endings:[...endings]} : old.progress || null,
      };
    } catch (error) {
      this.error = error;
      return empty();
    }
  }

  writeValue(key,value) {
    try {
      this.storage.setItem(STORAGE_PREFIX + key,JSON.stringify(value));
      this.error = null;return true;
    } catch (error) {this.error = error;return false;}
  }

  writeAuto(value) {return this.writeValue('auto',value);}
  writeSlot(index,value) {
    if (!Number.isInteger(index) || index < 0 || index > 2) {
      this.error = new Error('請選擇有效的存檔欄位。');return false;
    }
    return this.writeValue(`slot:${index}`,value);
  }
  writeMuted(value) {return this.writeValue('muted',value === true);}

  writeProgress(progress) {
    this.error = null;
    if (!this.sourceHash || progress?.sourceHash !== this.sourceHash) return true;
    try {
      // Each discovery only moves to true, at its own key. Concurrent discoveries cannot erase one another.
      const names = Array.isArray(progress.endings) ?
        progress.endings.filter(id => this.endingIds.has(id)).map(id => `ending:${id}`) : [];
      if (progress.completed === true) names.push('completed');
      for (const name of names) {
        const key = this.progressKey(name);
        if (this.storage.getItem(key) !== '1') this.storage.setItem(key,'1');
      }
      return true;
    } catch (error) {this.error = error;return false;}
  }

  relevantKey(key) {return key === null || key === STORAGE_KEY || key.startsWith(STORAGE_PREFIX);}
}
