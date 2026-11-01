import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CheckVerifyResult, LoginResult } from '@multicam/shared';
import { api, loadSession, onSessionExpired, saveSession, type Session } from './platform';
import { getRemoteRuntime, startRemoteRuntime, stopRemoteRuntime, type RemoteRuntime } from './remoteRuntime';

interface SessionContextValue {
  session: Session | null;
  runtime: RemoteRuntime | null;
  notice: string | null;
  setNotice: (msg: string | null) => void;
  signIn: (res: LoginResult | CheckVerifyResult) => void;
  signOut: (opts?: { callApi?: boolean; message?: string }) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [notice, setNotice] = useState<string | null>(null);
  const revokedRef = useRef<() => void>(() => undefined);

  // Tạo "máy Remote" ngay trong lần render đầu (idempotent theo deviceId) để màn hình không gặp runtime null.
  const runtime: RemoteRuntime | null = useMemo(
    () => (session?.role === 'remote' ? startRemoteRuntime(session.deviceId, session.cameraName, () => revokedRef.current()) : null),
    [session],
  );

  const signOut = useCallback(
    async (opts: { callApi?: boolean; message?: string } = {}) => {
      const s = loadSession();
      const rt = getRemoteRuntime();
      if (opts.callApi !== false && s) {
        // Đang ở trong phòng thì rời phòng trước khi đăng xuất.
        const roomId = rt?.agent.getState().roomId;
        if (roomId) await api.leaveRoom(roomId, s.deviceId).catch(() => undefined);
        await api.logout(s.deviceId).catch(() => undefined);
      }
      stopRemoteRuntime();
      saveSession(null);
      // Cache thư viện offline không được lộ sang tài khoản đăng nhập sau.
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith('mc.videos.cache.'))
          .forEach((k) => localStorage.removeItem(k));
      } catch {
        // localStorage bị chặn
      }
      queryClient.clear();
      setSession(null);
      if (opts.message) setNotice(opts.message);
    },
    [queryClient],
  );

  useEffect(() => {
    onSessionExpired(() => void signOut({ callApi: false, message: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại' }));
  }, [signOut]);

  revokedRef.current = () => void signOut({ callApi: false, message: 'Phiên đăng nhập đã bị thu hồi' });

  const signIn = useCallback((res: LoginResult | CheckVerifyResult) => {
    const user = 'user' in res && res.user ? res.user : null;
    const device = res.device;
    if (!user || !device) throw new Error('Thiếu thông tin tài khoản hoặc thiết bị');
    const s: Session = { user, role: res.account_role, deviceId: device.device_id, cameraName: device.camera_name };
    saveSession(s);
    setNotice(null);
    setSession(s);
  }, []);

  const value = useMemo(() => ({ session, runtime, notice, setNotice, signIn, signOut }), [session, runtime, notice, signIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
