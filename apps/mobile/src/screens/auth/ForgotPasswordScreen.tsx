import React, { useState } from 'react';
import { Text } from 'react-native';
import { Codes, VERIFY_RESEND_SECONDS, passwordSchema, splitAccount, verifyCodeSchema } from '@multicam/shared';
import { api, errorMessage, isApiError } from '../../services/api';
import { session } from '../../services/session';
import { useCountdown } from '../../hooks';
import { Banner, Button, Card, Field, Muted, Screen } from '../../ui/components';
import { colors } from '../../ui/theme';
import type { AuthScreenProps } from '../../navigation/types';

export function ForgotPasswordScreen({ navigation }: AuthScreenProps<'Forgot'>) {
  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [account, setAccount] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [hint, setHint] = useState<{ masked: string; code: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [loading, setLoading] = useState(false);
  const { remaining, start } = useCountdown();

  async function requestCode() {
    if (!account.trim()) {
      setErrors({ account: 'Nhập email hoặc số điện thoại' });
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      const res = await api.getVerifyCode({ ...splitAccount(account), purpose: 'forgot_password' });
      setHint({ masked: res.masked_target, code: res.code_verify });
      start(VERIFY_RESEND_SECONDS);
      setStep('reset');
    } catch (e) {
      if (isApiError(e, Codes.LIMITED_ACCESS)) {
        start(Number((e.data as { retry_after?: number } | null)?.retry_after) || VERIFY_RESEND_SECONDS);
        setStep('reset');
        setErrors({ form: 'Đã gửi mã trước đó' });
      } else if (isApiError(e, Codes.USER_NOT_VALIDATED)) {
        setErrors({ account: 'Tài khoản không tồn tại' });
      } else {
        setErrors({ account: errorMessage(e) });
      }
    } finally {
      setLoading(false);
    }
  }

  async function reset() {
    const next: Record<string, string> = {};
    const c = verifyCodeSchema.safeParse(code.trim());
    if (!c.success) next.code = c.error.issues[0]?.message ?? 'Mã gồm 6 số';
    const p = passwordSchema.safeParse(newPassword);
    if (!p.success) next.password = p.error.issues[0]?.message ?? 'Mật khẩu không hợp lệ';
    setErrors(next);
    if (Object.keys(next).length) return;
    setLoading(true);
    try {
      await api.forgotPassword({ ...splitAccount(account), code_verify: code.trim(), new_password: newPassword });
      session.setNotice('Đã đặt lại mật khẩu');
      navigation.popTo('Login');
    } catch (e) {
      if (isApiError(e, Codes.VERIFY_CODE_INCORRECT)) {
        setErrors({ code: 'Sai mã' });
        setCode('');
      } else if (isApiError(e) && e.field === 'new_password') {
        setErrors({ password: errorMessage(e) });
      } else {
        setErrors({ form: errorMessage(e) });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      {step === 'reset' && hint ? (
        <>
          <Muted style={{ fontSize: 14 }}>Đã gửi mã tới {hint.masked}</Muted>
          <Banner kind="info">
            <Text style={{ color: colors.text }}>
              Mã thử nghiệm: <Text style={{ fontWeight: '600', letterSpacing: 2, color: colors.accent }}>{hint.code}</Text>
            </Text>
          </Banner>
        </>
      ) : null}
      <Card>
        <Field
          label="Email hoặc số điện thoại"
          value={account}
          onChangeText={setAccount}
          autoCapitalize="none"
          keyboardType="email-address"
          editable={step === 'request'}
          error={errors.account}
        />
        {step === 'request' ? (
          <Button title="Gửi mã" onPress={requestCode} loading={loading} style={{ marginTop: 4 }} />
        ) : (
          <>
            <Field
              label="Mã 6 số"
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, ''))}
              keyboardType="number-pad"
              maxLength={6}
              error={errors.code}
            />
            <Field
              label="Mật khẩu mới"
              value={newPassword}
              onChangeText={setNewPassword}
              secureTextEntry
              autoCapitalize="none"
              maxLength={20}
              placeholder="6–20 ký tự"
              error={errors.password}
            />
            {errors.form ? <Text style={{ color: colors.danger }}>{errors.form}</Text> : null}
            <Button title="Đặt lại" onPress={reset} loading={loading} style={{ marginTop: 4 }} />
            <Button
              title={remaining > 0 ? `Gửi lại sau ${remaining}s` : 'Gửi lại'}
              variant="ghost"
              disabled={remaining > 0 || loading}
              onPress={requestCode}
            />
          </>
        )}
      </Card>
    </Screen>
  );
}
