import { Codes, CodeUserMessages, type Code } from './codes';
import type {
  ChangePasswordInput,
  CheckVerifyCodeInput,
  CreateRoomInput,
  ForgotPasswordInput,
  GetVerifyCodeInput,
  InitUploadInput,
  JoinRoomInput,
  ListVideosInput,
  LoginInput,
  SignupInput,
  StartRecordingInput,
  StopRecordingInput,
  SwitchCameraInput,
  RecordingConfigInput,
  SyncDeviceInput,
} from './schemas';
import type {
  ApiEnvelope,
  BulkDeleteResult,
  CheckVerifyResult,
  CloseRoomResult,
  CompleteUploadResult,
  CreateRoomResult,
  DeleteAccountResult,
  DeleteVideoResult,
  DownloadUrlResult,
  InitUploadResult,
  JoinRoomResult,
  KickResult,
  LeaveResult,
  LoginResult,
  RefreshResult,
  RoomMembersResult,
  SignupResult,
  StartRecordingResult,
  StopRecordingResult,
  SwitchCameraResult,
  RoomConfig,
  SyncDeviceResult,
  SyncRoomResult,
  UploadChunkResult,
  UploadStatusResult,
  VerifyCodeResult,
  VideoDetail,
  VideoListResult,
} from './types';

export interface Tokens {
  access_token: string;
  refresh_token: string;
}

export interface TokenStore {
  get(): Promise<Tokens | null>;
  set(tokens: Tokens | null): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    public readonly code: Code | 'NETWORK',
    message: string,
    public readonly data: unknown = null,
    public readonly httpStatus = 0,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Thông báo thân thiện để hiện cho người dùng. */
  get userMessage(): string {
    return CodeUserMessages[this.code] ?? this.message;
  }

  /** Lỗi tại ô nhập cụ thể (server trả data.field khi mã 1004/9996). */
  get field(): string | null {
    const d = this.data as { field?: string } | null;
    return d?.field ?? null;
  }
}

export interface ApiClientOptions {
  baseUrl: () => string;
  tokens: TokenStore;
  /** Refresh thất bại → xóa phiên, đưa về màn Đăng nhập. */
  onSessionExpired?: () => void;
  fetchImpl?: typeof fetch;
}

type Query = Record<string, string | number | undefined | null>;

interface RequestOptions {
  body?: unknown;
  query?: Query;
  auth?: boolean;
  /** Các mã ngoài 1000 vẫn coi là thành công (vd. 1010 lệnh trùng). */
  accept?: Code[];
}

function buildQuery(query?: Query): string {
  if (!query) return '';
  const params = Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!params.length) return '';
  return '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

export class ApiClient {
  private refreshing: Promise<boolean> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ApiClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  get baseUrl(): string {
    return this.opts.baseUrl().replace(/\/+$/, '');
  }

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  async getAccessToken(): Promise<string | null> {
    return (await this.opts.tokens.get())?.access_token ?? null;
  }

  /**
   * Gọi một request có xác thực. Gặp 9998 thì refresh ĐÚNG MỘT LẦN rồi thử lại;
   * vẫn lỗi thì xóa phiên. Dùng chung cho cả upload native của app di động.
   */
  async authed<T>(exec: (accessToken: string | null) => Promise<ApiEnvelope<T>>, accept: Code[] = []): Promise<ApiEnvelope<T>> {
    let res = await exec(await this.getAccessToken());
    if (res.code === Codes.TOKEN_INVALID) {
      const ok = await this.refresh();
      if (!ok) {
        await this.opts.tokens.set(null);
        this.opts.onSessionExpired?.();
        throw new ApiError(res.code, res.message, res.data);
      }
      res = await exec(await this.getAccessToken());
      if (res.code === Codes.TOKEN_INVALID) {
        await this.opts.tokens.set(null);
        this.opts.onSessionExpired?.();
      }
    }
    if (res.code !== Codes.OK && !accept.includes(res.code)) {
      throw new ApiError(res.code, res.message, res.data);
    }
    return res;
  }

