import { useEffect, useMemo, useState } from 'react';
import { formatBytes, formatDateTime, formatDuration, type VideoItem } from '@multicam/shared';
import { useStore, useVideoLibrary } from '@multicam/shared/react';
import { Banner, EmptyState, Modal } from '../components/ui';
import { UploadMiniCard } from '../components/UploadMiniCard';
import { clipStore, type ClipRecord } from '../lib/clipStore';
import { api, localKv } from '../lib/platform';
import { useSession } from '../lib/session';
import { VideoCard, VideoPlayerModal } from './LibraryPage';

/** Thư viện của Remote: chỉ xem lại trong ứng dụng — không có nút tải xuống, không có nút xóa. */
export function RemoteLibraryPage() {
  const { runtime } = useSession();
  const [tab, setTab] = useState<'local' | 'server'>('local');
  return (
    <div className="page">
      <div className="page-head">
        <h1>Thư viện</h1>
        <div className="tabs">
          <button className={tab === 'local' ? 'active' : ''} onClick={() => setTab('local')}>
            Trên máy này
          </button>
          <button className={tab === 'server' ? 'active' : ''} onClick={() => setTab('server')}>
            Đã upload
          </button>
        </div>
      </div>
      {runtime ? <UploadMiniCard uploads={runtime.uploads} /> : null}
      {tab === 'local' ? <LocalClips /> : <ServerClips />}
    </div>
  );
}

function LocalClips() {
  const { runtime } = useSession();
  const uploadState = useStore(runtime!.uploads);
  const [clips, setClips] = useState<ClipRecord[] | null>(null);
  const [playing, setPlaying] = useState<{ clip: ClipRecord; url: string } | null>(null);
  const thumbs = useMemo(() => new Map<string, string>(), []);

  useEffect(() => {
    void clipStore.all().then((all) => setClips(all.filter((c) => c.finalized).sort((a, b) => b.createdAt - a.createdAt)));
  }, [uploadState.active?.uid, uploadState.pending, uploadState.lastResult]);

  useEffect(() => () => thumbs.forEach((u) => URL.revokeObjectURL(u)), [thumbs]);

  const thumbUrl = (c: ClipRecord) => {
    if (!c.thumb) return null;
    if (!thumbs.has(c.uid)) thumbs.set(c.uid, URL.createObjectURL(c.thumb));
    return thumbs.get(c.uid)!;
  };

  const open = async (clip: ClipRecord) => {
    const blob = await clipStore.blob(clip.uid, clip.mimeType);
    setPlaying({ clip, url: URL.createObjectURL(blob) });
  };

  if (!clips) return <div className="muted">Đang tải…</div>;
  if (!clips.length) return <EmptyState title="Chưa có clip nào trên máy" />;
  return (
    <>
      <div className="video-grid">
        {clips.map((c) => {
          const active = uploadState.active?.uid === c.uid;
          return (
            <div key={c.uid} className="video-card" onClick={() => void open(c)}>
              <div className="thumb">
                {thumbUrl(c) ? <img src={thumbUrl(c)!} alt="" /> : <div className="thumb-empty">MP4</div>}
                <span className="duration">{formatDuration(c.metadata.duration_ms)}</span>
              </div>
              <div className="video-info">
                <strong>{c.metadata.session_id ? `Phiên ${c.metadata.session_id}` : 'Quay độc lập'}</strong>
                <span className="muted small">
                  {formatDateTime(c.metadata.recorded_at)} · {formatBytes(c.size)}
                </span>
                <span className={`small ${c.uploaded ? 'ok-text' : ''}`}>
                  {c.uploaded ? '✓ Đã gửi lên server' : active ? `Đang upload ${Math.round(uploadState.active!.percent)}%` : 'Chờ upload'}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {playing ? (
        <Modal
          title={formatDateTime(playing.clip.metadata.recorded_at)}
          onClose={() => {
            URL.revokeObjectURL(playing.url);
            setPlaying(null);
          }}
        >
          <video className="player" src={playing.url} controls autoPlay playsInline controlsList="nodownload" />
        </Modal>
      ) : null}
    </>
  );
}

function ServerClips() {
  const lib = useVideoLibrary(api, localKv, { pageSize: 24 });
  const [playing, setPlaying] = useState<VideoItem | null>(null);
  if (lib.isLoading) return <div className="muted">Đang tải…</div>;
  return (
    <>
      {lib.fromCache ? <Banner kind="info">Mất mạng — đang hiển thị dữ liệu đã lưu.</Banner> : null}
      {!lib.videos.length ? (
        <EmptyState title="Chưa có video nào" />
      ) : (
        <div className="video-grid">
          {lib.videos.map((v) => (
            <VideoCard key={v.id} video={{ ...v, downloaded_by_controller: 0 }} onOpen={() => setPlaying(v)} />
          ))}
        </div>
      )}
      {lib.hasNextPage ? (
        <button className="btn" onClick={() => void lib.fetchNextPage()} disabled={lib.isFetchingNextPage}>
          Tải thêm
        </button>
      ) : null}
      {playing ? <VideoPlayerModal video={playing} onClose={() => setPlaying(null)} /> : null}
    </>
  );
}
