export const MAX_FILE_SIZE = 1073741824; // 1 GB
export const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB
export const MAX_CHUNK_RETRIES = 3;
export const COMMAND_TTL_MS = 30_000;
export const MIN_FREE_STORAGE = 500 * 1024 * 1024; // cảnh báo dưới 500 MB
export const VERIFY_RESEND_SECONDS = 120;
export const VERIFY_EXPIRES_SECONDS = 300;
export const BULK_DELETE_MAX = 50;
export const ONLINE_TIMEOUT_MS = 15_000;
export const DEFAULT_SYNC_SECONDS = 3;
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const VIDEO_MIME = 'video/mp4';

export const DeviceType = { ANDROID: 1, IOS: 2, WEB: 4 } as const;
export type DeviceTypeValue = (typeof DeviceType)[keyof typeof DeviceType];

export type AccountRole = 'controller' | 'remote';
export type RecordingState = 'idle' | 'recording' | 'saved' | 'failed';
export type UploadState = 'none' | 'uploading' | 'uploaded' | 'failed';
export type CommandType = 'start_record' | 'stop_record' | 'leave_room' | 'switch_camera' | 'set_config';
export type CameraFacing = 'front' | 'back';
