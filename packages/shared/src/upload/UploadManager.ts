import { ApiError, type ApiClient } from '../api';
import { Codes } from '../codes';
import { MAX_CHUNK_RETRIES, MAX_FILE_SIZE, VIDEO_MIME, type UploadState } from '../constants';
import type { UploadMetadata } from '../schemas';
import type { UploadChunkResult } from '../types';
import { Emitter, sleep, type KeyValueStore } from '../utils';

/** Một clip trong thư mục clip của máy, chưa có dấu `.uploaded`. */
export interface LocalClip {
  uid: string;
  baseName: string;
  fileName: string;
  size: number;
  mimeType: string;
  metadata: UploadMetadata;
  /** Tham chiếu riêng của nền tảng (đường dẫn file, FileSystemFileHandle...). */
  ref: unknown;
}

export interface UploadPlatform {
  listPendingClips(): Promise<LocalClip[]>;
  /** SHA-256 toàn file (native trên app, hash-wasm trên web). */
  hashFile(clip: LocalClip, onProgress?: (fraction: number) => void): Promise<string>;
  /** Đọc mảnh thứ `index`, tính checksum mảnh rồi gửi lên server. */
  sendChunk(api: ApiClient, uploadId: string, clip: LocalClip, index: number, chunkSize: number): Promise<UploadChunkResult>;
  /** Ghi file rỗng `.uploaded` cạnh clip. */
  markUploaded(clip: LocalClip, videoId: string | null): Promise<void>;
  kv: KeyValueStore;
}

export interface UploadManagerState {
  active: { uid: string; baseName: string; phase: 'hashing' | 'uploading' | 'completing'; percent: number } | null;
  pending: number;
  lastResult: 'uploaded' | 'failed' | null;
  error: string | null;
  /** Hết hạn mức lưu trữ: dừng upload tự động cho tới khi người dùng thử lại. */
  blocked: boolean;
}

interface SavedUpload {
  upload_id: string;
  checksum: string;
  chunk_size: number;
  total_chunks: number;
}

class ChunkFailedError extends Error {}

/**
 * Tự động upload clip sau khi quay xong: băm SHA-256 → init_upload → gửi từng mảnh
 * (thử lại tối đa 3 lần) → complete_upload. Mất mạng thì tiếp tục từ missing_chunks.
 * Chạy độc lập với màn hình nên người dùng chuyển màn hình upload vẫn tiếp tục.
 */
export class UploadManager {
  private state: UploadManagerState = { active: null, pending: 0, lastResult: null, error: null, blocked: false };
  private readonly emitter = new Emitter<UploadManagerState>();
  private running = false;
  private again = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private skipped = new Set<string>();

  constructor(
    private readonly api: ApiClient,
    private readonly platform: UploadPlatform,
  ) {}

  subscribe = this.emitter.subscribe;
  getState = (): UploadManagerState => this.state;

  private set(patch: Partial<UploadManagerState>) {
    this.state = { ...this.state, ...patch };
    this.emitter.emit(this.state);
  }

  /** Trạng thái gửi kèm sync_device. */
  syncStatus = (): { upload_state: UploadState; upload_percent: number } => {
    const s = this.state;
    if (s.active) return { upload_state: 'uploading', upload_percent: s.active.percent };
    if (s.lastResult === 'failed') return { upload_state: 'failed', upload_percent: 0 };
    if (s.lastResult === 'uploaded') return { upload_state: 'uploaded', upload_percent: 100 };
    return { upload_state: 'none', upload_percent: 0 };
  };

  /** Quên kết quả của clip trước (phiên mới bắt đầu); clip đang upload thì vẫn báo "uploading". */
  resetResult() {
    if (!this.state.active) this.set({ lastResult: null, error: this.state.blocked ? this.state.error : null });
  }

  /** Gọi khi có clip mới, khi mở lại ứng dụng hoặc khi có mạng trở lại. */
  kick(options: { force?: boolean } = {}) {
    if (options.force) {
      this.skipped.clear();
      this.set({ blocked: false });
    }
    if (this.state.blocked) return;
    if (this.running) {
      this.again = true;
      return;
    }
    void this.run();
  }

