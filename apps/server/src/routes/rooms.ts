import { Router, type Request } from 'express';
import type { Device, Room, RoomMember } from '@prisma/client';
import {
  Codes,
  ONLINE_TIMEOUT_MS,
  createRoomSchema,
  joinRoomSchema,
  kickMemberSchema,
  leaveRoomSchema,
  paginationSchema,
  recordingConfigSchema,
  startRecordingSchema,
  stopRecordingSchema,
  switchCameraSchema,
  syncDeviceSchema,
  syncRoomSchema,
  type SyncMember,
} from '@multicam/shared';
import { prisma } from '../db';
import { env } from '../env';
import { newId, newInviteCode, newSessionCode } from '../lib/ids';
import { fail, iso, parse, send } from '../lib/http';
import { auth, requireAuth, requireController } from '../middleware/auth';
import { forgetMembership, notifyRoomChanged, pushCommand } from '../services/realtime';
import {
  activeMembers,
  activeMembership,
  bumpRevision,
  expireSessionIfDue,
  finalizeRoom,
  markMemberLeft,
  parseConfig,
  queueCommand,
  touchMember,
} from '../services/rooms';

export const roomsRouter = Router();
roomsRouter.use(['/rooms', '/devices'], requireAuth);

const isOnline = (d: Pick<Device, 'lastSeen'>) => !!d.lastSeen && Date.now() - d.lastSeen.getTime() < ONLINE_TIMEOUT_MS;
const flag = (b: boolean) => (b ? '1' : '0') as '0' | '1';
const str = (v: number | bigint | null | undefined) => (v === null || v === undefined ? null : String(v));

async function uniqueInviteCode(): Promise<string> {
  for (;;) {
    const code = newInviteCode();
    const clash = await prisma.room.findFirst({ where: { inviteCode: code, status: { not: 'closed' } } });
    if (!clash) return code;
  }
}

/** Phòng do chính Controller đang gọi sở hữu. */
async function ownedRoom(req: Request, opts: { allowClosed?: boolean } = {}): Promise<Room> {
  const a = auth(req);
  const room = await prisma.room.findUnique({ where: { id: String(req.params.room_id) } });
  if (!room) throw fail(Codes.PARAM_VALUE_INVALID, { field: 'room_id' });
  if (room.ownerId !== a.userId) throw fail(Codes.NOT_ROOM_OWNER);
  if (room.status === 'closed' && !opts.allowClosed) throw fail(Codes.ROOM_CLOSED);
  return room;
}

function memberBrief(m: RoomMember & { device: Device }) {
  return { member_id: m.id, camera_name: m.cameraName, is_online: flag(isOnline(m.device)) };
}

function syncMember(m: RoomMember & { device: Device }): SyncMember {
  const d = m.device;
  return {
    member_id: m.id,
    device_id: d.id,
    camera_name: m.cameraName,
    is_online: flag(isOnline(d)),
    battery_level: str(d.batteryLevel),
    is_charging: flag(d.isCharging),
    storage_free: str(d.storageFree),
    recording_state: d.recordingState as SyncMember['recording_state'],
    elapsed_ms: String(d.elapsedMs),
    upload_state: d.uploadState as SyncMember['upload_state'],
    upload_percent: String(d.uploadPercent),
    error_code: d.errorCode,
    camera_facing: d.cameraFacing,
    local_video_uid: d.localVideoUid,
    last_seen: iso(d.lastSeen),
  };
}

/** Lọc thành viên theo target (all | mảng member_id). */
function pickTargets<T extends { id: string }>(members: T[], target: 'all' | string[]): T[] {
  return target === 'all' ? members : members.filter((m) => target.includes(m.id));
}

/** Chống trùng lệnh bằng client_command_id: lần gửi lại trả 1010 kèm kết quả cũ. */
async function dedupe<T>(userId: string, clientCommandId: string, action: string, exec: () => Promise<T>): Promise<{ data: T; duplicate: boolean }> {
  const prev = await prisma.clientCommand.findUnique({ where: { userId_clientCommandId: { userId, clientCommandId } } });
  if (prev) return { data: JSON.parse(prev.response) as T, duplicate: true };
  const data = await exec();
  await prisma.clientCommand.create({ data: { id: newId('cc', 12), userId, clientCommandId, action, response: JSON.stringify(data) } });
  return { data, duplicate: false };
}

