import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import express, { Router, type Request } from 'express';
import type { Prisma, Video } from '@prisma/client';
import {
  CHUNK_SIZE,
  Codes,
  MAX_FILE_SIZE,
  VIDEO_MIME,
  buildClipBaseName,
  bulkDeleteSchema,
  compactTimestamp,
  initUploadSchema,
  listVideosSchema,
  slugify,
} from '@multicam/shared';
import { prisma } from '../db';
import { dirs, env } from '../env';
import { newId } from '../lib/ids';
import { baseUrl, fail, parse, send } from '../lib/http';
import { sha256, signPath, verifySignedPath } from '../lib/security';
import { auth, requireAuth, requireController, type AuthContext } from '../middleware/auth';
import { makeThumbnail, probeVideo, removeFiles } from '../services/media';

export const videosRouter = Router();

const chunkDir = (uploadId: string) => path.join(dirs.uploads, uploadId);
const chunkFile = (uploadId: string, index: number) => path.join(chunkDir(uploadId), `${index}.part`);

async function loadUpload(req: Request) {
  const a = auth(req);
  const upload = await prisma.uploadSession.findUnique({ where: { id: String(req.params.upload_id) }, include: { chunks: true } });
  if (!upload || upload.userId !== a.userId) throw fail(Codes.UPLOAD_NOT_FOUND);
  if (upload.status !== 'completed' && (upload.status === 'failed' || upload.expiresAt < new Date())) throw fail(Codes.UPLOAD_NOT_FOUND);
  return upload;
}

function missingChunks(total: number, received: Set<number>) {
  const out: number[] = [];
  for (let i = 0; i < total; i++) if (!received.has(i)) out.push(i);
  return out;
}

function expectedChunkSize(fileSize: number, chunkSize: number, index: number) {
  return Math.min(chunkSize, fileSize - index * chunkSize);
}

function mediaUrls(req: Request, v: Pick<Video, 'id' | 'thumbPath'>) {
  const video = signPath(`/files/videos/${v.id}`);
  const thumb = v.thumbPath ? signPath(`/files/thumbs/${v.id}`) : null;
  return { url: baseUrl(req) + video.url, thumbnail_url: thumb ? baseUrl(req) + thumb.url : null };
}

/** Controller thấy clip của mọi máy từng vào phòng của mình; Remote chỉ thấy clip của chính mình. */
async function visibleWhere(a: AuthContext): Promise<Prisma.VideoWhereInput> {
  if (a.role !== 'controller') return { userId: a.userId };
  const rooms = await prisma.room.findMany({ where: { ownerId: a.userId }, select: { id: true } });
  const roomIds = rooms.map((r) => r.id);
  const members = await prisma.roomMember.findMany({ where: { roomId: { in: roomIds } }, select: { deviceId: true }, distinct: ['deviceId'] });
  return { OR: [{ roomId: { in: roomIds } }, { deviceId: { in: members.map((m) => m.deviceId) } }] };
}

async function findVisibleVideo(a: AuthContext, videoId: string) {
  const video = await prisma.video.findFirst({ where: { AND: [{ id: videoId }, await visibleWhere(a)] } });
  if (!video) throw fail(Codes.VIDEO_NOT_FOUND, { video_id: videoId });
  return video;
}

function videoItem(req: Request, v: Video) {
  return {
    id: v.id,
    name: v.name,
    thumbnail_url: mediaUrls(req, v).thumbnail_url,
    duration_ms: v.durationMs,
    size: Number(v.size),
    created_at: v.createdAt.toISOString(),
    recorded_at: v.recordedAt.toISOString(),
    camera_name: v.cameraName,
    device_id: v.deviceId,
    session_id: v.sessionId,
    local_video_uid: v.localVideoUid,
    downloaded_by_controller: v.downloadedByController ? 1 : 0,
    // Mở rộng: metadata hiển thị ngay trên thẻ video của Thư viện.
    resolution: v.resolution,
    fps: v.fps,
  };
}

