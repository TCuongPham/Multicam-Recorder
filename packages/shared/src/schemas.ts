import { z } from 'zod';
import { BULK_DELETE_MAX } from './constants';

// Dùng chung giữa server (validate request) và client (validate form trước khi gọi API).

export const phoneSchema = z.string().regex(/^0\d{9}$/, 'Số điện thoại phải gồm 10 số và bắt đầu bằng 0');
export const passwordSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{6,20}$/, 'Mật khẩu 6–20 ký tự, không chứa ký tự đặc biệt');
export const emailSchema = z.string().trim().toLowerCase().email('Email không hợp lệ');
export const verifyCodeSchema = z.string().regex(/^\d{6}$/, 'Mã xác thực gồm 6 số');
export const inviteCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/, 'Mã mời gồm 6 ký tự');
export const uuidSchema = z.string().uuid();

const accountTarget = {
  email: z.string().trim().min(1).optional(),
  phone: z.string().trim().min(1).optional(),
};
const hasTarget = (v: { email?: string; phone?: string }) => !!(v.email || v.phone);
const targetMissing = { message: 'Cần email hoặc số điện thoại', path: ['email'] };

const deviceFields = {
  device_id: z.string().trim().min(1).max(64),
  device_type: z.union([z.literal(1), z.literal(2), z.literal(4)]),
  device_name: z.string().trim().min(1).max(80),
};

// ---------- A. Xác thực ----------
export const signupSchema = z
  .object({
    first_name: z.string().trim().min(1, 'Nhập tên').max(50),
    last_name: z.string().trim().min(1, 'Nhập họ').max(50),
    email: emailSchema,
    phone: phoneSchema,
    password: passwordSchema,
  })
  .refine((v) => v.password !== v.phone, { message: 'Mật khẩu không được trùng số điện thoại', path: ['password'] });

export const getVerifyCodeSchema = z
  .object({ ...accountTarget, purpose: z.enum(['signup', 'forgot_password']) })
  .refine(hasTarget, targetMissing);

export const checkVerifyCodeSchema = z
  .object({
    ...accountTarget,
    code_verify: verifyCodeSchema,
    // Bổ sung (tùy chọn) để server cấp token gắn với thiết bị ngay sau khi kích hoạt.
    device_id: deviceFields.device_id.optional(),
    device_type: deviceFields.device_type.optional(),
    device_name: deviceFields.device_name.optional(),
  })
  .refine(hasTarget, targetMissing);

export const loginSchema = z
  .object({ ...accountTarget, password: z.string().min(1, 'Nhập mật khẩu'), ...deviceFields })
  .refine(hasTarget, targetMissing);

export const refreshSchema = z.object({ refresh_token: z.string().min(1) });

export const forgotPasswordSchema = z
  .object({ ...accountTarget, code_verify: verifyCodeSchema, new_password: passwordSchema })
  .refine(hasTarget, targetMissing);

export const changePasswordSchema = z
  .object({ old_password: z.string().min(1), new_password: passwordSchema })
  .refine((v) => v.old_password !== v.new_password, {
    message: 'Mật khẩu mới không được trùng mật khẩu cũ',
    path: ['new_password'],
  });

export const logoutSchema = z.object({ device_id: z.string().optional() });

export const deleteAccountSchema = z.object({
  password: z.string().min(1),
  confirm: z.union([z.literal(true), z.literal('true')]),
});

// ---------- B. Phòng ----------
export const createRoomSchema = z.object({
  room_name: z.string().trim().max(60).optional(),
  max_members: z.coerce.number().int().min(1).max(32).optional(),
});

export const joinRoomSchema = z.object({
  invite_code: inviteCodeSchema,
  device_id: z.string().min(1),
  camera_name: z.string().trim().min(1).max(40),
  grant_control: z.union([z.literal(true), z.literal('true')]),
});

export const paginationSchema = z.object({
  index: z.coerce.number().int().min(0).default(0),
  count: z.coerce.number().int().min(1).max(100).default(20),
});

export const kickMemberSchema = z.object({ reason: z.string().max(200).optional() });
export const leaveRoomSchema = z.object({ device_id: z.string().optional() });

