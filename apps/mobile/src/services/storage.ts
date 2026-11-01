import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { uuid, type KeyValueStore, type Tokens, type TokenStore } from '@multicam/shared';

/** KV dùng chung cho RemoteAgent, UploadManager và cache thư viện. */
export const kv: KeyValueStore = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
};

const TOKEN_KEY = 'multicam.tokens';

/**
 * Token lưu trong Keychain (iOS) / Keystore (Android) qua expo-secure-store.
 * Giữ bản sao trong bộ nhớ để mỗi request không phải đọc lại Keychain.
 */
let tokenCache: Tokens | null | undefined;
export const tokenStore: TokenStore = {
  async get() {
    if (tokenCache !== undefined) return tokenCache;
    try {
      const raw = await SecureStore.getItemAsync(TOKEN_KEY);
      tokenCache = raw ? (JSON.parse(raw) as Tokens) : null;
    } catch {
      tokenCache = null;
    }
    return tokenCache;
  },
  async set(tokens) {
    tokenCache = tokens;
    if (tokens) await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(tokens));
    else await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined);
  },
};

// ---------- Cài đặt cục bộ ----------
const SERVER_URL_KEY = 'settings.server_url';
const DEVICE_UUID_KEY = 'settings.device_uuid';
const CAMERA_NAME_KEY = 'settings.camera_name';

export const DEFAULT_SERVER_URL = 'http://192.168.1.2:3000';

let serverUrl = DEFAULT_SERVER_URL;
let deviceUuid: string | null = null;

/** Gọi một lần lúc khởi động (kể cả trong tác vụ nền) để nạp cài đặt vào bộ nhớ. */
export async function loadSettings(): Promise<void> {
  const [url, dev] = await Promise.all([kv.get(SERVER_URL_KEY), kv.get(DEVICE_UUID_KEY)]);
  if (url) serverUrl = url;
  if (dev) deviceUuid = dev;
  else {
    deviceUuid = uuid();
    await kv.set(DEVICE_UUID_KEY, deviceUuid);
  }
}

export function getServerUrl(): string {
  return serverUrl;
}

export async function setServerUrl(url: string): Promise<void> {
  serverUrl = normalizeServerUrl(url);
  await kv.set(SERVER_URL_KEY, serverUrl);
}

export function normalizeServerUrl(url: string): string {
  let v = url.trim().replace(/\/+$/, '');
  if (v && !/^https?:\/\//i.test(v)) v = `http://${v}`;
  return v;
}

/** UUID sinh ở client lần đầu chạy, gửi lên làm device_id khi đăng nhập. */
export function getDeviceUuid(): string {
  if (!deviceUuid) throw new Error('loadSettings() chưa được gọi');
  return deviceUuid;
}

export async function getCameraName(): Promise<string | null> {
  return kv.get(CAMERA_NAME_KEY);
}

export async function setCameraName(name: string): Promise<void> {
  await kv.set(CAMERA_NAME_KEY, name.trim());
}
