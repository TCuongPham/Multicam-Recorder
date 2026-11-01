import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, Codes, MIN_FREE_STORAGE, formatBytes, formatDuration, inviteCodeSchema } from '@multicam/shared';
import { useNow, useStore } from '@multicam/shared/react';
import { Banner, errorText, useConfirm } from '../components/ui';
import { UploadMiniCard } from '../components/UploadMiniCard';
import { api } from '../lib/platform';
import { storageFree, type RemoteRuntime } from '../lib/remoteRuntime';
import { useSession } from '../lib/session';
import { supportedMp4Type } from '../lib/webRecorder';

/** Màn quay của máy Remote. */
export function CameraPage() {
  const { runtime } = useSession();
  if (!runtime) return <div className="page muted">Đang khởi động camera…</div>;
  return <CameraView runtime={runtime} />;
}

function CameraView({ runtime }: { runtime: RemoteRuntime }) {
  const { session } = useSession();
  const agent = useStore(runtime.agent);
  const rec = useStore(runtime.recorder);
  const now = useNow(500);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { confirm, dialog } = useConfirm();
  const [free, setFree] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [cameraName, setCameraName] = useState(runtime.getCameraName());
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const mp4 = supportedMp4Type();
  const recording = agent.recordingState === 'recording';
  const lowStorage = free !== null && free < MIN_FREE_STORAGE;

  // Khung xem trực tiếp.
  useEffect(() => {
    void runtime.recorder.ensureStream().catch(() => undefined);
    return () => {
      if (!runtime.agent.getState().inRoom) runtime.recorder.releaseStream();
    };
  }, [runtime]);
  useEffect(() => {
    if (videoRef.current && videoRef.current.srcObject !== rec.stream) videoRef.current.srcObject = rec.stream;
  }, [rec.stream]);
  useEffect(() => {
    const tick = () => void storageFree().then(setFree);
    tick();
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, []);

  const join = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = inviteCodeSchema.safeParse(code);
    if (!parsed.success) return setError('Mã mời gồm 6 ký tự');
    if (!consent) return setError('Cần đồng ý cấp quyền điều khiển quay cho Controller');
    if (!cameraName.trim()) return setError('Đặt tên cho camera này');
    setBusy(true);
    setError(null);
    runtime.setCameraName(cameraName.trim());
    const doJoin = () => api.joinRoom({ invite_code: parsed.data, device_id: session!.deviceId, camera_name: cameraName.trim(), grant_control: true });
    try {
      let res;
      try {
        res = await doJoin();
      } catch (err) {
        if (err instanceof ApiError && err.code === Codes.DEVICE_IN_OTHER_ROOM) {
          const oldRoom = (err.data as { room_id?: string })?.room_id;
          if (!oldRoom || !(await confirm('Đang ở phòng khác', <p>Thiết bị đang ở trong một phòng khác. Rời phòng cũ để vào phòng mới?</p>, false))) return;
          await api.leaveRoom(oldRoom, session!.deviceId);
          res = await doJoin();
        } else throw err;
      }
      runtime.agent.markJoinedRoom(res.room_id, res.room_name, res.member_id);
      setCode('');
    } catch (err) {
      if (err instanceof ApiError && err.code === Codes.INVITE_NOT_FOUND) {
        setCode('');
        setError('Mã mời không đúng hoặc đã hết hạn — xin mã mới từ Controller');
      } else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (!agent.roomId) return;
    if (!(await confirm('Rời phòng', <p>Rời phòng và thu hồi quyền điều khiển đã cấp cho Controller?</p>, false))) return;
    try {
      if (recording) await runtime.agent.stopRecording();
      await api.leaveRoom(agent.roomId, session!.deviceId);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === Codes.PARAM_VALUE_INVALID)) setError(errorText(err));
    }
    runtime.agent.markLeftRoom();
  };

  const toggleRecord = async () => {
    setError(null);
    if (recording) return runtime.agent.stopRecording();
    if (lowStorage) return setError(`Dung lượng trống dưới ${formatBytes(MIN_FREE_STORAGE)}, hãy giải phóng bớt trước khi quay`);
    await runtime.agent.startRecording({ sessionId: null, resolution: '1920x1080', fps: 30, maxDurationSec: 0 });
    if (runtime.agent.getState().recordingState === 'failed') setError(`Không quay được: ${runtime.agent.getState().errorCode}`);
  };

  const flip = async () => {
    setError(null);
    try {
      await runtime.recorder.switchCamera('toggle');
    } catch (err) {
      setError((err as Error).message === 'CAMERA_BUSY_RECORDING' ? 'Không lật được camera khi đang quay' : errorText(err));
    }
  };

  const elapsed = agent.recordingStartedAt ? now - agent.recordingStartedAt : 0;

  return (
    <div className="page camera-page">
      {dialog}
      {agent.inRoom ? (
        <div className="remote-banner">
          ● Đang được điều khiển từ xa · {agent.roomName ?? agent.roomId}
          <button className="btn btn-sm" onClick={leave}>
            Rời phòng
          </button>
        </div>
      ) : null}
      {!mp4 ? <Banner kind="error">Trình duyệt này không ghi được MP4 (H.264/AAC). Hãy dùng Chrome, Edge hoặc Safari bản mới.</Banner> : null}
      {lowStorage ? <Banner kind="danger">Dung lượng trống chỉ còn {formatBytes(free)} (dưới 500 MB).</Banner> : null}
      {rec.error ? <Banner kind="error">{rec.error}</Banner> : null}
      {error ? <Banner kind="error">{error}</Banner> : null}

      <div className="viewfinder">
        <video ref={videoRef} autoPlay muted playsInline className={rec.facing === 'front' ? 'mirror' : ''} />
        {recording ? (
          <div className="rec-overlay">
            <span className="rec-dot" /> {formatDuration(elapsed)}
          </div>
        ) : null}
        <div className="viewfinder-bar">
          <button className="round-btn" onClick={flip} disabled={recording} title="Lật camera trước/sau">
            ⇄
          </button>
          <button
            className={`shutter ${recording ? 'on' : ''}`}
            onClick={toggleRecord}
            disabled={agent.inRoom || !mp4 || (!recording && lowStorage)}
            title={agent.inRoom ? 'Đang được điều khiển từ xa — nút quay bị khóa' : recording ? 'Dừng' : 'Quay'}
          />
          <span className="round-btn ghost">{rec.facing === 'front' ? 'Trước' : 'Sau'}</span>
        </div>
      </div>

      <UploadMiniCard uploads={runtime.uploads} />

      {!agent.inRoom ? (
        <form className="card form" onSubmit={join}>
          <h2>Vào phòng điều khiển</h2>
          <div className="row-2">
            <label className="field">
              <span>Mã mời (6 ký tự)</span>
              <input value={code} maxLength={6} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="8F2A1C" className="code-input" autoCapitalize="characters" />
            </label>
            <label className="field">
              <span>Tên camera</span>
              <input value={cameraName} maxLength={40} onChange={(e) => setCameraName(e.target.value)} placeholder="Cam Trái" />
            </label>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>Tôi đồng ý cho Controller điều khiển bắt đầu / dừng quay trên thiết bị này</span>
          </label>
          <button className="btn btn-primary" disabled={busy}>
            Tham gia
          </button>
        </form>
      ) : (
        <div className="card small muted">
          Lệnh gần nhất: {agent.lastCommand ? `${agent.lastCommand.type} lúc ${new Date(agent.lastCommand.at).toLocaleTimeString('vi-VN')}` : 'chưa có'} · Lệch đồng hồ với server: {agent.clockOffsetMs} ms ·{' '}
          {agent.online ? 'Đã kết nối' : 'Mất kết nối'}
        </div>
      )}
    </div>
  );
}
