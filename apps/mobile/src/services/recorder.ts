import * as Device from 'expo-device';
import { Camera, type CameraCaptureError, type VideoFile } from 'react-native-vision-camera';
import {
  Emitter,
  MIN_FREE_STORAGE,
  sleep,
  uuid,
  type CameraFacing,
  type RecorderAdapter,
  type RecordingState,
  type StartRecordingOptions,
} from '@multicam/shared';
import { getFreeStorage, saveRecordedClip } from './clips';
import { session } from './session';
import { getCameraName } from './storage';
import { notifyClipsChanged, uploadManager } from './upload';

export interface CaptureConfig {
  resolution: string; // "1920x1080"
  fps: number;
}

export interface CameraBridgeState {
  facing: CameraFacing;
  config: CaptureConfig;
  /** Camera đã gắn vào màn hình và khởi tạo xong. */
  ready: boolean;
  recording: boolean;
  /** Lệnh lật camera tới khi đang quay: áp dụng sau khi dừng quay. */
  pendingFlip: boolean;
  lastError: string | null;
}

type Reporter = (state: RecordingState, extra?: { localVideoUid?: string; errorCode?: string }) => void;

interface ActiveRecording {
  opts: StartRecordingOptions;
  localVideoUid: string;
  startedAt: number;
}

export class LowStorageError extends Error {
  constructor() {
    super('LOW_STORAGE');
  }
}

export async function hasEnoughStorage(): Promise<boolean> {
  const free = await getFreeStorage();
  return free === null || free >= MIN_FREE_STORAGE;
}

export async function resolveCameraName(): Promise<string> {
  return (await getCameraName()) || session.getState().info?.cameraName || Device.deviceName || Device.modelName || 'Camera';
}

/**
 * Cầu nối giữa RemoteAgent (shared) và component <Camera> của vision-camera.
 * Camera nằm trong màn Quay; bridge giữ ref để lệnh từ Controller vẫn điều khiển được.
 */
class CameraBridge implements RecorderAdapter {
  private state: CameraBridgeState = {
    facing: 'back',
    config: { resolution: '1920x1080', fps: 30 },
    ready: false,
    recording: false,
    pendingFlip: false,
    lastError: null,
  };
  private readonly emitter = new Emitter<CameraBridgeState>();
  private camera: Camera | null = null;
  private active: ActiveRecording | null = null;
  private flipAfterStop: CameraFacing | 'toggle' | null = null;
  private reporter: Reporter = () => undefined;
  private onNeedCamera: (() => void) | null = null;

  subscribe = this.emitter.subscribe;
  getState = (): CameraBridgeState => this.state;

  private set(patch: Partial<CameraBridgeState>) {
    this.state = { ...this.state, ...patch };
    this.emitter.emit(this.state);
  }

  setReporter(fn: Reporter) {
    this.reporter = fn;
  }

  /** Lệnh quay tới khi màn Quay không hiển thị → app chuyển về tab Quay. */
  setOnNeedCamera(fn: (() => void) | null) {
    this.onNeedCamera = fn;
  }

  attach(camera: Camera | null) {
    this.camera = camera;
    if (!camera) this.set({ ready: false });
  }

  setReady(ready: boolean) {
    this.set({ ready });
  }

  setConfig(config: CaptureConfig) {
    this.set({ config });
  }

  /** Nút lật camera trên máy Remote — chạy hoàn toàn cục bộ. */
  toggleFacingLocal() {
    if (this.state.recording) return;
    this.set({ facing: this.state.facing === 'back' ? 'front' : 'back', ready: false });
  }

  private async waitReady(timeoutMs: number) {
    const started = Date.now();
    while (!(this.camera && this.state.ready)) {
      if (Date.now() - started > timeoutMs) throw new Error('CAMERA_NOT_READY');
      await sleep(100);
    }
  }

  // ---------- RecorderAdapter ----------

