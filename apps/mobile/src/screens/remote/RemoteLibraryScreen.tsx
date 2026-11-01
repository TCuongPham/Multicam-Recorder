import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { formatBytes, formatDateTime, formatDuration } from '@multicam/shared';
import { useStore, useVideoLibrary } from '@multicam/shared/react';
import { api, errorMessage } from '../../services/api';
import { listLocalClips, toUri, type LocalClipInfo } from '../../services/clips';
import { session } from '../../services/session';
import { kv } from '../../services/storage';
import { clipsStore, uploadManager } from '../../services/upload';
import { Badge, Banner, Button, Empty, Muted, ProgressBar, Row } from '../../ui/components';
import { VideoRow } from '../../ui/VideoRow';
import { colors, radius, spacing } from '../../ui/theme';
import type { AppStackParams } from '../../navigation/types';

const PHASE: Record<string, string> = {
  hashing: 'Đang tính SHA-256',
  uploading: 'Đang upload',
  completing: 'Đang hoàn tất',
};

/** Thẻ tiến trình thu nhỏ ở đầu màn Thư viện (trạng thái UploadManager). */
function UploadCard() {
  const s = useStore(uploadManager);
  return (
    <View style={styles.card}>
      {s.active ? (
        <>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.cardTitle}>
              {PHASE[s.active.phase]} {s.active.phase === 'uploading' ? `${Math.round(s.active.percent)}%` : ''}
            </Text>
            <ActivityIndicator color={colors.primary} />
          </Row>
          <Muted style={{ fontSize: 11 }}>{s.active.baseName}</Muted>
          <ProgressBar percent={s.active.phase === 'hashing' ? 0 : s.active.percent} />
          {s.pending > 1 ? <Muted>Còn {s.pending - 1} clip đang chờ</Muted> : null}
        </>
      ) : s.blocked ? (
        <>
          <Text style={[styles.cardTitle, { color: colors.danger }]}>Đã hết dung lượng lưu trữ trên server</Text>
          <Muted>Đề nghị Controller xóa bớt clip cũ rồi thử lại.</Muted>
          <Button title="Thử lại" small variant="secondary" onPress={() => uploadManager.kick({ force: true })} />
        </>
      ) : s.lastResult === 'failed' ? (
        <>
          <Text style={[styles.cardTitle, { color: colors.warning }]}>Upload tạm dừng: {s.error}</Text>
          <Muted>Sẽ tự thử lại khi có mạng hoặc lần mở ứng dụng sau.</Muted>
          <Button title="Thử lại ngay" small variant="secondary" onPress={() => uploadManager.kick({ force: true })} />
        </>
      ) : (
        <Text style={[styles.cardTitle, { color: colors.success }]}>✓ Tất cả clip đã được gửi lên server</Text>
      )}
    </View>
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

  if (!clips) return <ActivityIndicator style={{ margin: spacing.xl }} />;
  return (
    <FlatList
      data={clips}
      keyExtractor={(c) => c.baseName}
      contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            uploadManager.kick();
            setRefreshing(false);
          }}
        />
      }
      ListHeaderComponent={<UploadCard />}
      ListEmptyComponent={<Empty text="Chưa có clip nào trên máy" />}
      renderItem={({ item }) => {
        const active = upload.active?.baseName === item.baseName ? upload.active : null;
        return (
          <VideoRow
            thumbnail={item.thumbPath ? toUri(item.thumbPath) : null}
            title={item.meta.camera_name}
            subtitle={`${formatDuration(item.meta.duration_ms)} · ${formatBytes(item.size)} · ${item.meta.resolution}`}
            meta={`${formatDateTime(item.meta.recorded_at)} · ${item.meta.session_id ? `Phiên ${item.meta.session_id}` : 'Quay độc lập'}`}
            // Chỉ xem lại trong ứng dụng: không có nút tải xuống, không có nút xóa.
            onPress={() => navigation.navigate('Player', { uri: toUri(item.path), title: item.meta.camera_name })}
          >
            {item.meta.device_id && myDeviceId && item.meta.device_id !== myDeviceId && !item.uploaded ? (
              <Badge text="Clip của tài khoản khác — không upload" />
            ) : item.uploaded ? (
              <Badge text="Đã gửi ✓" color={colors.success} bg={colors.successBg} />
            ) : active ? (
              <Badge text={`${PHASE[active.phase]} ${Math.round(active.percent)}%`} color={colors.primary} bg={colors.infoBg} />
            ) : (
              <Badge text="Chờ upload" color={colors.warning} bg={colors.warningBg} />
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
  if (lib.isLoading) return <ActivityIndicator style={{ margin: spacing.xl }} />;
  return (
    <FlatList
      data={lib.videos}
      keyExtractor={(v) => v.id}
      contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
      refreshControl={<RefreshControl refreshing={lib.isRefetching && !lib.isFetchingNextPage} onRefresh={() => void lib.refetch()} />}
      onEndReachedThreshold={0.4}
      onEndReached={() => {
        if (lib.hasNextPage && !lib.isFetchingNextPage) void lib.fetchNextPage();
      }}
      ListHeaderComponent={
        <>
          {lib.fromCache ? <Banner kind="warning">Mất kết nối — đang xem danh sách đã lưu</Banner> : null}
          {lib.error && !lib.videos.length ? <Banner kind="danger">{errorMessage(lib.error)}</Banner> : null}
        </>
      }
      ListEmptyComponent={lib.error ? null : <Empty text="Chưa có video nào" />}
      ListFooterComponent={lib.isFetchingNextPage ? <ActivityIndicator style={{ margin: spacing.lg }} /> : null}
      renderItem={({ item }) => (
        <VideoRow
          thumbnail={item.thumbnail_url}
          title={item.camera_name}
          subtitle={`${formatDuration(item.duration_ms)} · ${formatBytes(item.size)}`}
          meta={`${formatDateTime(item.recorded_at || item.created_at)} · ${item.session_id ? `Phiên ${item.session_id}` : 'Quay độc lập'}`}
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
      <View style={styles.segment}>
        {(
          [
            ['local', 'Trên máy'],
            ['server', 'Đã upload'],
          ] as const
        ).map(([key, label]) => (
          <Pressable key={key} onPress={() => setTab(key)} style={[styles.segItem, tab === key && styles.segActive]}>
            <Text style={{ color: tab === key ? '#fff' : colors.text, fontWeight: '600' }}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {tab === 'local' ? <LocalClips /> : <ServerClips />}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginBottom: spacing.xs,
  },
  cardTitle: { fontWeight: '700', color: colors.text },
  segment: {
    flexDirection: 'row',
    margin: spacing.md,
    marginBottom: 0,
    backgroundColor: colors.border,
    borderRadius: radius.md,
    padding: 3,
  },
  segItem: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.sm },
  segActive: { backgroundColor: colors.primary },
});
