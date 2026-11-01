import { createSHA256, sha256 } from 'hash-wasm';
import { RemoteAgent, UploadManager, connectRealtime, type LocalClip, type UploadPlatform } from '@multicam/shared';
import { clipStore } from './clipStore';
import { api, localKv } from './platform';
import { WebRecorder } from './webRecorder';

const READ_BLOCK = 8 * 1024 * 1024;

/** Nền tảng upload của web: đọc clip từ IndexedDB, băm bằng hash-wasm, gửi Blob.slice(). */
const webUploadPlatform: UploadPlatform = {
  kv: localKv,
  async listPendingClips(): Promise<LocalClip[]> {
    const clips = await clipStore.all();
    return clips
      .filter((c) => c.finalized && !c.uploaded && c.size > 0)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => ({ uid: c.uid, baseName: c.baseName, fileName: c.fileName, size: c.size, mimeType: c.mimeType, metadata: c.metadata, ref: c.uid }));
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

export interface RemoteRuntime {
  agent: RemoteAgent;
  uploads: UploadManager;
  recorder: WebRecorder;
  setCameraName: (name: string) => void;
  getCameraName: () => string;
}

let runtime: RemoteRuntime | null = null;
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

/** Khôi phục clip dở dang (tab bị đóng giữa lúc quay): MP4 fragmented vẫn phát được tới khối cuối. */
async function recoverUnfinishedClips() {
  for (const c of await clipStore.all()) {
    if (c.finalized) continue;
    const blob = await clipStore.blob(c.uid);
    if (blob.size === 0) await clipStore.remove(c.uid);
    else await clipStore.put({ ...c, finalized: true, size: blob.size, metadata: { ...c.metadata, duration_ms: c.metadata.duration_ms || Date.now() - c.createdAt } });
  }
}

export function getRemoteRuntime(): RemoteRuntime | null {
  return runtime;
}

/** Khởi động "máy Remote" của bản web sau khi đăng nhập bằng tài khoản Remote. */
export function startRemoteRuntime(deviceId: string, cameraName: string, onSessionRevoked: () => void): RemoteRuntime {
  if (runtime && runtime.agent.getState().deviceId === deviceId) return runtime;
  stopRemoteRuntime();

  let name = cameraName;
  try {
    name = localStorage.getItem('mc.camera_name') || cameraName;
  } catch {
    // localStorage bị chặn
  }
  let agentRef: RemoteAgent | null = null;
  let uploadsRef: UploadManager | null = null;
  const recorder = new WebRecorder({
    getDeviceId: () => deviceId,
    getCameraName: () => name,
    onSaved: (clip) => {
      agentRef?.reportRecording('saved', { localVideoUid: clip.uid });
      uploadsRef?.kick(); // tự động upload ngay khi ghi xong file
    },
  });
  const uploads = new UploadManager(api, webUploadPlatform);
  const agent = new RemoteAgent({
    api,
    kv: localKv,
    recorder,
    getUploadStatus: uploads.syncStatus,
    getDeviceStatus: async () => {
      const b = await batteryStatus();
      return { battery_level: b.level, is_charging: b.charging, storage_free: await storageFree(), camera_facing: recorder.getState().facing };
    },
    onSessionRevoked,
  });
  agentRef = agent;
  uploadsRef = uploads;

  const onVisibility = () => (document.hidden ? agent.pause() : (agent.resume(), uploads.kick()));
  const onOnline = () => {
    void agent.syncNow();
    uploads.kick();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  const disconnect = connectRealtime({
    baseUrl: window.location.origin,
    getToken: () => api.getAccessToken(),
    onCommand: (cmd) => agent.handlePushedCommand(cmd),
    onSessionRevoked,
  });

  void navigator.storage?.persist?.().catch(() => undefined);
  void agent.start(deviceId);
  void recoverUnfinishedClips().then(() => uploads.kick());

  teardown = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    disconnect();
    agent.stop();
    void recorder.stopRecording().finally(() => recorder.releaseStream());
  };

  runtime = {
    agent,
    uploads,
    recorder,
    setCameraName: (n) => {
      name = n;
      try {
        localStorage.setItem('mc.camera_name', n);
      } catch {
        // localStorage bị chặn
      }
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