  private async raw<T>(method: string, path: string, init: { body?: unknown; rawBody?: BodyInit; headers?: Record<string, string>; token?: string | null }): Promise<ApiEnvelope<T>> {
    const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    let body: BodyInit | undefined = init.rawBody;
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), { method, headers, body });
    } catch (e) {
      throw new ApiError('NETWORK', (e as Error)?.message || 'Network error');
    }
    let json: ApiEnvelope<T>;
    try {
      json = (await response.json()) as ApiEnvelope<T>;
    } catch {
      throw new ApiError(Codes.EXCEPTION, `HTTP ${response.status}`, null, response.status);
    }
    return json;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> {
    const fullPath = path + buildQuery(options.query);
    if (options.auth === false) {
      const res = await this.raw<T>(method, fullPath, { body: options.body });
      if (res.code !== Codes.OK && !(options.accept ?? []).includes(res.code)) {
        throw new ApiError(res.code, res.message, res.data);
      }
      return res;
    }
    return this.authed<T>((token) => this.raw<T>(method, fullPath, { body: options.body, token }), options.accept);
  }

  private async data<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
    return (await this.request<T>(method, path, options)).data;
  }

  /** Chỉ chạy một lần refresh dù nhiều request cùng gặp 9998. */
  async refresh(): Promise<boolean> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const current = await this.opts.tokens.get();
        if (!current?.refresh_token) return false;
        try {
          const res = await this.raw<RefreshResult>('POST', '/auth/refresh', { body: { refresh_token: current.refresh_token } });
          if (res.code !== Codes.OK) return false;
          await this.opts.tokens.set({ access_token: res.data.access_token, refresh_token: res.data.refresh_token });
          return true;
        } catch {
          return false;
        }
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  // ---------- A. Xác thực và tài khoản ----------
  signup = (body: SignupInput) => this.data<SignupResult>('POST', '/auth/signup', { body, auth: false });
  getVerifyCode = (body: GetVerifyCodeInput) => this.data<VerifyCodeResult>('POST', '/auth/verify-code', { body, auth: false });
  checkVerifyCode = async (body: CheckVerifyCodeInput) => {
    const data = await this.data<CheckVerifyResult>('POST', '/auth/verify-code/check', { body, auth: false });
    await this.opts.tokens.set({ access_token: data.access_token, refresh_token: data.refresh_token });
    return data;
  };
  login = async (body: LoginInput) => {
    const data = await this.data<LoginResult>('POST', '/auth/login', { body, auth: false });
    await this.opts.tokens.set({ access_token: data.access_token, refresh_token: data.refresh_token });
    return data;
  };
  forgotPassword = (body: ForgotPasswordInput) => this.data<Record<string, never>>('POST', '/auth/password/forgot', { body, auth: false });
  changePassword = async (body: ChangePasswordInput) => {
    const data = await this.data<{ access_token?: string; refresh_token?: string }>('PUT', '/auth/password', { body });
    // Thiết bị vừa đổi giữ phiên: server cấp lại token mới cho chính thiết bị này.
    if (data.access_token && data.refresh_token) {
      await this.opts.tokens.set({ access_token: data.access_token, refresh_token: data.refresh_token });
    }
    return data;
  };
  logout = async (device_id?: string) => {
    try {
      await this.data('POST', '/auth/logout', { body: { device_id } });
    } finally {
      await this.opts.tokens.set(null);
    }
  };
  deleteAccount = async (password: string) => {
    const data = await this.data<DeleteAccountResult>('DELETE', '/users/me', { body: { password, confirm: true } });
    await this.opts.tokens.set(null);
    return data;
  };

  // ---------- B. Phòng ----------
  createRoom = (body: CreateRoomInput = {}) => this.data<CreateRoomResult>('POST', '/rooms', { body });
  joinRoom = (body: JoinRoomInput) => this.data<JoinRoomResult>('POST', '/rooms/join', { body });
  getRoomMembers = (roomId: string, index = 0, count = 50) =>
    this.data<RoomMembersResult>('GET', `/rooms/${roomId}/members`, { query: { index, count }, accept: [Codes.NO_DATA] });
  kickMember = (roomId: string, memberId: string, reason?: string) =>
    this.data<KickResult>('DELETE', `/rooms/${roomId}/members/${memberId}`, { body: { reason } });
  leaveRoom = (roomId: string, device_id: string) => this.data<LeaveResult>('POST', `/rooms/${roomId}/leave`, { body: { device_id } });
  closeRoom = (roomId: string) => this.data<CloseRoomResult>('DELETE', `/rooms/${roomId}`);

  // ---------- C. Đồng bộ và điều khiển ----------
  syncDevice = (deviceId: string, body: SyncDeviceInput) => this.data<SyncDeviceResult>('POST', `/devices/${deviceId}/sync`, { body });
  syncRoom = (roomId: string, since?: number) => this.data<SyncRoomResult>('GET', `/rooms/${roomId}/sync`, { query: { since } });
  startRecording = (roomId: string, body: StartRecordingInput) =>
    this.data<StartRecordingResult>('POST', `/rooms/${roomId}/recording/start`, { body, accept: [Codes.ACTION_DONE_PREVIOUSLY] });
  stopRecording = (roomId: string, body: StopRecordingInput) =>
    this.data<StopRecordingResult>('POST', `/rooms/${roomId}/recording/stop`, { body, accept: [Codes.ACTION_DONE_PREVIOUSLY] });
  /** Mở rộng: Controller đổi cấu hình quay trong menu → máy Remote cập nhật ngay (khi chưa quay). */
  setRoomConfig = (roomId: string, body: RecordingConfigInput) => this.data<{ config: RoomConfig }>('POST', `/rooms/${roomId}/config`, { body });
  switchCamera = (roomId: string, body: SwitchCameraInput) =>
    this.data<SwitchCameraResult>('POST', `/rooms/${roomId}/camera`, { body, accept: [Codes.ACTION_DONE_PREVIOUSLY] });

  // ---------- D. Upload ----------
  initUpload = (body: InitUploadInput) =>
    this.data<InitUploadResult>('POST', '/videos/uploads', { body, accept: [Codes.VIDEO_ALREADY_UPLOADED] });
  /** Web: body là Blob. App di động dùng `authed` + uploader native. */
  uploadChunk = (uploadId: string, index: number, chunk: BodyInit, checksum: string) =>
    this.authed<UploadChunkResult>((token) =>
      this.raw<UploadChunkResult>('PUT', `/videos/uploads/${uploadId}/chunks/${index}`, {
        rawBody: chunk,
        token,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Checksum': checksum },
      }),
    ).then((r) => r.data);
  getUploadStatus = (uploadId: string) => this.data<UploadStatusResult>('GET', `/videos/uploads/${uploadId}`);
  completeUpload = (uploadId: string) => this.data<CompleteUploadResult>('POST', `/videos/uploads/${uploadId}/complete`);

  // ---------- E. Thư viện ----------
  getListVideos = (params: ListVideosInput = {}) =>
    this.data<VideoListResult>('GET', '/videos', { query: params as Query, accept: [Codes.NO_DATA] });
  getVideo = (videoId: string) => this.data<VideoDetail>('GET', `/videos/${videoId}`);
  getDownloadUrl = (videoId: string) => this.data<DownloadUrlResult>('GET', `/videos/${videoId}/download`);
  deleteVideo = (videoId: string) => this.data<DeleteVideoResult>('DELETE', `/videos/${videoId}`);
  deleteVideosBulk = (video_ids: string[]) => this.data<BulkDeleteResult>('POST', '/videos/bulk-delete', { body: { video_ids } });
}