  private scheduleRetry(ms: number) {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.kick(), ms);
  }

  private async run() {
    this.running = true;
    try {
      do {
        this.again = false;
        const clips = (await this.platform.listPendingClips()).filter((c) => !this.skipped.has(c.uid));
        this.set({ pending: clips.length });
        for (const clip of clips) {
          try {
            await this.processClip(clip);
            this.set({ lastResult: 'uploaded', error: null, active: null, pending: Math.max(0, this.state.pending - 1) });
          } catch (e) {
            const err = e as Error;
            this.set({ active: null, lastResult: 'failed', error: err instanceof ApiError ? err.userMessage : String(err?.message ?? err) });
            if (err instanceof ApiError && (err.code === Codes.FILE_TOO_BIG || err.code === Codes.PARAM_VALUE_INVALID)) {
              this.skipped.add(clip.uid); // không bao giờ upload được, bỏ qua clip này
              continue;
            }
            if (err instanceof ApiError && err.code === Codes.QUOTA_EXCEEDED) {
              this.set({ blocked: true });
              return;
            }
            if (err instanceof ApiError && err.code === 'NETWORK') this.scheduleRetry(15_000);
            // Mảnh lỗi 3 lần: tạm dừng phiên, thử lại ở lần mở ứng dụng sau (hoặc sau 60 giây).
            else this.scheduleRetry(60_000);
            return;
          }
        }
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  private progress(uid: string, baseName: string, phase: 'hashing' | 'uploading' | 'completing', percent: number) {
    this.set({ active: { uid, baseName, phase, percent: Math.max(0, Math.min(100, percent)) } });
  }

  private async processClip(clip: LocalClip) {
    // Chặn ngay ở client: vượt 1 GB hoặc không phải MP4.
    if (clip.size > MAX_FILE_SIZE) throw new ApiError(Codes.FILE_TOO_BIG, 'File size is too big');
    if (clip.mimeType !== VIDEO_MIME || !clip.fileName.toLowerCase().endsWith('.mp4')) {
      throw new ApiError(Codes.PARAM_VALUE_INVALID, 'Only MP4 is allowed');
    }

    const kv = this.platform.kv;
    const shaKey = `upload.sha.${clip.uid}`;
    const sessionKey = `upload.session.${clip.uid}`;

    this.progress(clip.uid, clip.baseName, 'hashing', 0);
    let checksum = await kv.get(shaKey);
    if (!checksum) {
      checksum = await this.platform.hashFile(clip);
      await kv.set(shaKey, checksum);
    }

    let saved: SavedUpload | null = null;
    try {
      saved = JSON.parse((await kv.get(sessionKey)) || 'null');
    } catch {
      saved = null;
    }
    let missing: number[] | null = null;
    if (saved && saved.checksum === checksum) {
      try {
        const status = await this.api.getUploadStatus(saved.upload_id);
        missing = status.missing_chunks;
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== Codes.UPLOAD_NOT_FOUND) throw e;
        saved = null; // phiên hết hạn → mở phiên mới
      }
    } else {
      saved = null;
    }

    if (!saved) {
      const init = await this.api.initUpload({
        file_name: clip.fileName,
        file_size: clip.size,
        mime_type: clip.mimeType,
        checksum_sha256: checksum,
        metadata: clip.metadata,
      });
      if (init.already_uploaded === 1 || !init.upload_id) {
        await this.finish(clip, init.video_id);
        return;
      }
      saved = { upload_id: init.upload_id, checksum, chunk_size: init.chunk_size, total_chunks: init.total_chunks };
      await kv.set(sessionKey, JSON.stringify(saved));
      missing = Array.from({ length: init.total_chunks }, (_, i) => i);
    }

    await this.sendChunks(clip, saved, missing ?? []);

    this.progress(clip.uid, clip.baseName, 'completing', 100);
    try {
      const done = await this.api.completeUpload(saved.upload_id);
      await this.finish(clip, done.video_id);
    } catch (e) {
      if (e instanceof ApiError && e.code === Codes.MISSING_CHUNKS) {
        const status = await this.api.getUploadStatus(saved.upload_id);
        await this.sendChunks(clip, saved, status.missing_chunks);
        const done = await this.api.completeUpload(saved.upload_id);
        await this.finish(clip, done.video_id);
        return;
      }
      if (e instanceof ApiError && (e.code === Codes.CHECKSUM_MISMATCH || e.code === Codes.UPLOAD_NOT_FOUND)) {
        // Sai mã băm toàn file: bỏ phiên cũ, lần sau mở phiên upload mới.
        await kv.remove(sessionKey);
        await kv.remove(shaKey);
      }
      throw e;
    }
  }

  private async sendChunks(clip: LocalClip, saved: SavedUpload, missing: number[]) {
    const total = saved.total_chunks;
    let done = total - missing.length;
    this.progress(clip.uid, clip.baseName, 'uploading', (done / total) * 100);
    for (const index of missing) {
      let attempt = 0;
      for (;;) {
        try {
          await this.platform.sendChunk(this.api, saved.upload_id, clip, index, saved.chunk_size);
          break;
        } catch (e) {
          attempt++;
          const fatal = e instanceof ApiError && (e.code === Codes.UPLOAD_NOT_FOUND || e.code === Codes.TOKEN_INVALID);
          if (fatal) throw e;
          if (attempt >= MAX_CHUNK_RETRIES) {
            if (e instanceof ApiError) throw e;
            throw new ChunkFailedError(`Chunk ${index} failed after ${MAX_CHUNK_RETRIES} attempts`);
          }
          await sleep(1000 * attempt);
        }
      }
      done++;
      this.progress(clip.uid, clip.baseName, 'uploading', (done / total) * 100);
    }
  }

  private async finish(clip: LocalClip, videoId: string | null) {
    await this.platform.markUploaded(clip, videoId);
    await this.platform.kv.remove(`upload.session.${clip.uid}`);
    await this.platform.kv.remove(`upload.sha.${clip.uid}`);
  }
}
