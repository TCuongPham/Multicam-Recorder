import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { formatBytes, formatDateTime, formatDuration } from '@multicam/shared';
import { useStore, useVideoLibrary } from '@multicam/shared/react';
import { api, errorMessage } from '../../services/api';
import { listLocalClips, toUri, type LocalClipInfo } from '../../services/clips';
import { session } from '../../services/session';
import { kv } from '../../services/storage';
import { clipsStore, uploadManager } from '../../services/upload';
import { Badge, Banner, Button, Empty, Icon, IconButton, Muted, ProgressBar, Row, Segmented, SpinningIcon } from '../../ui/components';
import { VideoRow } from '../../ui/VideoRow';
import { colors, font, radius, spacing } from '../../ui/theme';
import type { AppStackParams } from '../../navigation/types';

/** Thẻ tiến trình thu nhỏ ở đầu màn Thư viện (trạng thái UploadManager). */
function UploadCard() {
  const s = useStore(uploadManager);
  return (
    <View style={styles.card}>
      {s.active ? (
        <>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.cardTitle}>Đang tải lên · {s.active.phase === 'hashing' ? 0 : Math.round(s.active.percent)}%</Text>
            <ActivityIndicator color={colors.accent} size="small" />
          </Row>
          <ProgressBar percent={s.active.phase === 'hashing' ? 0 : s.active.percent} />
          {s.pending > 1 ? <Muted style={{ fontVariant: font.tabular }}>+{s.pending - 1} chờ</Muted> : null}
        </>
      ) : s.blocked ? (
        <>
          <Text style={[styles.cardTitle, { color: colors.danger }]}>Hết dung lượng lưu trữ</Text>
          <Button title="Thử lại" small variant="tonal" style={{ alignSelf: 'flex-start' }} onPress={() => uploadManager.kick({ force: true })} />
        </>
      ) : s.lastResult === 'failed' ? (
        <>
          <Text style={[styles.cardTitle, { color: colors.warning }]}>Tải lên tạm dừng</Text>
          {s.error ? <Muted numberOfLines={1}>{s.error}</Muted> : null}
          <Button title="Thử lại" small variant="tonal" style={{ alignSelf: 'flex-start' }} onPress={() => uploadManager.kick({ force: true })} />
        </>
      ) : (
        <Row style={{ gap: 6 }}>
          <Icon name="check" size={16} color={colors.success} strokeWidth={2.25} />
          <Text style={[styles.cardTitle, { color: colors.success }]}>Đã tải lên xong</Text>
        </Row>
      )}
    </View>
  );
}

function ListHeader({ text, spinning, onRefresh }: { text: string; spinning: boolean; onRefresh: () => void }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <Muted style={{ fontVariant: font.tabular }}>{text}</Muted>
      <IconButton label="Làm mới" size={32} iconNode={<SpinningIcon spinning={spinning} color={colors.text} />} onPress={onRefresh} />
    </Row>
  );
}

