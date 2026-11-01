import { Emitter, UploadManager } from '@multicam/shared';
import { api } from './api';
import { uploadPlatform } from './clips';

/**
 * UploadManager sống ở phạm vi module (không gắn vào màn hình nào) nên người dùng
 * chuyển màn hình thì upload vẫn chạy tiếp. Tác vụ nền của hệ điều hành cũng gọi kick().
 */
export const uploadManager = new UploadManager(api, uploadPlatform);

/** Báo cho màn Thư viện của Remote khi thư mục clip thay đổi (clip mới / vừa upload xong). */
const clipsEmitter = new Emitter<number>();
let clipsVersion = 0;
export const clipsStore = {
  subscribe: clipsEmitter.subscribe,
  getState: () => clipsVersion,
};
export function notifyClipsChanged() {
  clipsVersion++;
  clipsEmitter.emit(clipsVersion);
}

let lastActiveUid: string | null = null;
uploadManager.subscribe((s) => {
  const uid = s.active?.uid ?? null;
  if (uid !== lastActiveUid) {
    // Một clip vừa xong (hoặc bắt đầu) → làm mới danh sách clip cục bộ.
    lastActiveUid = uid;
    notifyClipsChanged();
  }
});

/** Chờ UploadManager rảnh (dùng trong tác vụ nền có giới hạn thời gian). */
export function waitForUploadsIdle(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    let idleTicks = 0;
    const tick = () => {
      const s = uploadManager.getState();
      idleTicks = s.active ? 0 : idleTicks + 1;
      if (idleTicks >= 3 || Date.now() - started > timeoutMs) return resolve();
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
  });
}
