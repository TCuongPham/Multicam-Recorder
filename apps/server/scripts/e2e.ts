// Kiểm thử đầu-cuối cả 28 API trên server đang chạy: npm run test:e2e -w @multicam/server
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { ApiClient, ApiError, Codes, sleep, uuid, type Tokens, type TokenStore } from '@multicam/shared';

const BASE = process.env.API_URL ?? 'http://localhost:3000';
let passed = 0;

function memoryTokens(): TokenStore {
  let t: Tokens | null = null;
  return { get: async () => t, set: async (v) => void (t = v) };
}
const client = () => new ApiClient({ baseUrl: () => BASE, tokens: memoryTokens() });

function ok(cond: unknown, label: string) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

async function expectCode(p: Promise<unknown>, code: string, label: string) {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError && e.code === code) return ok(true, `${label} → ${code}`);
    throw new Error(`FAIL: ${label}: expected ${code}, got ${(e as ApiError).code} ${(e as Error).message}`);
  }
  throw new Error(`FAIL: ${label}: expected ${code}, got success`);
}

const sha = (b: Uint8Array) =>crypto.createHash('sha256').update(b).digest('hex');

function makeVideo(seconds: number, bitrate: string): Buffer {
  const out = path.join(os.tmpdir(), `multicam-e2e-${seconds}.mp4`);
  const r = spawnSync(ffmpegPath as unknown as string, [
    '-y', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${seconds},noise=alls=40:allf=t+u`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-b:v', bitrate, '-minrate', bitrate, '-maxrate', bitrate, '-bufsize', bitrate,
    '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-movflags', 'frag_keyframe+empty_moov', out,
  ]);
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr?.toString().slice(-500));
  return fs.readFileSync(out);
}

async function uploadClip(api: ApiClient, file: Buffer, deviceId: string, sessionId: string | null, opts: { corruptFirst?: boolean } = {}) {
  const uid = uuid();
  const recordedAt = new Date().toISOString();
  const checksum = sha(file);
  const init = await api.initUpload({
    file_name: `${uid}.mp4`,
    file_size: file.length,
    mime_type: 'video/mp4',
    checksum_sha256: checksum,
    metadata: { local_video_uid: uid, device_id: deviceId, camera_name: 'Cam Trái', session_id: sessionId, recorded_at: recordedAt, duration_ms: 1000, resolution: '1280x720', fps: 30, clock_offset_ms: 12 },
  });
  // Uint8Array (không phải Buffer dùng chung pool) để làm BlobPart.
  const chunks = Array.from({ length: init.total_chunks }, (_, i) => new Uint8Array(file.subarray(i * init.chunk_size, (i + 1) * init.chunk_size)));
  if (opts.corruptFirst) {
    await expectCode(api.uploadChunk(init.upload_id!, 0, new Blob([chunks[0]]), sha(Buffer.from('x'))), Codes.CHECKSUM_MISMATCH, 'upload_chunk sai checksum mảnh');
  }
  await api.uploadChunk(init.upload_id!, 0, new Blob([chunks[0]]), sha(chunks[0]));
  if (chunks.length > 1) {
    await expectCode(api.completeUpload(init.upload_id!), Codes.MISSING_CHUNKS, 'complete_upload khi còn thiếu mảnh');
    const status = await api.getUploadStatus(init.upload_id!);
    ok(status.missing_chunks.length === chunks.length - 1 && status.received_chunks[0] === 0, 'get_upload_status trả đúng missing_chunks');
    for (const i of status.missing_chunks) await api.uploadChunk(init.upload_id!, i, new Blob([chunks[i]]), sha(chunks[i]));
  }
  const done = await api.completeUpload(init.upload_id!);
  return { uid, checksum, done, init };
}

async function main() {
  console.log(`E2E → ${BASE}`);
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  ok(health.code === '1000', 'server sống');

  // ---------- A. Tài khoản ----------
  console.log('A. Xác thực và tài khoản');
  const remote = client();
  const phone = '09' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const email = `remote${Date.now()}@test.vn`;
  await expectCode(remote.signup({ first_name: 'An', last_name: 'Nguyen', email, phone, password: phone }), Codes.PARAM_VALUE_INVALID, 'signup mật khẩu trùng số điện thoại');
  const su = await remote.signup({ first_name: 'An', last_name: 'Nguyen', email, phone, password: 'abc123' });
  ok(su.account_role === 'remote' && su.verify_required === '1', 'signup → tài khoản Remote, cần xác thực');
  await expectCode(remote.signup({ first_name: 'B', last_name: 'C', email: 'admin@multicam.local', phone: '0900000001', password: 'abc123' }), Codes.USER_EXISTED, 'signup email đã có');
  const deviceUidA = uuid();
  await expectCode(remote.login({ email, password: 'abc123', device_id: deviceUidA, device_type: 4, device_name: 'Web A' }), Codes.USER_NOT_VALIDATED, 'login khi chưa kích hoạt');
  const vc = await remote.getVerifyCode({ email, purpose: 'signup' });
  ok(/^\d{6}$/.test(vc.code_verify) && vc.masked_target.includes('***'), 'get_verify_code trả mã 6 số');
  await expectCode(remote.getVerifyCode({ email, purpose: 'signup' }), Codes.LIMITED_ACCESS, 'gọi lại get_verify_code trong 120 giây');
  const wrong = vc.code_verify === '000000' ? '111111' : '000000';
  await expectCode(remote.checkVerifyCode({ email, code_verify: wrong }), Codes.VERIFY_CODE_INCORRECT, 'check_verify_code sai mã');
  const checked = await remote.checkVerifyCode({ email, code_verify: vc.code_verify, device_id: deviceUidA, device_type: 4, device_name: 'Web A' });
  ok(checked.active === '1' && checked.access_token && checked.device?.device_id, 'check_verify_code kích hoạt + trả token');

  await expectCode(remote.login({ email, password: 'wrong1', device_id: deviceUidA, device_type: 4, device_name: 'Web A' }), Codes.PARAM_VALUE_INVALID, 'login sai mật khẩu');
  const loginA = await remote.login({ phone, password: 'abc123', device_id: deviceUidA, device_type: 4, device_name: 'Web A' });
  ok(loginA.account_role === 'remote' && loginA.device.device_id.startsWith('dv_'), 'login Remote bằng số điện thoại');
  const deviceA = loginA.device.device_id;
  ok(await remote.refresh(), 'refresh_token cấp lại access_token');

  const ctrl = client();
  const loginC = await ctrl.login({ email: 'admin', password: 'admin', device_id: uuid(), device_type: 4, device_name: 'Controller Web' });
  ok(loginC.account_role === 'controller', 'login admin/admin → Controller');

  // ---------- B. Phòng ----------
  console.log('B. Phòng và mã mời');
  await expectCode(remote.createRoom({}), Codes.NOT_ACCESS, 'Remote gọi create_room');
  const stale = await ctrl.createRoom({}); // dọn phòng còn sót từ lần chạy trước
  await ctrl.closeRoom(stale.room_id);
  const room = await ctrl.createRoom({ room_name: 'Buoi quay test' });
  ok(room.room_id !== stale.room_id, 'đóng phòng cũ rồi tạo phòng mới');
  ok(/^[A-Z0-9]{6}$/.test(room.invite_code), `create_room → mã mời ${room.invite_code}`);
  const room2 = await ctrl.createRoom({});
  ok(room2.room_id === room.room_id, 'create_room lần 2 trả lại đúng phòng cũ');
  await expectCode(remote.joinRoom({ invite_code: 'ZZZZZZ', device_id: deviceA, camera_name: 'Cam Trai', grant_control: true }), Codes.INVITE_NOT_FOUND, 'join_room sai mã');
  await expectCode(remote.joinRoom({ invite_code: room.invite_code, device_id: deviceA, camera_name: 'Cam Trai', grant_control: false as never }), Codes.PARAM_VALUE_INVALID, 'join_room không cấp quyền điều khiển');
  const joined = await remote.joinRoom({ invite_code: room.invite_code.toLowerCase(), device_id: deviceA, camera_name: 'Cam Trai', grant_control: true });
  ok(joined.member_id.startsWith('mb_'), 'join_room thành công');
  const members = await ctrl.getRoomMembers(room.room_id);
  ok(members.total === '1' && members.members[0].camera_name === 'Cam Trai', 'get_room_members');

  // ---------- C. Đồng bộ ----------
  console.log('C. Đồng bộ và điều khiển quay');
  const raw = await fetch(`${BASE}/devices/${deviceA}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${(await remote.getAccessToken())!}` },
    body: JSON.stringify({ battery_level: '80', recording_state: 'idle' }),
  }).then((r) => r.json());
  ok(raw.code === Codes.PARAM_TYPE_INVALID, 'sync_device battery_level dạng chuỗi → 1003');
  let s = await remote.syncDevice(deviceA, { battery_level: 87, storage_free: 12884901888, recording_state: 'idle' });
  ok(s.room_status.in_room === '1' && s.room_status.room_id === room.room_id, 'sync_device: đang trong phòng');
  const rs1 = await ctrl.syncRoom(room.room_id);
  ok(rs1.members[0].battery_level === '87' && rs1.members[0].is_online === '1', 'sync_room thấy pin + online');
  const rev = Number(rs1.revision);
  const rsEmpty = await ctrl.syncRoom(room.room_id, rev);
  ok(rsEmpty.members.length === 0, 'sync_room since=revision chỉ trả phần thay đổi');

  // Cấu hình trong menu Controller tới máy Remote trước khi quay (mở rộng).
  await ctrl.setRoomConfig(room.room_id, { resolution: '3840x2160', fps: 60, max_duration: 0 });
  s = await remote.syncDevice(deviceA, { recording_state: 'idle' });
  ok(s.room_status.config?.resolution === '3840x2160' && s.room_status.config?.fps === 60, 'sync_device nhận cấu hình Controller đang chọn');
  ok((await ctrl.syncRoom(room.room_id)).room.config?.fps === 60, 'sync_room trả lại cấu hình đã lưu của phòng');
  const camIdle = await ctrl.switchCamera(room.room_id, { facing: 'front', client_command_id: uuid() });
  ok(camIdle.targets.length === 1, 'lật camera khi chưa quay (lệnh mở rộng)');

  const startId = uuid();
  await expectCode(remote.startRecording(room.room_id, { client_command_id: startId }), Codes.NOT_ACCESS, 'Remote gọi start_recording');
  const start = await ctrl.startRecording(room.room_id, { target: 'all', config: { resolution: '1280x720', fps: 30, max_duration: 0 }, client_command_id: startId });
  ok(start.session_id.startsWith('S') && start.targets.length === 1, `start_recording → phiên ${start.session_id}`);
  const dup = await ctrl.request('POST', `/rooms/${room.room_id}/recording/start`, { body: { client_command_id: startId }, accept: [Codes.ACTION_DONE_PREVIOUSLY] });
  ok(dup.code === Codes.ACTION_DONE_PREVIOUSLY, 'start_recording trùng client_command_id → 1010');
  await expectCode(ctrl.startRecording(room.room_id, { client_command_id: uuid() }), Codes.INVALID_SESSION_STATE, 'start_recording khi đang quay');
  s = await remote.syncDevice(deviceA, { recording_state: 'idle' });
  const startCmd = s.pending_commands.find((c) => c.type === 'start_record');
  ok(startCmd && startCmd.payload.session_id === start.session_id && s.room_status.session_id === start.session_id, 'sync_device nhận lệnh start_record');
  s = await remote.syncDevice(deviceA, { recording_state: 'recording', elapsed_ms: 3200, last_command_id: startCmd!.command_id });
  ok(!s.pending_commands.some((c) => c.command_id === startCmd!.command_id), 'lệnh đã thực hiện không bị gửi lại');
  await expectCode(ctrl.switchCamera(room.room_id, { facing: 'back', client_command_id: uuid() }), Codes.INVALID_SESSION_STATE, 'không lật camera khi đang quay');
  await expectCode(ctrl.setRoomConfig(room.room_id, { resolution: '1920x1080', fps: 30, max_duration: 0 }), Codes.INVALID_SESSION_STATE, 'không đổi cấu hình khi đang quay');
  const stop = await ctrl.stopRecording(room.room_id, { client_command_id: uuid() });
  ok(stop.results[0].status === 'saved', 'stop_recording');
  s = await remote.syncDevice(deviceA, { recording_state: 'recording', elapsed_ms: 5000 });
  ok(s.pending_commands.some((c) => c.type === 'stop_record') && s.room_status.session_id === null, 'sync_device nhận lệnh stop_record');

  // Giới hạn thời gian: Controller không bấm Dừng thì server tự kết thúc phiên sau giới hạn (+5 giây chờ).
  const limited = await ctrl.startRecording(room.room_id, { target: 'all', config: { resolution: '1280x720', fps: 30, max_duration: 1 }, client_command_id: uuid() });
  ok((await ctrl.syncRoom(room.room_id)).room.config?.max_duration === 1, 'sync_room trả max_duration của phiên đang quay');
  await sleep(6500);
  const rsExpired = await ctrl.syncRoom(room.room_id);
  ok(rsExpired.room.status === 'open' && rsExpired.room.session_id === null, `phiên ${limited.session_id} tự kết thúc khi hết giới hạn`);
  await expectCode(ctrl.stopRecording(room.room_id, { client_command_id: uuid() }), Codes.INVALID_SESSION_STATE, 'stop_recording sau khi phiên đã tự kết thúc');
  s = await remote.syncDevice(deviceA, { recording_state: 'idle' });

  // ---------- D. Upload ----------
  console.log('D. Tự động upload');
  const big = makeVideo(12, '6M');
  ok(big.length > 5 * 1024 * 1024, `video test ${(big.length / 1048576).toFixed(1)} MB (nhiều mảnh)`);
  await expectCode(
    remote.initUpload({ file_name: 'a.mp4', file_size: 1073741825, mime_type: 'video/mp4', checksum_sha256: sha(big), metadata: { local_video_uid: uuid(), device_id: deviceA, camera_name: 'x', recorded_at: new Date().toISOString(), duration_ms: 1, resolution: '1x1', fps: 1 } }),
    Codes.FILE_TOO_BIG,
    'init_upload file > 1 GB',
  );
  await expectCode(
    remote.initUpload({ file_name: 'a.mov', file_size: 10, mime_type: 'video/quicktime', checksum_sha256: sha(big), metadata: { local_video_uid: uuid(), device_id: deviceA, camera_name: 'x', recorded_at: new Date().toISOString(), duration_ms: 1, resolution: '1x1', fps: 1 } }),
    Codes.PARAM_VALUE_INVALID,
    'init_upload không phải MP4',
  );
  const up1 = await uploadClip(remote, big, deviceA, start.session_id, { corruptFirst: true });
  ok(up1.done.video_id.startsWith('vd_') && up1.done.thumbnail_url, 'complete_upload → video + thumbnail');
  ok(up1.done.duration_ms > 11000 && up1.done.duration_ms < 13000, `ffprobe đọc thời lượng ${up1.done.duration_ms} ms`);
  const again = await remote.initUpload({
    file_name: 'x.mp4', file_size: big.length, mime_type: 'video/mp4', checksum_sha256: up1.checksum,
    metadata: { local_video_uid: up1.uid, device_id: deviceA, camera_name: 'Cam Trái', recorded_at: new Date().toISOString(), duration_ms: 1, resolution: '1x1', fps: 1 },
  });
  ok(again.already_uploaded === 1 && again.video_id === up1.done.video_id, 'init_upload lần 2 → already_uploaded = 1');
  const small = makeVideo(2, '1M');
  const up2 = await uploadClip(remote, small, deviceA, start.session_id);
  ok(up2.done.video_id !== up1.done.video_id, 'upload clip thứ hai (1 mảnh)');

  // ---------- E. Thư viện ----------
  console.log('E. Thư viện video');
  const listC = await ctrl.getListVideos({ index: 0, count: 1, session_id: start.session_id });
  ok(listC.total === 2 && listC.videos.length === 1, 'get_list_videos phân trang index/count');
  const listR = await remote.getListVideos({ session_id: start.session_id });
  ok(listR.total === 2, 'Remote thấy clip của chính mình');
  const detail = await ctrl.getVideo(up1.done.video_id);
  ok(detail.codec.includes('h264') && detail.resolution === '1280x720' && detail.clock_offset_ms === 12, 'get_video: codec, độ phân giải, lệch đồng hồ');
  const ranged = await fetch(detail.url, { headers: { Range: 'bytes=0-99' } });
  ok(ranged.status === 206, 'URL phát có chữ ký hỗ trợ Range');
  const thumb = await fetch(detail.thumbnail_url!);
  ok(thumb.status === 200 && thumb.headers.get('content-type')?.includes('jpeg'), 'thumbnail .jpg');
  ok((await fetch(detail.url.replace(/sig=[^&]+/, 'sig=bad'))).status !== 200, 'URL sai chữ ký bị chặn');

  await expectCode(remote.getDownloadUrl(up1.done.video_id), Codes.NOT_ACCESS, 'Remote gọi get_download_url');
  const dl1 = await ctrl.getDownloadUrl(up1.done.video_id);
  await expectCode(ctrl.getDownloadUrl(up2.done.video_id), Codes.DOWNLOAD_IN_PROGRESS, 'xin link clip khác khi đang tải');
  const file = Buffer.from(await (await fetch(dl1.download_url)).arrayBuffer());
  ok(sha(file) === dl1.checksum_sha256, 'tải về đúng checksum');
  await new Promise((r) => setTimeout(r, 300));
  const dl2 = await ctrl.getDownloadUrl(up2.done.video_id);
  ok(!!dl2.download_url, 'tải xong clip 1 thì xin được link clip 2');
  await fetch(dl2.download_url).then((r) => r.arrayBuffer());
  const after = await ctrl.getListVideos({ session_id: start.session_id });
  ok(after.videos.every((v) => v.downloaded_by_controller === 1), 'downloaded_by_controller = 1');

  await expectCode(remote.deleteVideo(up1.done.video_id), Codes.NOT_ACCESS, 'Remote gọi delete_video');
  const del = await ctrl.deleteVideo(up1.done.video_id);
  ok(del.video_id === up1.done.video_id, 'delete_video');
  await expectCode(ctrl.getVideo(up1.done.video_id), Codes.VIDEO_NOT_FOUND, 'get_video clip đã xóa');
  await expectCode(ctrl.deleteVideosBulk(Array.from({ length: 51 }, (_, i) => `vd_${i}`)), Codes.PARAM_VALUE_INVALID, 'bulk delete quá 50 clip');
  const bulk = await ctrl.deleteVideosBulk([up2.done.video_id, 'vd_notexist']);
  ok(bulk.deleted.length === 1 && bulk.failed[0].reason === 'NOT_FOUND', 'delete_videos_bulk: xóa 1, lỗi 1');
  const empty = await ctrl.getListVideos({ session_id: start.session_id });
  ok(empty.total === 0, 'thư viện trống → 9994 được xử lý như rỗng');

  // ---------- B (tiếp). Loại / rời / đóng phòng ----------
  console.log('B. Loại, rời, đóng phòng');
  await remote.syncDevice(deviceA, { recording_state: 'saved', upload_state: 'uploaded', upload_percent: 100 });
  const kick = await ctrl.kickMember(room.room_id, joined.member_id, 'test');
  ok(kick.member_id === joined.member_id, 'kick_member');
  s = await remote.syncDevice(deviceA, { recording_state: 'idle' });
  ok(s.room_status.in_room === '0' && s.pending_commands.some((c) => c.type === 'leave_room'), 'máy bị loại nhận leave_room');
  const rsLeft = await ctrl.syncRoom(room.room_id, rev);
  ok(rsLeft.left.includes(joined.member_id), 'sync_room: máy bị loại nằm trong mảng left');
  const rejoin = await remote.joinRoom({ invite_code: room.invite_code, device_id: deviceA, camera_name: 'Cam Phai', grant_control: true });
  const afterRejoin = (await ctrl.syncRoom(room.room_id)).members.find((m) => m.member_id === rejoin.member_id);
  ok(afterRejoin?.upload_state === 'none' && afterRejoin.recording_state === 'idle', 'vào lại phòng: xóa trạng thái "Đã lưu clip / Đã upload" cũ');
  const left = await remote.leaveRoom(room.room_id, deviceA);
  ok(left.device_id === deviceA && rejoin.member_id !== joined.member_id, 'leave_room');
  const closed = await ctrl.closeRoom(room.room_id);
  ok(closed.session_stopped === 0, 'close_room');
  await expectCode(ctrl.syncRoom(room.room_id), Codes.ROOM_CLOSED, 'sync_room phòng đã đóng');

  // ---------- A (tiếp). Mật khẩu, đăng xuất, xóa tài khoản ----------
  console.log('A. Mật khẩu, đăng xuất, xóa tài khoản');
  const remoteB = client();
  await remoteB.login({ email, password: 'abc123', device_id: uuid(), device_type: 1, device_name: 'Android B' });
  await expectCode(remote.changePassword({ old_password: 'sai123', new_password: 'xyz789' }), Codes.PARAM_VALUE_INVALID, 'change_password sai mật khẩu cũ');
  await remote.changePassword({ old_password: 'abc123', new_password: 'xyz789' });
  ok(!!(await remote.getListVideos({})), 'thiết bị vừa đổi mật khẩu vẫn giữ phiên');
  await expectCode(remoteB.getListVideos({}), Codes.TOKEN_INVALID, 'thiết bị khác bị đăng xuất ở lần gọi kế tiếp');
  await expectCode(remote.getVerifyCode({ email: 'khongco@test.vn', purpose: 'forgot_password' }), Codes.USER_NOT_VALIDATED, 'quên mật khẩu với tài khoản không tồn tại');
  const fvc = await remote.getVerifyCode({ phone, purpose: 'forgot_password' });
  await remote.forgotPassword({ phone, code_verify: fvc.code_verify, new_password: 'newpw1' });
  ok(true, 'forgot_password đặt lại mật khẩu');
  const remoteC = client();
  const loginNew = await remoteC.login({ email, password: 'newpw1', device_id: uuid(), device_type: 2, device_name: 'iPhone' });
  ok(!!loginNew.access_token, 'đăng nhập bằng mật khẩu mới');

  const m = await fetch(`${BASE}/auth/login`, { method: 'GET' }).then((r) => r.json());
  ok(m.code === Codes.METHOD_INVALID, 'sai HTTP method → 9997');
  await expectCode(ctrl.deleteAccount('admin'), Codes.NOT_ACCESS, 'không xóa được tài khoản Controller');
  await expectCode(remoteC.deleteAccount('sai'), Codes.PARAM_VALUE_INVALID, 'xóa tài khoản sai mật khẩu');
  const gone = await remoteC.deleteAccount('newpw1');
  ok(!!gone.deleted_at, 'delete_account');
  await expectCode(client().login({ email, password: 'newpw1', device_id: uuid(), device_type: 4, device_name: 'x' }), Codes.USER_NOT_VALIDATED, 'tài khoản đã xóa không đăng nhập được');
  await ctrl.logout();
  ok(true, 'logout');

  console.log(`\nĐẠT ${passed} kiểm tra.`);
}

main().catch((e) => {
  console.error('\n' + (e as Error).message);
  process.exit(1);
});
