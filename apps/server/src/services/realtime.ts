import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { MAX_PREVIEW_BYTES, type ClientToServerEvents, type PendingCommand, type ServerToClientEvents } from '@multicam/shared';
import { prisma } from '../db';
import { resolveToken } from '../middleware/auth';

let io: Server<ClientToServerEvents, ServerToClientEvents> | null = null;

interface MembershipInfo {
  roomId: string;
  memberId: string;
  ownerId: string;
}
const membershipCache = new Map<string, { at: number; info: MembershipInfo | null }>();

/** Phòng đang tham gia của một thiết bị (cache 5 giây để không truy vấn CSDL cho từng khung hình). */
async function membershipOf(deviceId: string): Promise<MembershipInfo | null> {
  const hit = membershipCache.get(deviceId);
  if (hit && Date.now() - hit.at < 5000) return hit.info;
  const m = await prisma.roomMember.findFirst({
    where: { deviceId, leftAt: null, room: { status: { not: 'closed' } } },
    select: { id: true, roomId: true, room: { select: { ownerId: true } } },
  });
  const info = m ? { roomId: m.roomId, memberId: m.id, ownerId: m.room.ownerId } : null;
  membershipCache.set(deviceId, { at: Date.now(), info });
  return info;
}

/** Socket đẩy lệnh: máy Remote nhận lệnh quay trong dưới 1 giây; Controller được báo phòng thay đổi và xem trước camera. */
export function attachRealtime(servers: HttpServer[]) {
  io = new Server({ cors: { origin: true, credentials: true }, serveClient: false, maxHttpBufferSize: MAX_PREVIEW_BYTES + 10_000 });
  for (const s of servers) io.attach(s);

  io.use(async (socket, next) => {
    const token = (socket.handshake.auth as { token?: string })?.token;
    const auth = await resolveToken(token);
    if (!auth) return next(new Error('9998'));
    socket.data.auth = auth;
    next();
  });

  io.on('connection', (socket) => {
    const auth = socket.data.auth as { userId: string; deviceId: string | null; role: string };
    void socket.join(`user:${auth.userId}`);
    if (auth.deviceId) void socket.join(`device:${auth.deviceId}`);

    // Máy Remote gửi khung hình xem trước → chuyển tiếp cho Controller chủ phòng (không lưu lại).
    let lastFrameAt = 0;
    socket.on('preview_frame', async (image) => {
      if (!auth.deviceId || typeof image !== 'string' || image.length > MAX_PREVIEW_BYTES) return;
      if (!image.startsWith('data:image/jpeg;base64,')) return;
      const now = Date.now();
      if (now - lastFrameAt < 400) return; // tối đa ~2 khung/giây mỗi máy
      lastFrameAt = now;
      const m = await membershipOf(auth.deviceId).catch(() => null);
      if (!m) return;
      io?.to(`user:${m.ownerId}`).volatile.emit('preview', {
        room_id: m.roomId,
        member_id: m.memberId,
        device_id: auth.deviceId,
        image,
        at: now,
      });
    });
  });
}

/** Thành viên rời/vào phòng → bỏ cache để khung hình không gửi nhầm phòng. */
export function forgetMembership(deviceId: string) {
  membershipCache.delete(deviceId);
}

export function pushCommand(deviceId: string, cmd: PendingCommand) {
  io?.to(`device:${deviceId}`).emit('command', cmd);
}

export function notifyRoomChanged(ownerId: string, roomId: string, revision: number) {
  io?.to(`user:${ownerId}`).emit('room_changed', { room_id: roomId, revision });
}

export function notifySessionRevoked(userId: string) {
  io?.to(`user:${userId}`).emit('session_revoked');
}
