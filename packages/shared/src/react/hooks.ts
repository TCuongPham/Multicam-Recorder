import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type ApiClient } from '../api';
import { ONLINE_TIMEOUT_MS } from '../constants';
import type { SyncMember, SyncRoomResult, VideoItem, VideoListResult } from '../types';
import type { KeyValueStore } from '../utils';

/** Đọc một store ngoài React (RemoteAgent, UploadManager) như một state. */
export function useStore<T>(store: { subscribe: (fn: (v: T) => void) => () => void; getState: () => T }): T {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** Bộ đếm "now" để vẽ đồng hồ quay trên từng dòng thiết bị. */
export function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface RoomView {
  room: SyncRoomResult['room'] | null;
  members: (SyncMember & { online: boolean; elapsedLiveMs: number })[];
  serverOffsetMs: number;
  revision: number | null;
  joined: string[];
  left: string[];
  error: unknown;
  isLoading: boolean;
  refresh: () => void;
}

/**
 * Màn Điều khiển: get_room_members MỘT LẦN để dựng danh sách ban đầu,
 * sau đó sync_room theo nhịp next_sync_in (truyền since = revision lần trước).
 */
export function useRoomController(api: ApiClient, roomId: string | null, options: { paused?: boolean } = {}): RoomView {
  const queryClient = useQueryClient();
  const membersRef = useRef(new Map<string, SyncMember>());
  const revisionRef = useRef<number | undefined>(undefined);
  const now = useNow(500);

  useEffect(() => {
    membersRef.current = new Map();
    revisionRef.current = undefined;
  }, [roomId]);

  const initial = useQuery({
    queryKey: ['room-members', roomId],
    enabled: !!roomId,
    staleTime: Infinity,
    queryFn: async () => {
      const res = await api.getRoomMembers(roomId!, 0, 50);
      for (const m of res.members ?? []) {
        if (!membersRef.current.has(m.member_id)) {
          membersRef.current.set(m.member_id, {
            ...m,
            is_charging: '0',
            elapsed_ms: '0',
            upload_state: 'none',
            upload_percent: '0',
            error_code: null,
            camera_facing: null,
            local_video_uid: null,
            last_seen: null,
          });
        }
      }
      return res;
    },
  });

  const sync = useQuery({
    queryKey: ['room-sync', roomId],
    enabled: !!roomId && initial.isSuccess && !options.paused,
    queryFn: async () => {
      const receivedLocal = Date.now();
      const res = await api.syncRoom(roomId!, revisionRef.current);
      for (const m of res.members) membersRef.current.set(m.member_id, m);
      for (const id of res.left) membersRef.current.delete(id);
      revisionRef.current = Number(res.revision);
      return {
        ...res,
        members: Array.from(membersRef.current.values()),
        serverOffsetMs: Date.parse(res.server_time) - receivedLocal,
      };
    },
    refetchInterval: (q) => (Number(q.state.data?.next_sync_in) || 3) * 1000,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const data = sync.data;
  const serverOffsetMs = data?.serverOffsetMs ?? 0;
  const members = useMemo(() => {
    const list = data?.members ?? Array.from(membersRef.current.values());
    const serverNow = now + serverOffsetMs;
    const syncedAt = data ? Date.parse(data.server_time) : serverNow;
    return list
      .map((m) => {
        const lastSeen = m.last_seen ? Date.parse(m.last_seen) : 0;
        const online = m.is_online === '1' && serverNow - lastSeen < ONLINE_TIMEOUT_MS;
        const elapsedLiveMs = m.recording_state === 'recording' ? Number(m.elapsed_ms) + Math.max(0, serverNow - syncedAt) : Number(m.elapsed_ms);
        return { ...m, online, elapsedLiveMs };
      })
      .sort((a, b) => a.camera_name.localeCompare(b.camera_name));
  }, [data, now, serverOffsetMs]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['room-sync', roomId] });
  }, [queryClient, roomId]);

  return {
    room: data?.room ?? null,
    members,
    serverOffsetMs,
    revision: revisionRef.current ?? null,
    joined: data?.joined ?? [],
    left: data?.left ?? [],
    error: sync.error ?? initial.error,
    isLoading: initial.isLoading,
    refresh,
  };
}

export interface LibraryParams {
  session_id?: string;
  device_id?: string;
  sort?: 'created_at_desc' | 'created_at_asc';
  pageSize?: number;
}