// 10. create_room — chỉ Controller; đang có phòng mở thì trả lại đúng phòng cũ.
roomsRouter.post('/rooms', requireController, async (req, res) => {
  const a = auth(req);
  const body = parse(createRoomSchema, req.body);
  let room = await prisma.room.findFirst({
    where: { ownerId: a.userId, status: { in: ['open', 'recording'] } },
    orderBy: { createdAt: 'desc' },
  });
  const inviteExpiresAt = new Date(Date.now() + env.inviteTtlMinutes * 60_000);
  if (!room) {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    room = await prisma.room.create({
      data: {
        id: newId('rm', 8),
        ownerId: a.userId,
        name: body.room_name || `Buoi quay ${p(now.getDate())}/${p(now.getMonth() + 1)}`,
        inviteCode: await uniqueInviteCode(),
        inviteExpiresAt,
        maxMembers: body.max_members ?? 8,
      },
    });
  } else if (room.inviteExpiresAt < new Date()) {
    // Mã mời cũ đã hết hạn: cấp mã mới cho chính phòng này.
    room = await prisma.room.update({ where: { id: room.id }, data: { inviteCode: await uniqueInviteCode(), inviteExpiresAt } });
  }
  const members = await activeMembers(room.id);
  send(res, {
    room_id: room.id,
    room_name: room.name,
    invite_code: room.inviteCode,
    expires_at: room.inviteExpiresAt.toISOString(),
    created_at: room.createdAt.toISOString(),
    status: room.status,
    members: members.map(memberBrief),
  });
});

// 11. join_room — máy Remote nhập mã mời và bắt buộc cấp quyền điều khiển.
roomsRouter.post('/rooms/join', async (req, res) => {
  const a = auth(req);
  if (a.role === 'controller') throw fail(Codes.NOT_ACCESS, { reason: 'controller_cannot_join' });
  const body = parse(joinRoomSchema, req.body);
  const device = await prisma.device.findFirst({ where: { id: body.device_id, userId: a.userId } });
  if (!device) throw fail(Codes.PARAM_VALUE_INVALID, { field: 'device_id' });

  const room = await prisma.room.findFirst({
    where: { inviteCode: body.invite_code, status: { not: 'closed' }, inviteExpiresAt: { gt: new Date() } },
  });
  if (!room) throw fail(Codes.INVITE_NOT_FOUND, { field: 'invite_code' });
  if (room.status === 'closing') throw fail(Codes.ROOM_CLOSED);

  const current = await activeMembership(device.id);
  if (current && current.roomId !== room.id) throw fail(Codes.DEVICE_IN_OTHER_ROOM, { room_id: current.roomId });

  let member = current;
  if (!member) {
    const count = await prisma.roomMember.count({ where: { roomId: room.id, leftAt: null } });
    if (count >= room.maxMembers) throw fail(Codes.ROOM_FULL);
    // Vào phòng mới: xóa trạng thái "Đã lưu clip / Đã upload / lỗi" còn sót của phiên trước.
    const resetStatus = device.recordingState === 'recording' ? {} : { recordingState: 'idle', elapsedMs: 0, localVideoUid: null };
    await prisma.device.update({
      where: { id: device.id },
      data: { cameraName: body.camera_name, lastSeen: new Date(), uploadState: 'none', uploadPercent: 0, errorCode: null, ...resetStatus },
    });
    const created = await prisma.$transaction(async (tx) => {
      const bumped = await tx.room.update({ where: { id: room.id }, data: { revision: { increment: 1 } } });
      return tx.roomMember.create({
        data: {
          id: newId('mb', 8),
          roomId: room.id,
          deviceId: device.id,
          userId: a.userId,
          cameraName: body.camera_name,
          grantControl: true,
          joinedRev: bumped.revision,
          updatedRev: bumped.revision,
        },
      });
    });
    notifyRoomChanged(room.ownerId, room.id, room.revision + 1);
    forgetMembership(device.id);
    member = { ...created, room };
  }
  const members = await activeMembers(room.id);
  send(res, { room_id: room.id, room_name: room.name, member_id: member.id, members: members.map(memberBrief) });
});

