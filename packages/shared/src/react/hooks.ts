import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type ApiClient } from '../api';
import { ONLINE_TIMEOUT_MS } from '../constants';
import type { RoomConfig, StopRecordingResult, SyncMember, SyncRoomResult, VideoItem, VideoListResult } from '../types';
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

export type MemberView = SyncMember & { online: boolean; elapsedLiveMs: number };

export interface RoomView {
  room: SyncRoomResult['room'] | null;
  members: MemberView[];
  serverOffsetMs: number;
  revision: number | null;
  joined: string[];
  left: string[];
  error: unknown;
  isLoading: boolean;
  refresh: () => void;
}

interface RoomCacheEntry {
  members: Map<string, SyncMember>;
  revision?: number;
}

/** Giữ danh sách máy + revision khi rời màn Điều khiển (sang Thư viện/Cài đặt) để quay lại không bị reset. */
const roomCache = new Map<string, RoomCacheEntry>();
function roomEntry(roomId: string): RoomCacheEntry {
  let e = roomCache.get(roomId);
  if (!e) {
    e = { members: new Map() };
    roomCache.set(roomId, e);
  }
  return e;
}

type SyncData = SyncRoomResult & { serverOffsetMs: number };

/**
 * Màn Điều khiển: get_room_members MỘT LẦN để dựng danh sách ban đầu,
 * sau đó sync_room theo nhịp next_sync_in (truyền since = revision lần trước).
 */
