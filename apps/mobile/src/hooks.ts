import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import * as Device from 'expo-device';
import { DeviceType } from '@multicam/shared';
import { getDeviceUuid } from './services/storage';

/** Đếm ngược theo giây (nút "Gửi lại mã" 120 giây). */
export function useCountdown() {
  const [until, setUntil] = useState<number>(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= now) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [until, now]);
  const start = useCallback((seconds: number) => {
    setNow(Date.now());
    setUntil(Date.now() + seconds * 1000);
  }, []);
  const remaining = Math.max(0, Math.ceil((until - now) / 1000));
  return { remaining, start };
}

export function useAppState(): AppStateStatus {
  const [state, setState] = useState<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', setState);
    return () => sub.remove();
  }, []);
  return state;
}

/** Thông tin thiết bị gửi kèm login / check_verify_code. */
export function deviceFields() {
  return {
    device_id: getDeviceUuid(),
    device_type: Platform.OS === 'ios' ? DeviceType.IOS : DeviceType.ANDROID,
    device_name: (Device.deviceName || Device.modelName || (Platform.OS === 'ios' ? 'iPhone' : 'Android')).slice(0, 80),
  } as const;
}
