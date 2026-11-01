import AsyncStorage from '@react-native-async-storage/async-storage';
import { Emitter, type AccountRole, type UserInfo } from '@multicam/shared';
import { onSessionExpired } from './api';
import { kv, loadSettings, tokenStore } from './storage';

export interface SessionInfo {
  role: AccountRole;
  user: UserInfo | null;
  /** device_id do server cấp (dv_xxx) — dùng cho sync/join/upload. */
  deviceId: string | null;
  cameraName: string | null;
}

export interface SessionState {
  status: 'loading' | 'signedOut' | 'signedIn';
  info: SessionInfo | null;
  /** Thông báo hiện ở màn Đăng nhập (vd. "Đặt lại mật khẩu thành công"). */
  notice: string | null;
}

const INFO_KEY = 'session.info';

/** Cache thư viện (offline) thuộc về tài khoản cũ → xóa khi đăng xuất. */
async function clearLibraryCache() {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith('videos.cache.'));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  } catch {
    // bỏ qua
  }
}

class SessionStore {
  private state: SessionState = { status: 'loading', info: null, notice: null };
  private readonly emitter = new Emitter<SessionState>();
  subscribe = this.emitter.subscribe;
  getState = (): SessionState => this.state;

  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    this.emitter.emit(this.state);
  }

  /** Khởi động: nạp cài đặt, khôi phục phiên nếu còn token. */
  async restore(): Promise<void> {
    await loadSettings();
    const tokens = await tokenStore.get();
    let info: SessionInfo | null = null;
    try {
      info = JSON.parse((await kv.get(INFO_KEY)) || 'null');
    } catch {
      info = null;
    }
    if (tokens && info) this.set({ status: 'signedIn', info });
    else this.set({ status: 'signedOut', info: null });
  }

  async signIn(info: SessionInfo): Promise<void> {
    await kv.set(INFO_KEY, JSON.stringify(info));
    this.set({ status: 'signedIn', info, notice: null });
  }

  async updateInfo(patch: Partial<SessionInfo>): Promise<void> {
    if (!this.state.info) return;
    const info = { ...this.state.info, ...patch };
    await kv.set(INFO_KEY, JSON.stringify(info));
    this.set({ info });
  }

  /** Xóa phiên cục bộ (token + thông tin) và về màn Đăng nhập. */
  async clear(notice: string | null = null): Promise<void> {
    await tokenStore.set(null);
    await kv.remove(INFO_KEY);
    await clearLibraryCache();
    this.set({ status: 'signedOut', info: null, notice });
  }

  setNotice(notice: string | null) {
    this.set({ notice });
  }
}

export const session = new SessionStore();

onSessionExpired(() => {
  if (session.getState().status === 'signedIn') void session.clear('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại');
});
