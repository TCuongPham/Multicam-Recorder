import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { kv, loadSettings, tokenStore } from './storage';
import { uploadManager, waitForUploadsIdle } from './upload';

/**
 * Tác vụ nền của hệ điều hành (WorkManager trên Android, BGTaskScheduler trên iOS):
 * đánh thức UploadManager để gửi tiếp các clip còn dở kể cả khi ứng dụng không mở.
 */
export const UPLOAD_TASK = 'multicam-background-upload';

TaskManager.defineTask(UPLOAD_TASK, async () => {
  try {
    await loadSettings();
    const tokens = await tokenStore.get();
    const info = JSON.parse((await kv.get('session.info')) || 'null') as { role?: string } | null;
    if (!tokens || info?.role !== 'remote') return BackgroundTask.BackgroundTaskResult.Success;
    uploadManager.kick();
    await waitForUploadsIdle(25_000);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundUpload(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
    if (await TaskManager.isTaskRegisteredAsync(UPLOAD_TASK)) return;
    await BackgroundTask.registerTaskAsync(UPLOAD_TASK, { minimumInterval: 15 });
  } catch {
    // Không hỗ trợ tác vụ nền (máy ảo / Expo Go) → upload vẫn chạy khi ứng dụng mở.
  }
}

export async function unregisterBackgroundUpload(): Promise<void> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(UPLOAD_TASK)) await BackgroundTask.unregisterTaskAsync(UPLOAD_TASK);
  } catch {
    // bỏ qua
  }
}
