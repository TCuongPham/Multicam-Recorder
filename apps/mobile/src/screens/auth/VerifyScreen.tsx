import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { Codes, VERIFY_RESEND_SECONDS, verifyCodeSchema } from '@multicam/shared';
import { api, errorMessage, isApiError } from '../../services/api';
import { session } from '../../services/session';
import { deviceFields, useCountdown } from '../../hooks';
import { Banner, Button, Card, Field, Muted, Screen } from '../../ui/components';
import { colors } from '../../ui/theme';
import type { AuthScreenProps } from '../../navigation/types';

export function VerifyScreen({ route }: AuthScreenProps<'Verify'>) {
  const { email, phone, autoSend } = route.params;
  const target = email ? { email } : { phone };
  const [code, setCode] = useState('');
  const [hint, setHint] = useState<{ masked: string; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const { remaining, start } = useCountdown();
  const sentOnce = useRef(false);

  const send = useCallback(async () => {
    setSending(true);
    setSendError(null);
    try {
      const res = await api.getVerifyCode({ ...target, purpose: 'signup' });
      setHint({ masked: res.masked_target, code: res.code_verify });
      start(VERIFY_RESEND_SECONDS);
    } catch (e) {
      if (isApiError(e, Codes.LIMITED_ACCESS)) {
        const retry = Number((e.data as { retry_after?: number } | null)?.retry_after) || VERIFY_RESEND_SECONDS;
        start(retry);
        setSendError('Đã gửi mã trước đó');
      } else {
        setSendError(errorMessage(e));
      }
    } finally {
      setSending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, phone, start]);

  useEffect(() => {
    // Tự động gọi get_verify_code sau khi đăng ký.
    if (autoSend && !sentOnce.current) {
      sentOnce.current = true;
      void send();
    }
  }, [autoSend, send]);

  async function onConfirm() {
    const parsed = verifyCodeSchema.safeParse(code.trim());
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Mã gồm 6 số');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await api.checkVerifyCode({ ...target, code_verify: parsed.data, ...deviceFields() });
      // Đúng mã: nhận token và vào thẳng Trang chính (bản Remote).
      await session.signIn({
        role: res.account_role,
        user: res.user ?? null,
        deviceId: res.device?.device_id ?? null,
        cameraName: res.device?.camera_name ?? null,
      });
    } catch (e) {
      if (isApiError(e, Codes.VERIFY_CODE_INCORRECT)) {
        setError('Sai mã');
        setCode('');
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      <Muted style={{ fontSize: 14 }}>Đã gửi mã tới {hint?.masked ?? email ?? phone}</Muted>
      {hint ? (
        <Banner kind="info">
          <Text style={{ color: colors.text }}>
            Mã thử nghiệm: <Text style={{ fontWeight: '600', letterSpacing: 2, color: colors.accent }}>{hint.code}</Text>
          </Text>
        </Banner>
      ) : null}
      {sendError ? <Banner kind="warning">{sendError}</Banner> : null}
      <Card>
        <Field
          label="Mã 6 số"
          value={code}
          onChangeText={(v) => setCode(v.replace(/\D/g, ''))}
          keyboardType="number-pad"
          maxLength={6}
          placeholder="______"
          error={error}
        />
        <Button title="Xác nhận" onPress={onConfirm} loading={loading} style={{ marginTop: 4 }} />
        <Button
          title={remaining > 0 ? `Gửi lại sau ${remaining}s` : 'Gửi lại'}
          variant="ghost"
          onPress={() => void send()}
          disabled={remaining > 0}
          loading={sending}
        />
      </Card>
    </Screen>
  );
}
