import React, { useState } from 'react';
import { Alert, Text } from 'react-native';
import { Codes } from '@multicam/shared';
import { errorMessage, isApiError } from '../../services/api';
import { deleteAccount } from '../../services/runtime';
import { Banner, Button, Card, Field, Screen } from '../../ui/components';
import { colors } from '../../ui/theme';

function confirmAsync(title: string, message: string, ok: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Hủy', style: 'cancel', onPress: () => resolve(false) },
      { text: ok, style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

/** Xóa tài khoản vĩnh viễn cùng toàn bộ video đã upload — xác nhận hai lớp. */
export function DeleteAccountScreen() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onDelete() {
    if (!password) {
      setError('Nhập lại mật khẩu để xác nhận');
      return;
    }
    setError(null);
    const first = await confirmAsync(
      'Xóa tài khoản?',
      'Tài khoản và TOÀN BỘ video bạn đã upload lên server sẽ bị xóa vĩnh viễn.',
      'Tiếp tục',
    );
    if (!first) return;
    const second = await confirmAsync('Xác nhận lần cuối', 'Thao tác này KHÔNG THỂ hoàn tác. Bạn chắc chắn muốn xóa?', 'Xóa vĩnh viễn');
    if (!second) return;
    setLoading(true);
    try {
      await deleteAccount(password);
    } catch (e) {
      if (isApiError(e, Codes.NOT_ACCESS)) setError('Tài khoản Controller không thể xóa');
      else if (isApiError(e) && e.field === 'password') setError('Sai mật khẩu');
      else setError(errorMessage(e));
      setLoading(false);
    }
  }

  return (
    <Screen>
      <Banner kind="danger">
        <Text style={{ color: colors.danger }}>
          Xóa vĩnh viễn tài khoản cùng toàn bộ video đã upload lên server. Clip đang nằm trong máy không bị ảnh hưởng.
          Nếu máy đang ở trong phòng, ứng dụng sẽ rời phòng trước.
        </Text>
      </Banner>
      <Card>
        <Field label="Mật khẩu" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" error={error} />
        <Button title="Xóa tài khoản" variant="danger" onPress={onDelete} loading={loading} />
      </Card>
    </Screen>
  );
}
