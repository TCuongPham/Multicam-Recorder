import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, BULK_DELETE_MAX, Codes, formatBytes, formatDateTime, formatDuration, sleep, type BulkDeleteResult, type VideoItem } from '@multicam/shared';
import { groupBySession, useDownloadQueue, useVideoLibrary } from '@multicam/shared/react';
import { IconCheck, IconDownload, IconRefresh, IconSelectAll, IconTrash, IconX } from '../components/icons';
import { Banner, EmptyState, Modal, errorText, useConfirm, useOneShot } from '../components/ui';
import { api, tabKv } from '../lib/platform';
import { useSession } from '../lib/session';

/** Trình phát trong ứng dụng: lấy URL có chữ ký qua get_video, không cần tải về. */
export function VideoPlayerModal({ video, onClose, onGone }: { video: VideoItem; onClose: () => void; onGone?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .getVideo(video.id)
      .then((d) => setUrl(d.url))
      .catch((e) => {
        if (e instanceof ApiError && e.code === Codes.VIDEO_NOT_FOUND) onGone?.();
        setError(errorText(e));
      });
  }, [video.id, onGone]);
  return (
    <Modal title={`${video.camera_name} · ${formatDateTime(video.recorded_at)}`} onClose={onClose}>
      {error ? <Banner kind="error">{error}</Banner> : null}
      {url ? <video className="player" src={url} controls autoPlay playsInline controlsList="nodownload" /> : !error ? <div className="muted">Đang tải…</div> : null}
      <div className="player-meta muted small tabular">
        {[formatDuration(video.duration_ms), formatBytes(video.size), /^\d+x\d+$/.test(video.resolution ?? '') ? video.resolution : null, Number(video.fps) ? `${Math.round(Number(video.fps))}fps` : null]
          .filter(Boolean)
          .join(' · ')}
      </div>
    </Modal>
  );
}

export function VideoCard(props: { video: VideoItem; selectable?: boolean; selected?: boolean; onToggle?: () => void; onOpen: () => void }) {
  const v = props.video;
  return (
    <div className={`video-card ${props.selected ? 'selected' : ''}`} onClick={props.selectable ? props.onToggle : props.onOpen}>
      <div className="thumb">
        {v.thumbnail_url ? <img src={v.thumbnail_url} alt="" loading="lazy" /> : <div className="thumb-empty">MP4</div>}
        <span className="duration">{formatDuration(v.duration_ms)}</span>
        {props.selectable ? <span className={`check ${props.selected ? 'on' : ''}`}>{props.selected ? <IconCheck size={14} /> : null}</span> : null}
        {v.downloaded_by_controller ? (
          <span className="badge-dl" title="Đã tải về">
            <IconDownload size={13} />
          </span>
        ) : null}
      </div>
      <div className="video-info">
        <strong>{v.camera_name}</strong>
        <span className="muted small">
          {formatDateTime(v.recorded_at)} · {formatBytes(v.size)}
        </span>
        <VideoSpecs resolution={v.resolution} fps={v.fps} />
      </div>
    </div>
  );
}

/** Độ phân giải · fps của clip (ẩn phần chưa biết). */
export function VideoSpecs({ resolution, fps }: { resolution?: string | null; fps?: number | string | null }) {
  const res = resolution && /^\d+x\d+$/.test(resolution) ? resolution : null;
  const f = Math.round(Number(fps) || 0);
  if (!res && !f) return null;
  return <span className="muted small tabular">{[res, f ? `${f}fps` : null].filter(Boolean).join(' · ')}</span>;
}

/** Nút tải lại: icon xoay khi bấm và trong lúc đang tải. */
export function RefreshButton({ fetching, onRefresh }: { fetching: boolean; onRefresh: () => void }) {
  const [spinClass, spin] = useOneShot('spin-once', 600);
  return (
    <button
      className={`btn btn-icon ${fetching ? 'spin' : spinClass}`}
      title="Làm mới"
      aria-label="Làm mới"
      onClick={() => {
        spin();
        onRefresh();
      }}
    >
      <IconRefresh />
    </button>
  );
}

