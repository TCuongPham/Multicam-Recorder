import { useSyncExternalStore } from 'react';
import type { PreviewFrame } from '@multicam/shared';

export interface StoredFrame extends PreviewFrame {
  /** Giờ máy này nhận được khung (tránh lệch đồng hồ khi xét "khung quá cũ"). */
  receivedAt: number;
}

type Listener = () => void;

/**
 * Controller: khung hình xem trước mới nhất của từng máy Remote (theo member_id).
 * Chỉ giữ khung cuối cùng; mỗi ô camera chỉ vẽ lại khi khung của chính nó đổi.
 */
class PreviewStore {
  private frames = new Map<string, StoredFrame>();
  private listeners = new Set<Listener>();

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  get = (memberId: string): StoredFrame | null => this.frames.get(memberId) ?? null;

  push(frame: PreviewFrame) {
    if (!frame?.member_id || typeof frame.image !== 'string' || !frame.image.startsWith('data:image/jpeg;base64,')) return;
    const prev = this.frames.get(frame.member_id);
    if (prev && frame.at && prev.at > frame.at) return; // khung tới trễ
    this.frames.set(frame.member_id, { ...frame, receivedAt: Date.now() });
    for (const fn of this.listeners) fn();
  }

  /** Bỏ khung của các máy đã rời phòng. */
  retain(memberIds: Iterable<string>) {
    const keep = new Set(memberIds);
    let changed = false;
    for (const id of this.frames.keys()) {
      if (!keep.has(id)) {
        this.frames.delete(id);
        changed = true;
      }
    }
    if (changed) for (const fn of this.listeners) fn();
  }

  clear() {
    if (!this.frames.size) return;
    this.frames.clear();
    for (const fn of this.listeners) fn();
  }
}

export const previewStore = new PreviewStore();

export function usePreviewFrame(memberId: string): StoredFrame | null {
  return useSyncExternalStore(
    previewStore.subscribe,
    () => previewStore.get(memberId),
    () => previewStore.get(memberId),
  );
}
