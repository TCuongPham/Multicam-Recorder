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

export const localKv: KeyValueStore = {
  get: async (k) => lsGet(`mc.${k}`),
  set: async (k, v) => lsSet(`mc.${k}`, v),
  remove: async (k) => lsSet(`mc.${k}`, null),
};

export interface Session {
  user: LoginResult['user'];
  role: LoginResult['account_role'];
  deviceId: string; // id do server cấp (dv_...)
  cameraName: string;
}

export function loadSession(): Session | null {
  try {
    return JSON.parse(lsGet('mc.session') || 'null');
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  lsSet('mc.session', s ? JSON.stringify(s) : null);
}

/** UUID thiết bị sinh ở client lần đầu chạy. */
export function deviceUid(): string {
  let id = lsGet('mc.device_uid');
  if (!id) {
    id = uuid();
    lsSet('mc.device_uid', id);
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
        return JSON.parse(lsGet('mc.tokens') || 'null') as Tokens | null;
      } catch {
        return null;
      }
    },
    set: async (t) => lsSet('mc.tokens', t ? JSON.stringify(t) : null),
  },
  onSessionExpired: () => sessionExpiredHandler?.(),
});