async function deleteVideo(v: Video) {
  await removeFiles(v.filePath, v.thumbPath);
  await prisma.video.delete({ where: { id: v.id } });
}

// ---------- D. Tự động upload ----------

// 20. init_upload
videosRouter.post('/videos/uploads', requireAuth, async (req, res) => {
  const a = auth(req);
  const body = parse(initUploadSchema, req.body);
  if (body.file_size > MAX_FILE_SIZE) throw fail(Codes.FILE_TOO_BIG, { field: 'file_size', max: MAX_FILE_SIZE });
  if (body.mime_type !== VIDEO_MIME || !body.file_name.toLowerCase().endsWith('.mp4')) {
    throw fail(Codes.PARAM_VALUE_INVALID, { field: 'mime_type' });
  }
  const checksum = body.checksum_sha256.toLowerCase();
  const device = await prisma.device.findFirst({ where: { id: body.metadata.device_id, userId: a.userId } });
  if (!device) throw fail(Codes.PARAM_VALUE_INVALID, { field: 'metadata.device_id' });

  // Cặp local_video_uid + checksum đã có → không mở phiên mới, không truyền lại 1 GB.
  const existing = await prisma.video.findUnique({ where: { localVideoUid_checksum: { localVideoUid: body.metadata.local_video_uid, checksum } } });
  if (existing) {
    send(res, { upload_id: null, chunk_size: CHUNK_SIZE, total_chunks: 0, expires_at: null, already_uploaded: 1, video_id: existing.id });
    return;
  }

  // Phiên dở dang còn hạn của đúng clip này thì dùng lại (tiếp tục từ missing_chunks).
  const pending = await prisma.uploadSession.findFirst({
    where: { userId: a.userId, localVideoUid: body.metadata.local_video_uid, checksum, status: 'in_progress', expiresAt: { gt: new Date() } },
  });
  if (pending) {
    send(res, {
      upload_id: pending.id,
      chunk_size: pending.chunkSize,
      total_chunks: pending.totalChunks,
      expires_at: pending.expiresAt.toISOString(),
      already_uploaded: 0,
      video_id: null,
    });
    return;
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
  const used = await prisma.video.aggregate({ where: { userId: a.userId }, _sum: { size: true } });
  if ((used._sum.size ?? 0n) + BigInt(body.file_size) > user.storageQuota) throw fail(Codes.QUOTA_EXCEEDED);

  const totalChunks = Math.ceil(body.file_size / CHUNK_SIZE);
  const upload = await prisma.uploadSession.create({
    data: {
      id: newId('up', 8),
      userId: a.userId,
      deviceId: device.id,
      localVideoUid: body.metadata.local_video_uid,
      fileName: body.file_name,
      fileSize: BigInt(body.file_size),
      checksum,
      metadata: JSON.stringify(body.metadata),
      chunkSize: CHUNK_SIZE,
      totalChunks,
      expiresAt: new Date(Date.now() + env.uploadTtlHours * 3600_000),
    },
  });
  await fs.mkdir(chunkDir(upload.id), { recursive: true });
  send(res, {
    upload_id: upload.id,
    chunk_size: CHUNK_SIZE,
    total_chunks: totalChunks,
    expires_at: upload.expiresAt.toISOString(),
    already_uploaded: 0,
    video_id: null,
  });
});

// 21. upload_chunk — body là dữ liệu nhị phân, checksum mảnh nằm ở header X-Chunk-Checksum.
videosRouter.put(
  '/videos/uploads/:upload_id/chunks/:index',
  requireAuth,
  express.raw({ type: () => true, limit: CHUNK_SIZE + 1024 }),
  async (req, res) => {
    const upload = await loadUpload(req);
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= upload.totalChunks) throw fail(Codes.PARAM_VALUE_INVALID, { field: 'chunk_index' });
    const checksum = req.get('x-chunk-checksum');
    if (!checksum) throw fail(Codes.PARAM_NOT_ENOUGH, { field: 'chunk_checksum' });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const expected = expectedChunkSize(Number(upload.fileSize), upload.chunkSize, index);
    if (body.length !== expected) throw fail(Codes.PARAM_VALUE_INVALID, { field: 'chunk', expected, received: body.length });
    if (sha256(body) !== checksum.toLowerCase()) throw fail(Codes.CHECKSUM_MISMATCH, { chunk_index: index });

    try {
      await fs.mkdir(chunkDir(upload.id), { recursive: true });
      await fs.writeFile(chunkFile(upload.id, index), body);
    } catch {
      throw fail(Codes.UPLOAD_FAILED, { chunk_index: index });
    }
    await prisma.uploadChunk.upsert({
      where: { uploadId_index: { uploadId: upload.id, index } },
      update: { size: body.length, checksum: checksum.toLowerCase() },
      create: { uploadId: upload.id, index, size: body.length, checksum: checksum.toLowerCase() },
    });
    const received = new Set([...upload.chunks.map((c) => c.index), index]);
    const missing = missingChunks(upload.totalChunks, received);
    send(res, { chunk_index: index, received: body.length, next_expected_index: missing[0] ?? null });
  },
);

