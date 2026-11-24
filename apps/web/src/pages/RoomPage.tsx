import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { ApiError, Codes, connectRealtime, formatBytes, formatDuration, uuid, type PreviewFrame, type StopRecordingResult } from '@multicam/shared';
import { useNow, useRoomConfig, useRoomController, useSessionClock, useSessionSummary, type MemberView, type SummaryRow } from '@multicam/shared/react';
import { IconBattery, IconCamera, IconCameraOff, IconChevronLeft, IconChevronRight, IconExpand, IconFlip, IconStop, IconStorage, IconUserMinus } from '../components/icons';
import { Banner, EmptyState, Modal, ProgressBar, errorText, useConfirm, useOneShot } from '../components/ui';
import { api } from '../lib/platform';

const RESOLUTIONS = ['1280x720', '1920x1080', '3840x2160'];
const PAGE_SIZE = 6;
const FRAME_STALE_MS = 5000;

type Frames = Record<string, { image: string; at: number }>;
type PendingFlips = Record<string, { from: string | null; at: number }>;

/** Màn Điều khiển của Controller: mã mời, nút quay, lưới màn hình camera của các máy Remote. */
export function RoomPage() {
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const now = useNow(1000);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<StopRecordingResult | null>(null);
  const [closed, setClosed] = useState(false);
  const [frames, setFrames] = useState<Frames>({});
  const [pendingFlips, setPendingFlips] = useState<PendingFlips>({});
  const [page, setPage] = useState(0);
  const [zoomId, setZoomId] = useState<string | null>(null);
  const [flipAllClass, flipAllAnim] = useOneShot('flip-once', 500);

  // Mở màn hình → create_room (đang có phòng mở thì server trả lại phòng cũ).
  const roomQuery = useQuery({ queryKey: ['create-room'], queryFn: () => api.createRoom({}), enabled: !closed, staleTime: Infinity });
  const room = roomQuery.data;
  const view = useRoomController(api, room?.room_id ?? null);
  const { config, setConfig } = useRoomConfig(api, room?.room_id ?? null, view.room);

  // Mã mời hết hạn → gọi lại create_room để lấy mã mới cho chính phòng này.
  useEffect(() => {
    if (!room) return;
    const ms = Date.parse(room.expires_at) - Date.now();
    const t = setTimeout(() => void roomQuery.refetch(), Math.max(1000, ms + 500));
    return () => clearTimeout(t);
  }, [room, roomQuery]);

  // Socket: phòng thay đổi → sync_room ngay; nhận khung hình xem trước của từng máy.
  const refreshRef = useRef(view.refresh);
  refreshRef.current = view.refresh;
  useEffect(() => {
    if (!room) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    return connectRealtime({
      baseUrl: window.location.origin,
      getToken: () => api.getAccessToken(),
      onRoomChanged: (p) => {
        if (p.room_id !== room.room_id || pending) return;
        pending = setTimeout(() => {
          pending = null;
          refreshRef.current();
        }, 250);
      },
      onPreview: (f: PreviewFrame) => {
        if (f.room_id !== room.room_id) return;
        setFrames((prev) => ({ ...prev, [f.member_id]: { image: f.image, at: Date.now() } }));
      },
    });
  }, [room]);

  // Lệnh lật đã tới máy khi camera_facing đổi (hoặc hết 6 giây chờ).
  useEffect(() => {
    setPendingFlips((prev) => {
      const next: PendingFlips = {};
      for (const [id, p] of Object.entries(prev)) {
        const m = view.members.find((x) => x.member_id === id);
        if (m && m.camera_facing === p.from && Date.now() - p.at < 6000) next[id] = p;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [view.members, now]);

  const status = view.room?.status ?? room?.status ?? 'open';
  const recording = status === 'recording';
  const onlineCount = view.members.filter((m) => m.online).length;
  const pageCount = Math.max(1, Math.ceil(view.members.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageMembers = view.members.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
        view.refresh();
      }
    },
    [view],
  );

  const start = () =>
    run(async () => {
      const res = await api.startRecording(room!.room_id, { target: 'all', config, client_command_id: uuid() });
      if (res.rejected.length) setError(`${res.rejected.length} máy mất kết nối`);
    });

  const stop = (auto = false) =>
    run(async () => {
      try {
        const res = await api.stopRecording(room!.room_id, { target: 'all', client_command_id: uuid() });
        setSummary(res);
      } catch (e) {
        // Tự dừng khi hết giờ mà server đã kết thúc phiên trước: không báo lỗi.
        if (!(auto && e instanceof ApiError && e.code === Codes.INVALID_SESSION_STATE)) throw e;
      }
    });

  // Hết giới hạn thời gian: đồng hồ dừng đúng giới hạn và phiên tự kết thúc.
  const clock = useSessionClock(view, now, () => void stop(true));

  const flip = (targets: MemberView[]) => {
    const at = Date.now();
    setPendingFlips((prev) => ({ ...prev, ...Object.fromEntries(targets.map((m) => [m.member_id, { from: m.camera_facing, at }])) }));
    const all = targets.length === view.members.length && targets.length > 1;
    void run(() =>
      api.switchCamera(room!.room_id, { target: all ? 'all' : targets.map((m) => m.member_id), facing: 'toggle', client_command_id: uuid() }),
    );
  };

  const kick = async (m: MemberView) => {
    if (!(await confirm(`Loại ${m.camera_name}?`, <p>Clip đang quay vẫn được lưu.</p>))) return;
    await run(() => api.kickMember(room!.room_id, m.member_id));
  };

  const closeRoom = async () => {
    const msg = recording ? 'Phiên quay sẽ dừng.' : 'Mọi máy sẽ rời phòng.';
    if (!(await confirm('Đóng phòng?', <p>{msg}</p>))) return;
    await run(async () => {
      await api.closeRoom(room!.room_id);
      setClosed(true);
      setFrames({});
      queryClient.removeQueries({ queryKey: ['create-room'] });
    });
  };

  const zoomMember = view.members.find((m) => m.member_id === zoomId) ?? null;

  if (closed) {
    return (
      <div className="page">
        <EmptyState title="Phòng đã đóng">
          <button className="btn btn-primary" onClick={() => setClosed(false)}>
            Tạo phòng mới
          </button>
        </EmptyState>
      </div>
    );
  }
  if (roomQuery.isLoading) return <div className="page muted">Đang mở phòng…</div>;
  if (roomQuery.error || !room) {
    return (
      <div className="page">
        <Banner kind="error">{errorText(roomQuery.error)}</Banner>
      </div>
    );
  }

  return (
    <div className="page room-page">
      {dialog}
      <div className="room-top">
        <section className="card invite-card">
          <div>
            <div className="invite-label">Mã mời</div>
            <div className="invite-code">{view.room?.invite_code ?? room.invite_code}</div>
            <div className="muted small">Hết hạn {new Date(room.expires_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
          <div className="qr">
            <QRCodeSVG value={view.room?.invite_code ?? room.invite_code} size={104} bgColor="#ffffff" fgColor="#101318" />
          </div>
        </section>

        <section className="card controls">
          <div className="controls-row">
            <label className="field compact">
              <span>Độ phân giải</span>
              <select value={config.resolution} disabled={recording} onChange={(e) => setConfig({ resolution: e.target.value })}>
                {RESOLUTIONS.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <label className="field compact">
              <span>FPS</span>
              <select value={config.fps} disabled={recording} onChange={(e) => setConfig({ fps: Number(e.target.value) })}>
                {[24, 30, 60].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <label className="field compact">
              <span>Giới hạn (giây)</span>
              <input type="number" min={0} value={config.max_duration} disabled={recording} onChange={(e) => setConfig({ max_duration: Math.max(0, Math.floor(Number(e.target.value)) || 0) })} />
            </label>
          </div>
          <div className="controls-row">
            {recording ? (
              <button className="btn btn-danger btn-lg" disabled={busy} onClick={() => void stop()}>
                <IconStop size={16} /> Dừng
              </button>
            ) : (
              <button className="btn btn-record btn-lg" disabled={busy || onlineCount === 0 || status === 'closing'} onClick={start}>
                <span className="rec-glyph" /> Quay
              </button>
            )}
            <button
              className={`btn ${flipAllClass}`}
              disabled={busy || recording || !view.members.length}
              title={recording ? 'Không lật khi đang quay' : undefined}
              onClick={() => {
                flipAllAnim();
                flip(view.members.filter((m) => m.online));
              }}
            >
              <IconFlip /> Lật tất cả
            </button>
            <span className="spacer" />
            <button className="btn btn-ghost-danger" disabled={busy} onClick={closeRoom}>
              Đóng phòng
            </button>
          </div>
          {recording ? (
            <div className="session-bar">
              <span className="rec-badge">
                <span className="dot" /> REC
              </span>
              <span className="tabular">
                {formatDuration(clock.elapsedMs)}
                {clock.limitMs ? <span className="muted"> / {formatDuration(clock.limitMs)}</span> : null}
              </span>
              <span className="muted">{view.room?.session_id}</span>
            </div>
          ) : null}
          {status === 'closing' ? <Banner kind="info">Đang đóng phòng…</Banner> : null}
          {error ? <Banner kind="error">{error}</Banner> : null}
        </section>
      </div>

      <section>
        <div className="section-head">
          <h2>Camera</h2>
          <span className="muted small">
            {onlineCount}/{view.members.length} trực tuyến
          </span>
        </div>
        {view.members.length === 0 ? (
          <div className="card">
            <EmptyState title="Chưa có máy nào">Chờ máy quay tham gia</EmptyState>
          </div>
        ) : (
          <>
            <div className="cam-grid">
              {pageMembers.map((m) => (
                <CameraTile
                  key={m.member_id}
                  member={m}
                  frame={frames[m.member_id]}
                  now={now}
                  flipping={!!pendingFlips[m.member_id]}
                  locked={recording}
                  busy={busy}
                  onFlip={() => flip([m])}
                  onKick={() => void kick(m)}
                  onZoom={() => setZoomId(m.member_id)}
                />
              ))}
            </div>
            {pageCount > 1 ? (
              <div className="pager">
                <button className="icon-btn" disabled={safePage === 0} onClick={() => setPage(safePage - 1)} aria-label="Trang trước">
                  <IconChevronLeft />
                </button>
                {Array.from({ length: pageCount }, (_, i) => (
                  <button key={i} className={`page-dot ${i === safePage ? 'active' : ''}`} onClick={() => setPage(i)}>
                    {i + 1}
                  </button>
                ))}
                <button className="icon-btn" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)} aria-label="Trang sau">
                  <IconChevronRight />
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>

      {zoomMember ? (
        <Modal title={zoomMember.camera_name} onClose={() => setZoomId(null)}>
          <div className="zoom-view">
            {frames[zoomMember.member_id] ? <img src={frames[zoomMember.member_id].image} alt="" /> : <div className="cam-placeholder">Đang kết nối</div>}
            {zoomMember.recording_state === 'recording' ? (
              <div className="cam-overlay">
                <span className="rec-badge">
                  <span className="dot" /> REC
                </span>
                <span className="cam-chip">{formatDuration(zoomMember.elapsedLiveMs)}</span>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {summary ? <SummaryModal summary={summary} members={view.members} onClose={() => setSummary(null)} /> : null}
    </div>
  );
}

function CameraTile(props: {
  member: MemberView;
  frame?: { image: string; at: number };
  now: number;
  flipping: boolean;
  /** Phiên đang quay: không cho lật camera. */
  locked: boolean;
  busy: boolean;
  onFlip: () => void;
  onKick: () => void;
  onZoom: () => void;
}) {
  const m = props.member;
  const [flipClass, flipAnim] = useOneShot('flip-once', 500);
  const isRec = m.recording_state === 'recording';
  const frameFresh = props.frame && props.now - props.frame.at < FRAME_STALE_MS;
  const uploading = m.upload_state === 'uploading';
  return (
    <article className={`cam-tile ${isRec ? 'recording' : ''} ${m.online ? '' : 'offline'}`}>
      <div className="cam-screen" onClick={props.onZoom} title="Phóng to">
        {props.frame ? <img src={props.frame.image} alt="" /> : null}
        {!props.frame || !m.online ? (
          <div className="cam-placeholder">
            {m.online ? <IconCamera size={22} /> : <IconCameraOff size={22} />}
            <span>{m.online ? 'Đang kết nối' : 'Mất kết nối'}</span>
          </div>
        ) : null}
        <div className="cam-overlay">
          {isRec ? (
            <span className="rec-badge">
              <span className="dot" /> REC
            </span>
          ) : null}
          {isRec ? <span className="cam-chip">{formatDuration(m.elapsedLiveMs)}</span> : null}
          <span className="spacer" />
          {props.frame && !frameFresh && m.online ? <span className="cam-chip">Hình cũ</span> : null}
          <span className="cam-chip">
            <IconExpand size={12} />
          </span>
        </div>
        {uploading ? (
          <div className="cam-progress">
            <div style={{ width: `${Number(m.upload_percent)}%` }} />
          </div>
        ) : null}
      </div>
      <div className="cam-body">
        <div className="cam-title">
          <span className={`status-dot ${m.online ? 'on' : 'off'}`} />
          <strong>{m.camera_name}</strong>
          <span className="spacer" />
          <StatusTag member={m} />
        </div>
        <div className="cam-meta">
          <span className="inline-icon">
            <IconBattery size={15} level={m.battery_level === null ? null : Number(m.battery_level)} />
            {m.battery_level ?? '—'}%
          </span>
          <span className="inline-icon">
            <IconStorage size={14} /> {formatBytes(m.storage_free)}
          </span>
          <span className="inline-icon">
            <IconCamera size={14} /> {props.flipping ? 'Đang lật…' : m.camera_facing === 'front' ? 'Trước' : m.camera_facing === 'back' ? 'Sau' : '—'}
          </span>
        </div>
        {uploading ? (
          <div className="upload-line">
            <ProgressBar percent={Number(m.upload_percent)} />
            <span className="small tabular">{m.upload_percent}%</span>
          </div>
        ) : null}
        <div className="cam-actions">
          <button
            className={`btn btn-sm ${flipClass}`}
            disabled={props.busy || props.locked || !m.online || props.flipping}
            title={props.locked ? 'Không lật khi đang quay' : undefined}
            onClick={() => {
              flipAnim();
              props.onFlip();
            }}
          >
            <IconFlip size={15} /> Lật
          </button>
          <button className="btn btn-sm btn-ghost-danger" disabled={props.busy} onClick={props.onKick}>
            <IconUserMinus size={15} /> Loại
          </button>
        </div>
      </div>
    </article>
  );
}

function StatusTag({ member: m }: { member: MemberView }) {
  if (!m.online) return <span className="tag">Mất kết nối</span>;
  if (m.recording_state === 'failed' || (m.error_code && m.error_code !== 'null')) return <span className="tag tag-error" title={m.error_code ?? ''}>Lỗi</span>;
  if (m.recording_state === 'recording') return null;
  if (m.upload_state === 'uploading') return <span className="tag">Đang tải lên</span>;
  if (m.upload_state === 'uploaded') return <span className="tag tag-ok">Đã tải lên</span>;
  if (m.recording_state === 'saved') return <span className="tag">Đã lưu</span>;
  return <span className="tag">Sẵn sàng</span>;
}

const SUMMARY_LABEL: Record<SummaryRow['status'], string> = {
  uploaded: 'Đã tải lên',
  uploading: 'Đang tải lên',
  stopping: 'Đang dừng',
  processing: 'Đang xử lý',
  failed: 'Lỗi',
  offline: 'Mất kết nối',
};

/** Tổng kết phiên: trạng thái lấy từ thư viện trên server, không dùng lại kết quả của phiên trước. */
function SummaryModal({ summary, members, onClose }: { summary: StopRecordingResult; members: MemberView[]; onClose: () => void }) {
  const { rows, done } = useSessionSummary(api, summary, members);
  return (
    <Modal title={`Phiên ${summary.session_id}`} onClose={onClose}>
      {rows.length === 0 ? (
        <EmptyState title="Không có clip" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Máy</th>
              <th>Thời lượng</th>
              <th style={{ width: '45%' }}>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.member_id}>
                <td>{r.camera_name}</td>
                <td className="tabular">{formatDuration(r.duration_ms)}</td>
                <td>
                  {r.status === 'uploading' ? (
                    <div className="upload-line">
                      <ProgressBar percent={r.percent} />
                      <span className="small tabular">{r.percent}%</span>
                    </div>
                  ) : (
                    <span className={r.status === 'uploaded' ? 'ok-text' : r.status === 'failed' ? 'error-text' : 'muted'}>
                      {SUMMARY_LABEL[r.status]}
                      {r.error ? ` (${r.error})` : ''}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {done ? <Banner kind="success">Đã tải lên xong</Banner> : null}
    </Modal>
  );
}
