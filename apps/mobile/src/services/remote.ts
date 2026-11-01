import * as Battery from 'expo-battery';
import { RemoteAgent, type DeviceStatus } from '@multicam/shared';
import { api } from './api';
import { getFreeStorage } from './clips';
import { cameraBridge } from './recorder';
import { session } from './session';
import { kv } from './storage';
import { uploadManager } from './upload';

async function getDeviceStatus(): Promise<DeviceStatus> {
  let battery_level: number | null = null;
  let is_charging: 0 | 1 = 0;
  try {
    const level = await Battery.getBatteryLevelAsync();
    battery_level = level >= 0 ? Math.round(level * 100) : null;
    const state = await Battery.getBatteryStateAsync();
    is_charging = state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL ? 1 : 0;
  } catch {
    // máy ảo / không đọc được pin
  }
  const free = await getFreeStorage();
  return {
    battery_level,
    is_charging,
    storage_free: free === null ? null : Math.floor(free),
    camera_facing: cameraBridge.getState().facing,
  };
}

/**
 * Bộ não máy Remote (shared/RemoteAgent): sync_device theo next_sync_in, hàng đợi lệnh,
 * chống trùng, bỏ lệnh cũ hơn 30 giây, tính lệch đồng hồ. Sống ở phạm vi module.
 */
export const remoteAgent = new RemoteAgent({
  api,
  kv,
  recorder: cameraBridge,
  getDeviceStatus,
  getUploadStatus: uploadManager.syncStatus,
  onSessionRevoked: () => {
    void session.clear('Phiên đăng nhập đã bị thu hồi, vui lòng đăng nhập lại');
  },
});

cameraBridge.setReporter((state, extra) => remoteAgent.reportRecording(state, extra));
