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
  const [confirm, setConfirm] = useState('');
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
        setErrors({ form: 'Mã đã được gửi trước đó, vui lòng dùng mã cũ hoặc chờ để gửi lại.' });
      } else if (isApiError(e, Codes.USER_NOT_VALIDATED)) {
        setErrors({ account: 'Tài khoản không tồn tại hoặc chưa kích hoạt' });
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
    if (!c.success) next.code = c.error.issues[0]?.message ?? 'Mã xác thực gồm 6 số';
    const p = passwordSchema.safeParse(newPassword);
    if (!p.success) next.password = p.error.issues[0]?.message ?? 'Mật khẩu không hợp lệ';
    if (newPassword !== confirm) next.confirm = 'Mật khẩu nhập lại không khớp';
    setErrors(next);
    if (Object.keys(next).length) return;
    setLoading(true);
    try {
      await api.forgotPassword({ ...splitAccount(account), code_verify: code.trim(), new_password: newPassword });
      session.setNotice('Đặt lại mật khẩu thành công. Vui lòng đăng nhập bằng mật khẩu mới.');
      navigation.popTo('Login');
    } catch (e) {
      if (isApiError(e, Codes.VERIFY_CODE_INCORRECT)) {
        setErrors({ code: 'Mã xác thực không đúng hoặc đã hết hạn' });
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
      <Card>
        <Field
          label="Email / Số điện thoại"
          value={account}
          onChangeText={setAccount}
          autoCapitalize="none"
          keyboardType="email-address"
          editable={step === 'request'}
          error={errors.account}
        />
        {step === 'request' ? (
          <>
            <Muted>Mã xác thực 6 số sẽ được gửi về email hoặc SMS của bạn.</Muted>
            <Button title="Gửi mã xác thực" onPress={requestCode} loading={loading} />
          </>
        ) : (
          <>
            {hint ? (
              <Banner kind="info">
                <Text style={{ color: colors.primary }}>
                  Đã gửi tới {hint.masked}. Mô phỏng — mã: <Text style={{ fontWeight: '800', letterSpacing: 2 }}>{hint.code}</Text>
                </Text>
              </Banner>
            ) : null}
            <Field
              label="Mã xác thực"
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
              error={errors.password}
              hint="6–20 ký tự chữ hoặc số"
            />
            <Field label="Nhập lại mật khẩu mới" value={confirm} onChangeText={setConfirm} secureTextEntry autoCapitalize="none" error={errors.confirm} />
            {errors.form ? <Text style={{ color: colors.danger }}>{errors.form}</Text> : null}
            <Button title="Đặt lại mật khẩu" onPress={reset} loading={loading} />
            <Button
              title={remaining > 0 ? `Gửi lại mã (${remaining}s)` : 'Gửi lại mã'}
              variant="secondary"
              disabled={remaining > 0 || loading}
              onPress={requestCode}
            />
          </>
        )}
      </Card>
    </Screen>
  );
}
