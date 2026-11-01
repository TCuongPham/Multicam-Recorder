import { ApiClient, ApiError, Codes } from '@multicam/shared';
import { getServerUrl, tokenStore } from './storage';

type Listener = () => void;
const expiredListeners = new Set<Listener>();

/** Gọi khi refresh token thất bại (9998 hai lần) → xóa phiên và về màn Đăng nhập. */
export function onSessionExpired(fn: Listener): () => void {
  expiredListeners.add(fn);
  return () => expiredListeners.delete(fn);
}

/** ApiClient dùng chung cho cả app (một instance duy nhất, sống ngoài màn hình). */
export const api = new ApiClient({
  baseUrl: getServerUrl,
  tokens: tokenStore,
  onSessionExpired: () => {
    for (const fn of expiredListeners) fn();
  },
});

/** Thông báo lỗi thân thiện cho người dùng. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === Codes.PARAM_VALUE_INVALID && e.field === 'password') return 'Sai mật khẩu';
    if (e.code === Codes.PARAM_VALUE_INVALID && e.field === 'old_password') return 'Mật khẩu cũ không đúng';
    return e.userMessage;
  }
  const msg = (e as Error)?.message;
  return msg ? String(msg) : 'Đã có lỗi xảy ra, vui lòng thử lại';
}

export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}
