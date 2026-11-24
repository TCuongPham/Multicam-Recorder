import type { ApiClient, ApiError } from '../api';
import { Codes } from '../codes';
import { COMMAND_TTL_MS, DEFAULT_SYNC_SECONDS, type CameraFacing, type RecordingState, type UploadState } from '../constants';
import type { PendingCommand, RoomConfig, SyncDeviceResult } from '../types';
import { Emitter, type KeyValueStore } from '../utils';

export interface StartRecordingOptions {
  sessionId: string | null;
  resolution: string;
  fps: number;
  /** Giờ server tại thời điểm bắt đầu quay (đã bù lệch đồng hồ). */
  serverStartedAt: string;
  clockOffsetMs: number;
}

/** Phần quay video phụ thuộc nền tảng (vision-camera trên app, MediaRecorder trên web). */
export interface RecorderAdapter {
  startRecording(opts: StartRecordingOptions): Promise<void>;
  /** Dừng quay; file được nền tảng tự lưu rồi gọi `agent.reportRecording('saved', ...)`. */
  stopRecording(): Promise<void>;
  switchCamera(facing: CameraFacing | 'toggle'): Promise<void>;
  /** Controller đổi cấu hình trong menu (chỉ gọi khi đang không quay): chuẩn bị camera theo cấu hình mới. */
  applyConfig?(config: { resolution: string; fps: number }): void;
}

export interface DeviceStatus {
  battery_level: number | null;
  is_charging: 0 | 1;
  storage_free: number | null;
  camera_facing?: CameraFacing;
}

export interface RemoteAgentDeps {
  api: ApiClient;
  kv: KeyValueStore;
  recorder: RecorderAdapter;
  getDeviceStatus: () => Promise<DeviceStatus>;
  getUploadStatus: () => { upload_state: UploadState; upload_percent: number };
  onSessionRevoked?: () => void;
  /** Bắt đầu phiên mới (vào phòng / bắt đầu quay): xóa kết quả upload cũ để Controller không thấy trạng thái của lần trước. */
  onStatusReset?: () => void;
}

export interface RemoteAgentState {
  deviceId: string | null;
  running: boolean;
  paused: boolean;
  online: boolean;
  inRoom: boolean;
  roomId: string | null;
  roomName: string | null;
  memberId: string | null;
  roomSessionId: string | null;
  /** Cấu hình quay Controller đang chọn cho phòng. */
  roomConfig: RoomConfig | null;
  recordingState: RecordingState;
  recordingSessionId: string | null;
  recordingStartedAt: number | null;
  localVideoUid: string | null;
  errorCode: string | null;
  clockOffsetMs: number;
  lastSyncAt: number | null;
  nextSyncIn: number;
  lastCommand: { type: string; at: number } | null;
  lastError: string | null;
}

// Tách theo thiết bị: nhiều tài khoản / tab trên cùng một máy không dùng chung danh sách lệnh đã chạy.
const executedKey = (deviceId: string) => `remote.executed_commands.${deviceId}`;
const MAX_EXECUTED = 200;

/**
 * Bộ não của máy Remote: gọi sync_device theo nhịp next_sync_in, đọc hàng đợi lệnh,
 * chống trùng bằng command_id, bỏ lệnh cũ hơn 30 giây, tính lệch đồng hồ.
 * Lệnh tới qua socket cũng đi vào cùng một đường xử lý.
 */
