import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  ApiError,
  Codes,
  VERIFY_RESEND_SECONDS,
  fieldErrors,
  forgotPasswordSchema,
  signupSchema,
  splitAccount,
} from '@multicam/shared';
import { Banner, Field, errorText, useCountdown } from '../components/ui';
import { api, deviceInfo } from '../lib/platform';
import { useSession } from '../lib/session';

function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-dot" />
          Multi-Cam Recorder
        </div>
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
        {children}
      </div>
    </div>
  );
}

// ---------- Đăng nhập ----------
export function LoginPage() {
  const { signIn, notice } = useSession();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { message?: string } };
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!account.trim()) errs.account = 'Nhập email, số điện thoại hoặc tên đăng nhập';
    if (!password) errs.password = 'Nhập mật khẩu';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.login({ ...splitAccount(account), password, ...deviceInfo() });
      signIn(res);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === Codes.USER_NOT_VALIDATED && (err.data as { verify_required?: string })?.verify_required === '1') {
        navigate('/verify', { state: { ...splitAccount(account), autoSend: true } });
        return;
      }
      if (err instanceof ApiError && err.field === 'password') setErrors({ password: 'Sai mật khẩu' });
      else if (err instanceof ApiError && err.code === Codes.USER_NOT_VALIDATED) setErrors({ account: 'Tài khoản không tồn tại' });
      else if (err instanceof ApiError && err.code === Codes.NOT_ACCESS) setError('Tài khoản đã bị khóa');
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Đăng nhập" subtitle="Tài khoản Controller dùng để điều khiển; mọi tài khoản đăng ký là máy Remote.">
      {location.state?.message ? <Banner kind="success">{location.state.message}</Banner> : null}
      {notice ? <Banner kind="info">{notice}</Banner> : null}
      {error ? <Banner kind="error">{error}</Banner> : null}
      <form onSubmit={submit} className="form">
        <Field label="Email / Số điện thoại" name="account" value={account} onChange={setAccount} error={errors.account} autoComplete="username" />
        <Field label="Mật khẩu" name="password" type="password" value={password} onChange={setPassword} error={errors.password} autoComplete="current-password" />
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>
      </form>
      <div className="auth-links">
        <Link to="/forgot">Quên mật khẩu?</Link>
        <Link to="/signup">Tạo tài khoản</Link>
      </div>
    </AuthShell>
  );
}

// ---------- Đăng ký (luôn là Remote) ----------
export function SignupPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = signupSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setError(null);
    setBusy(true);
    try {
      await api.signup(parsed.data);
      navigate('/verify', { state: { email: parsed.data.email, autoSend: true } });
    } catch (err) {
      if (err instanceof ApiError && err.field) {
        setErrors({ [err.field]: err.code === Codes.USER_EXISTED ? `${err.field === 'email' ? 'Email' : 'Số điện thoại'} đã được đăng ký` : 'Giá trị không hợp lệ' });
      } else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Tạo tài khoản" subtitle="Tài khoản tạo ở đây là tài khoản Remote (máy quay).">
      {error ? <Banner kind="error">{error}</Banner> : null}
      <form onSubmit={submit} className="form">
        <div className="row-2">
          <Field label="Họ" name="last_name" value={form.last_name} onChange={set('last_name')} error={errors.last_name} autoComplete="family-name" />
          <Field label="Tên" name="first_name" value={form.first_name} onChange={set('first_name')} error={errors.first_name} autoComplete="given-name" />
        </div>
        <Field label="Email" name="email" type="email" value={form.email} onChange={set('email')} error={errors.email} autoComplete="email" />
        <Field label="Số điện thoại" name="phone" inputMode="tel" value={form.phone} onChange={set('phone')} error={errors.phone} placeholder="0912345678" autoComplete="tel" maxLength={10} />
        <Field label="Mật khẩu (6–20 ký tự, không ký tự đặc biệt)" name="password" type="password" value={form.password} onChange={set('password')} error={errors.password} autoComplete="new-password" maxLength={20} />
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Đang tạo…' : 'Tạo tài khoản'}
        </button>
      </form>
      <div className="auth-links">
        <Link to="/login">Đã có tài khoản? Đăng nhập</Link>
      </div>
    </AuthShell>
  );
}

