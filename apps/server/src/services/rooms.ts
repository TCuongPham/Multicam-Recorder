import { COMMAND_TTL_MS, type CommandType, type PendingCommand } from '@multicam/shared';
import type { Room } from '@prisma/client';
import { prisma } from '../db';
import { newId } from '../lib/ids';
import { notifyRoomChanged, pushCommand } from './realtime';

/** Tăng revision của phòng (dùng cho tham số since của sync_room). */
export async function bumpRevision(roomId: string, notify = true): Promise<Room> {
  const room = await prisma.room.update({ where: { id: roomId }, data: { revision: { increment: 1 } } });
  if (notify) notifyRoomChanged(room.ownerId, room.id, room.revision);
  return room;
}

/** Xếp một lệnh vào hàng đợi của từng máy và đẩy ngay qua socket nếu đang mở. */
export async function queueCommand(opts: {
  roomId: string | null;
  deviceIds: string[];
  type: CommandType;
  payload?: Record<string, string | number | null>;
  commandId?: string;
  ttlMs?: number;
}): Promise<string> {
  const commandId = opts.commandId ?? newId('cmd', 8);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + (opts.ttlMs ?? COMMAND_TTL_MS));
  const payload = opts.payload ?? {};
  for (const deviceId of opts.deviceIds) {
    await prisma.command.create({
      data: {
        id: newId('cq', 12),
        commandId,
        roomId: opts.roomId,
        deviceId,
        type: opts.type,
        payload: JSON.stringify(payload),
        issuedAt,
        expiresAt,
      },
    });
    const cmd: PendingCommand = { command_id: commandId, type: opts.type, payload, issued_at: issuedAt.toISOString() };
    pushCommand(deviceId, cmd);
  }
  return commandId;
}

/** Thành viên đang ở trong một phòng chưa đóng. */
export function activeMembership(deviceId: string) {
  return prisma.roomMember.findFirst({
    where: { deviceId, leftAt: null, room: { status: { not: 'closed' } } },
    include: { room: true },
  });
}

export function activeMembers(roomId: string) {
  return prisma.roomMember.findMany({ where: { roomId, leftAt: null }, include: { device: true }, orderBy: { joinedAt: 'asc' } });
}

/** Đánh dấu thành viên rời phòng (tự rời / bị loại / phòng đóng). */
export async function markMemberLeft(memberId: string, reason: 'left' | 'kicked' | 'closed') {
  const member = await prisma.roomMember.findUnique({ where: { id: memberId } });
  if (!member || member.leftAt) return null;
  const room = await bumpRevision(member.roomId);
  return prisma.roomMember.update({
    where: { id: memberId },
    data: { leftAt: new Date(), leftReason: reason, leftRev: room.revision, updatedRev: room.revision },
  });
}

/** Rời mọi phòng đang tham gia (đăng xuất / xóa tài khoản). */
export async function leaveAllRooms(deviceIds: string[]) {
  const members = await prisma.roomMember.findMany({ where: { deviceId: { in: deviceIds }, leftAt: null } });
  for (const m of members) await markMemberLeft(m.id, 'left');
}

/** Đóng hẳn phòng: mọi máy rời phòng, mã mời vô hiệu. */
export async function finalizeRoom(roomId: string) {
  const members = await activeMembers(roomId);
  for (const m of members) await markMemberLeft(m.id, 'closed');
  if (members.length) {
    await queueCommand({ roomId, deviceIds: members.map((m) => m.deviceId), type: 'leave_room', payload: { reason: 'closed' } });
  }
  const now = new Date();
  await prisma.recordingSession.updateMany({ where: { roomId, stoppedAt: null }, data: { stoppedAt: now } });
  const room = await prisma.room.update({
    where: { id: roomId },
    data: { status: 'closed', closedAt: now, currentSessionId: null, revision: { increment: 1 } },
  });
  notifyRoomChanged(room.ownerId, room.id, room.revision);
  return room;
}

const CLOSING_TIMEOUT_MS = 10 * 60 * 1000;

/** Phòng đang "closing": chờ các máy ghi xong và upload xong rồi mới đóng hẳn. */
export async function finalizeClosingRooms() {
  const rooms = await prisma.room.findMany({ where: { status: 'closing' } });
  for (const room of rooms) {
    // Cho các máy ít nhất 10 giây để nhận lệnh STOP và bắt đầu upload.
    if (room.closingSince && Date.now() - room.closingSince.getTime() < 10_000) continue;
    const members = await activeMembers(room.id);
    const busy = members.some((m) => {
      const fresh = m.device.lastSeen && Date.now() - m.device.lastSeen.getTime() < 60_000;
      return fresh && (m.device.recordingState === 'recording' || m.device.uploadState === 'uploading');
    });
    const timedOut = room.closingSince && Date.now() - room.closingSince.getTime() > CLOSING_TIMEOUT_MS;
    if (!busy || timedOut) await finalizeRoom(room.id);
  }
}
