import { AppState, type AppStateStatus } from 'react-native';
import { Emitter, connectRealtime } from '@multicam/shared';
import { api } from './api';
import { registerBackgroundUpload, unregisterBackgroundUpload } from './background';
import { remoteAgent } from './remote';
import { session, type SessionState } from './session';
import { uploadManager } from './upload';

/** Controller: server báo phòng vừa đổi (qua socket) → màn Phòng làm mới ngay. */
export const roomChanged = new Emitter<{ room_id: string; revision: number }>();

let disconnectRealtime: (() => void) | null = null;
let activeKey: string | null = null;

function stopAll() {
  remoteAgent.stop();
  selfLeftAt = Date.now();
  remoteAgent.markLeftRoom(); // không giữ trạng thái phòng của phiên cũ
  disconnectRealtime?.();
  disconnectRealtime = null;
}

function applySession(s: SessionState) {
  const key = s.status === 'signedIn' && s.info ? `${s.info.role}:${s.info.deviceId}` : null;
  if (key === activeKey) return;
  activeKey = key;
  stopAll();
  if (!key || !s.info) {
    void unregisterBackgroundUpload();
    return;
  }

  const info = s.info;
  if (info.role === 'remote') {
    if (info.deviceId) void remoteAgent.start(info.deviceId);
    disconnectRealtime = connectRealtime({
      baseUrl: api.baseUrl,
      getToken: () => api.getAccessToken(),
      onCommand: (cmd) => remoteAgent.handlePushedCommand(cmd),
      onSessionRevoked: () => void session.clear('Phiên đăng nhập đã bị thu hồi, vui lòng đăng nhập lại'),
    });
    uploadManager.kick({ force: true });
    void registerBackgroundUpload();
  } else {
    disconnectRealtime = connectRealtime({
      baseUrl: api.baseUrl,
      getToken: () => api.getAccessToken(),
      onRoomChanged: (p) => roomChanged.emit(p),
      onSessionRevoked: () => void session.clear('Phiên đăng nhập đã bị thu hồi, vui lòng đăng nhập lại'),
    });
  }
}

let started = false;
/** Gắn vòng đời phiên + AppState. Gọi một lần ở App. */
export function startRuntime() {
  if (started) return;
  started = true;
  session.subscribe(applySession);
  applySession(session.getState());

  let last: AppStateStatus = AppState.currentState;
  AppState.addEventListener('change', (next) => {
    const info = session.getState().info;
    if (next === 'active' && last !== 'active') {
      if (info?.role === 'remote') {
        remoteAgent.resume();
        uploadManager.kick();
      }
    } else if (next === 'background') {
      // Bộ đếm nhịp sync tạm dừng khi ứng dụng vào nền.
      remoteAgent.pause();
    }
    last = next;
  });
}

let selfLeftAt = 0;
/** Máy vừa tự rời phòng (để màn Quay không báo nhầm là bị loại). */
export function leftByUserRecently(): boolean {
  return Date.now() - selfLeftAt < 5000;
}

/** Rời phòng hiện tại (nếu có). Dừng quay trước nếu đang quay. */
export async function leaveCurrentRoom(): Promise<void> {
  selfLeftAt = Date.now();
  const st = remoteAgent.getState();
  const deviceId = session.getState().info?.deviceId;
  if (st.recordingState === 'recording') await remoteAgent.stopRecording();
  if (st.inRoom && st.roomId && deviceId) {
    try {
      await api.leaveRoom(st.roomId, deviceId);
    } finally {
      selfLeftAt = Date.now();
      remoteAgent.markLeftRoom();
    }
  }
}

/** Đăng xuất: nếu đang ở trong phòng thì leave_room trước, sau đó logout và xóa token. */
export async function signOut(): Promise<void> {
  const info = session.getState().info;
  try {
    if (info?.role === 'remote') await leaveCurrentRoom().catch(() => undefined);
    await api.logout(info?.deviceId ?? undefined);
  } catch {
    // Mất mạng vẫn xóa phiên cục bộ.
  } finally {
    await session.clear(null);
  }
}

/** Xóa tài khoản vĩnh viễn (chỉ Remote). Rời phòng trước. */
export async function deleteAccount(password: string): Promise<void> {
  await leaveCurrentRoom().catch(() => undefined);
  await api.deleteAccount(password);
  await session.clear('Tài khoản đã được xóa vĩnh viễn');
}
