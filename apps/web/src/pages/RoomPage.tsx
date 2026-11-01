import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { connectRealtime, formatBytes, formatDuration, uuid, type StopRecordingResult } from '@multicam/shared';
import { useRoomController } from '@multicam/shared/react';
import { Banner, EmptyState, Modal, ProgressBar, errorText, useConfirm } from '../components/ui';
import { api } from '../lib/platform';

const RESOLUTIONS = ['1280x720', '1920x1080', '3840x2160'];

/** Màn Điều khiển của Controller. */
export function RoomPage() {
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState({ resolution: '1920x1080', fps: 30, max_duration: 0 });
  const [summary, setSummary] = useState<StopRecordingResult | null>(null);
  const [closed, setClosed] = useState(false);

  // Mở màn hình → create_room (đang có phòng mở thì server trả lại phòng cũ).
  const roomQuery = useQuery({ queryKey: ['create-room'], queryFn: () => api.createRoom({}), enabled: !closed, staleTime: Infinity });
  const room = roomQuery.data;
  const view = useRoomController(api, room?.room_id ?? null);

  // Mã mời hết hạn → gọi lại create_room để lấy mã mới cho chính phòng này.
  useEffect(() => {
    if (!room) return;
    const ms = Date.parse(room.expires_at) - Date.now();
    const t = setTimeout(() => void roomQuery.refetch(), Math.max(1000, ms + 500));
    return () => clearTimeout(t);
  }, [room, roomQuery]);

  // Socket: phòng thay đổi → sync_room ngay thay vì chờ nhịp kế tiếp.
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
        }, 300);
      },
    });
  }, [room]);

  const status = view.room?.status ?? room?.status ?? 'open';
  const recording = status === 'recording';
  const onlineCount = view.members.filter((m) => m.online).length;

  const run = useCallback(async (fn: () => Promise<unknown>) => {
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
  }, [view]);

  const start = () =>
    run(async () => {
      const res = await api.startRecording(room!.room_id, { target: 'all', config, client_command_id: uuid() });
      if (res.rejected.length) setError(`${res.rejected.length} máy đang mất kết nối nên không nhận lệnh quay`);
    });

  const stop = () =>
    run(async () => {
      const res = await api.stopRecording(room!.room_id, { target: 'all', client_command_id: uuid() });
      setSummary(res);
    });

  const flip = (memberId?: string) =>
    run(() => api.switchCamera(room!.room_id, { target: memberId ? [memberId] : 'all', facing: 'toggle', client_command_id: uuid() }));

  const kick = async (memberId: string, name: string) => {
    if (!(await confirm('Loại khỏi phòng', <p>Loại máy <b>{name}</b> khỏi phòng? Nếu máy đang quay, clip sẽ được ghi xong và tự upload trước khi bị loại.</p>))) return;
    await run(() => api.kickMember(room!.room_id, memberId));
  };

  const closeRoom = async () => {
    const msg = recording ? 'Đang quay: server sẽ dừng quay ở mọi máy, chờ upload xong rồi mới đóng hẳn phòng.' : 'Mã mời sẽ bị vô hiệu hóa và mọi máy rời phòng.';
    if (!(await confirm('Đóng phòng', <p>{msg}</p>))) return;
    await run(async () => {
      await api.closeRoom(room!.room_id);
      setClosed(true);
      queryClient.removeQueries({ queryKey: ['create-room'] });
    });
  };

  const summaryRows = useMemo(() => {
    if (!summary) return [];
    return summary.results.map((r) => {
      const live = view.members.find((m) => m.member_id === r.member_id);
      return { ...r, camera: live?.camera_name ?? r.member_id, upload_state: live?.upload_state ?? 'none', upload_percent: Number(live?.upload_percent ?? 0) };
    });
  }, [summary, view.members]);

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
  if (roomQuery.error || !room) return <div className="page"><Banner kind="error">{errorText(roomQuery.error)}</Banner></div>;

  return (
    <div className="page room-page">
      {dialog}
      <section className="card invite-card">
        <div>
          <div className="muted small">Mã mời · {room.room_name}</div>
          <div className="invite-code">{view.room?.invite_code ?? room.invite_code}</div>
          <div className="muted small">Hết hạn lúc {new Date(room.expires_at).toLocaleTimeString('vi-VN')} (tự cấp mã mới)</div>
          {status === 'closing' ? <Banner kind="info">Đang đóng phòng — chờ các máy upload xong…</Banner> : null}
        </div>
        <QRCodeSVG value={view.room?.invite_code ?? room.invite_code} size={132} bgColor="transparent" fgColor="currentColor" />
      </section>

      <section className="card controls">
        <div className="controls-row">
          <label className="field compact">
            <span>Độ phân giải</span>
            <select value={config.resolution} disabled={recording} onChange={(e) => setConfig({ ...config, resolution: e.target.value })}>
              {RESOLUTIONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label className="field compact">
            <span>FPS</span>
            <select value={config.fps} disabled={recording} onChange={(e) => setConfig({ ...config, fps: Number(e.target.value) })}>
              {[24, 30, 60].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label className="field compact">
            <span>Tối đa (giây, 0 = không giới hạn)</span>
            <input type="number" min={0} value={config.max_duration} disabled={recording} onChange={(e) => setConfig({ ...config, max_duration: Math.max(0, Number(e.target.value) || 0) })} />
          </label>
        </div>
        <div className="controls-row">
          {recording ? (
            <button className="btn btn-danger btn-lg" disabled={busy} onClick={stop}>
              ■ Dừng quay
            </button>
          ) : (
            <button className="btn btn-record btn-lg" disabled={busy || onlineCount === 0 || status === 'closing'} onClick={start}>
              ● Quay ({onlineCount} máy)
            </button>
          )}
          <button className="btn" disabled={busy || !view.members.length} onClick={() => flip()}>
            ⇄ Lật camera tất cả
          </button>
          <span className="spacer" />
          <button className="btn btn-ghost-danger" disabled={busy} onClick={closeRoom}>
            Đóng phòng
          </button>
        </div>
        {recording && view.room?.started_at ? <div className="rec-pill">● REC · phiên {view.room.session_id}</div> : null}
        {error ? <Banner kind="error">{error}</Banner> : null}
      </section>

      <section className="card">
        <h2>
          Thiết bị trong phòng <span className="muted">({view.members.length})</span>
        </h2>
        {view.members.length === 0 ? (
          <EmptyState title="Chưa có máy nào">Máy Remote nhập mã mời ở trên để vào phòng.</EmptyState>
        ) : (
          <ul className="device-list">
            {view.members.map((m) => (
              <li key={m.member_id} className={`device-row ${m.online ? '' : 'offline'}`}>
                <div className="device-main">
                  <div className="device-title">
                    {m.recording_state === 'recording' ? <span className="rec-dot" title="Đang quay" /> : <span className={`status-dot ${m.online ? 'on' : 'off'}`} />}
                    <strong>{m.camera_name}</strong>
                    {m.recording_state === 'recording' ? <span className="timer">{formatDuration(m.elapsedLiveMs)}</span> : null}
                    {!m.online ? <span className="tag">Mất kết nối</span> : null}
                    {m.error_code && m.error_code !== 'null' ? <span className="tag tag-error">{m.error_code}</span> : null}
                  </div>
                  <div className="device-meta">
                    <span>🔋 {m.battery_level ?? '—'}%{m.is_charging === '1' ? ' ⚡' : ''}</span>
                    <span>💾 {formatBytes(m.storage_free)}</span>
                    <span>📷 {m.camera_facing === 'front' ? 'Trước' : m.camera_facing === 'back' ? 'Sau' : '—'}</span>
                    <span>{recordingLabel(m.recording_state)}</span>
                  </div>
                  {m.upload_state === 'uploading' || m.upload_state === 'failed' ? (
                    <div className="upload-line">
                      <ProgressBar percent={Number(m.upload_percent)} />
                      <span className="small">{m.upload_state === 'failed' ? 'Upload lỗi' : `Upload ${m.upload_percent}%`}</span>
                    </div>
                  ) : m.upload_state === 'uploaded' ? (
                    <div className="small ok-text">✓ Đã upload</div>
                  ) : null}
                </div>
                <div className="device-actions">
                  <button className="btn btn-sm" disabled={busy || !m.online} onClick={() => flip(m.member_id)}>
                    ⇄ Lật
                  </button>
                  <button className="btn btn-sm btn-ghost-danger" disabled={busy} onClick={() => kick(m.member_id, m.camera_name)}>
                    Loại khỏi phòng
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {summary ? (
        <Modal title={`Tổng kết phiên ${summary.session_id}`} onClose={() => setSummary(null)}>
          <p className="muted">Các máy tự động upload clip lên server. Theo dõi tiến độ bên dưới.</p>
          <table className="table">
            <thead>
              <tr>
                <th>Máy</th>
                <th>Thời lượng</th>
                <th>Upload</th>
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((r) => (
                <tr key={r.member_id}>
                  <td>{r.camera}</td>
                  <td>{formatDuration(r.duration_ms)}</td>
                  <td style={{ minWidth: 140 }}>
                    {r.upload_state === 'uploaded' ? (
                      <span className="ok-text">✓ Xong</span>
                    ) : r.upload_state === 'failed' ? (
                      <span className="error-text">Lỗi</span>
                    ) : (
                      <ProgressBar percent={r.upload_percent} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {summaryRows.length && summaryRows.every((r) => r.upload_state === 'uploaded') ? <Banner kind="success">Tất cả máy đã upload xong.</Banner> : null}
        </Modal>
      ) : null}
    </div>
  );
}

function recordingLabel(s: string) {
  return { idle: 'Sẵn sàng', recording: 'Đang quay', saved: 'Đã lưu clip', failed: 'Lỗi quay' }[s] ?? s;
}