// 22. get_upload_status — mảnh nào đã nhận, mảnh nào còn thiếu.
videosRouter.get('/videos/uploads/:upload_id', requireAuth, async (req, res) => {
  const upload = await loadUpload(req);
  const received = upload.chunks.map((c) => c.index).sort((x, y) => x - y);
  send(res, {
    upload_id: upload.id,
    status: upload.status,
    received_chunks: received,
    missing_chunks: upload.status === 'completed' ? [] : missingChunks(upload.totalChunks, new Set(received)),
    expires_at: upload.expiresAt.toISOString(),
  });
});

// 23. complete_upload — ghép file, đối chiếu checksum, sinh thumbnail, tạo bản ghi Video.
videosRouter.post('/videos/uploads/:upload_id/complete', requireAuth, async (req, res) => {
  const upload = await loadUpload(req);

  if (upload.status === 'completed' && upload.videoId) {
    const v = await prisma.video.findUnique({ where: { id: upload.videoId } });
    if (v) {
      send(res, completeResult(req, v));
      return;
    }
  }

  const missing = missingChunks(upload.totalChunks, new Set(upload.chunks.map((c) => c.index)));
  if (missing.length) throw fail(Codes.MISSING_CHUNKS, { missing_chunks: missing });

  const meta = JSON.parse(upload.metadata) as {
    local_video_uid: string;
    camera_name: string;
    session_id?: string | null;
    recorded_at: string;
    duration_ms: number;
    resolution: string;
    fps: number;
    clock_offset_ms?: number;
  };
  const baseName = buildClipBaseName({
    recordedAt: meta.recorded_at,
    cameraName: meta.camera_name,
    sessionId: meta.session_id ?? null,
    localVideoUid: meta.local_video_uid,
  });
  await fs.mkdir(dirs.videos, { recursive: true });
  const finalPath = path.join(dirs.videos, `${baseName}.mp4`);
  const thumbPath = path.join(dirs.videos, `${baseName}.jpg`);

  // Ghép mảnh tuần tự và băm toàn file trong cùng một lượt đọc.
  const hash = crypto.createHash('sha256');
  const out = createWriteStream(finalPath);
  try {
    for (let i = 0; i < upload.totalChunks; i++) {
      const data = await fs.readFile(chunkFile(upload.id, i));
      hash.update(data);
      if (!out.write(data)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch {
    out.destroy();
    await removeFiles(finalPath);
    throw fail(Codes.UPLOAD_FAILED);
  }
  if (hash.digest('hex') !== upload.checksum) {
    await removeFiles(finalPath);
    await prisma.uploadSession.update({ where: { id: upload.id }, data: { status: 'failed' } });
    await fs.rm(chunkDir(upload.id), { recursive: true, force: true });
    throw fail(Codes.CHECKSUM_MISMATCH, { scope: 'file' });
  }

  const probe = await probeVideo(finalPath);
  const durationMs = probe?.durationMs ?? meta.duration_ms;
  const hasThumb = await makeThumbnail(finalPath, thumbPath, durationMs);
  const session = meta.session_id ? await prisma.recordingSession.findUnique({ where: { id: meta.session_id } }) : null;
  const recordedAt = new Date(meta.recorded_at);
  const stamp = compactTimestamp(recordedAt.toISOString()); // 20260803T142530Z

  const video = await prisma.video.create({
    data: {
      id: newId('vd', 8),
      userId: upload.userId,
      deviceId: upload.deviceId,
      roomId: session?.roomId ?? null,
      sessionId: meta.session_id ?? null,
      localVideoUid: upload.localVideoUid,
      checksum: upload.checksum,
      name: `${slugify(meta.camera_name).replace(/-/g, '')}_${stamp.slice(0, 8)}_${stamp.slice(9, 13)}`,
      fileName: `${baseName}.mp4`,
      filePath: finalPath,
      thumbPath: hasThumb ? thumbPath : null,
      durationMs,
      size: upload.fileSize,
      resolution: probe?.width && probe.height ? `${probe.width}x${probe.height}` : meta.resolution,
      fps: probe?.fps ?? meta.fps,
      codec: probe?.codec ?? 'h264/aac',
      cameraName: meta.camera_name,
      recordedAt,
      clockOffsetMs: Math.round(meta.clock_offset_ms ?? 0),
    },
  });
  await prisma.uploadSession.update({ where: { id: upload.id }, data: { status: 'completed', videoId: video.id } });
  await prisma.uploadChunk.deleteMany({ where: { uploadId: upload.id } });
  await fs.rm(chunkDir(upload.id), { recursive: true, force: true });
  send(res, completeResult(req, video));
});

function completeResult(req: Request, v: Video) {
  const urls = mediaUrls(req, v);
  return {
    video_id: v.id,
    local_video_uid: v.localVideoUid,
    url: urls.url,
    thumbnail_url: urls.thumbnail_url,
    duration_ms: v.durationMs,
    size: Number(v.size),
    created_at: v.createdAt.toISOString(),
  };
}

// ---------- E. Thư viện ----------

// 24. get_list_videos
videosRouter.get('/videos', requireAuth, async (req, res) => {
  const a = auth(req);
  const q = parse(listVideosSchema, req.query);
  const where: Prisma.VideoWhereInput = {
    AND: [await visibleWhere(a), q.session_id ? { sessionId: q.session_id } : {}, q.device_id ? { deviceId: q.device_id } : {}],
  };
  const [total, videos] = await Promise.all([
    prisma.video.count({ where }),
    prisma.video.findMany({
      where,
      orderBy: { createdAt: q.sort === 'created_at_asc' ? 'asc' : 'desc' },
      skip: q.index,
      take: q.count,
    }),
  ]);
  send(res, { total, videos: videos.map((v) => videoItem(req, v)) }, videos.length ? Codes.OK : Codes.NO_DATA);
});

// 25. get_video — URL phát lại có chữ ký và thời hạn.
videosRouter.get('/videos/:video_id', requireAuth, async (req, res) => {
  const v = await findVisibleVideo(auth(req), String(req.params.video_id));
  const urls = mediaUrls(req, v);
  send(res, {
    ...videoItem(req, v),
    url: urls.url,
    resolution: v.resolution,
    codec: v.codec,
    fps: v.fps,
    clock_offset_ms: v.clockOffsetMs,
  });
});

// 26. get_download_url — chỉ Controller, mỗi lần đúng một clip.
videosRouter.get('/videos/:video_id/download', requireAuth, requireController, async (req, res) => {
  const a = auth(req);
  const v = await findVisibleVideo(a, String(req.params.video_id));
  const now = new Date();
  const active = await prisma.downloadTicket.findFirst({ where: { userId: a.userId, doneAt: null, expiresAt: { gt: now } } });
  if (active && active.videoId !== v.id) throw fail(Codes.DOWNLOAD_IN_PROGRESS, { video_id: active.videoId });
  const ticket =
    active ??
    (await prisma.downloadTicket.create({
      data: { id: newId('dl', 12), userId: a.userId, videoId: v.id, expiresAt: new Date(now.getTime() + env.downloadTicketMinutes * 60_000) },
    }));
  await prisma.video.update({ where: { id: v.id }, data: { downloadedByController: true } });
  const signed = signPath(`/files/download/${ticket.id}`, env.downloadTicketMinutes * 60);
  send(res, { download_url: baseUrl(req) + signed.url, expires_at: signed.expiresAt.toISOString(), size: Number(v.size), checksum_sha256: v.checksum });
});

// 27. delete_video — chỉ xóa bản trên server.
videosRouter.delete('/videos/:video_id', requireAuth, requireController, async (req, res) => {
  const v = await findVisibleVideo(auth(req), String(req.params.video_id));
  await deleteVideo(v);
  send(res, { video_id: v.id, deleted_at: new Date().toISOString() });
});

// 28. delete_videos_bulk — tối đa 50 clip; clip lỗi không làm hỏng cả lô.
videosRouter.post('/videos/bulk-delete', requireAuth, requireController, async (req, res) => {
  const a = auth(req);
  const body = parse(bulkDeleteSchema, req.body);
  const where = await visibleWhere(a);
  const deleted: string[] = [];
  const failed: { video_id: string; reason: string }[] = [];
  for (const id of [...new Set(body.video_ids)]) {
    const v = await prisma.video.findFirst({ where: { AND: [{ id }, where] } });
    if (!v) {
      failed.push({ video_id: id, reason: 'NOT_FOUND' });
      continue;
    }
    try {
      await deleteVideo(v);
      deleted.push(id);
    } catch {
      failed.push({ video_id: id, reason: 'DELETE_FAILED' });
    }
  }
  send(res, { deleted, failed });
});

// ---------- File tĩnh có chữ ký (phát trong ứng dụng / tải về) ----------
export const filesRouter = Router();

filesRouter.get('/files/videos/:video_id', async (req, res) => {
  if (!verifySignedPath(req.path, req.query.exp, req.query.sig)) throw fail(Codes.NOT_ACCESS);
  const v = await prisma.video.findUnique({ where: { id: String(req.params.video_id) } });
  if (!v) throw fail(Codes.VIDEO_NOT_FOUND);
  res.type('video/mp4');
  res.sendFile(v.filePath); // hỗ trợ Range để tua video
});

filesRouter.get('/files/thumbs/:video_id', async (req, res) => {
  if (!verifySignedPath(req.path, req.query.exp, req.query.sig)) throw fail(Codes.NOT_ACCESS);
  const v = await prisma.video.findUnique({ where: { id: String(req.params.video_id) } });
  if (!v?.thumbPath) throw fail(Codes.VIDEO_NOT_FOUND);
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(v.thumbPath);
});

filesRouter.get('/files/download/:ticket_id', async (req, res) => {
  if (!verifySignedPath(req.path, req.query.exp, req.query.sig)) throw fail(Codes.NOT_ACCESS);
  const ticket = await prisma.downloadTicket.findUnique({ where: { id: String(req.params.ticket_id) } });
  if (!ticket || ticket.doneAt) throw fail(Codes.NOT_ACCESS);
  const v = await prisma.video.findUnique({ where: { id: ticket.videoId } });
  if (!v) throw fail(Codes.VIDEO_NOT_FOUND);
  // Lượt tải kết thúc (xong hoặc bị hủy) thì cho phép xin link clip kế tiếp.
  res.on('close', () => {
    void prisma.downloadTicket.update({ where: { id: ticket.id }, data: { doneAt: new Date() } }).catch(() => undefined);
  });
  res.set('Content-Disposition', `attachment; filename="${v.fileName}"`);
  res.set('Content-Type', 'video/mp4');
  res.set('Content-Length', String(v.size));
  await pipeline(createReadStream(v.filePath), res);
});
