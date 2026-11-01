import * as RNFS from '@dr.pogodin/react-native-fs';
import * as FileSystem from 'expo-file-system/legacy';
import * as VideoThumbnails from 'expo-video-thumbnails';
import {
  ApiError,
  Codes,
  VIDEO_MIME,
  buildClipBaseName,
  parseClipBaseName,
  type ApiClient,
  type ApiEnvelope,
  type LocalClip,
  type UploadChunkResult,
  type UploadMetadata,
  type UploadPlatform,
} from '@multicam/shared';
import { kv, tokenStore } from './storage';

/** Thư mục clip của ứng dụng: <Documents>/clips/<baseName>.mp4|.jpg|.json|.uploaded */
export const CLIPS_DIR = `${RNFS.DocumentDirectoryPath}/clips`;
/** Thư mục tải về của Controller (trong vùng nhớ riêng của ứng dụng). */
export const DOWNLOADS_DIR = `${RNFS.DocumentDirectoryPath}/downloads`;
/** Mảnh tạm khi upload. */
const CHUNK_TMP_DIR = `${RNFS.CachesDirectoryPath}/upload-chunks`;

export function toUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

export function fromUri(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  const p = uri.slice('file://'.length);
  try {
    return decodeURI(p);
  } catch {
    return p;
  }
}

async function ensureDir(dir: string) {
  if (!(await RNFS.exists(dir))) await RNFS.mkdir(dir);
}

/** Metadata đi kèm clip (<baseName>.json) để dựng lại UploadMetadata mà không cần DB. */
export type ClipMeta = UploadMetadata & { clock_offset_ms: number };

export interface LocalClipInfo {
  baseName: string;
  path: string;
  thumbPath: string | null;
  size: number;
  uploaded: boolean;
  meta: ClipMeta;
}

async function readMeta(baseName: string): Promise<ClipMeta | null> {
  try {
    const raw = await RNFS.readFile(`${CLIPS_DIR}/${baseName}.json`, 'utf8');
    return JSON.parse(raw) as ClipMeta;
  } catch {
    // Không có file .json: dựng lại tối thiểu từ tên file.
    const p = parseClipBaseName(baseName);
    if (!p) return null;
    return {
      local_video_uid: p.localVideoUid,
      device_id: '',
      camera_name: p.cameraName,
      session_id: p.sessionId,
      recorded_at: p.recordedAt,
      duration_ms: 0,
      resolution: 'unknown',
      fps: 0,
      clock_offset_ms: 0,
    };
  }
}

/** Liệt kê clip cục bộ (mới nhất trước). */
export async function listLocalClips(): Promise<LocalClipInfo[]> {
  if (!(await RNFS.exists(CLIPS_DIR))) return [];
  const items = await RNFS.readDir(CLIPS_DIR);
  const names = new Set(items.map((i) => i.name));
  const out: LocalClipInfo[] = [];
  for (const item of items) {
    if (!item.isFile() || !item.name.toLowerCase().endsWith('.mp4')) continue;
    const baseName = item.name.slice(0, -4);
    const meta = await readMeta(baseName);
    if (!meta) continue;
    out.push({
      baseName,
      path: item.path,
      thumbPath: names.has(`${baseName}.jpg`) ? `${CLIPS_DIR}/${baseName}.jpg` : null,
      size: Number(item.size),
      uploaded: names.has(`${baseName}.uploaded`),
      meta,
    });
  }
  return out.sort((a, b) => b.meta.recorded_at.localeCompare(a.meta.recorded_at));
}

export interface SaveClipInput {
  tempPath: string;
  localVideoUid: string;
  recordedAt: string;
  cameraName: string;
  sessionId: string | null;
  deviceId: string;
  durationMs: number;
  resolution: string;
  fps: number;
  clockOffsetMs: number;
}

/**
 * Chuyển file vision-camera vừa ghi vào thư mục clip theo mẫu tên
 * <recorded_at>__<camera_name>__<session_id>__<local_video_uid>.mp4, kèm .json và .jpg.
 */
export async function saveRecordedClip(input: SaveClipInput): Promise<string> {
  await ensureDir(CLIPS_DIR);
  const baseName = buildClipBaseName({
    recordedAt: input.recordedAt,
    cameraName: input.cameraName,
    sessionId: input.sessionId,
    localVideoUid: input.localVideoUid,
  });
  const meta: ClipMeta = {
    local_video_uid: input.localVideoUid,
    device_id: input.deviceId,
    camera_name: input.cameraName.slice(0, 40),
    session_id: input.sessionId,
    recorded_at: input.recordedAt,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    resolution: input.resolution,
    fps: input.fps,
    clock_offset_ms: Math.round(input.clockOffsetMs),
  };
  // Ghi .json TRƯỚC khi đặt .mp4 vào thư mục để UploadManager luôn đọc được metadata.
  await RNFS.writeFile(`${CLIPS_DIR}/${baseName}.json`, JSON.stringify(meta), 'utf8');
  const src = fromUri(input.tempPath);
  const dest = `${CLIPS_DIR}/${baseName}.mp4`;
  try {
    await RNFS.moveFile(src, dest);
  } catch {
    await RNFS.copyFile(src, dest);
    await RNFS.unlink(src).catch(() => undefined);
  }
  try {
    const thumb = await VideoThumbnails.getThumbnailAsync(toUri(dest), { time: 500, quality: 0.6 });
    const thumbSrc = fromUri(thumb.uri);
    const thumbDest = `${CLIPS_DIR}/${baseName}.jpg`;
    try {
      await RNFS.moveFile(thumbSrc, thumbDest);
    } catch {
      await RNFS.copyFile(thumbSrc, thumbDest);
    }
  } catch {
    // Không sinh được thumbnail thì vẫn giữ clip.
  }
  return baseName;
}

