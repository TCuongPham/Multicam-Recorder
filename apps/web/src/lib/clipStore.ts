import type { UploadMetadata } from '@multicam/shared';

/**
 * "Thư mục clip" của bản web: IndexedDB lưu từng khối MediaRecorder dưới dạng Blob
 * (trình duyệt giữ Blob trên đĩa, không chiếm RAM). Cờ `uploaded` thay cho file rỗng `.uploaded`.
 */
export interface ClipRecord {
  uid: string;
  baseName: string;
  fileName: string;
  mimeType: string;
  size: number;
  parts: number;
  metadata: UploadMetadata;
  thumb: Blob | null;
  finalized: boolean;
  uploaded: boolean;
  videoId: string | null;
  createdAt: number;
}

const DB_NAME = 'multicam-clips';
let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('clips', { keyPath: 'uid' });
        d.createObjectStore('parts'); // key: [uid, seq]
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(stores, mode);
        const req = fn(t);
        t.oncomplete = () => resolve(req ? req.result : (undefined as T));
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const clipStore = {
  put(clip: ClipRecord) {
    return tx(['clips'], 'readwrite', (t) => t.objectStore('clips').put(clip));
  },
  get(uid: string) {
    return tx<ClipRecord | undefined>(['clips'], 'readonly', (t) => t.objectStore('clips').get(uid));
  },
  all() {
    return tx<ClipRecord[]>(['clips'], 'readonly', (t) => t.objectStore('clips').getAll());
  },
  addPart(uid: string, seq: number, blob: Blob) {
    return tx(['parts'], 'readwrite', (t) => t.objectStore('parts').put(blob, [uid, seq]));
  },
  /** Toàn bộ file dưới dạng một Blob ghép từ các khối (không nạp vào RAM). */
  async blob(uid: string, mimeType = 'video/mp4'): Promise<Blob> {
    const range = IDBKeyRange.bound([uid, 0], [uid, Number.MAX_SAFE_INTEGER]);
    const parts = await tx<Blob[]>(['parts'], 'readonly', (t) => t.objectStore('parts').getAll(range));
    return new Blob(parts, { type: mimeType });
  },
  async remove(uid: string) {
    const range = IDBKeyRange.bound([uid, 0], [uid, Number.MAX_SAFE_INTEGER]);
    await tx(['parts', 'clips'], 'readwrite', (t) => {
      t.objectStore('parts').delete(range);
      t.objectStore('clips').delete(uid);
    });
  },
};
