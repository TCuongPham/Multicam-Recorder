import {
  Emitter,
  buildClipBaseName,
  uuid,
  type CameraFacing,
  type RecorderAdapter,
  type StartRecordingOptions,
} from '@multicam/shared';
import { clipStore, type ClipRecord } from './clipStore';

const MP4_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'];

/** Định dạng MP4 (H.264 + AAC) mà trình duyệt ghi được; null nếu không hỗ trợ (vd. Firefox). */
export function supportedMp4Type(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return MP4_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

export interface RecorderState {
  stream: MediaStream | null;
  facing: CameraFacing;
  recording: boolean;
  error: string | null;
  /** Cấu hình quay hiện tại (Controller chọn trong menu, hoặc mặc định khi quay độc lập). */
  config: { resolution: string; fps: number };
}

interface Active {
  recorder: MediaRecorder;
  uid: string;
  baseName: string;
  startedAt: number;
  seq: number;
  size: number;
  writes: Promise<unknown>;
  thumb: Blob | null;
  opts: StartRecordingOptions;
  stopped: Promise<void>;
}

/**
 * Pipeline quay video trên web: xin quyền camera + micro, khung xem trực tiếp,
 * MediaRecorder ghi MP4 dạng fragmented (start(timeslice)) vào IndexedDB.
 */
export class WebRecorder implements RecorderAdapter {
  private state: RecorderState = { stream: null, facing: 'back', recording: false, error: null, config: { resolution: '1920x1080', fps: 30 } };
  private readonly emitter = new Emitter<RecorderState>();
  private active: Active | null = null;
  private resolution = '1920x1080';
  private fps = 30;

  constructor(
    private readonly ctx: {
      getDeviceId: () => string | null;
      getUserId: () => string;
      getCameraName: () => string;
      onSaved: (clip: ClipRecord) => void;
    },
  ) {}

  subscribe = this.emitter.subscribe;
  getState = () => this.state;

  private set(patch: Partial<RecorderState>) {
    this.state = { ...this.state, ...patch };
    this.emitter.emit(this.state);
  }

  async ensureStream(): Promise<MediaStream> {
    if (this.state.stream?.active) return this.state.stream;
    return this.openStream(this.state.facing);
  }

  private async openStream(facing: CameraFacing): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      const msg = 'Trình duyệt chặn camera: cần mở trang qua https:// hoặc localhost';
      this.set({ error: msg });
      throw new Error(msg);
    }
    const [w, h] = this.resolution.split('x').map(Number);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing === 'front' ? 'user' : 'environment', width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: this.fps } },
        audio: { echoCancellation: false, noiseSuppression: false },
      });
      this.state.stream?.getTracks().forEach((t) => t.stop());
      this.set({ stream, facing, error: null });
      return stream;
    } catch (e) {
      const msg = (e as Error).name === 'NotAllowedError' ? 'Chưa được cấp quyền camera và micro' : `Không mở được camera: ${(e as Error).message}`;
      this.set({ error: msg });
      throw new Error(msg);
    }
  }

  private snapVideo: HTMLVideoElement | null = null;
  private snapCanvas: HTMLCanvasElement | null = null;

  /** Ảnh JPEG nhỏ của khung hình hiện tại (xem trước trên màn Controller). */
  snapshot(width = 320, quality = 0.55): string | null {
    const stream = this.state.stream;
    if (!stream?.active) return null;
    if (!this.snapVideo) {
      this.snapVideo = document.createElement('video');
      this.snapVideo.muted = true;
      this.snapVideo.playsInline = true;
    }
    const v = this.snapVideo;
    if (v.srcObject !== stream) {
      v.srcObject = stream;
      void v.play().catch(() => undefined);
    }
    if (!v.videoWidth) return null;
    const c = (this.snapCanvas ??= document.createElement('canvas'));
    c.width = width;
    c.height = Math.round((v.videoHeight / v.videoWidth) * width);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    if (this.state.facing === 'front') {
      ctx.setTransform(-1, 0, 0, 1, c.width, 0); // gương như khung xem trên máy
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }

  releaseStream() {
    if (this.active) return;
    this.state.stream?.getTracks().forEach((t) => t.stop());
    this.set({ stream: null });
  }

  /** Lật camera chạy cục bộ. Đang quay thì không lật được (MediaRecorder không đổi track giữa chừng). */
  async switchCamera(facing: CameraFacing | 'toggle'): Promise<void> {
    const next = facing === 'toggle' ? (this.state.facing === 'front' ? 'back' : 'front') : facing;
    if (this.active) throw new Error('CAMERA_BUSY_RECORDING');
    if (next === this.state.facing && this.state.stream) return;
    await this.openStream(next);
  }

  /** Controller đổi cấu hình khi chưa quay: mở lại camera theo độ phân giải / fps mới. */
  applyConfig(config: { resolution: string; fps: number }) {
    if (this.active || (config.resolution === this.resolution && config.fps === this.fps)) return;
    this.resolution = config.resolution;
    this.fps = config.fps;
    this.set({ config: { ...config } });
    if (this.state.stream) void this.openStream(this.state.facing).catch(() => undefined);
  }

  async startRecording(opts: StartRecordingOptions): Promise<void> {
    const mimeType = supportedMp4Type();
    if (!mimeType) throw new Error('MP4_NOT_SUPPORTED');
    if (opts.resolution !== this.resolution || opts.fps !== this.fps) {
      this.resolution = opts.resolution;
      this.fps = opts.fps;
      this.set({ config: { resolution: opts.resolution, fps: opts.fps } });
      if (this.state.stream) await this.openStream(this.state.facing);
    }
    const stream = await this.ensureStream();
    const uid = uuid();
    const baseName = buildClipBaseName({
      recordedAt: opts.serverStartedAt,
      cameraName: this.ctx.getCameraName(),
      sessionId: opts.sessionId,
      localVideoUid: uid,
    });
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 128_000 });
    let resolveStopped!: () => void;
    const active: Active = {
      recorder,
      uid,
      baseName,
      startedAt: Date.now(),
      seq: 0,
      size: 0,
      writes: Promise.resolve(),
      thumb: null,
      opts,
      stopped: new Promise((r) => (resolveStopped = r)),
    };
    const settings = stream.getVideoTracks()[0]?.getSettings();
    const actualResolution = settings?.width && settings?.height ? `${settings.width}x${settings.height}` : opts.resolution;

    await clipStore.put(this.record(active, mimeType, actualResolution, false));
    recorder.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      const seq = active.seq++;
      active.size += ev.data.size;
      active.writes = active.writes.then(() => clipStore.addPart(uid, seq, ev.data));
    };
    recorder.onstop = () => resolveStopped();
    recorder.start(1000); // mỗi giây một khối → file MP4 fragmented
    this.active = active;
    this.set({ recording: true });
    setTimeout(() => void this.captureThumb(active), 800);

    void active.stopped.then(async () => {
      await active.writes;
      const durationMs = Date.now() - active.startedAt;
      const clip = this.record(active, mimeType, actualResolution, true, durationMs);
      await clipStore.put(clip);
      this.active = null;
      this.set({ recording: false });
      this.ctx.onSaved(clip);
    });
  }

  async stopRecording(): Promise<void> {
    const a = this.active;
    if (!a) return;
    if (a.recorder.state !== 'inactive') a.recorder.stop();
    await a.stopped;
  }

  private record(a: Active, mimeType: string, resolution: string, finalized: boolean, durationMs = 0): ClipRecord {
    return {
      uid: a.uid,
      userId: this.ctx.getUserId(),
      baseName: a.baseName,
      fileName: `${a.baseName}.mp4`,
      mimeType: mimeType.split(';')[0],
      size: a.size,
      parts: a.seq,
      thumb: a.thumb,
      finalized,
      uploaded: false,
      videoId: null,
      createdAt: a.startedAt,
      metadata: {
        local_video_uid: a.uid,
        device_id: this.ctx.getDeviceId() ?? '',
        camera_name: this.ctx.getCameraName(),
        session_id: a.opts.sessionId,
        recorded_at: a.opts.serverStartedAt,
        duration_ms: durationMs,
        resolution,
        fps: a.opts.fps,
        clock_offset_ms: a.opts.clockOffsetMs,
      },
    };
  }

  /** Thumbnail .jpg chụp từ khung hình đầu clip. */
  private async captureThumb(a: Active) {
    const stream = this.state.stream;
    if (!stream) return;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try {
      await video.play();
      const canvas = document.createElement('canvas');
      const scale = 480 / (video.videoWidth || 480);
      canvas.width = 480;
      canvas.height = Math.round((video.videoHeight || 270) * scale);
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      a.thumb = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
    } catch {
      a.thumb = null;
    } finally {
      video.srcObject = null;
    }
  }
}
