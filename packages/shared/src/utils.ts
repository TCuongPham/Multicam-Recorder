/** UUID v4. Dùng crypto.randomUUID nếu có (trang HTTP trong LAN không có hàm này). */
export function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) {
    try {
      return c.randomUUID();
    } catch {
      // randomUUID chỉ có trong secure context
    }
  }
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** "Cam Trái" → "Cam-Trai" — an toàn để làm tên file. */
export function slugify(input: string): string {
  return (
    input
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'cam'
  );
}

/** ISO → "20260803T142530Z" (không có ":" để dùng được trong tên file). */
export function compactTimestamp(iso: string): string {
  return iso.replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
}

export function expandTimestamp(compact: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(compact);
  if (!m) return compact;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

export interface ClipNameParts {
  recordedAt: string; // ISO
  cameraName: string;
  sessionId: string | null;
  localVideoUid: string;
}

/** Tên file theo mẫu <recorded_at>__<camera_name>__<session_id>__<local_video_uid> (chưa có đuôi). */
export function buildClipBaseName(p: ClipNameParts): string {
  return [compactTimestamp(p.recordedAt), slugify(p.cameraName), p.sessionId || 'SOLO', p.localVideoUid].join('__');
}

export function parseClipBaseName(baseName: string): ClipNameParts | null {
  const parts = baseName.replace(/\.(mp4|jpg|uploaded)$/i, '').split('__');
  if (parts.length !== 4) return null;
  return {
    recordedAt: expandTimestamp(parts[0]),
    cameraName: parts[1],
    sessionId: parts[2] === 'SOLO' ? null : parts[2],
    localVideoUid: parts[3],
  };
}

export function formatBytes(bytes: number | string | null | undefined): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms: number | string | null | undefined): string {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Đoán ô nhập là email hay số điện thoại (màn Đăng nhập / Quên mật khẩu). */
export function splitAccount(account: string): { email?: string; phone?: string } {
  const v = account.trim();
  return /^\+?\d[\d\s]*$/.test(v) ? { phone: v.replace(/\s/g, '') } : { email: v };
}

/** Bộ phát sự kiện tối giản để các store ngoài React báo thay đổi (dùng với useSyncExternalStore). */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();
  subscribe = (fn: (value: T) => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  emit(value: T) {
    for (const fn of this.listeners) fn(value);
  }
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class MemoryKeyValueStore implements KeyValueStore {
  private map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
  async remove(key: string) {
    this.map.delete(key);
  }
}
