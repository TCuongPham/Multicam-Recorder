import type { UploadManager } from '@multicam/shared';
import { useStore } from '@multicam/shared/react';
import { ProgressBar } from './ui';

/** Thẻ tiến trình thu nhỏ (đầu màn Thư viện / màn quay). */
export function UploadMiniCard({ uploads }: { uploads: UploadManager }) {
  const s = useStore(uploads);
  if (!s.active && !s.error && !s.pending) return null;
  const phase = s.active?.phase === 'hashing' ? 'Đang tính mã băm' : s.active?.phase === 'completing' ? 'Đang hoàn tất' : 'Đang upload';
  return (
    <div className="card upload-mini">
      {s.active ? (
        <>
          <div className="upload-mini-head">
            <strong>{phase}</strong>
            <span className="muted small">{Math.round(s.active.percent)}% · còn {Math.max(0, s.pending - 1)} clip chờ</span>
          </div>
          <ProgressBar percent={s.active.percent} />
        </>
      ) : s.error ? (
        <div className="upload-mini-head">
          <span className="error-text">{s.blocked ? 'Đã hết dung lượng lưu trữ — Controller cần xóa bớt clip cũ' : `Upload tạm dừng: ${s.error}`}</span>
          <button className="btn btn-sm" onClick={() => uploads.kick({ force: true })}>
            Thử lại
          </button>
        </div>
      ) : (
        <span className="muted small">{s.pending} clip chờ upload</span>
      )}
    </div>
  );
}
