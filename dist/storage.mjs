export const STORAGE_KEY = 'lianpo-story-v1';

export class LocalSaves {
  constructor(storage) { this.storage = storage; this.error = null; }
  read() {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return {auto:null,slots:[null,null,null],settings:{muted:false},progress:null};
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || !Array.isArray(value.slots)) throw new Error('存檔資料損壞');
      const normalize = item => {
        if (!item) return null;
        if (typeof item !== 'object' || typeof item.chapter !== 'string' || typeof item.preview !== 'string' ||
            !Number.isFinite(Date.parse(item.time)) || item.snapshot?.schema !== 1 || !item.snapshot?.state) {
          this.error = new Error('部分存檔資料損壞');return null;
        }
        return item;
      };
      return {auto:normalize(value.auto),slots:value.slots.slice(0,3).map(normalize),settings:{muted:value.settings?.muted === true},progress:value.progress || null};
    } catch (error) {
      this.error = error;
      return {auto:null,slots:[null,null,null],settings:{muted:false},progress:null};
    }
  }
  write(value) {
    try { this.storage.setItem(STORAGE_KEY,JSON.stringify(value)); this.error = null; return true; }
    catch (error) { this.error = error; return false; }
  }
}
