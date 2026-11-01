import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '@multicam/shared';

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.userMessage;
  return (e as Error)?.message ?? String(e);
}

export function Field(props: {
  label: string;
  name: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric' | 'tel' | 'email';
  maxLength?: number;
}) {
  return (
    <label className={`field ${props.error ? 'has-error' : ''}`}>
      <span>{props.label}</span>
      <input
        name={props.name}
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete}
        inputMode={props.inputMode}
        maxLength={props.maxLength}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.error ? <small className="error-text">{props.error}</small> : null}
    </label>
  );
}

export function Banner({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success' | 'danger'; children: ReactNode }) {
  return <div className={`banner banner-${kind}`}>{children}</div>;
}

export function ProgressBar({ percent, label }: { percent: number; label?: string }) {
  return (
    <div className="progress" title={label}>
      <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Đóng">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** Hộp thoại xác nhận dùng chung (xóa clip, loại máy, đóng phòng...). */
export function useConfirm() {
  const [state, setState] = useState<{ title: string; message: ReactNode; danger?: boolean; resolve: (v: boolean) => void } | null>(null);
  const confirm = (title: string, message: ReactNode, danger = true) =>
    new Promise<boolean>((resolve) => setState({ title, message, danger, resolve }));
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const dialog = state ? (
    <Modal
      title={state.title}
      onClose={() => close(false)}
      footer={
        <>
          <button className="btn" onClick={() => close(false)}>
            Hủy
          </button>
          <button className={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => close(true)}>
            Đồng ý
          </button>
        </>
      }
    >
      {state.message}
    </Modal>
  ) : null;
  return { confirm, dialog };
}

/** Đếm ngược theo giây (nút "Gửi lại mã"). */
export function useCountdown(): [number, (seconds: number) => void] {
  const [left, setLeft] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);
  const start = (seconds: number) => {
    if (timer.current) clearInterval(timer.current);
    const until = Date.now() + seconds * 1000;
    setLeft(seconds);
    timer.current = setInterval(() => {
      const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setLeft(s);
      if (s === 0 && timer.current) clearInterval(timer.current);
    }, 250);
  };
  return [left, start];
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
