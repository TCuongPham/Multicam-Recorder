import React, { useState } from 'react';
import { Alert } from 'react-native';
import { Codes } from '@multicam/shared';
import { errorMessage, isApiError } from '../../services/api';
import { deleteAccount } from '../../services/runtime';
import { Button, Card, Field, Muted, Screen, SectionTitle } from '../../ui/components';

function confirmAsync(title: string, message: string, ok: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Hủy', style: 'cancel', onPress: () => resolve(false) },
      { text: ok, style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

/**
 * Xóa tài khoản vĩnh viễn cùng toàn bộ video đã tải lên — xác nhận hai lớp:
 * bước 1 nhập lại mật khẩu, bước 2 hộp thoại "Xóa vĩnh viễn?". Đang ở trong phòng thì rời phòng trước.
 */
export function DeleteAccountScreen() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onDelete() {
    if (!password) {
      setError('Nhập mật khẩu');
      return;
    }
    setError(null);
    if (!(await confirmAsync('Xóa vĩnh viễn?', 'Không thể hoàn tác.', 'Xóa'))) return;
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
      <Card>
        <SectionTitle>Nhập mật khẩu</SectionTitle>
        <Muted>Xóa vĩnh viễn tài khoản và video.</Muted>
        <Field label="Mật khẩu" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" error={error} />
        <Button title="Xóa" variant="danger" onPress={onDelete} loading={loading} style={{ marginTop: 4 }} />
      </Card>
    </Screen>
  );
}
