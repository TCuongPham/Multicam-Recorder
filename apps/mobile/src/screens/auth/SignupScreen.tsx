import React, { useState } from 'react';
import { Text } from 'react-native';
import { Codes, fieldErrors, signupSchema } from '@multicam/shared';
import { api, errorMessage, isApiError } from '../../services/api';
import { Button, Card, Field, Row, Screen } from '../../ui/components';
import { colors } from '../../ui/theme';
import type { AuthScreenProps } from '../../navigation/types';

type Form = { last_name: string; first_name: string; email: string; phone: string; password: string };

export function SignupScreen({ navigation }: AuthScreenProps<'Signup'>) {
  const [form, setForm] = useState<Form>({ last_name: '', first_name: '', email: '', phone: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const set = (k: keyof Form) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: '' }));
  };

  async function onSubmit() {
    setFormError(null);
    const parsed = signupSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      const res = await api.signup(parsed.data);
      navigation.replace('Verify', { email: res.email, autoSend: true });
    } catch (e) {
      if (isApiError(e) && e.field) {
        const msg = e.code === Codes.USER_EXISTED ? 'Đã được đăng ký' : errorMessage(e);
        setErrors({ [e.field]: msg });
      } else {
        setFormError(errorMessage(e));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      <Card>
        <Row style={{ alignItems: 'flex-start' }}>
          <Field style={{ flex: 1 }} label="Họ" value={form.last_name} onChangeText={set('last_name')} error={errors.last_name} />
          <Field style={{ flex: 1 }} label="Tên" value={form.first_name} onChangeText={set('first_name')} error={errors.first_name} />
        </Row>
        <Field
          label="Email"
          value={form.email}
          onChangeText={set('email')}
          autoCapitalize="none"
          keyboardType="email-address"
          error={errors.email}
        />
        <Field
          label="Số điện thoại"
          value={form.phone}
          onChangeText={set('phone')}
          keyboardType="phone-pad"
          placeholder="0912345678"
          maxLength={10}
          error={errors.phone}
        />
        <Field
          label="Mật khẩu"
          value={form.password}
          onChangeText={set('password')}
          secureTextEntry
          autoCapitalize="none"
          error={errors.password}
          placeholder="6–20 ký tự"
        />
        {formError ? <Text style={{ color: colors.danger }}>{formError}</Text> : null}
        <Button title="Tạo tài khoản" onPress={onSubmit} loading={loading} style={{ marginTop: 4 }} />
      </Card>
      <Button title="Đã có tài khoản? Đăng nhập" variant="ghost" small onPress={() => navigation.popTo('Login')} style={{ alignSelf: 'center' }} />
    </Screen>
  );
}
