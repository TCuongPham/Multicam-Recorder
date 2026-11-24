import React, { useState } from 'react';
import { Alert, Text } from 'react-native';
import { changePasswordSchema, fieldErrors } from '@multicam/shared';
import { api, errorMessage, isApiError } from '../../services/api';
import { Button, Card, Field, Screen } from '../../ui/components';
import { colors } from '../../ui/theme';
import type { AppScreenProps } from '../../navigation/types';

export function ChangePasswordScreen({ navigation }: AppScreenProps<'ChangePassword'>) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    const parsed = changePasswordSchema.safeParse({ old_password: oldPassword, new_password: newPassword });
    const next = parsed.success ? {} : fieldErrors(parsed.error);
    if (!oldPassword) next.old_password = 'Nhập mật khẩu hiện tại';
    setErrors(next);
    if (Object.keys(next).length || !parsed.success) return;
    setLoading(true);
    try {
      await api.changePassword(parsed.data);
      // KHÔNG lưu mật khẩu mới vào thiết bị. Thiết bị này giữ phiên, các máy khác bị đăng xuất.
      setOldPassword('');
      setNewPassword('');
      Alert.alert('Đã đổi mật khẩu', undefined, [{ text: 'Đồng ý', onPress: () => navigation.goBack() }]);
    } catch (e) {
      if (isApiError(e) && e.field === 'old_password') setErrors({ old_password: 'Sai mật khẩu' });
      else if (isApiError(e) && e.field === 'new_password') setErrors({ new_password: errorMessage(e) });
      else setErrors({ form: errorMessage(e) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      <Card>
        <Field
          label="Mật khẩu hiện tại"
          value={oldPassword}
          onChangeText={setOldPassword}
          secureTextEntry
          autoCapitalize="none"
          error={errors.old_password}
        />
        <Field
          label="Mật khẩu mới"
          value={newPassword}
          onChangeText={setNewPassword}
          secureTextEntry
          autoCapitalize="none"
          maxLength={20}
          placeholder="6–20 ký tự"
          error={errors.new_password}
        />
        {errors.form ? <Text style={{ color: colors.danger }}>{errors.form}</Text> : null}
        <Button title="Lưu" onPress={onSubmit} loading={loading} style={{ marginTop: 4 }} />
      </Card>
    </Screen>
  );
}