// ---------- Nhập mã xác thực sau khi đăng ký ----------
export function VerifyPage() {
  const { signIn } = useSession();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { email?: string; phone?: string; autoSend?: boolean } };
  const target = { email: location.state?.email, phone: location.state?.phone };
  const [code, setCode] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [left, startCountdown] = useCountdown();
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setError(null);
    try {
      const res = await api.getVerifyCode({ ...target, purpose: 'signup' });
      startCountdown(VERIFY_RESEND_SECONDS);
      setHint(`Mã đã gửi tới ${res.masked_target} (môi trường thử nghiệm: ${res.code_verify})`);
    } catch (err) {
      if (err instanceof ApiError && err.code === Codes.LIMITED_ACCESS) {
        startCountdown(Number((err.data as { retry_after?: number })?.retry_after) || VERIFY_RESEND_SECONDS);
      } else setError(errorText(err));
    }
  };

  const autoSent = useRef(false);
  useEffect(() => {
    if (!target.email && !target.phone) navigate('/signup', { replace: true });
    else if (location.state?.autoSend && !autoSent.current) {
      autoSent.current = true; // StrictMode chạy effect 2 lần — chỉ gửi mã một lần
      void send();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError('Mã xác thực gồm 6 số');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.checkVerifyCode({ ...target, code_verify: code, ...deviceInfo() });
      signIn(res); // vào thẳng Trang chính bản Remote, không bắt đăng nhập lại
      navigate('/', { replace: true });
    } catch (err) {
      setCode('');
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Nhập mã xác thực" subtitle={`Mã 6 số đã gửi về ${target.email ?? target.phone ?? ''}`}>
      {hint ? <Banner kind="info">{hint}</Banner> : null}
      {error ? <Banner kind="error">{error}</Banner> : null}
      <form onSubmit={submit} className="form">
        <Field label="Mã xác thực" name="code" inputMode="numeric" value={code} onChange={(v) => setCode(v.replace(/\D/g, ''))} maxLength={6} autoComplete="one-time-code" />
        <button className="btn btn-primary btn-block" disabled={busy}>
          Xác nhận
        </button>
        <button type="button" className="btn btn-block" disabled={left > 0} onClick={send}>
          {left > 0 ? `Gửi lại mã (${left}s)` : 'Gửi lại mã'}
        </button>
      </form>
    </AuthShell>
  );
}

// ---------- Quên mật khẩu ----------
export function ForgotPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [account, setAccount] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [left, startCountdown] = useCountdown();
  const [busy, setBusy] = useState(false);

  const requestCode = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!account.trim()) {
      setErrors({ account: 'Nhập email hoặc số điện thoại' });
      return;
    }
    setErrors({});
    setError(null);
    setBusy(true);
    try {
      const res = await api.getVerifyCode({ ...splitAccount(account), purpose: 'forgot_password' });
      startCountdown(VERIFY_RESEND_SECONDS);
      setHint(`Mã đã gửi tới ${res.masked_target} (môi trường thử nghiệm: ${res.code_verify})`);
      setStep(2);
    } catch (err) {
      if (err instanceof ApiError && err.code === Codes.LIMITED_ACCESS) {
        startCountdown(Number((err.data as { retry_after?: number })?.retry_after) || VERIFY_RESEND_SECONDS);
        setStep(2);
      } else if (err instanceof ApiError && err.code === Codes.USER_NOT_VALIDATED) setErrors({ account: 'Tài khoản không tồn tại' });
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: FormEvent) => {
    e.preventDefault();
    const input = { ...splitAccount(account), code_verify: code, new_password: password };
    const parsed = forgotPasswordSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.forgotPassword(parsed.data);
      navigate('/login', { replace: true, state: { message: 'Đặt lại mật khẩu thành công, hãy đăng nhập lại' } });
    } catch (err) {
      setError(err instanceof ApiError && err.code === Codes.VERIFY_CODE_INCORRECT ? 'Mã xác thực không đúng hoặc đã hết hạn' : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Quên mật khẩu" subtitle="Đặt lại mật khẩu qua mã xác thực gửi về email hoặc SMS.">
      {hint ? <Banner kind="info">{hint}</Banner> : null}
      {error ? <Banner kind="error">{error}</Banner> : null}
      {step === 1 ? (
        <form onSubmit={requestCode} className="form">
          <Field label="Email / Số điện thoại" name="account" value={account} onChange={setAccount} error={errors.account} />
          <button className="btn btn-primary btn-block" disabled={busy}>
            Gửi mã xác thực
          </button>
        </form>
      ) : (
        <form onSubmit={reset} className="form">
          <Field label="Mã xác thực" name="code" inputMode="numeric" value={code} onChange={(v) => setCode(v.replace(/\D/g, ''))} error={errors.code_verify} maxLength={6} />
          <Field label="Mật khẩu mới" name="password" type="password" value={password} onChange={setPassword} error={errors.new_password} autoComplete="new-password" maxLength={20} />
          <button className="btn btn-primary btn-block" disabled={busy}>
            Đặt lại mật khẩu
          </button>
          <button type="button" className="btn btn-block" disabled={left > 0 || busy} onClick={() => void requestCode()}>
            {left > 0 ? `Gửi lại mã (${left}s)` : 'Gửi lại mã'}
          </button>
        </form>
      )}
      <div className="auth-links">
        <Link to="/login">Quay lại đăng nhập</Link>
      </div>
    </AuthShell>
  );
}
