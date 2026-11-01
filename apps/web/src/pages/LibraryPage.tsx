import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, Codes, formatBytes, formatDateTime, formatDuration, sleep, type BulkDeleteResult, type VideoItem } from '@multicam/shared';
import { groupBySession, useDownloadQueue, useVideoLibrary } from '@multicam/shared/react';
import { Banner, EmptyState, Modal, errorText, useConfirm } from '../components/ui';
import { api, localKv } from '../lib/platform';
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
        {props.selectable ? <span className={`check ${props.selected ? 'on' : ''}`}>{props.selected ? '✓' : ''}</span> : null}
        {v.downloaded_by_controller ? <span className="badge-dl" title="Đã tải về">⬇</span> : null}
      </div>
      <div className="video-info">
        <strong>{v.camera_name}</strong>
        <span className="muted small">
          {formatDateTime(v.recorded_at)} · {formatBytes(v.size)}
        </span>
      </div>
    </div>
  );
}

/** Thư viện của Controller: gom theo phiên quay, chọn nhiều để xóa, hàng đợi tải xuống. */
export function LibraryPage() {
  const { session } = useSession();
  const isController = session?.role === 'controller';
  const queryClient = useQueryClient();
  const lib = useVideoLibrary(api, localKv, { sort: 'created_at_desc', pageSize: 24 });
  const groups = useMemo(() => groupBySession(lib.videos), [lib.videos]);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<VideoItem | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkDeleteResult | null>(null);
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

  const removeSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!(await confirm('Xóa clip', <p>Xóa {ids.length} clip khỏi server? Bản trên máy Remote vẫn giữ nguyên và không bị upload lại.</p>))) return;
    setError(null);
    try {
      if (ids.length === 1) {
        await api.deleteVideo(ids[0]); // một clip → delete_video
      } else {
        const res = await api.deleteVideosBulk(ids.slice(0, 50)); // từ hai clip → delete_videos_bulk
        if (res.failed.length) setBulkResult(res);
      }
      setSelected(new Set());
      setSelectMode(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      void queryClient.invalidateQueries({ queryKey: ['videos'] });
    }
  };

  const selectedVideos = lib.videos.filter((v) => selected.has(v.id));

  return (
    <div className="page">
      {dialog}
      <div className="page-head">
        <h1>Thư viện</h1>
        <span className="muted">{lib.total} clip</span>
        <span className="spacer" />
        {isController ? (
          selectMode ? (
            <>
              <span className="muted small">Đã chọn {selected.size}</span>
              <button className="btn" disabled={!selected.size || downloads.active} onClick={() => downloads.enqueue(selectedVideos)}>
                ⬇ Tải về
              </button>
              <button className="btn btn-danger" disabled={!selected.size || selected.size > 50} onClick={removeSelected}>
                Xóa
              </button>
              <button className="btn" onClick={() => (setSelectMode(false), setSelected(new Set()))}>
                Xong
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setSelectMode(true)} disabled={!lib.videos.length}>
              Chọn nhiều
            </button>
          )
        ) : null}
        <button className="btn" onClick={() => void lib.refetch()} title="Làm mới">
          ↻
        </button>
      </div>

      {downloads.label ? <Banner kind="info">{downloads.label} — {downloads.current?.camera_name}</Banner> : null}
      {downloads.errors.map((e) => (
        <Banner key={e.video.id} kind="error">
          Không tải được {e.video.name}: {e.message}
        </Banner>
      ))}
      {selected.size > 50 ? <Banner kind="error">Chỉ xóa tối đa 50 clip mỗi lần.</Banner> : null}
      {lib.fromCache ? <Banner kind="info">Mất mạng — đang hiển thị dữ liệu đã lưu.</Banner> : null}
      {error ? <Banner kind="error">{error}</Banner> : null}
      {lib.error && !lib.videos.length ? <Banner kind="error">{errorText(lib.error)}</Banner> : null}

      {lib.isLoading ? (
        <div className="muted">Đang tải…</div>
      ) : !lib.videos.length ? (
        <EmptyState title="Chưa có video nào" />
      ) : (
        groups.map((g) => (
          <section key={g.session_id ?? g.videos[0].id} className="session-group">
            <h3>
              {g.session_id ? `Phiên ${g.session_id}` : 'Quay độc lập'} <span className="muted small">· {formatDateTime(g.recorded_at)} · {g.videos.length} góc máy</span>
            </h3>
            <div className="video-grid">
              {g.videos.map((v) => (
                <VideoCard key={v.id} video={v} selectable={selectMode} selected={selected.has(v.id)} onToggle={() => toggle(v.id)} onOpen={() => setPlaying(v)} />
              ))}
            </div>
          </section>
        ))
      )}
      <div ref={sentinel} className="sentinel">
        {lib.isFetchingNextPage ? 'Đang tải thêm…' : ''}
      </div>

      {playing ? <VideoPlayerModal video={playing} onClose={() => setPlaying(null)} onGone={() => void queryClient.invalidateQueries({ queryKey: ['videos'] })} /> : null}
      {bulkResult ? (
        <Modal title="Kết quả xóa" onClose={() => setBulkResult(null)}>
          <p>Đã xóa {bulkResult.deleted.length} clip. Các clip sau không xóa được:</p>
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
