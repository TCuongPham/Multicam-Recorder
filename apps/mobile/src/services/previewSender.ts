import { useEffect, type RefObject } from 'react';
import { AppState } from 'react-native';
import * as RNFS from '@dr.pogodin/react-native-fs';
import type { Camera } from 'react-native-vision-camera';
import { MAX_PREVIEW_BYTES } from '@multicam/shared';
import { isRealtimeConnected, sendPreviewFrame } from './runtime';

const INTERVAL_MS = 1000;
const MAX_QUALITY = 30;
const MIN_QUALITY = 5;
const JPEG_PREFIX = 'data:image/jpeg;base64,';

/**
 * Remote: khi đang ở trong phòng và camera sẵn sàng, cứ ~1 giây chụp nhanh khung xem trước
 * (takeSnapshot, JPEG chất lượng thấp) rồi gửi qua socket cho Controller.
 * - Không chạy chồng: lượt trước chưa xong thì bỏ lượt này.
 * - Ứng dụng ở nền / mất socket: không chụp.
 * - Khung vượt MAX_PREVIEW_BYTES: bỏ khung đó, lần sau giảm chất lượng.
 * - Lỗi (vd. nền tảng không cho chụp khi đang quay): bỏ qua, chờ một lúc rồi thử lại — không ảnh hưởng việc quay.
 */
export function usePreviewSender(cameraRef: RefObject<Camera | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let busy = false;
    let quality = MAX_QUALITY;
    let skipUntil = 0;
    let failures = 0;

    const tick = async () => {
      if (cancelled || busy || Date.now() < skipUntil) return;
      if (AppState.currentState !== 'active' || !isRealtimeConnected()) return;
      const camera = cameraRef.current;
      if (!camera) return;
      busy = true;
      let path: string | null = null;
      try {
        const snap = await camera.takeSnapshot({ quality });
        path = snap.path.startsWith('file://') ? snap.path.slice(7) : snap.path;
        if (cancelled) return;
        const b64 = await RNFS.readFile(path, 'base64');
        const dataUrl = JPEG_PREFIX + b64;
        failures = 0;
        if (dataUrl.length > MAX_PREVIEW_BYTES) {
          quality = Math.max(MIN_QUALITY, Math.floor(quality * 0.6));
          return;
        }
        if (!cancelled) sendPreviewFrame(dataUrl);
        // Còn dư nhiều so với giới hạn → nâng dần chất lượng lại.
        if (dataUrl.length < MAX_PREVIEW_BYTES * 0.45 && quality < MAX_QUALITY) quality = Math.min(MAX_QUALITY, quality + 5);
      } catch {
        failures += 1;
        skipUntil = Date.now() + Math.min(10_000, 1500 * failures);
      } finally {
        if (path) void RNFS.unlink(path).catch(() => undefined);
        busy = false;
      }
    };

    const id = setInterval(() => void tick(), INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [cameraRef, enabled]);
}