export class RemoteAgent {
  private state: RemoteAgentState = {
    deviceId: null,
    running: false,
    paused: false,
    online: true,
    inRoom: false,
    roomId: null,
    roomName: null,
    memberId: null,
    roomSessionId: null,
    roomConfig: null,
    recordingState: 'idle',
    recordingSessionId: null,
    recordingStartedAt: null,
    localVideoUid: null,
    errorCode: null,
    clockOffsetMs: 0,
    lastSyncAt: null,
    nextSyncIn: DEFAULT_SYNC_SECONDS,
    lastCommand: null,
    lastError: null,
  };
  private readonly emitter = new Emitter<RemoteAgentState>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  /** Đã gửi lệnh dừng cho recorder, đang chờ file ghi xong: không gọi dừng lần hai (vision-camera báo lỗi). */
  private stoppingAt = 0;
  /** Cấu hình (resolution|fps) đã báo cho recorder, tránh báo lại ở mỗi nhịp sync. */
  private appliedConfigKey = '';
  private syncAgain = false;
  private executed: string[] = [];
  private lastCommandId: string | null = null;
  private commandChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RemoteAgentDeps) {}

  subscribe = this.emitter.subscribe;
  getState = (): RemoteAgentState => this.state;

  private set(patch: Partial<RemoteAgentState>) {
    this.state = { ...this.state, ...patch };
    this.emitter.emit(this.state);
  }

  async start(deviceId: string) {
    if (this.state.running && this.state.deviceId === deviceId) return;
    try {
      this.executed = JSON.parse((await this.deps.kv.get(executedKey(deviceId))) || '[]');
    } catch {
      this.executed = [];
    }
    this.set({ deviceId, running: true, paused: false });
    void this.syncNow();
  }

  stop() {
    this.clearTimer();
    this.set({ running: false });
  }

  /** Ứng dụng vào nền: tạm dừng bộ đếm nhịp sync. */
  pause() {
    this.clearTimer();
    this.set({ paused: true });
  }

  resume() {
    if (!this.state.running) return;
    this.set({ paused: false });
    void this.syncNow();
  }

  /** Thời gian theo đồng hồ server. */
  serverNow(): number {
    return Date.now() + this.state.clockOffsetMs;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(seconds: number) {
    this.clearTimer();
    if (!this.state.running || this.state.paused) return;
    const s = Math.min(30, Math.max(1, seconds || DEFAULT_SYNC_SECONDS));
    this.timer = setTimeout(() => void this.syncNow(), s * 1000);
  }

  async syncNow(): Promise<void> {
    if (!this.state.running || !this.state.deviceId) return;
    if (this.inFlight) {
      this.syncAgain = true;
      return;
    }
    this.inFlight = true;
    this.clearTimer();
    let next = this.state.nextSyncIn;
    try {
      const status = await this.deps.getDeviceStatus();
      const upload = this.deps.getUploadStatus();
      const s = this.state;
      const sentAt = Date.now();
      const res = await this.deps.api.syncDevice(s.deviceId!, {
        battery_level: status.battery_level,
        is_charging: status.is_charging,
        storage_free: status.storage_free,
        camera_facing: status.camera_facing,
        recording_state: s.recordingState,
        elapsed_ms: s.recordingStartedAt ? Date.now() - s.recordingStartedAt : 0,
        local_video_uid: s.localVideoUid,
        upload_state: upload.upload_state,
        upload_percent: Math.round(upload.upload_percent),
        error_code: s.errorCode,
        last_command_id: this.lastCommandId,
      });
      const receivedAt = Date.now();
      next = Number(res.next_sync_in) || DEFAULT_SYNC_SECONDS;
      this.applySync(res, sentAt, receivedAt);
    } catch (e) {
      const err = e as ApiError;
      this.set({ online: err.code !== 'NETWORK' ? this.state.online : false, lastError: err.message });
      if (err.code === Codes.TOKEN_INVALID) {
        this.stop();
        this.deps.onSessionRevoked?.();
      }
    } finally {
      this.inFlight = false;
      if (this.syncAgain) {
        this.syncAgain = false;
        void this.syncNow();
      } else {
        this.schedule(next);
      }
    }
  }

  private applySync(res: SyncDeviceResult, sentAt: number, receivedAt: number) {
    const serverTime = Date.parse(res.server_time);
    const clockOffsetMs = Number.isFinite(serverTime) ? Math.round(serverTime - (sentAt + receivedAt) / 2) : this.state.clockOffsetMs;
    const rs = res.room_status;
    const inRoom = rs.in_room === '1';
    this.set({
      online: true,
      lastError: null,
      lastSyncAt: receivedAt,
      nextSyncIn: Number(res.next_sync_in) || DEFAULT_SYNC_SECONDS,
      clockOffsetMs,
      inRoom,
      roomId: inRoom ? rs.room_id : null,
      roomName: inRoom ? (rs.room_name ?? null) : null,
      memberId: inRoom ? (rs.member_id ?? null) : null,
      roomSessionId: inRoom ? rs.session_id : null,
    });
    if (inRoom && rs.config) this.applyRoomConfig(rs.config);

    if (res.session_revoked === '1') {
      this.stop();
      this.deps.onSessionRevoked?.();
      return;
    }

    const commands = [...res.pending_commands].sort((a, b) => Date.parse(a.issued_at) - Date.parse(b.issued_at));
    for (const cmd of commands) this.enqueueCommand(cmd);

    // Lỡ mất lệnh STOP (quá 30 giây) thì vẫn dừng khi phiên quay của phòng đã kết thúc.
    const s = this.state;
    if (s.recordingState === 'recording' && s.recordingSessionId && s.recordingSessionId !== s.roomSessionId) {
      this.commandChain = this.commandChain.then(() => this.stopRecording());
    }
  }

  /** Lệnh đẩy qua socket (nhanh hơn chu kỳ sync). */
  handlePushedCommand(cmd: PendingCommand) {
    this.enqueueCommand(cmd);
  }

  private enqueueCommand(cmd: PendingCommand) {
    this.commandChain = this.commandChain.then(() => this.execute(cmd)).catch(() => undefined);
  }

  private async rememberExecuted(id: string) {
    this.executed.push(id);
    if (this.executed.length > MAX_EXECUTED) this.executed = this.executed.slice(-MAX_EXECUTED);
    this.lastCommandId = id;
    if (this.state.deviceId) await this.deps.kv.set(executedKey(this.state.deviceId), JSON.stringify(this.executed));
  }

  private async execute(cmd: PendingCommand) {
    if (this.executed.includes(cmd.command_id)) return;
    const age = this.serverNow() - Date.parse(cmd.issued_at);
    await this.rememberExecuted(cmd.command_id);
    if (age > COMMAND_TTL_MS) return; // lệnh quá cũ: bỏ qua nhưng vẫn đánh dấu đã đọc

    this.set({ lastCommand: { type: cmd.type, at: Date.now() } });
    const payload = cmd.payload || {};
    switch (cmd.type) {
      case 'start_record':
        await this.startRecording({
          sessionId: (payload.session_id as string) ?? this.state.roomSessionId,
          resolution: String(payload.resolution ?? '1920x1080'),
          fps: Number(payload.fps ?? 30),
          maxDurationSec: Number(payload.max_duration ?? 0),
        });
        break;
      case 'stop_record':
        await this.stopRecording();
        break;
      case 'switch_camera':
        await this.deps.recorder.switchCamera((payload.facing as CameraFacing | 'toggle') ?? 'toggle').catch(() => undefined);
        break;
      case 'set_config':
        this.applyRoomConfig({
          resolution: String(payload.resolution ?? '1920x1080'),
          fps: Number(payload.fps ?? 30),
          max_duration: Number(payload.max_duration ?? 0),
        });
        return; // không cần sync lại
      case 'leave_room':
        if (this.state.recordingState === 'recording') await this.stopRecording();
        this.markLeftRoom();
        break;
    }
    void this.syncNow();
  }

  private applyRoomConfig(config: RoomConfig) {
    const prev = this.state.roomConfig;
    const same = prev && prev.resolution === config.resolution && prev.fps === config.fps && prev.max_duration === config.max_duration;
    if (!same) this.set({ roomConfig: config });
    // Đang quay thì giữ nguyên camera; cấu hình mới áp dụng sau khi dừng. Chỉ báo recorder khi thật sự đổi.
    const key = `${config.resolution}|${config.fps}`;
    if (this.state.recordingState === 'recording' || key === this.appliedConfigKey) return;
    this.appliedConfigKey = key;
    this.deps.recorder.applyConfig?.({ resolution: config.resolution, fps: config.fps });
  }

  /** Bắt đầu quay (do lệnh Controller hoặc người dùng bấm khi không ở trong phòng). */
  async startRecording(opts: { sessionId: string | null; resolution: string; fps: number; maxDurationSec: number }) {
    if (this.state.recordingState === 'recording') return;
    try {
      await this.deps.recorder.startRecording({
        sessionId: opts.sessionId,
        resolution: opts.resolution,
        fps: opts.fps,
        serverStartedAt: new Date(this.serverNow()).toISOString(),
        clockOffsetMs: this.state.clockOffsetMs,
      });
      this.deps.onStatusReset?.();
      this.stoppingAt = 0;
      this.appliedConfigKey = `${opts.resolution}|${opts.fps}`; // recorder đã chuyển sang cấu hình của lần quay này
      this.set({
        recordingState: 'recording',
        recordingSessionId: opts.sessionId,
        recordingStartedAt: Date.now(),
        localVideoUid: null,
        errorCode: null,
      });
      if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
      if (opts.maxDurationSec > 0) {
        this.maxDurationTimer = setTimeout(() => void this.stopRecording(), opts.maxDurationSec * 1000);
      }
    } catch (e) {
      this.reportRecording('failed', { errorCode: (e as Error)?.message?.slice(0, 60) || 'RECORD_START_FAILED' });
    }
  }

  async stopRecording() {
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.maxDurationTimer = null;
    // Lệnh STOP, hẹn giờ giới hạn và lần sync thấy phiên đã kết thúc có thể cùng gọi tới đây: chỉ dừng một lần.
    // Quá 15 giây mà file chưa xong thì cho dừng lại lần nữa.
    if (this.state.recordingState !== 'recording' || Date.now() - this.stoppingAt < 15_000) return;
    this.stoppingAt = Date.now();
    try {
      await this.deps.recorder.stopRecording();
    } catch (e) {
      this.stoppingAt = 0;
      this.reportRecording('failed', { errorCode: (e as Error)?.message?.slice(0, 60) || 'RECORD_STOP_FAILED' });
    }
  }

  /** Nền tảng báo kết quả ghi file (saved kèm local_video_uid, hoặc failed). */
  reportRecording(state: RecordingState, extra: { localVideoUid?: string; errorCode?: string } = {}) {
    if (state !== 'recording') this.stoppingAt = 0;
    this.set({
      recordingState: state,
      recordingStartedAt: state === 'recording' ? this.state.recordingStartedAt : null,
      recordingSessionId: state === 'recording' ? this.state.recordingSessionId : null,
      localVideoUid: extra.localVideoUid ?? this.state.localVideoUid,
      errorCode: extra.errorCode ?? (state === 'failed' ? 'RECORD_FAILED' : null),
    });
    void this.syncNow();
  }

  /** Xóa trạng thái "Đã lưu clip / Đã upload / Lỗi" của lần trước (khi vào hoặc rời phòng). */
  private resetFinishedStatus() {
    if (this.state.recordingState === 'recording') return;
    this.deps.onStatusReset?.();
    this.set({ recordingState: 'idle', localVideoUid: null, errorCode: null });
  }

  /** Rời phòng chủ động (đã gọi API leave_room). */
  markLeftRoom() {
    this.set({ inRoom: false, roomId: null, roomName: null, memberId: null, roomSessionId: null, roomConfig: null });
    this.resetFinishedStatus();
  }

  markJoinedRoom(roomId: string, roomName: string, memberId: string) {
    this.set({ inRoom: true, roomId, roomName, memberId });
    this.resetFinishedStatus();
    void this.syncNow();
  }
}