// 12. get_room_members — Controller gọi MỘT LẦN khi mở màn hình.
roomsRouter.get('/rooms/:room_id/members', requireController, async (req, res) => {
  const room = await ownedRoom(req);
  const q = parse(paginationSchema, req.query);
  const where = { roomId: room.id, leftAt: null };
  const [total, members] = await Promise.all([
    prisma.roomMember.count({ where }),
    prisma.roomMember.findMany({ where, include: { device: true }, orderBy: { joinedAt: 'asc' }, skip: q.index, take: q.count }),
  ]);
  const data = {
    total: String(total),
    members: members.map((m) => ({
      member_id: m.id,
      device_id: m.deviceId,
      camera_name: m.cameraName,
      is_online: flag(isOnline(m.device)),
      battery_level: str(m.device.batteryLevel),
      storage_free: str(m.device.storageFree),
      recording_state: m.device.recordingState,
    })),
  };
  send(res, data, members.length ? Codes.OK : Codes.NO_DATA);
});

// 13. kick_member — đang quay thì xếp sẵn stop_record để máy ghi xong file và tự upload.
roomsRouter.delete('/rooms/:room_id/members/:member_id', requireController, async (req, res) => {
  const room = await ownedRoom(req);
  parse(kickMemberSchema, req.body);
  const member = await prisma.roomMember.findFirst({
    where: { id: String(req.params.member_id), roomId: room.id, leftAt: null },
    include: { device: true },
  });
  if (!member) throw fail(Codes.PARAM_VALUE_INVALID, { field: 'member_id' });
  const recording = member.device.recordingState === 'recording';
  if (recording) await queueCommand({ roomId: room.id, deviceIds: [member.deviceId], type: 'stop_record', payload: { reason: 'kicked' } });
  await queueCommand({ roomId: room.id, deviceIds: [member.deviceId], type: 'leave_room', payload: { reason: 'kicked' } });
  const left = await markMemberLeft(member.id, 'kicked');
  send(res, { member_id: member.id, removed_at: iso(left?.leftAt ?? new Date()), session_stopped: recording ? 1 : 0 });
});

// 14. leave_room — Remote tự rời phòng bất cứ lúc nào.
roomsRouter.post('/rooms/:room_id/leave', async (req, res) => {
  const a = auth(req);
  const body = parse(leaveRoomSchema, req.body);
  const deviceId = body.device_id || a.deviceId;
  if (!deviceId) throw fail(Codes.PARAM_NOT_ENOUGH, { field: 'device_id' });
  const member = await prisma.roomMember.findFirst({
    where: { roomId: String(req.params.room_id), deviceId, userId: a.userId, leftAt: null },
  });
  if (!member) throw fail(Codes.PARAM_VALUE_INVALID, { field: 'room_id' });
  await markMemberLeft(member.id, 'left');
  send(res, { room_id: member.roomId, device_id: deviceId });
});

// 15. close_room — đang quay thì xếp lệnh STOP, chờ upload xong rồi mới đóng hẳn.
roomsRouter.delete('/rooms/:room_id', requireController, async (req, res) => {
  const room = await ownedRoom(req);
  if (room.status === 'closing') {
    send(res, { closed_at: new Date().toISOString(), session_stopped: 1 });
    return;
  }
  if (room.status === 'recording') {
    const members = await activeMembers(room.id);
    await queueCommand({ roomId: room.id, deviceIds: members.map((m) => m.deviceId), type: 'stop_record', payload: { reason: 'room_closed' } });
    await prisma.recordingSession.updateMany({ where: { roomId: room.id, stoppedAt: null }, data: { stoppedAt: new Date() } });
    await prisma.room.update({
      where: { id: room.id },
      data: { status: 'closing', closingSince: new Date(), currentSessionId: null, inviteExpiresAt: new Date() },
    });
    await bumpRevision(room.id);
    send(res, { closed_at: new Date().toISOString(), session_stopped: 1 });
    return;
  }
  const closed = await finalizeRoom(room.id);
  send(res, { closed_at: iso(closed.closedAt), session_stopped: 0 });
});

