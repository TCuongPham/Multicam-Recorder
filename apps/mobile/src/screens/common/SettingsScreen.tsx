import React, { useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useStore } from '@multicam/shared/react';
import { session } from '../../services/session';
import { signOut } from '../../services/runtime';
import { getDeviceUuid, getServerUrl, setCameraName } from '../../services/storage';
import { remoteAgent } from '../../services/remote';
import { resolveCameraName } from '../../services/recorder';
import { Button, Card, Field, Muted, Screen } from '../../ui/components';
import { colors } from '../../ui/theme';
import type { AppStackParams } from '../../navigation/types';

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Muted>{label}</Muted>
      <Text style={{ color: colors.text, flexShrink: 1, textAlign: 'right' }} selectable>
        {value || '—'}
      </Text>
    </View>
  );
}

export function SettingsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParams>>();
  const { info } = useStore(session);
  const agent = useStore(remoteAgent);
  const isRemote = info?.role === 'remote';
  const [cameraName, setName] = useState('');
  const [saved, setSaved] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    if (isRemote) void resolveCameraName().then(setName);
  }, [isRemote]);

  function confirmLogout() {
    const msg = isRemote && agent.inRoom ? 'Máy đang ở trong phòng. Ứng dụng sẽ rời phòng trước khi đăng xuất.' : 'Bạn có chắc muốn đăng xuất?';
    Alert.alert('Đăng xuất', msg, [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Đăng xuất',
        style: 'destructive',
        onPress: async () => {
          setLoggingOut(true);
          await signOut();
        },
      },
    ]);
  }

  const user = info?.user;
  return (
    <Screen>
      <Card>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>
          {user ? `${user.last_name} ${user.first_name}`.trim() : 'Tài khoản'}
        </Text>
        <InfoRow label="Vai trò" value={info?.role === 'controller' ? 'Controller (điều khiển)' : 'Remote (máy quay)'} />
        <InfoRow label="Email" value={user?.email} />
        <InfoRow label="Số điện thoại" value={user?.phone} />
        <InfoRow label="Server" value={getServerUrl()} />
        <InfoRow label="Mã thiết bị (server)" value={info?.deviceId} />
        <InfoRow label="UUID cài đặt" value={getDeviceUuid()} />
      </Card>

      {isRemote ? (
        <Card>
          <Field
            label="Tên máy quay"
            value={cameraName}
            onChangeText={(v) => {
              setName(v);
              setSaved(false);
            }}
            maxLength={40}
            hint={saved ? 'Đã lưu. Tên mới dùng cho lần vào phòng / clip tiếp theo.' : 'Hiện trên màn Điều khiển và trong tên file clip'}
          />
          <Button
            title="Lưu tên máy"
            variant="secondary"
            disabled={!cameraName.trim()}
            onPress={async () => {
              await setCameraName(cameraName);
              await session.updateInfo({ cameraName: cameraName.trim() });
              setSaved(true);
            }}
          />
        </Card>
      ) : null}

      <Card>
        <Button title="Đổi mật khẩu" variant="secondary" onPress={() => navigation.navigate('ChangePassword')} />
        <Button title="Đăng xuất" variant="secondary" onPress={confirmLogout} loading={loggingOut} />
        {/* Ẩn mục xóa tài khoản khi account_role = controller. */}
        {isRemote ? <Button title="Xóa tài khoản" variant="danger" onPress={() => navigation.navigate('DeleteAccount')} /> : null}
      </Card>
    </Screen>
  );
}