  async startRecording(opts: StartRecordingOptions): Promise<void> {
    if (this.state.recording) return;
    if (!(await hasEnoughStorage())) throw new LowStorageError();
    const [cam, mic] = [Camera.getCameraPermissionStatus(), Camera.getMicrophonePermissionStatus()];
    if (cam !== 'granted') throw new Error('NO_CAMERA_PERMISSION');

    const changed = opts.resolution !== this.state.config.resolution || opts.fps !== this.state.config.fps;
    if (changed) {
      this.set({ config: { resolution: opts.resolution, fps: opts.fps } });
      await sleep(800); // cho phiên camera cấu hình lại định dạng
    }
    if (!(this.camera && this.state.ready)) this.onNeedCamera?.();
    await this.waitReady(8000);

    const camera = this.camera!;
    const rec: ActiveRecording = { opts, localVideoUid: uuid(), startedAt: Date.now() };
    this.active = rec;
    camera.startRecording({
      fileType: 'mp4',
      videoCodec: 'h264',
      onRecordingFinished: (video) => void this.onFinished(rec, video),
      onRecordingError: (error) => this.onError(rec, error),
    });
    this.set({ recording: true, lastError: mic === 'granted' ? null : 'Không có quyền micro: video sẽ không có tiếng' });
  }

  async stopRecording(): Promise<void> {
    if (!this.state.recording) return;
    if (!this.camera) {
      // Màn Quay đã bị gỡ: không thể dừng gọn, báo lỗi.
      this.finishActive();
      this.reporter('failed', { errorCode: 'CAMERA_UNMOUNTED' });
      return;
    }
    await this.camera.stopRecording();
  }

  async switchCamera(facing: CameraFacing | 'toggle'): Promise<void> {
    if (this.state.recording) {
      // Đổi camera giữa chừng sẽ làm hỏng file đang ghi → áp dụng ngay sau khi dừng quay.
      this.flipAfterStop = facing;
      this.set({ pendingFlip: true });
      return;
    }
    this.applyFlip(facing);
  }

  private applyFlip(facing: CameraFacing | 'toggle') {
    const next: CameraFacing = facing === 'toggle' ? (this.state.facing === 'back' ? 'front' : 'back') : facing;
    if (next !== this.state.facing) this.set({ facing: next, ready: false });
  }

  private finishActive() {
    this.active = null;
    this.set({ recording: false, pendingFlip: false });
    if (this.flipAfterStop) {
      const f = this.flipAfterStop;
      this.flipAfterStop = null;
      this.applyFlip(f);
    }
  }

  private async onFinished(rec: ActiveRecording, video: VideoFile) {
    this.finishActive();
    try {
      const info = session.getState().info;
      const cameraName = await resolveCameraName();
      await saveRecordedClip({
        tempPath: video.path,
        localVideoUid: rec.localVideoUid,
        recordedAt: rec.opts.serverStartedAt,
        cameraName,
        sessionId: rec.opts.sessionId,
        deviceId: info?.deviceId ?? '',
        durationMs: (video.duration || (Date.now() - rec.startedAt) / 1000) * 1000,
        resolution: video.width && video.height ? `${Math.max(video.width, video.height)}x${Math.min(video.width, video.height)}` : rec.opts.resolution,
        fps: rec.opts.fps,
        clockOffsetMs: rec.opts.clockOffsetMs,
      });
      this.reporter('saved', { localVideoUid: rec.localVideoUid });
      notifyClipsChanged();
      uploadManager.kick();
    } catch (e) {
      this.set({ lastError: (e as Error)?.message ?? 'SAVE_FAILED' });
      this.reporter('failed', { errorCode: 'SAVE_FAILED' });
    }
  }

  private onError(rec: ActiveRecording, error: CameraCaptureError) {
    if (this.active !== rec) return;
    this.finishActive();
    this.set({ lastError: error.message });
    this.reporter('failed', { errorCode: error.code.slice(0, 60) });
  }
}

export const cameraBridge = new CameraBridge();