// 16. sync_device — Remote đẩy trạng thái lên và nhận pending_commands.
roomsRouter.post('/devices/:device_id/sync', async (req, res) => {
  const a = auth(req);
  const body = parse(syncDeviceSchema, req.body);
  const device = await prisma.device.findFirst({ where: { id: String(req.params.device_id), userId: a.userId } });
  if (!device) throw fail(Codes.NOT_ACCESS, { field: 'device_id' });

  if (body.last_command_id) {
    const last = await prisma.command.findFirst({ where: { deviceId: device.id, commandId: body.last_command_id } });
    if (last) {
      await prisma.command.updateMany({
        where: { deviceId: device.id, ackedAt: null, issuedAt: { lte: last.issuedAt } },
        data: { ackedAt: new Date() },
      });
    }
  }

  await prisma.device.update({
    where: { id: device.id },
    data: {
      batteryLevel: body.battery_level ?? null,
      isCharging: body.is_charging === 1,
      storageFree: body.storage_free === null || body.storage_free === undefined ? null : BigInt(Math.floor(body.storage_free)),
      recordingState: body.recording_state,
      elapsedMs: body.elapsed_ms,
      localVideoUid: body.local_video_uid ?? device.localVideoUid,
      uploadState: body.upload_state,
      uploadPercent: Math.round(body.upload_percent),
      errorCode: body.error_code ?? null,
      cameraFacing: body.camera_facing ?? device.cameraFacing,
      lastCommandId: body.last_command_id ?? device.lastCommandId,
      lastSeen: new Date(),
    },
  });

  let membership = await activeMembership(device.id);
  if (membership?.room.status === 'recording') {
    const room = await expireSessionIfDue(membership.room);
    if (room !== membership.room) membership = { ...membership, room };
  }
  if (membership) {
    // Chỉ báo Controller qua socket khi trạng thái quay/upload đổi; còn lại để nhịp sync_room tự lấy.
    const changed =
      device.recordingState !== body.recording_state ||
      device.uploadState !== body.upload_state ||
      device.cameraFacing !== (body.camera_facing ?? device.cameraFacing) ||
      !device.lastSeen ||
      Date.now() - device.lastSeen.getTime() > 10_000; // máy vừa có kết nối lại
    await touchMember(membership.roomId, membership.id, undefined, changed);
  }

  const commands = await prisma.command.findMany({
    where: { deviceId: device.id, ackedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { issuedAt: 'asc' },
  });
  const user = await prisma.user.findUnique({ where: { id: a.userId }, select: { locked: true } });
  send(res, {
    server_time: new Date().toISOString(),
    next_sync_in: membership ? '3' : '5',
    room_status: {
      in_room: flag(!!membership),
      room_id: membership?.roomId ?? null,
      room_name: membership?.room.name ?? null,
      member_id: membership?.id ?? null,
      session_id: membership?.room.currentSessionId ?? null,
      config: parseConfig(membership?.room.config),
    },
    pending_commands: commands.map((c) => ({
      command_id: c.commandId,
      type: c.type,
      payload: JSON.parse(c.payload),
      issued_at: c.issuedAt.toISOString(),
    })),
    session_revoked: flag(!!user?.locked),
  });
});

// 17. sync_room — Controller lấy trạng thái mới nhất của cả phòng; since = revision lần trước.
roomsRouter.get('/rooms/:room_id/sync', requireController, async (req, res) => {
  const room = await expireSessionIfDue(await ownedRoom(req));
  const q = parse(syncRoomSchema, req.query);
  const since = q.since;
  const [members, joined, left] = await Promise.all([
    prisma.roomMember.findMany({
      where: { roomId: room.id, leftAt: null, ...(since !== undefined ? { updatedRev: { gt: since } } : {}) },
      include: { device: true },
      orderBy: { joinedAt: 'asc' },
    }),
    since !== undefined ? prisma.roomMember.findMany({ where: { roomId: room.id, joinedRev: { gt: since }, leftAt: null }, select: { id: true } }) : [],
    since !== undefined ? prisma.roomMember.findMany({ where: { roomId: room.id, leftRev: { gt: since } }, select: { id: true } }) : [],
  ]);
  const session = room.currentSessionId ? await prisma.recordingSession.findUnique({ where: { id: room.currentSessionId } }) : null;
  send(res, {
    server_time: new Date().toISOString(),
    revision: String(room.revision),
    next_sync_in: '3',
    room: {
      room_id: room.id,
      status: room.status,
      session_id: room.currentSessionId,
      started_at: iso(session?.startedAt),
      invite_code: room.inviteCode,
      // Đang quay: cấu hình của phiên (có max_duration để Controller tự dừng đúng giờ).
      config: parseConfig(session?.config ?? room.config),
    },
    members: members.map(syncMember),
    joined: joined.map((m) => m.id),
    left: left.map((m) => m.id),
  });
});

// 18. start_recording — tạo recording_session chung, xếp lệnh START cho từng máy.
roomsRouter.post('/rooms/:room_id/recording/start', requireController, async (req, res) => {
  const a = auth(req);
  const room = await ownedRoom(req);
  const body = parse(startRecordingSchema, req.body);
  const { data, duplicate } = await dedupe(a.userId, body.client_command_id, 'start_recording', async () => {
    if (room.status === 'closing') throw fail(Codes.ROOM_CLOSED);
    if (room.status === 'recording') throw fail(Codes.INVALID_SESSION_STATE, { session_id: room.currentSessionId });
    const members = pickTargets(await activeMembers(room.id), body.target);
    const online = members.filter((m) => isOnline(m.device));
    const rejected = members.filter((m) => !isOnline(m.device)).map((m) => m.id);
    if (!online.length) throw fail(Codes.NO_DATA, { reason: 'no_device_online', rejected });

    const session = await prisma.recordingSession.create({
      data: { id: newSessionCode(), roomId: room.id, config: JSON.stringify(body.config) },
    });
    await prisma.room.update({
      where: { id: room.id },
      data: { status: 'recording', currentSessionId: session.id, config: JSON.stringify(body.config) },
    });
    const commandId = await queueCommand({
      roomId: room.id,
      deviceIds: online.map((m) => m.deviceId),
      type: 'start_record',
      payload: { session_id: session.id, resolution: body.config.resolution, fps: body.config.fps, max_duration: body.config.max_duration },
    });
    await bumpRevision(room.id);
    return { session_id: session.id, started_at: session.startedAt.toISOString(), command_id: commandId, targets: online.map((m) => m.id), rejected };
  });
  send(res, data, duplicate ? Codes.ACTION_DONE_PREVIOUSLY : Codes.OK);
});

// 19. stop_recording — dừng đồng thời; mỗi máy tự upload sau khi ghi xong file.
roomsRouter.post('/rooms/:room_id/recording/stop', requireController, async (req, res) => {
  const a = auth(req);
  const room = await ownedRoom(req);
  const body = parse(stopRecordingSchema, req.body);
  const { data, duplicate } = await dedupe(a.userId, body.client_command_id, 'stop_recording', async () => {
    if (room.status !== 'recording' || !room.currentSessionId) throw fail(Codes.INVALID_SESSION_STATE);
    const all = await activeMembers(room.id);
    const members = pickTargets(all, body.target);
    const commandId = await queueCommand({
      roomId: room.id,
      deviceIds: members.map((m) => m.deviceId),
      type: 'stop_record',
      payload: { session_id: room.currentSessionId },
    });
    const session = await prisma.recordingSession.findUnique({ where: { id: room.currentSessionId } });
    // Có giới hạn thời gian thì phiên không dài quá giới hạn (máy Remote đã tự dừng đúng lúc).
    const max = parseConfig(session?.config)?.max_duration ?? 0;
    const limitAt = session && max > 0 ? session.startedAt.getTime() + max * 1000 : Infinity;
    const stoppedAt = new Date(Math.min(Date.now(), limitAt));
    if (body.target === 'all' || members.length === all.length) {
      await prisma.recordingSession.update({ where: { id: room.currentSessionId }, data: { stoppedAt } });
      await prisma.room.update({ where: { id: room.id }, data: { status: 'open', currentSessionId: null } });
    }
    await bumpRevision(room.id);
    // Tổng kết chỉ gồm các máy đã nhận lệnh START của phiên này (máy vào phòng sau thì không có clip).
    const started = await prisma.command.findMany({
      where: { roomId: room.id, type: 'start_record', payload: { contains: room.currentSessionId } },
      select: { deviceId: true },
    });
    const startedDevices = new Set(started.map((c) => c.deviceId));
    return {
      session_id: room.currentSessionId,
      started_at: session?.startedAt.toISOString(),
      stopped_at: stoppedAt.toISOString(),
      command_id: commandId,
      results: members
        .filter((m) => startedDevices.has(m.deviceId))
        .map((m) => ({
          member_id: m.id,
          device_id: m.deviceId,
          camera_name: m.cameraName,
          is_online: m.device.lastSeen && Date.now() - m.device.lastSeen.getTime() < ONLINE_TIMEOUT_MS ? '1' : '0',
          local_video_uid: m.device.localVideoUid,
          duration_ms: String(session ? stoppedAt.getTime() - session.startedAt.getTime() : m.device.elapsedMs),
          size: null,
          status: m.device.recordingState === 'recording' ? 'saved' : m.device.recordingState,
        })),
    };
  });
  send(res, data, duplicate ? Codes.ACTION_DONE_PREVIOUSLY : Codes.OK);
});

// Mở rộng: Controller đổi cấu hình quay trong menu → lưu vào phòng và báo ngay cho các máy Remote.
roomsRouter.post('/rooms/:room_id/config', requireController, async (req, res) => {
  const room = await ownedRoom(req);
  const config = parse(recordingConfigSchema, req.body);
  if (room.status === 'recording') throw fail(Codes.INVALID_SESSION_STATE);
  await prisma.room.update({ where: { id: room.id }, data: { config: JSON.stringify(config) } });
  // Không cần xếp hàng đợi: máy Remote đọc lại cấu hình ở mỗi lần sync_device; socket chỉ để cập nhật tức thì.
  const issuedAt = new Date().toISOString();
  for (const m of await activeMembers(room.id)) {
    pushCommand(m.deviceId, { command_id: newId('cfg', 10), type: 'set_config', payload: config, issued_at: issuedAt });
  }
  send(res, { config });
});

// Mở rộng: Controller ra lệnh lật camera trước/sau cho máy Remote (không cho lật khi đang quay).
roomsRouter.post('/rooms/:room_id/camera', requireController, async (req, res) => {
  const a = auth(req);
  const room = await ownedRoom(req);
  const body = parse(switchCameraSchema, req.body);
  const { data, duplicate } = await dedupe(a.userId, body.client_command_id, 'switch_camera', async () => {
    if (room.status === 'recording') throw fail(Codes.INVALID_SESSION_STATE);
    const members = pickTargets(await activeMembers(room.id), body.target);
    if (!members.length) throw fail(Codes.NO_DATA);
    const commandId = await queueCommand({
      roomId: room.id,
      deviceIds: members.map((m) => m.deviceId),
      type: 'switch_camera',
      payload: { facing: body.facing },
    });
    return { command_id: commandId, targets: members.map((m) => m.id) };
  });
  send(res, data, duplicate ? Codes.ACTION_DONE_PREVIOUSLY : Codes.OK);
});