/**
 * Màn Thư viện: phân trang bằng index và count, cache kết quả để xem lại khi mất mạng.
 */
export function useVideoLibrary(api: ApiClient, cache: KeyValueStore, params: LibraryParams = {}, enabled = true) {
  const pageSize = params.pageSize ?? 20;
  const query = useInfiniteQuery({
    queryKey: ['videos', params.session_id, params.device_id, params.sort],
    enabled,
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<VideoListResult & { index: number; fromCache: boolean }> => {
      const cacheKey = `videos.cache.${params.session_id ?? ''}.${params.device_id ?? ''}.${params.sort ?? ''}.${pageParam}`;
      try {
        const res = await api.getListVideos({
          index: pageParam,
          count: pageSize,
          session_id: params.session_id,
          device_id: params.device_id,
          sort: params.sort,
        });
        const page = { total: Number(res.total) || 0, videos: res.videos ?? [], index: pageParam, fromCache: false };
        await cache.set(cacheKey, JSON.stringify(page)).catch(() => undefined);
        return page;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'NETWORK') {
          const cached = await cache.get(cacheKey).catch(() => null);
          if (cached) return { ...JSON.parse(cached), fromCache: true };
        }
        throw e;
      }
    },
    getNextPageParam: (last) => {
      const next = last.index + last.videos.length;
      return last.videos.length === pageSize && next < last.total ? next : undefined;
    },
  });
  const videos = useMemo(() => query.data?.pages.flatMap((p) => p.videos) ?? [], [query.data]);
  const fromCache = query.data?.pages.some((p) => p.fromCache) ?? false;
  const total = query.data?.pages[0]?.total ?? 0;
  return { ...query, videos, total, fromCache };
}

export interface SessionGroup {
  session_id: string | null;
  recorded_at: string;
  videos: VideoItem[];
}

/** Gom clip theo phiên quay (thư viện của Controller). */
export function groupBySession(videos: VideoItem[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  for (const v of videos) {
    const key = v.session_id ?? `solo-${v.device_id}`;
    let g = map.get(key);
    if (!g) {
      g = { session_id: v.session_id, recorded_at: v.recorded_at || v.created_at, videos: [] };
      map.set(key, g);
    }
    g.videos.push(v);
    if ((v.recorded_at || v.created_at) < g.recorded_at) g.recorded_at = v.recorded_at || v.created_at;
  }
  return Array.from(map.values()).sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
}

export interface DownloadQueueState {
  active: boolean;
  current: VideoItem | null;
  position: number; // clip thứ mấy đang tải (1-based)
  total: number;
  errors: { video: VideoItem; message: string }[];
}

/**
 * Hàng đợi tải xuống: mỗi lần ĐÚNG MỘT clip, hiện "đang tải clip 2/5".
 */
export function useDownloadQueue(download: (video: VideoItem) => Promise<void>) {
  const [state, setState] = useState<DownloadQueueState>({ active: false, current: null, position: 0, total: 0, errors: [] });
  const queueRef = useRef<VideoItem[]>([]);
  const runningRef = useRef(false);
  const doneRef = useRef(0);
  const downloadRef = useRef(download);
  downloadRef.current = download;

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      while (queueRef.current.length) {
        const video = queueRef.current.shift()!;
        doneRef.current += 1;
        const position = doneRef.current;
        setState((s) => ({ ...s, active: true, current: video, position, total: position + queueRef.current.length }));
        try {
          await downloadRef.current(video);
        } catch (e) {
          const message = e instanceof ApiError ? e.userMessage : String((e as Error)?.message ?? e);
          setState((s) => ({ ...s, errors: [...s.errors, { video, message }] }));
        }
      }
    } finally {
      runningRef.current = false;
      doneRef.current = 0;
      setState((s) => ({ ...s, active: false, current: null }));
    }
  }, []);

  const enqueue = useCallback(
    (videos: VideoItem[]) => {
      if (!runningRef.current) setState((s) => ({ ...s, errors: [] }));
      queueRef.current.push(...videos);
      setState((s) => ({ ...s, total: doneRef.current + queueRef.current.length }));
      void run();
    },
    [run],
  );

  const cancel = useCallback(() => {
    queueRef.current = [];
  }, []);

  return { ...state, enqueue, cancel, label: state.active ? `Đang tải clip ${state.position}/${state.total}` : null };
}