function LocalClips() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParams>>();
  const version = useStore(clipsStore);
  const upload = useStore(uploadManager);
  const myDeviceId = useStore(session).info?.deviceId;
  const [clips, setClips] = useState<LocalClipInfo[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setClips(await listLocalClips());
    } catch {
      setClips([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = async () => {
    setRefreshing(true);
    await load();
    uploadManager.kick();
    setRefreshing(false);
  };

  if (!clips) return <ActivityIndicator style={{ margin: spacing.xl }} color={colors.muted} />;
  return (
    <FlatList
      data={clips}
      keyExtractor={(c) => c.baseName}
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.muted} colors={[colors.accent]} />}
      ListHeaderComponent={
        <View style={{ gap: spacing.sm }}>
          <ListHeader text={`${clips.length} clip`} spinning={refreshing} onRefresh={() => void refresh()} />
          <UploadCard />
        </View>
      }
      ListEmptyComponent={<Empty text="Chưa có clip" />}
      renderItem={({ item }) => {
        const active = upload.active?.baseName === item.baseName ? upload.active : null;
        return (
          <VideoRow
            thumbnail={item.thumbPath ? toUri(item.thumbPath) : null}
            title={item.meta.camera_name}
            subtitle={`${formatDuration(item.meta.duration_ms)} · ${formatBytes(item.size)} · ${item.meta.resolution}`}
            meta={`${formatDateTime(item.meta.recorded_at)} · ${item.meta.session_id ? `Phiên ${item.meta.session_id}` : 'Quay lẻ'}`}
            // Chỉ xem lại trong ứng dụng: không có nút tải xuống, không có nút xóa.
            onPress={() => navigation.navigate('Player', { uri: toUri(item.path), title: item.meta.camera_name })}
          >
            {item.meta.device_id && myDeviceId && item.meta.device_id !== myDeviceId && !item.uploaded ? (
              <Badge text="Tài khoản khác" />
            ) : item.uploaded ? (
              <Badge text="Đã tải lên" icon="check" color={colors.success} bg={colors.successBg} />
            ) : active ? (
              <Badge text={`Đang tải lên ${active.phase === 'hashing' ? 0 : Math.round(active.percent)}%`} color={colors.accent} bg={colors.accentSoft} />
            ) : (
              <Badge text="Chờ tải lên" color={colors.warning} bg={colors.warningBg} />
            )}
          </VideoRow>
        );
      }}
    />
  );
}

function ServerClips() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParams>>();
  const lib = useVideoLibrary(api, kv, { sort: 'created_at_desc', pageSize: 20 });
  if (lib.isLoading) return <ActivityIndicator style={{ margin: spacing.xl }} color={colors.muted} />;
  const refreshing = lib.isRefetching && !lib.isFetchingNextPage;
  return (
    <FlatList
      data={lib.videos}
      keyExtractor={(v) => v.id}
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void lib.refetch()} tintColor={colors.muted} colors={[colors.accent]} />}
      onEndReachedThreshold={0.4}
      onEndReached={() => {
        if (lib.hasNextPage && !lib.isFetchingNextPage) void lib.fetchNextPage();
      }}
      ListHeaderComponent={
        <View style={{ gap: spacing.sm }}>
          <ListHeader text={`${lib.total} clip`} spinning={refreshing} onRefresh={() => void lib.refetch()} />
          {lib.fromCache ? <Banner kind="warning">Ngoại tuyến · dữ liệu đã lưu</Banner> : null}
          {lib.error && !lib.videos.length ? <Banner kind="danger">{errorMessage(lib.error)}</Banner> : null}
        </View>
      }
      ListEmptyComponent={lib.error ? null : <Empty text="Chưa có video nào" />}
      ListFooterComponent={lib.isFetchingNextPage ? <ActivityIndicator style={{ margin: spacing.lg }} color={colors.muted} /> : null}
      renderItem={({ item }) => (
        <VideoRow
          thumbnail={item.thumbnail_url}
          title={item.camera_name}
          subtitle={`${formatDuration(item.duration_ms)} · ${formatBytes(item.size)}`}
          meta={`${formatDateTime(item.recorded_at || item.created_at)} · ${item.session_id ? `Phiên ${item.session_id}` : 'Quay lẻ'}`}
          onPress={() => navigation.navigate('Player', { videoId: item.id, title: item.camera_name })}
        />
      )}
    />
  );
}

export function RemoteLibraryScreen() {
  const [tab, setTab] = useState<'local' | 'server'>('local');
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Segmented
        items={[
          ['local', 'Trên máy'],
          ['server', 'Đã tải lên'],
        ] as const}
        value={tab}
        onChange={setTab}
        style={{ marginHorizontal: spacing.lg, marginTop: spacing.md }}
      />
      {tab === 'local' ? <LocalClips /> : <ServerClips />}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  cardTitle: { fontWeight: font.heading, color: colors.text, fontVariant: font.tabular },
});