/** Dung lượng trống của bộ nhớ máy (byte). */
export async function getFreeStorage(): Promise<number | null> {
  try {
    const info = await RNFS.getFSInfo();
    return Number(info.freeSpace);
  } catch {
    try {
      return await FileSystem.getFreeDiskStorageAsync();
    } catch {
      return null;
    }
  }
}

// ---------- Nền tảng upload cho UploadManager ----------

function parseEnvelope<T>(body: string, status: number): ApiEnvelope<T> {
  try {
    return JSON.parse(body) as ApiEnvelope<T>;
  } catch {
    throw new ApiError(Codes.EXCEPTION, `HTTP ${status}`, null, status);
  }
}

export const uploadPlatform: UploadPlatform = {
  kv,

  async listPendingClips(): Promise<LocalClip[]> {
    // Chỉ upload khi đang đăng nhập bằng tài khoản Remote (đọc thẳng từ storage để chạy được cả trong tác vụ nền).
    const tokens = await tokenStore.get();
    let info: { role?: string; deviceId?: string | null } | null = null;
    try {
      info = JSON.parse((await kv.get('session.info')) || 'null');
    } catch {
      info = null;
    }
    if (!tokens || info?.role !== 'remote' || !info.deviceId) return [];
    const deviceId = info.deviceId;

    const clips = await listLocalClips();
    return clips
      .filter((c) => !c.uploaded && (!c.meta.device_id || c.meta.device_id === deviceId)) // clip của tài khoản khác thì bỏ qua
      .reverse() // cũ nhất trước
      .map((c) => {
        const { clock_offset_ms, ...rest } = c.meta;
        const metadata: UploadMetadata = { ...rest, device_id: rest.device_id || deviceId, session_id: rest.session_id ?? null, clock_offset_ms };
        return {
          uid: c.meta.local_video_uid,
          baseName: c.baseName,
          fileName: `${c.baseName}.mp4`,
          size: c.size,
          mimeType: VIDEO_MIME,
          metadata,
          ref: c.path,
        };
      });
  },

  async hashFile(clip: LocalClip): Promise<string> {
    // Băm native (không đưa 1 GB qua cầu JS).
    return (await RNFS.hash(clip.ref as string, 'sha256')).toLowerCase();
  },

  async sendChunk(client: ApiClient, uploadId: string, clip: LocalClip, index: number, chunkSize: number): Promise<UploadChunkResult> {
    await ensureDir(CHUNK_TMP_DIR);
    const tmp = `${CHUNK_TMP_DIR}/${uploadId}_${index}.bin`;
    try {
      const b64 = await RNFS.read(clip.ref as string, chunkSize, index * chunkSize, 'base64');
      await RNFS.writeFile(tmp, b64, 'base64');
      const checksum = (await RNFS.hash(tmp, 'sha256')).toLowerCase();
      const url = client.url(`/videos/uploads/${uploadId}/chunks/${index}`);
      const res = await client.authed<UploadChunkResult>(async (token) => {
        let r: FileSystem.FileSystemUploadResult;
        try {
          r = await FileSystem.uploadAsync(url, toUri(tmp), {
            httpMethod: 'PUT',
            uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
            sessionType: FileSystem.FileSystemSessionType.BACKGROUND,
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/octet-stream',
              'X-Chunk-Checksum': checksum,
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
          });
        } catch (e) {
          throw new ApiError('NETWORK', (e as Error)?.message || 'Network error');
        }
        return parseEnvelope<UploadChunkResult>(r.body, r.status);
      });
      return res.data;
    } finally {
      await RNFS.unlink(tmp).catch(() => undefined);
    }
  },

  async markUploaded(clip: LocalClip): Promise<void> {
    // File rỗng .uploaded thay cho cơ sở dữ liệu ở client.
    await RNFS.writeFile(`${CLIPS_DIR}/${clip.baseName}.uploaded`, '', 'utf8');
  },
};

// ---------- Tải về (Controller) ----------

export async function ensureDownloadsDir(): Promise<void> {
  await ensureDir(DOWNLOADS_DIR);
}

export function downloadFileName(videoId: string, name: string): string {
  const safe = (name || videoId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return `${videoId}__${safe}.mp4`;
}

/** Danh sách video_id đã có bản tải về trong thư mục downloads. */
export async function listDownloadedIds(): Promise<Set<string>> {
  if (!(await RNFS.exists(DOWNLOADS_DIR))) return new Set();
  const items = await RNFS.readDir(DOWNLOADS_DIR);
  return new Set(items.filter((i) => i.name.endsWith('.mp4')).map((i) => i.name.split('__')[0]));
}
