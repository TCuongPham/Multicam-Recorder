import { COMMAND_TTL_MS, type CommandType, type PendingCommand, type RoomConfig } from '@multicam/shared';
import type { Room } from '@prisma/client';
import { prisma } from '../db';
import { newId } from '../lib/ids';
import { forgetMembership, notifyRoomChanged, pushCommand } from './realtime';

/** Tăng revision của phòng (dùng cho tham số since của sync_room). */
export async function bumpRevision(roomId: string, notify = true): Promise<Room> {
  const room = await prisma.room.update({ where: { id: roomId }, data: { revision: { increment: 1 } } });
  if (notify) notifyRoomChanged(room.ownerId, room.id, room.revision);
  return room;
}

/**
 * Tăng revision và gắn revision mới cho dòng thành viên trong CÙNG một transaction.
 * Nếu tách làm hai lệnh ghi, sync_room có thể đọc revision mới nhưng chưa thấy thành viên được cập nhật
 * → Controller lưu since = revision mới và bỏ lỡ thay đổi đó mãi mãi.
 */
export async function touchMember(
  roomId: string,
  memberId: string,
  data: (revision: number) => Parameters<typeof prisma.roomMember.update>[0]['data'] = (rev) => ({ updatedRev: rev }),
  notify = true,
) {
  const [room, member] = await prisma.$transaction(async (tx) => {
    const r = await tx.room.update({ where: { id: roomId }, data: { revision: { increment: 1 } } });
    const m = await tx.roomMember.update({ where: { id: memberId }, data: data(r.revision) });
    return [r, m] as const;
  });
  if (notify) notifyRoomChanged(room.ownerId, room.id, room.revision);
  return { room, member };
}

/** Đọc cấu hình quay (JSON) của phòng hoặc phiên quay. */
export function parseConfig(json: string | null | undefined): RoomConfig | null {
  if (!json) return null;
  try {
    const c = JSON.parse(json) as Partial<RoomConfig>;
    return { resolution: String(c.resolution ?? '1920x1080'), fps: Number(c.fps ?? 30), max_duration: Number(c.max_duration ?? 0) };
  } catch {
    return null;
  }
}

/** Cho máy Remote quá giới hạn mới bị coi là quá hạn (Controller thường tự dừng đúng lúc). */
const EXPIRE_GRACE_MS = 5000;

/**
 * Phiên có giới hạn thời gian đã quá hạn mà Controller chưa bấm dừng (ví dụ đóng màn hình):
 * server tự kết thúc phiên để trạng thái phòng không kẹt ở "đang quay".
 */
export async function expireSessionIfDue(room: Room): Promise<Room> {
  if (room.status !== 'recording' || !room.currentSessionId) return room;
  const session = await prisma.recordingSession.findUnique({ where: { id: room.currentSessionId } });
  const max = parseConfig(session?.config)?.max_duration ?? 0;
  if (!session || max <= 0 || Date.now() < session.startedAt.getTime() + max * 1000 + EXPIRE_GRACE_MS) return room;
  await prisma.recordingSession.update({ where: { id: session.id }, data: { stoppedAt: new Date(session.startedAt.getTime() + max * 1000) } });
  const updated = await prisma.room.updateMany({ where: { id: room.id, currentSessionId: session.id }, data: { status: 'open', currentSessionId: null } });
  if (updated.count) {
    const members = await activeMembers(room.id);
    await queueCommand({ roomId: room.id, deviceIds: members.map((m) => m.deviceId), type: 'stop_record', payload: { session_id: session.id, reason: 'max_duration' } });
  }
  return bumpRevision(room.id);
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
  forgetMembership(member.deviceId);
  const { member: left } = await touchMember(member.roomId, memberId, (rev) => ({
    leftAt: new Date(),
    leftReason: reason,
    leftRev: rev,
    updatedRev: rev,
  }));
  return left;
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