// ---------- C. Đồng bộ và điều khiển ----------
export const recordingStateSchema = z.enum(['idle', 'recording', 'saved', 'failed']);
export const uploadStateSchema = z.enum(['none', 'uploading', 'uploaded', 'failed']);

export const syncDeviceSchema = z.object({
  battery_level: z.number().int().min(0).max(100).nullable().optional(),
  is_charging: z.union([z.literal(0), z.literal(1)]).optional(),
  storage_free: z.number().min(0).nullable().optional(),
  recording_state: recordingStateSchema,
  elapsed_ms: z.number().int().min(0).default(0),
  local_video_uid: z.string().nullable().optional(),
  upload_state: uploadStateSchema.default('none'),
  upload_percent: z.number().min(0).max(100).default(0),
  error_code: z.string().nullable().optional(),
  last_command_id: z.string().nullable().optional(),
  camera_facing: z.enum(['front', 'back']).optional(),
});

export const syncRoomSchema = z.object({ since: z.coerce.number().int().min(0).optional() });

export const targetSchema = z.union([z.literal('all'), z.array(z.string().min(1)).min(1)]);

export const recordingConfigSchema = z.object({
  resolution: z
    .string()
    .regex(/^\d{3,4}x\d{3,4}$/)
    .default('1920x1080'),
  fps: z.number().int().min(15).max(60).default(30),
  max_duration: z.number().int().min(0).max(4 * 3600).default(0), // giây, 0 = không giới hạn
});

export const startRecordingSchema = z.object({
  target: targetSchema.default('all'),
  config: recordingConfigSchema.default({}),
  client_command_id: uuidSchema,
});

export const stopRecordingSchema = z.object({
  target: targetSchema.default('all'),
  client_command_id: uuidSchema,
});

// Mở rộng (ngoài 28 API): Controller ra lệnh lật camera cho máy Remote.
export const switchCameraSchema = z.object({
  target: targetSchema.default('all'),
  facing: z.enum(['front', 'back', 'toggle']).default('toggle'),
  client_command_id: uuidSchema,
});

// ---------- D. Upload ----------
export const uploadMetadataSchema = z.object({
  local_video_uid: z.string().min(1).max(64),
  device_id: z.string().min(1),
  camera_name: z.string().min(1).max(40),
  session_id: z.string().nullable().optional(),
  recorded_at: z.string().datetime(),
  duration_ms: z.number().int().min(0),
  resolution: z.string().max(20),
  fps: z.number().min(0).max(240),
  clock_offset_ms: z.number().optional(),
});

export const initUploadSchema = z.object({
  file_name: z.string().min(1).max(255),
  file_size: z.number().int().positive(),
  mime_type: z.string().min(1),
  checksum_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  metadata: uploadMetadataSchema,
});

// ---------- E. Thư viện ----------
export const listVideosSchema = paginationSchema.extend({
  session_id: z.string().optional(),
  device_id: z.string().optional(),
  sort: z.enum(['created_at_desc', 'created_at_asc']).default('created_at_desc'),
});

export const bulkDeleteSchema = z.object({
  video_ids: z.array(z.string().min(1)).min(1).max(BULK_DELETE_MAX),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type GetVerifyCodeInput = z.infer<typeof getVerifyCodeSchema>;
export type CheckVerifyCodeInput = z.infer<typeof checkVerifyCodeSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type CreateRoomInput = z.input<typeof createRoomSchema>;
export type JoinRoomInput = z.input<typeof joinRoomSchema>;
export type SyncDeviceInput = z.input<typeof syncDeviceSchema>;
export type RecordingConfig = z.infer<typeof recordingConfigSchema>;
export type StartRecordingInput = z.input<typeof startRecordingSchema>;
export type StopRecordingInput = z.input<typeof stopRecordingSchema>;
export type SwitchCameraInput = z.input<typeof switchCameraSchema>;
export type UploadMetadata = z.infer<typeof uploadMetadataSchema>;
export type InitUploadInput = z.infer<typeof initUploadSchema>;
export type ListVideosInput = z.input<typeof listVideosSchema>;

/** Gom lỗi Zod thành map field → thông báo, để hiện lỗi tại đúng ô nhập. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
