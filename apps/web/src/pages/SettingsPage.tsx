import { useState, type FormEvent } from 'react';
import { ApiError, changePasswordSchema, fieldErrors } from '@multicam/shared';
import { Banner, Field, Modal, errorText } from '../components/ui';
import { api } from '../lib/platform';
import { useSession } from '../lib/session';

export function SettingsPage() {
  const { session, signOut, runtime } = useSession();
  const [pw, setPw] = useState({ old_password: '', new_password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [deletePw, setDeletePw] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (!session) return null;
  const isController = session.role === 'controller';

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = changePasswordSchema.safeParse(pw);
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    setBusy(true);
    try {
      await api.changePassword(parsed.data);
      // Không lưu mật khẩu mới vào thiết bị; các máy khác bị đăng xuất ở lần gọi API kế tiếp.
      setPw({ old_password: '', new_password: '' });
      setMsg({ kind: 'success', text: 'Đã đổi mật khẩu. Các thiết bị khác sẽ bị đăng xuất.' });
    } catch (err) {
      if (err instanceof ApiError && err.field === 'old_password') setErrors({ old_password: 'Mật khẩu cũ không đúng' });
      else setMsg({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    setBusy(true);
    setDeleteError(null);
    try {
      const roomId = runtime?.agent.getState().roomId;
      if (roomId) await api.leaveRoom(roomId, session.deviceId).catch(() => undefined);
      await api.deleteAccount(deletePw);
      await signOut({ callApi: false, message: 'Tài khoản và toàn bộ video đã upload đã bị xóa vĩnh viễn.' });
    } catch (err) {
      setDeleteError(err instanceof ApiError && err.field === 'password' ? 'Sai mật khẩu' : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <h1>Cài đặt</h1>
      <section className="card">
        <h2>Tài khoản</h2>
        <p>
          <b>
            {session.user.last_name} {session.user.first_name}
          </b>{' '}
          · <span className={`role role-${session.role}`}>{isController ? 'Controller' : 'Remote'}</span>
        </p>
        <p className="muted small">
          {session.user.email ?? ''} {session.user.phone ? `· ${session.user.phone}` : ''} · Thiết bị {session.deviceId}
        </p>
      </section>

      <section className="card">
        <h2>Đổi mật khẩu</h2>
        {msg ? <Banner kind={msg.kind}>{msg.text}</Banner> : null}
        <form className="form" onSubmit={changePassword}>
          <Field label="Mật khẩu hiện tại" name="old_password" type="password" value={pw.old_password} onChange={(v) => setPw({ ...pw, old_password: v })} error={errors.old_password} autoComplete="current-password" />
          <Field label="Mật khẩu mới (6–20 ký tự)" name="new_password" type="password" value={pw.new_password} onChange={(v) => setPw({ ...pw, new_password: v })} error={errors.new_password} autoComplete="new-password" maxLength={20} />
          <button className="btn btn-primary" disabled={busy}>
            Xác nhận đổi mật khẩu
          </button>
        </form>
      </section>

      <section className="card">
        <button className="btn btn-block" onClick={() => void signOut()}>
          Đăng xuất
        </button>
      </section>

      {/* Ẩn mục xóa tài khoản khi account_role = controller. */}
      {!isController ? (
        <section className="card danger-zone">
          <h2>Xóa tài khoản</h2>
          <p className="muted">Xóa vĩnh viễn tài khoản cùng toàn bộ video đã upload lên server. Không thể hoàn tác.</p>
          <button className="btn btn-danger" onClick={() => setDeleteStep(1)}>
            Xóa tài khoản
          </button>
        </section>
      ) : null}

      {deleteStep === 1 ? (
        <Modal
          title="Xóa tài khoản (bước 1/2)"
          onClose={() => setDeleteStep(0)}
          footer={
            <>
              <button className="btn" onClick={() => setDeleteStep(0)}>
                Hủy
              </button>
              <button className="btn btn-danger" disabled={!deletePw} onClick={() => setDeleteStep(2)}>
                Tiếp tục
              </button>
            </>
          }
        >
          <p>Nhập lại mật khẩu để xác nhận.</p>
          <Field label="Mật khẩu" name="delete_password" type="password" value={deletePw} onChange={setDeletePw} autoComplete="current-password" />
        </Modal>
      ) : null}
      {deleteStep === 2 ? (
        <Modal
          title="Xóa tài khoản (bước 2/2)"
          onClose={() => setDeleteStep(0)}
          footer={
            <>
              <button className="btn" onClick={() => setDeleteStep(0)}>
                Hủy
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={deleteAccount}>
                Xóa vĩnh viễn
              </button>
            </>
          }
        >
          {deleteError ? <Banner kind="error">{deleteError}</Banner> : null}
          <p>
            Bạn chắc chắn muốn xóa vĩnh viễn tài khoản <b>{session.user.email ?? session.user.phone}</b> và toàn bộ video đã upload?
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
