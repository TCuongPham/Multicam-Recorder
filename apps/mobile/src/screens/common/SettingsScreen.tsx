import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useStore } from '@multicam/shared/react';
import { session } from '../../services/session';
import { signOut } from '../../services/runtime';
import { getServerUrl, setCameraName } from '../../services/storage';
import { remoteAgent } from '../../services/remote';
import { resolveCameraName } from '../../services/recorder';
import { Button, Card, Field, Icon, Muted, PressableScale, Row, Screen, type IconName } from '../../ui/components';
import { colors, font, radius, spacing } from '../../ui/theme';
import type { AppStackParams } from '../../navigation/types';

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Muted>{label}</Muted>
      <Text style={{ color: colors.text, flexShrink: 1, textAlign: 'right', fontSize: 13 }} selectable>
        {value || '—'}
      </Text>
    </View>
  );
}

/** Một dòng thao tác kiểu danh sách cài đặt: biểu tượng · nhãn (· mô tả) · mũi tên. */
function ActionRow({
  icon,
  label,
  description,
  danger,
  loading,
  onPress,
}: {
  icon: IconName;
  label: string;
  description?: string;
  danger?: boolean;
  loading?: boolean;
  onPress: () => void;
}) {
  const fg = danger ? colors.danger : colors.text;
  return (
    <PressableScale accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={loading} style={styles.action}>
      <Icon name={icon} size={20} color={fg} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.actionText, { color: fg }]}>{label}</Text>
        {description ? <Muted>{description}</Muted> : null}
      </View>
      {loading ? <ActivityIndicator size="small" color={colors.muted} /> : <Icon name="chevron-right" size={18} color={colors.muted} />}
    </PressableScale>
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
    Alert.alert('Đăng xuất?', isRemote && agent.inRoom ? 'Máy sẽ rời phòng.' : undefined, [
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
        <Row style={{ gap: 12, marginBottom: 4 }}>
          <View style={styles.avatar}>
            <Icon name="user" size={20} color={colors.accent} />
          </View>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: font.heading, color: colors.text }}>
            {user ? `${user.last_name} ${user.first_name}`.trim() : 'Tài khoản'}
          </Text>
        </Row>
        <InfoRow label="Vai trò" value={info?.role === 'controller' ? 'Điều khiển' : 'Máy quay'} />
        <InfoRow label="Email" value={user?.email} />
        <InfoRow label="Số điện thoại" value={user?.phone} />
        <InfoRow label="Máy chủ" value={getServerUrl()} />
        <InfoRow label="Mã thiết bị" value={info?.deviceId} />
      </Card>

      {isRemote ? (
        <Card>
          <Field
            label="Tên camera"
            value={cameraName}
            onChangeText={(v) => {
              setName(v);
              setSaved(false);
            }}
            maxLength={40}
            hint={saved ? 'Đã lưu' : null}
          />
          <Button
            title="Lưu"
            variant="tonal"
            small
            style={{ alignSelf: 'flex-start' }}
            disabled={!cameraName.trim()}
            onPress={async () => {
              await setCameraName(cameraName);
              await session.updateInfo({ cameraName: cameraName.trim() });
              setSaved(true);
            }}
          />
        </Card>
      ) : null}

      <Card style={{ padding: spacing.xs, gap: 0 }}>
        <ActionRow icon="key" label="Đổi mật khẩu" onPress={() => navigation.navigate('ChangePassword')} />
        <ActionRow icon="logout" label="Đăng xuất" onPress={confirmLogout} loading={loggingOut} />
        {/* Ẩn mục xóa tài khoản khi account_role = controller. */}
        {isRemote ? (
          <ActionRow
            icon="trash"
            label="Xóa tài khoản"
            description="Xóa vĩnh viễn tài khoản và video."
            danger
            onPress={() => navigation.navigate('DeleteAccount')}
          />
        ) : null}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
  },
  actionText: { fontSize: 15, fontWeight: font.medium },
});
