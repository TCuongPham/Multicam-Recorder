import { createSHA256, sha256 } from 'hash-wasm';
import { RemoteAgent, UploadManager, connectRealtime, type LocalClip, type UploadPlatform } from '@multicam/shared';
import { clipStore } from './clipStore';
import { api, localKv, tabStore } from './platform';
import { WebRecorder } from './webRecorder';

const READ_BLOCK = 8 * 1024 * 1024;

/** Nền tảng upload của web: đọc clip từ IndexedDB, băm bằng hash-wasm, gửi Blob.slice(). */
function webUploadPlatform(userId: string): UploadPlatform {
  return {
    kv: localKv,
    async listPendingClips(): Promise<LocalClip[]> {
      const clips = await clipStore.all();
      return (
        clips
          // Chỉ clip của tài khoản đang đăng nhập (các tab khác có thể đang đăng nhập tài khoản khác).
          .filter((c) => c.finalized && !c.uploaded && c.size > 0 && (c.userId ?? userId) === userId)
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((c) => ({ uid: c.uid, baseName: c.baseName, fileName: c.fileName, size: c.size, mimeType: c.mimeType, metadata: c.metadata, ref: c.uid }))
      );
    },
    async hashFile(clip, onProgress) {
      const blob = await clipStore.blob(clip.uid);
      const hasher = await createSHA256();
      hasher.init();
      for (let pos = 0; pos < blob.size; pos += READ_BLOCK) {
        hasher.update(new Uint8Array(await blob.slice(pos, pos + READ_BLOCK).arrayBuffer()));
        onProgress?.(Math.min(1, (pos + READ_BLOCK) / blob.size));
      }
      return hasher.digest('hex');
    },
    async sendChunk(client, uploadId, clip, index, chunkSize) {
      const blob = await clipStore.blob(clip.uid);
      const slice = blob.slice(index * chunkSize, (index + 1) * chunkSize);
      const checksum = await sha256(new Uint8Array(await slice.arrayBuffer()));
      return client.uploadChunk(uploadId, index, slice, checksum);
    },
    async markUploaded(clip, videoId) {
      const rec = await clipStore.get(clip.uid);
      if (rec) await clipStore.put({ ...rec, uploaded: true, videoId });
    },
  };
}

export interface RemoteRuntime {
  agent: RemoteAgent;
  uploads: UploadManager;
  recorder: WebRecorder;
  setCameraName: (name: string) => void;
  getCameraName: () => string;
}

let runtime: (RemoteRuntime & { deviceId: string }) | null = null;
let teardown: (() => void) | null = null;

async function batteryStatus(): Promise<{ level: number | null; charging: 0 | 1 }> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> };
  try {
    const b = await nav.getBattery?.();
    if (b) return { level: Math.round(b.level * 100), charging: b.charging ? 1 : 0 };
  } catch {
    // Battery API chỉ có trên Chromium
  }
  return { level: null, charging: 0 };
}

export async function storageFree(): Promise<number | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota !== undefined) return Math.max(0, est.quota - (est.usage ?? 0));
  } catch {
    // không hỗ trợ
  }
  return null;
}

/**
 * Khôi phục clip dở dang (tab bị đóng giữa lúc quay): MP4 fragmented vẫn phát được tới khối cuối.
 * Chỉ khôi phục clip của tài khoản này và không đụng clip đang được tab khác ghi.
 */
async function recoverUnfinishedClips(userId: string) {
  for (const c of await clipStore.all()) {
    if (c.finalized || (c.userId ?? userId) !== userId) continue;
    const parts = await clipStore.partCount(c.uid);
    // Tab khác vẫn đang ghi clip này nếu số khối còn tăng.
    await new Promise((r) => setTimeout(r, 2500));
    if ((await clipStore.partCount(c.uid)) !== parts) continue;
    const blob = await clipStore.blob(c.uid);
    if (blob.size === 0) await clipStore.remove(c.uid);
    else await clipStore.put({ ...c, finalized: true, size: blob.size, parts, metadata: { ...c.metadata, duration_ms: parts * 1000 } });
  }
}

/**
 * Bộ hẹn giờ chạy trong Web Worker: trình duyệt bóp setTimeout của tab nền xuống 1 lần/phút,
 * còn worker thì không — nhờ vậy máy Remote vẫn sync đều khi người dùng chuyển tab/cửa sổ.
 */
function startWorkerTicker(onTick: () => void, intervalMs: number): () => void {
  try {
    const src = `setInterval(() => postMessage(0), ${intervalMs});`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = onTick;
    return () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const id = setInterval(onTick, intervalMs);
    return () => clearInterval(id);
  }
}

