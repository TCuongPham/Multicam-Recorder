import React, { useState } from 'react';
import { Alert, Text } from 'react-native';
import { changePasswordSchema, fieldErrors } from '@multicam/shared';
import { api, errorMessage, isApiError } from '../../services/api';
import { Button, Card, Field, Muted, Screen } from '../../ui/components';
import { colors } from '../../ui/theme';
import type { AppScreenProps } from '../../navigation/types';

export function ChangePasswordScreen({ navigation }: AppScreenProps<'ChangePassword'>) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    const parsed = changePasswordSchema.safeParse({ old_password: oldPassword, new_password: newPassword });
    const next = parsed.success ? {} : fieldErrors(parsed.error);
    if (!oldPassword) next.old_password = 'Nhập mật khẩu cũ';
    if (newPassword !== confirm) next.confirm = 'Mật khẩu nhập lại không khớp';
    setErrors(next);
    if (Object.keys(next).length || !parsed.success) return;
    setLoading(true);
    try {
      await api.changePassword(parsed.data);
      // KHÔNG lưu mật khẩu mới vào thiết bị. Thiết bị này giữ phiên, các máy khác bị đăng xuất.
      setOldPassword('');
      setNewPassword('');
      setConfirm('');
      Alert.alert('Đổi mật khẩu thành công', 'Các thiết bị khác sẽ bị đăng xuất ở lần gọi API kế tiếp.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      if (isApiError(e) && e.field === 'old_password') setErrors({ old_password: 'Mật khẩu cũ không đúng' });
      else if (isApiError(e) && e.field === 'new_password') setErrors({ new_password: errorMessage(e) });
      else setErrors({ form: errorMessage(e) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      <Card>
        <Field label="Mật khẩu cũ" value={oldPassword} onChangeText={setOldPassword} secureTextEntry autoCapitalize="none" error={errors.old_password} />
        <Field
          label="Mật khẩu mới"
          value={newPassword}
          onChangeText={setNewPassword}
          secureTextEntry
          autoCapitalize="none"
          error={errors.new_password}
          hint="6–20 ký tự chữ hoặc số, khác mật khẩu cũ"
        />
        <Field label="Nhập lại mật khẩu mới" value={confirm} onChangeText={setConfirm} secureTextEntry autoCapitalize="none" error={errors.confirm} />
        {errors.form ? <Text style={{ color: colors.danger }}>{errors.form}</Text> : null}
        <Button title="Xác nhận đổi mật khẩu" onPress={onSubmit} loading={loading} />
        <Muted>Sau khi đổi, các thiết bị khác đang đăng nhập tài khoản này sẽ bị đăng xuất.</Muted>
      </Card>
    </Screen>
  );
}
