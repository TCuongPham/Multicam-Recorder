import { io, type Socket } from 'socket.io-client';
import type { PendingCommand, ServerToClientEvents } from './types';

export interface RealtimeOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  onCommand?: (cmd: PendingCommand) => void;
  onRoomChanged?: (payload: { room_id: string; revision: number }) => void;
  onSessionRevoked?: () => void;
  onStatus?: (connected: boolean) => void;
}

/**
 * Socket đẩy lệnh: lệnh quay tới mọi máy trong dưới một giây.
 * Socket chỉ là đường nhanh — sync_device định kỳ vẫn là nguồn chính nên mất socket không mất lệnh.
 */
export function connectRealtime(opts: RealtimeOptions): () => void {
  const socket: Socket<ServerToClientEvents> = io(opts.baseUrl, {
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
  return () => {
    socket.removeAllListeners();
    socket.disconnect();
  };
}