/** Mỗi tài khoản chỉ một tab được upload (tránh hai tab cùng gửi một clip). */
function acquireUploadLock(userId: string, onAcquired: () => void): () => void {
  let release: () => void = () => undefined;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) {
    onAcquired();
    return () => undefined;
  }
  void locks.request(`multicam-uploader-${userId}`, () => {
    onAcquired();
    return new Promise<void>((resolve) => (release = resolve));
  });
  return () => release();
}

export function getRemoteRuntime(): RemoteRuntime | null {
  return runtime;
}

/** Khởi động "máy Remote" của bản web sau khi đăng nhập bằng tài khoản Remote. */
export function startRemoteRuntime(opts: { deviceId: string; userId: string; cameraName: string; onSessionRevoked: () => void }): RemoteRuntime {
  if (runtime && runtime.deviceId === opts.deviceId) return runtime;
  stopRemoteRuntime();
  const { deviceId, userId } = opts;

  let name = tabStore.get('mc.camera_name') || opts.cameraName;
  let agentRef: RemoteAgent | null = null;
  let canUpload = false;
  const uploads = new UploadManager(api, webUploadPlatform(userId));
  const kickUploads = () => canUpload && uploads.kick();
  const recorder = new WebRecorder({
    getDeviceId: () => deviceId,
    getUserId: () => userId,
    getCameraName: () => name,
    onSaved: (clip) => {
      agentRef?.reportRecording('saved', { localVideoUid: clip.uid });
      kickUploads(); // tự động upload ngay khi ghi xong file
    },
  });
  const agent = new RemoteAgent({
    api,
    kv: localKv,
    recorder,
    getUploadStatus: uploads.syncStatus,
    getDeviceStatus: async () => {
      const b = await batteryStatus();
      return { battery_level: b.level, is_charging: b.charging, storage_free: await storageFree(), camera_facing: recorder.getState().facing };
    },
    onSessionRevoked: opts.onSessionRevoked,
    onStatusReset: () => uploads.resetResult(),
  });
  agentRef = agent;

  // Trên web KHÔNG tạm dừng khi tab ẩn (khác app di động): người dùng chuyển tab/cửa sổ
  // thì máy vẫn phải nhận lệnh và báo trạng thái, nếu không Controller sẽ thấy "mất kết nối".
  const stopTicker = startWorkerTicker(() => {
    const s = agent.getState();
    if (s.running && (!s.lastSyncAt || Date.now() - s.lastSyncAt > s.nextSyncIn * 1000 + 1500)) void agent.syncNow();
  }, 1000);
  const onVisible = () => {
    if (!document.hidden) {
      void agent.syncNow();
      kickUploads();
    }
  };
  const onOnline = () => {
    void agent.syncNow();
    kickUploads();
  };
  // Đóng tab khi đang quay: hỏi lại; nếu vẫn đóng thì các khối đã ghi được khôi phục và upload ở lần mở sau.
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (agent.getState().recordingState === 'recording') {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  window.addEventListener('beforeunload', onBeforeUnload);

  const conn = connectRealtime({
    baseUrl: window.location.origin,
    getToken: () => api.getAccessToken(),
    onCommand: (cmd) => agent.handlePushedCommand(cmd),
    onSessionRevoked: opts.onSessionRevoked,
  });

  // Xem trước cho Controller: ~1 khung/giây khi đang ở trong phòng và camera đang mở.
  const stopPreview = startWorkerTicker(() => {
    if (!agent.getState().inRoom || !conn.isConnected()) return;
    const frame = recorder.snapshot();
    if (frame) conn.sendPreview(frame);
  }, 1000);

  const releaseLock = acquireUploadLock(userId, () => {
    canUpload = true;
    void recoverUnfinishedClips(userId).then(kickUploads);
  });

  void navigator.storage?.persist?.().catch(() => undefined);
  void agent.start(deviceId);

  teardown = () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('beforeunload', onBeforeUnload);
    stopTicker();
    stopPreview();
    releaseLock();
    conn();
    agent.stop();
    void recorder.stopRecording().finally(() => recorder.releaseStream());
  };

  runtime = {
    deviceId,
    agent,
    uploads,
    recorder,
    setCameraName: (n) => {
      name = n;
      tabStore.set('mc.camera_name', n);
    },
    getCameraName: () => name,
  };
  return runtime;
}

export function stopRemoteRuntime() {
  teardown?.();
  teardown = null;
  runtime = null;
}