/** Thư viện của Controller: gom theo phiên quay, chọn nhiều / chọn cả phiên / chọn tất cả, hàng đợi tải về. */
export function LibraryPage() {
  const { session } = useSession();
  const isController = session?.role === 'controller';
  const queryClient = useQueryClient();
  const lib = useVideoLibrary(api, tabKv, { sort: 'created_at_desc', pageSize: 24 });
  const groups = useMemo(() => groupBySession(lib.videos), [lib.videos]);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<VideoItem | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkDeleteResult | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const sentinel = useRef<HTMLDivElement>(null);

  // Cuộn tới cuối danh sách → gọi lại với index tăng dần.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && lib.hasNextPage && !lib.isFetchingNextPage) void lib.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [lib]);

  // Tải lần lượt từng clip: xin link (4002 thì chờ lượt trước xong), rồi để trình duyệt tải.
  const downloads = useDownloadQueue(async (video) => {
    const deadline = Date.now() + 15 * 60_000;
    for (;;) {
      try {
        const res = await api.getDownloadUrl(video.id);
        const a = document.createElement('a');
        a.href = res.download_url;
        a.download = `${video.name}.mp4`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      } catch (e) {
        if (e instanceof ApiError && e.code === Codes.DOWNLOAD_IN_PROGRESS && Date.now() < deadline) {
          await sleep(2000);
          continue;
        }
        throw e;
      }
    }
  });
  useEffect(() => {
    if (!downloads.active && downloads.total) void queryClient.invalidateQueries({ queryKey: ['videos'] });
  }, [downloads.active, downloads.total, queryClient]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  /** Chọn / bỏ chọn một nhóm clip (cả phiên, hoặc tất cả). */
  const toggleMany = (ids: string[]) =>
    setSelected((s) => {
      const allOn = ids.every((id) => s.has(id));
      const n = new Set(s);
      for (const id of ids) {
        if (allOn) n.delete(id);
        else n.add(id);
      }
      return n;
    });

  const allIds = lib.videos.map((v) => v.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const selectAll = async () => {
    if (allSelected) return setSelected(new Set());
    // "Chọn tất cả" lấy nốt các trang chưa tải để chọn đủ toàn bộ thư viện.
    let data = lib.data;
    let hasNext = lib.hasNextPage;
    while (hasNext) {
      const r = await lib.fetchNextPage();
      data = r.data;
      hasNext = r.hasNextPage && !r.isError;
    }
    const ids = (data?.pages ?? []).flatMap((p) => p.videos.map((v) => v.id));
    setSelected(new Set(ids.length ? ids : allIds));
  };

  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const removeSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!(await confirm(`Xóa ${ids.length} clip?`, <p>Clip trên máy quay không bị xóa.</p>))) return;
    setError(null);
    const failed: BulkDeleteResult['failed'] = [];
    const deleted: string[] = [];
    try {
      if (ids.length === 1) {
        await api.deleteVideo(ids[0]); // một clip → delete_video
        deleted.push(ids[0]);
      } else {
        // Từ hai clip → delete_videos_bulk, chia lô tối đa 50 clip mỗi lời gọi.
        for (let i = 0; i < ids.length; i += BULK_DELETE_MAX) {
          setDeleting(`Đang xóa ${Math.min(i + BULK_DELETE_MAX, ids.length)}/${ids.length}…`);
          const res = await api.deleteVideosBulk(ids.slice(i, i + BULK_DELETE_MAX));
          deleted.push(...res.deleted);
          failed.push(...res.failed);
        }
      }
      if (failed.length) setBulkResult({ deleted, failed });
      exitSelect();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: ['videos'] });
    }
  };

  const selectedVideos = lib.videos.filter((v) => selected.has(v.id));

  return (
    <div className="page">
      {dialog}
      <div className="page-head">
        <h1>Thư viện</h1>
        <span className="muted small">{lib.total} clip</span>
        <span className="spacer" />
        {isController && !selectMode ? (
          <button className="btn" onClick={() => setSelectMode(true)} disabled={!lib.videos.length}>
            Chọn
          </button>
        ) : null}
        <RefreshButton fetching={lib.isRefetching && !lib.isFetchingNextPage} onRefresh={() => void lib.refetch()} />
      </div>

      {isController && selectMode ? (
        <div className="select-bar">
          <button className="btn btn-sm" onClick={() => void selectAll()}>
            <IconSelectAll size={15} /> {allSelected ? 'Bỏ chọn' : 'Chọn tất cả'}
          </button>
          <span className="small muted">{selected.size} đã chọn</span>
          <span className="spacer" />
          <button className="btn btn-sm" disabled={!selected.size || downloads.active} onClick={() => downloads.enqueue(selectedVideos)}>
            <IconDownload size={15} /> Tải về
          </button>
          <button className="btn btn-sm btn-danger" disabled={!selected.size || !!deleting} onClick={removeSelected}>
            <IconTrash size={15} /> Xóa
          </button>
          <button className="btn btn-sm btn-ghost" onClick={exitSelect} aria-label="Thoát chế độ chọn">
            <IconX size={15} /> Xong
          </button>
        </div>
      ) : null}

      {downloads.label ? <Banner kind="info">{downloads.label} — {downloads.current?.camera_name}</Banner> : null}
      {downloads.errors.map((e) => (
        <Banner key={e.video.id} kind="error">
          Lỗi tải {e.video.name}: {e.message}
        </Banner>
      ))}
      {deleting ? <Banner kind="info">{deleting}</Banner> : null}
      {lib.fromCache ? <Banner kind="info">Ngoại tuyến · dữ liệu đã lưu</Banner> : null}
      {error ? <Banner kind="error">{error}</Banner> : null}
      {lib.error && !lib.videos.length ? <Banner kind="error">{errorText(lib.error)}</Banner> : null}

      {lib.isLoading ? (
        <div className="muted">Đang tải…</div>
      ) : !lib.videos.length ? (
        <EmptyState title="Chưa có video nào" />
      ) : (
        groups.map((g) => {
          const ids = g.videos.map((v) => v.id);
          const groupAll = ids.every((id) => selected.has(id));
          return (
            <section key={g.session_id ?? g.videos[0].id} className="session-group">
              <div className="session-head">
                <h3>{g.session_id ? `Phiên ${g.session_id}` : 'Quay lẻ'}</h3>
                <span className="muted small">
                  {formatDateTime(g.recorded_at)} · {g.videos.length} góc máy
                </span>
                {selectMode ? (
                  <button className="btn btn-sm btn-ghost" onClick={() => toggleMany(ids)}>
                    {groupAll ? 'Bỏ chọn phiên' : 'Chọn phiên'}
                  </button>
                ) : null}
              </div>
              <div className="video-grid">
                {g.videos.map((v) => (
                  <VideoCard key={v.id} video={v} selectable={selectMode} selected={selected.has(v.id)} onToggle={() => toggle(v.id)} onOpen={() => setPlaying(v)} />
                ))}
              </div>
            </section>
          );
        })
      )}
      <div ref={sentinel} className="sentinel">
        {lib.isFetchingNextPage ? 'Đang tải thêm…' : ''}
      </div>

      {playing ? <VideoPlayerModal video={playing} onClose={() => setPlaying(null)} onGone={() => void queryClient.invalidateQueries({ queryKey: ['videos'] })} /> : null}
      {bulkResult ? (
        <Modal title={`Không xóa được ${bulkResult.failed.length} clip`} onClose={() => setBulkResult(null)}>
          <table className="table">
            <tbody>
              {bulkResult.failed.map((f) => (
                <tr key={f.video_id}>
                  <td>{f.video_id}</td>
                  <td className="error-text">{f.reason === 'NOT_FOUND' ? 'Không tồn tại' : f.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      ) : null}
    </div>
  );
}