export function useRoomController(api: ApiClient, roomId: string | null, options: { paused?: boolean } = {}): RoomView {
  const queryClient = useQueryClient();
  const now = useNow(250);
  const entry = roomId ? roomEntry(roomId) : null;

  const initial = useQuery({
    queryKey: ['room-members', roomId],
    // Đã có dữ liệu từ lần mở trước thì không cần dựng lại danh sách ban đầu.
    enabled: !!roomId && entry?.revision === undefined,
    staleTime: Infinity,
    queryFn: async () => {
      const res = await api.getRoomMembers(roomId!, 0, 50);
      const e = roomEntry(roomId!);
      for (const m of res.members ?? []) {
        if (!e.members.has(m.member_id)) {
          e.members.set(m.member_id, {
            ...m,
            recording_state: 'idle',
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

  const sync = useQuery<SyncData>({
    queryKey: ['room-sync', roomId],
    enabled: !!roomId && (initial.isSuccess || entry?.revision !== undefined) && !options.paused,
    queryFn: async () => {
      const e = roomEntry(roomId!);
      const sentLocal = Date.now();
      const res = await api.syncRoom(roomId!, e.revision);
      const receivedLocal = Date.now();
      for (const m of res.members) e.members.set(m.member_id, m);
      for (const id of res.left) e.members.delete(id);
      e.revision = Number(res.revision);
      return {
        ...res,
        members: Array.from(e.members.values()),
        serverOffsetMs: Date.parse(res.server_time) - (sentLocal + receivedLocal) / 2,
      };
    },
    refetchInterval: (q) => (Number(q.state.data?.next_sync_in) || 3) * 1000,
    // Vẫn đồng bộ khi tab/cửa sổ không được focus — Controller cần thấy trạng thái thật mọi lúc.
    refetchIntervalInBackground: true,
    retry: false,
  });

  // Quay lại màn hình / ứng dụng vào foreground → đồng bộ ngay, không chờ nhịp kế tiếp.
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['room-sync', roomId] });
  }, [queryClient, roomId]);
  useEffect(() => {
    if (roomId && !options.paused) refresh();
  }, [roomId, options.paused, refresh]);

  const data = sync.data;
  const serverOffsetMs = data?.serverOffsetMs ?? 0;
  const members = useMemo(() => {
    const list = data?.members ?? (entry ? Array.from(entry.members.values()) : []);
    const serverNow = now + serverOffsetMs;
    const syncedAt = data ? Date.parse(data.server_time) : serverNow;
    return list
      .map((m): MemberView => {
        const lastSeen = m.last_seen ? Date.parse(m.last_seen) : 0;
        // Mất kết nối = máy không gửi sync_device trong 15 giây (tính theo giờ server ở lần sync_room gần nhất).
        const online = m.is_online === '1' && !!lastSeen && syncedAt - lastSeen < ONLINE_TIMEOUT_MS;
        // elapsed_ms được máy đo đúng lúc gửi sync (≈ last_seen) → ngoại suy từ last_seen của CHÍNH máy đó,
        // nên các máy bắt đầu cùng lúc luôn hiển thị cùng một thời gian.
        const elapsedLiveMs =
          m.recording_state === 'recording' && lastSeen
            ? Number(m.elapsed_ms) + Math.max(0, (online ? serverNow : syncedAt) - lastSeen)
            : Number(m.elapsed_ms);
        return { ...m, online, elapsedLiveMs };
      })
      .sort((a, b) => a.camera_name.localeCompare(b.camera_name));
  }, [data, now, serverOffsetMs, entry]);

  return {
    room: data?.room ?? null,
    members,
    serverOffsetMs,
    revision: entry?.revision ?? null,
    joined: data?.joined ?? [],
    left: data?.left ?? [],
    error: sync.error ?? initial.error,
    isLoading: initial.isLoading && !data,
    refresh,
  };
}

export type SummaryStatus = 'uploaded' | 'uploading' | 'stopping' | 'processing' | 'failed' | 'offline';

export interface SummaryRow {
  member_id: string;
  camera_name: string;
  status: SummaryStatus;
  percent: number;
  duration_ms: number;
  error: string | null;
}

/**
 * Bảng tổng kết sau khi dừng quay. Nguồn sự thật là thư viện trên server (get_list_videos theo session_id):
 * clip đã có trên server mới là "Đã upload"; trạng thái live chỉ dùng cho tiến độ đang chạy.
 */
export function useSessionSummary(api: ApiClient, summary: StopRecordingResult | null, members: MemberView[]) {
  const sessionId = summary?.session_id ?? null;
  const [allDone, setAllDone] = useState(false);
  useEffect(() => setAllDone(false), [sessionId]);

  const videos = useQuery({
    queryKey: ['session-videos', sessionId],
    enabled: !!sessionId,
    queryFn: () => api.getListVideos({ session_id: sessionId!, index: 0, count: 50 }),
    refetchInterval: allDone ? false : 2500,
    refetchIntervalInBackground: true,
  });

  const rows = useMemo<SummaryRow[]>(() => {
    if (!summary) return [];
    const sessionMs = summary.started_at ? Date.parse(summary.stopped_at) - Date.parse(summary.started_at) : 0;
    const list = videos.data?.videos ?? [];
    return summary.results.map((r) => {
      const live = members.find((m) => m.member_id === r.member_id);
      const deviceId = r.device_id ?? live?.device_id;
      const video = list.find((v) => v.device_id === deviceId);
      const base = { member_id: r.member_id, camera_name: live?.camera_name ?? r.camera_name ?? r.member_id, error: null as string | null };
      if (video) return { ...base, status: 'uploaded', percent: 100, duration_ms: video.duration_ms };
      const duration_ms = Math.max(0, sessionMs);
      if (!live || !live.online) return { ...base, status: 'offline', percent: 0, duration_ms };
      if (live.recording_state === 'recording') return { ...base, status: 'stopping', percent: 0, duration_ms };
      if (live.recording_state === 'failed' || live.upload_state === 'failed') {
        return { ...base, status: 'failed', percent: 0, duration_ms, error: live.error_code };
      }
      if (live.upload_state === 'uploading') return { ...base, status: 'uploading', percent: Number(live.upload_percent) || 0, duration_ms };
      return { ...base, status: 'processing', percent: 0, duration_ms };
    });
  }, [summary, videos.data, members]);

  const done = rows.length > 0 && rows.every((r) => r.status === 'uploaded');
  useEffect(() => {
    if (done) setAllDone(true);
  }, [done]);
  return { rows, done };
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

const DEFAULT_ROOM_CONFIG: RoomConfig = { resolution: '1920x1080', fps: 30, max_duration: 0 };

/**
 * Cấu hình quay trong menu của Controller (độ phân giải, fps, giới hạn).
 * Lấy giá trị đã lưu của phòng khi mở màn hình; mỗi lần đổi thì gửi lên server (trễ 300 ms)
 * để máy Remote cập nhật ngay, kể cả khi chưa quay. Đang quay thì hiện đúng cấu hình của phiên.
 */
export function useRoomConfig(api: ApiClient, roomId: string | null, room: SyncRoomResult['room'] | null) {
  const [config, setLocal] = useState<RoomConfig>(DEFAULT_ROOM_CONFIG);
  const latest = useRef(config);
  const initFor = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recording = room?.status === 'recording';
  const serverConfig = room?.config ?? null;
  const serverKey = serverConfig ? `${serverConfig.resolution}|${serverConfig.fps}|${serverConfig.max_duration}` : '';

  const apply = useCallback((next: RoomConfig) => {
    latest.current = next;
    setLocal(next);
  }, []);

  useEffect(() => {
    if (!roomId || !room || room.room_id !== roomId) return;
    const first = initFor.current !== roomId;
    initFor.current = roomId;
    if (serverConfig && (first || recording)) apply(serverConfig);
    else if (first) void api.setRoomConfig(roomId, latest.current).catch(() => undefined); // phòng mới: báo cấu hình mặc định
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, room?.room_id, recording, serverKey]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const setConfig = useCallback(
    (patch: Partial<RoomConfig>) => {
      const next = { ...latest.current, ...patch };
      apply(next);
      if (!roomId) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void api.setRoomConfig(roomId, next).catch(() => undefined), 300);
    },
    [api, roomId, apply],
  );

  return { config, setConfig };
}

/**
 * Đồng hồ phiên quay của Controller: dừng ở đúng giới hạn thời gian và tự gọi stop_recording
 * khi hết giờ (các máy Remote cũng tự dừng ở cùng thời điểm), không chạy tiếp tới khi bấm Dừng.
 */
export function useSessionClock(view: Pick<RoomView, 'room' | 'serverOffsetMs'>, now: number, onLimit: () => void) {
  const room = view.room;
  const recording = room?.status === 'recording' && !!room.started_at;
  const limitMs = recording ? (room?.config?.max_duration ?? 0) * 1000 : 0;
  const raw = recording ? now + view.serverOffsetMs - Date.parse(room!.started_at!) : 0;
  const elapsedMs = Math.max(0, limitMs > 0 ? Math.min(raw, limitMs) : raw);
  const reached = limitMs > 0 && raw >= limitMs;
  const firedFor = useRef<string | null>(null);
  const onLimitRef = useRef(onLimit);
  onLimitRef.current = onLimit;
  const sessionId = room?.session_id ?? null;
  useEffect(() => {
    if (!reached || !sessionId || firedFor.current === sessionId) return;
    firedFor.current = sessionId;
    onLimitRef.current();
  }, [reached, sessionId]);
  return { elapsedMs, limitMs, reached };
}
