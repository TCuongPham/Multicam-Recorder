import * as RNFS from '@dr.pogodin/react-native-fs';
import * as FileSystem from 'expo-file-system/legacy';
import { ApiError, Codes, sleep, type DownloadUrlResult, type VideoItem } from '@multicam/shared';
import { api } from './api';
import { DOWNLOADS_DIR, downloadFileName, ensureDownloadsDir, toUri } from './clips';

/**
 * Tải ĐÚNG MỘT clip (Controller). Hàng đợi useDownloadQueue gọi lần lượt từng clip.
 * Gặp 4002 (đang có lượt tải khác) thì chờ rồi xin link lại.
 */
export async function downloadVideo(video: VideoItem): Promise<void> {
  let link: DownloadUrlResult | null = null;
  for (let attempt = 0; !link; attempt++) {
    try {
      link = await api.getDownloadUrl(video.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === Codes.DOWNLOAD_IN_PROGRESS && attempt < 60) {
        await sleep(2000);
        continue;
      }
      throw e;
    }
  }
  await ensureDownloadsDir();
  const dest = `${DOWNLOADS_DIR}/${downloadFileName(video.id, video.name)}`;
  const tmp = `${dest}.part`;
  const res = await FileSystem.downloadAsync(link.download_url, toUri(tmp));
  if (res.status < 200 || res.status >= 300) {
    await RNFS.unlink(tmp).catch(() => undefined);
    throw new Error(`Tải thất bại (HTTP ${res.status})`);
  }
  if (link.checksum_sha256) {
    const sum = (await RNFS.hash(tmp, 'sha256')).toLowerCase();
    if (sum !== link.checksum_sha256.toLowerCase()) {
      await RNFS.unlink(tmp).catch(() => undefined);
      throw new Error('File tải về bị hỏng (sai checksum)');
    }
  }
  if (await RNFS.exists(dest)) await RNFS.unlink(dest);
  await RNFS.moveFile(tmp, dest);
}
