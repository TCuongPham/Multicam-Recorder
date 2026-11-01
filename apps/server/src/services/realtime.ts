import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { PendingCommand, ServerToClientEvents } from '@multicam/shared';
import { resolveToken } from '../middleware/auth';

let io: Server<Record<string, never>, ServerToClientEvents> | null = null;

/** Socket đẩy lệnh: máy Remote nhận lệnh quay trong dưới 1 giây; Controller được báo phòng thay đổi. */
export function attachRealtime(servers: HttpServer[]) {
  io = new Server({ cors: { origin: true, credentials: true }, serveClient: false });
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
  });
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
