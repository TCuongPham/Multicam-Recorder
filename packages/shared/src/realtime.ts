import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, PendingCommand, PreviewFrame, ServerToClientEvents } from './types';

export interface RealtimeOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  onCommand?: (cmd: PendingCommand) => void;
  onRoomChanged?: (payload: { room_id: string; revision: number }) => void;
  onSessionRevoked?: () => void;
  onPreview?: (frame: PreviewFrame) => void;
  onStatus?: (connected: boolean) => void;
}

/** Gọi để ngắt kết nối; kèm hàm gửi khung hình xem trước (máy Remote). */
export interface RealtimeConnection {
  (): void;
  sendPreview: (image: string) => void;
  isConnected: () => boolean;
}

/** Khung hình lớn hơn mức này bị bỏ (server cũng chặn). */
export const MAX_PREVIEW_BYTES = 250_000;

/**
 * Socket đẩy lệnh: lệnh quay tới mọi máy trong dưới một giây.
 * Socket chỉ là đường nhanh — sync_device định kỳ vẫn là nguồn chính nên mất socket không mất lệnh.
 */
export function connectRealtime(opts: RealtimeOptions): RealtimeConnection {
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(opts.baseUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnectionDelayMax: 5000,
    auth: (cb) => {
      void opts.getToken().then((token) => cb({ token }));
    },
  });
  socket.on('connect', () => opts.onStatus?.(true));
  socket.on('disconnect', () => opts.onStatus?.(false));
  socket.on('connect_error', () => opts.onStatus?.(false));
  if (opts.onCommand) socket.on('command', opts.onCommand);
  if (opts.onRoomChanged) socket.on('room_changed', opts.onRoomChanged);
  if (opts.onSessionRevoked) socket.on('session_revoked', opts.onSessionRevoked);
  if (opts.onPreview) socket.on('preview', opts.onPreview);

  const close = () => {
    socket.removeAllListeners();
    socket.disconnect();
  };
  return Object.assign(close, {
    sendPreview: (image: string) => {
      // volatile: mất khung nào thì bỏ khung đó, không dồn hàng đợi khi mạng chậm.
      if (socket.connected && image.length <= MAX_PREVIEW_BYTES) socket.volatile.emit('preview_frame', image);
    },
    isConnected: () => socket.connected,
  });
}
