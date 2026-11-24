import type { AccountRole, CommandType, RecordingState, UploadState } from './constants';
import type { Code } from './codes';

// Kiểu dữ liệu trả về, bám sát ví dụ JSON trong tài liệu
// (một số trường số được tài liệu trả dạng chuỗi, giữ nguyên để đúng đặc tả).

export interface ApiEnvelope<T> {
  code: Code;
  message: string;
  data: T;
}

export type Flag = '0' | '1';

export interface UserInfo {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
}

export interface SignupResult {
  user_id: string;
  email: string;
  phone: string;
  account_role: AccountRole;
  verify_required: Flag;
}

export interface VerifyCodeResult {
  expires_in: number;
  masked_target: string;
  code_verify: string;
}

export interface CheckVerifyResult {
  user_id: string;
  access_token: string;
  refresh_token: string;
  account_role: AccountRole;
  active: Flag;
  user?: UserInfo;
  device?: { device_id: string; camera_name: string };
}

export interface LoginResult {
  user: UserInfo;
  account_role: AccountRole;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  device: { device_id: string; camera_name: string };
}

export interface RefreshResult {
  access_token: string;
  refresh_token: string;
  expires_in: string;
}

export interface DeleteAccountResult {
  deleted_at: string;
}

export interface RoomMemberBrief {
  member_id: string;
  camera_name: string;
  is_online: Flag;
}

export interface CreateRoomResult {
  room_id: string;
  room_name: string;
  invite_code: string;
  expires_at: string;
  created_at: string;
  status: RoomStatus;
  members: RoomMemberBrief[];
}

export interface JoinRoomResult {
  room_id: string;
  room_name: string;
  member_id: string;
  members: RoomMemberBrief[];
}

export interface RoomMemberDetail {
  member_id: string;
  device_id: string;
  camera_name: string;
  is_online: Flag;
  battery_level: string | null;
  storage_free: string | null;
  recording_state: RecordingState;
}

export interface RoomMembersResult {
  total: string;
  members: RoomMemberDetail[];
}

export interface KickResult {
  member_id: string;
  removed_at: string;
  session_stopped: 0 | 1;
}

export interface LeaveResult {
  room_id: string;
  device_id: string;
}

export interface CloseRoomResult {
  closed_at: string;
  session_stopped: 0 | 1;
}

export interface PendingCommand {
  command_id: string;
  type: CommandType;
  payload: Record<string, string | number | null>;
  issued_at: string;
}

export interface SyncDeviceResult {
  server_time: string;
  next_sync_in: string;
  room_status: {
    in_room: Flag;
    room_id: string | null;
    room_name?: string | null;
    member_id?: string | null;
    session_id: string | null;
    /** Cấu hình quay Controller đang chọn (máy Remote hiện và chuẩn bị camera trước khi quay). */
    config?: RoomConfig | null;
  };
  pending_commands: PendingCommand[];
  session_revoked: Flag;
}

export type RoomStatus = 'open' | 'recording' | 'closing' | 'closed';

/** Cấu hình quay của phòng: độ phân giải, fps, giới hạn thời gian (giây, 0 = không giới hạn). */
export interface RoomConfig {
  resolution: string;
  fps: number;
  max_duration: number;
}

export interface SyncMember {
  member_id: string;
  device_id: string;
  camera_name: string;
  is_online: Flag;
  battery_level: string | null;
  is_charging: Flag;
  storage_free: string | null;
  recording_state: RecordingState;
  elapsed_ms: string;
  upload_state: UploadState;
  upload_percent: string;
  error_code: string | null;
  camera_facing: string | null;
  local_video_uid: string | null;
  last_seen: string | null;
}

export interface SyncRoomResult {
  server_time: string;
  revision: string;
  next_sync_in: string;
  room: {
    room_id: string;
    status: RoomStatus;
    session_id: string | null;
    started_at: string | null;
    invite_code: string;
    /** Cấu hình đang chọn của phòng (đang quay thì là cấu hình của phiên đó). */
    config?: RoomConfig | null;
  };
  members: SyncMember[];
  joined: string[];
  left: string[];
}

export interface StartRecordingResult {
  session_id: string;
  started_at: string;
  command_id: string;
  targets: string[];
  rejected: string[];
}

export interface StopRecordingResult {
  session_id: string;
  started_at?: string;
  stopped_at: string;
  command_id: string;
  results: {
    member_id: string;
    device_id?: string;
    camera_name?: string;
    is_online?: Flag;
    local_video_uid: string | null;
    duration_ms: string;
    size: string | null;
    status: RecordingState;
  }[];
}

export interface SwitchCameraResult {
  command_id: string;
  targets: string[];
}

export interface InitUploadResult {
  upload_id: string | null;
  chunk_size: number;
  total_chunks: number;
  expires_at: string | null;
  already_uploaded: 0 | 1;
  video_id: string | null;
}

export interface UploadChunkResult {
  chunk_index: number;
  received: number;
  next_expected_index: number | null;
}

export interface UploadStatusResult {
  upload_id: string;
  status: 'in_progress' | 'completed' | 'failed';
  received_chunks: number[];
  missing_chunks: number[];
  expires_at: string;
}

export interface CompleteUploadResult {
  video_id: string;
  local_video_uid: string;
  url: string;
  thumbnail_url: string | null;
  duration_ms: number;
  size: number;
  created_at: string;
}

export interface VideoItem {
  id: string;
  name: string;
  thumbnail_url: string | null;
  duration_ms: number;
  size: number;
  created_at: string;
  recorded_at: string;
  camera_name: string;
  device_id: string;
  session_id: string | null;
  local_video_uid: string;
  downloaded_by_controller: 0 | 1;
  /** Mở rộng: độ phân giải thực của file (server đọc bằng ffprobe), vd. "1920x1080". */
  resolution?: string;
  fps?: number;
}

export interface VideoListResult {
  total: number;
  videos: VideoItem[];
}

export interface VideoDetail extends Omit<VideoItem, 'downloaded_by_controller'> {
  url: string;
  resolution: string;
  codec: string;
  fps: number;
  clock_offset_ms: number;
}

export interface DownloadUrlResult {
  download_url: string;
  expires_at: string;
  size: number;
  checksum_sha256: string;
}

export interface DeleteVideoResult {
  video_id: string;
  deleted_at: string;
}

export interface BulkDeleteResult {
  deleted: string[];
  failed: { video_id: string; reason: string }[];
}

/** Khung hình xem trước của một máy Remote (JPEG dạng data URL, ~1 khung/giây). */
export interface PreviewFrame {
  room_id: string;
  member_id: string;
  device_id: string;
  image: string;
  at: number;
}

/** Sự kiện Socket.IO (đẩy lệnh < 1 giây, khung hình xem trước). */
export interface ServerToClientEvents {
  command: (cmd: PendingCommand) => void;
  room_changed: (payload: { room_id: string; revision: number }) => void;
  session_revoked: () => void;
  preview: (frame: PreviewFrame) => void;
}

export interface ClientToServerEvents {
  preview_frame: (image: string) => void;
}
