import { ApiClient, DeviceType, uuid, type KeyValueStore, type LoginResult, type Tokens } from '@multicam/shared';

/** localStorage có thể ném lỗi (chế độ riêng tư, bị chặn) — luôn bọc try/catch. */
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // bỏ qua
  }
}

/**
 * Phiên đăng nhập, token và UUID thiết bị nằm trong sessionStorage (riêng từng tab):
 * mỗi tab là một "máy" độc lập — mở nhiều tab Remote/Controller trên cùng trình duyệt không giẫm token của nhau.
 */
function ssGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function ssSet(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // bỏ qua
  }
}

/** Dữ liệu cần sống qua việc đóng tab (phiên upload dở, lệnh đã chạy theo thiết bị). */
export const localKv: KeyValueStore = {
  get: async (k) => lsGet(`mc.${k}`),
  set: async (k, v) => lsSet(`mc.${k}`, v),
  remove: async (k) => lsSet(`mc.${k}`, null),
};

/** Dữ liệu riêng của tab (cache thư viện để xem lại khi mất mạng). */
export const tabKv: KeyValueStore = {
  get: async (k) => ssGet(`mc.${k}`),
  set: async (k, v) => ssSet(`mc.${k}`, v),
  remove: async (k) => ssSet(`mc.${k}`, null),
};

export function clearTabCache(prefix: string) {
  try {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith(`mc.${prefix}`))
      .forEach((k) => sessionStorage.removeItem(k));
  } catch {
    // bỏ qua
  }
}

export const tabStore = { get: ssGet, set: ssSet };

export interface Session {
  user: LoginResult['user'];
  role: LoginResult['account_role'];
  deviceId: string; // id do server cấp (dv_...)
  cameraName: string;
}

export function loadSession(): Session | null {
  try {
    return JSON.parse(ssGet('mc.session') || 'null');
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  ssSet('mc.session', s ? JSON.stringify(s) : null);
}

/** UUID thiết bị sinh ở client lần đầu chạy (mỗi tab là một thiết bị). */
export function deviceUid(): string {
  let id = ssGet('mc.device_uid');
  if (!id) {
    id = uuid();
    ssSet('mc.device_uid', id);
  }
  return id;
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Trình duyệt';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : 'Linux';
  return `${browser} trên ${os}`;
}

export const deviceInfo = () => ({ device_id: deviceUid(), device_type: DeviceType.WEB, device_name: deviceName() });

let sessionExpiredHandler: (() => void) | null = null;
export const onSessionExpired = (fn: () => void) => {
  sessionExpiredHandler = fn;
};

export const api = new ApiClient({
  baseUrl: () => window.location.origin,
  tokens: {
    get: async () => {
      try {
        return JSON.parse(ssGet('mc.tokens') || 'null') as Tokens | null;
      } catch {
        return null;
      }
    },
    set: async (t) => ssSet('mc.tokens', t ? JSON.stringify(t) : null),
  },
  onSessionExpired: () => sessionExpiredHandler?.(),
});
