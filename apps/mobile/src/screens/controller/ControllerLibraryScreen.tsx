import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Modal, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
import {
  BULK_DELETE_MAX,
  Codes,
  formatBytes,
  formatDateTime,
  formatDuration,
  type BulkDeleteResult,
  type VideoItem,
} from '@multicam/shared';
import { groupBySession, useDownloadQueue, useVideoLibrary } from '@multicam/shared/react';
import { api, errorMessage, isApiError } from '../../services/api';
import { listDownloadedIds } from '../../services/clips';
import { downloadVideo } from '../../services/downloads';
import { kv } from '../../services/storage';
import { Badge, Banner, Button, Empty, Loading, Muted, ProgressBar, Row } from '../../ui/components';
import { VideoRow } from '../../ui/VideoRow';
import { colors, radius, spacing } from '../../ui/theme';
import type { AppStackParams } from '../../navigation/types';

const REASONS: Record<string, string> = {
  NOT_FOUND: 'Không tồn tại / đã bị xóa',
  FORBIDDEN: 'Không có quyền',
};

export function ControllerLibraryScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParams>>();
  const queryClient = useQueryClient();
  const lib = useVideoLibrary(api, kv, { sort: 'created_at_desc', pageSize: 20 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failures, setFailures] = useState<BulkDeleteResult['failed'] | null>(null);
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());

  const refreshDownloaded = useCallback(() => {
    void listDownloadedIds()
      .then(setDownloaded)
      .catch(() => undefined);
  }, []);
  useFocusEffect(refreshDownloaded);

  const download = useCallback(
    async (v: VideoItem) => {
      await downloadVideo(v);
      refreshDownloaded();
    },
    [refreshDownloaded],
  );
  const queue = useDownloadQueue(download);
  useEffect(() => {
    if (!queue.active) void queryClient.invalidateQueries({ queryKey: ['videos'] });
  }, [queue.active, queryClient]);

  const sections = useMemo(
    () =>
      groupBySession(lib.videos).map((g) => ({
        key: g.session_id ?? `solo-${g.videos[0]?.device_id}`,
        title: g.session_id ? `Phiên ${g.session_id}` : 'Quay độc lập',
        subtitle: `${formatDateTime(g.recorded_at)} · ${g.videos.length} clip`,
        data: g.videos,
      })),
    [lib.videos],
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const exitSelection = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const selectedVideos = lib.videos.filter((v) => selected.has(v.id));

  async function doDelete() {
    const ids = [...selected];
    setDeleting(true);
    try {
      if (ids.length === 1) {
        // Chọn một clip → delete_video
        try {
          await api.deleteVideo(ids[0]);
        } catch (e) {
          if (!isApiError(e, Codes.VIDEO_NOT_FOUND)) throw e; // đã bị xóa trước đó → coi như gỡ khỏi danh sách
        }
      } else {
        // Từ hai clip trở lên → delete_videos_bulk (tối đa 50 clip mỗi lời gọi)
        const failed: BulkDeleteResult['failed'] = [];
        for (let i = 0; i < ids.length; i += BULK_DELETE_MAX) {
          const r = await api.deleteVideosBulk(ids.slice(i, i + BULK_DELETE_MAX));
          failed.push(...r.failed);
        }
        if (failed.length) setFailures(failed);
      }
      exitSelection();
    } catch (e) {
      Alert.alert('Không xóa được', errorMessage(e));
    } finally {
      setDeleting(false);
      void queryClient.invalidateQueries({ queryKey: ['videos'] });
    }
  }

  function confirmDelete() {
    const n = selected.size;
    Alert.alert('Xóa clip khỏi server', `Xóa ${n} clip đã chọn? Bản trong máy Remote vẫn còn và không bị upload lại.`, [
      { text: 'Hủy', style: 'cancel' },
      { text: 'Xóa', style: 'destructive', onPress: () => void doDelete() },
    ]);
  }

  function startDownload() {
    queue.enqueue(selectedVideos);
    exitSelection();
  }

  const nameOf = (id: string) => lib.videos.find((v) => v.id === id)?.camera_name ?? id;

  if (lib.isLoading) return <Loading />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {lib.fromCache ? (
        <Banner kind="warning" style={styles.topBanner}>
          Mất kết nối — đang xem danh sách đã lưu (ngoại tuyến)
        </Banner>
      ) : null}
      {queue.active ? (
        <View style={[styles.queue, styles.topBanner]}>
          <Row>
            <ActivityIndicator color={colors.primary} />
            <Text style={{ fontWeight: '700', color: colors.text }}>{queue.label}</Text>
          </Row>
          <Muted>{queue.current?.camera_name} — {queue.current?.name}</Muted>
          <ProgressBar percent={(queue.position - 1) / Math.max(1, queue.total) * 100} />
          <Button title="Hủy các clip còn lại" small variant="ghost" onPress={queue.cancel} />
        </View>
      ) : null}
      {!queue.active && queue.errors.length ? (
        <Banner kind="danger" style={styles.topBanner}>
          <Text style={{ color: colors.danger, fontWeight: '700' }}>Tải lỗi {queue.errors.length} clip:</Text>
          {queue.errors.map((e) => (
            <Text key={e.video.id} style={{ color: colors.danger, fontSize: 12 }}>
              • {e.video.camera_name} ({e.video.name}): {e.message}
            </Text>
          ))}
        </Banner>
      ) : null}
      {lib.error && !lib.videos.length ? (
        <Banner kind="danger" style={styles.topBanner}>
          {errorMessage(lib.error)}
        </Banner>
      ) : null}

      <SectionList
        sections={sections}
        keyExtractor={(v) => v.id}
        contentContainerStyle={{ padding: spacing.md, gap: spacing.sm, paddingBottom: selecting ? 120 : spacing.xl }}
        stickySectionHeadersEnabled={false}
        refreshControl={<RefreshControl refreshing={lib.isRefetching && !lib.isFetchingNextPage} onRefresh={() => void lib.refetch()} />}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (lib.hasNextPage && !lib.isFetchingNextPage) void lib.fetchNextPage();
        }}
        ListHeaderComponent={
          <Row style={{ justifyContent: 'space-between', marginBottom: spacing.xs }}>
            <Muted>
              {lib.total} clip trên server{lib.fromCache ? ' (bản lưu)' : ''}
            </Muted>
            {selecting ? (
              <Button title="Xong" small variant="ghost" onPress={exitSelection} />
            ) : (
              <Button title="Chọn" small variant="ghost" onPress={() => setSelecting(true)} disabled={!lib.videos.length} />
            )}
          </Row>
        }
        renderSectionHeader={({ section }) => (
          <View style={{ marginTop: spacing.md, marginBottom: spacing.xs }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>{section.title}</Text>
            <Muted>{section.subtitle}</Muted>
          </View>
        )}
        renderItem={({ item }) => (
          <View style={{ marginBottom: spacing.sm }}>
            <VideoRow
              thumbnail={item.thumbnail_url}
              title={item.camera_name}
              subtitle={`${formatDuration(item.duration_ms)} · ${formatBytes(item.size)}`}
              meta={formatDateTime(item.recorded_at || item.created_at)}
              selecting={selecting}
              selected={selected.has(item.id)}
              onPress={() => (selecting ? toggle(item.id) : navigation.navigate('Player', { videoId: item.id, title: item.camera_name }))}
              onLongPress={() => {
                setSelecting(true);
                toggle(item.id);
              }}
            >
              <Row>
                {downloaded.has(item.id) ? <Badge text="Đã tải về máy" color={colors.success} bg={colors.successBg} /> : null}
                {!downloaded.has(item.id) && item.downloaded_by_controller ? <Badge text="Đã từng tải" /> : null}
                {queue.current?.id === item.id ? <Badge text="Đang tải…" color={colors.primary} bg={colors.infoBg} /> : null}
              </Row>
            </VideoRow>
          </View>
        )}
        ListEmptyComponent={lib.error ? null : <Empty text="Chưa có video nào" />}
        ListFooterComponent={lib.isFetchingNextPage ? <ActivityIndicator style={{ margin: spacing.lg }} /> : null}
      />

      {selecting ? (
        <View style={styles.toolbar}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>Đã chọn {selected.size}</Text>
          <Row>
            <Button title="Tải về" small variant="secondary" disabled={!selected.size} onPress={startDownload} />
            <Button title="Xóa" small variant="danger" disabled={!selected.size} loading={deleting} onPress={confirmDelete} />
          </Row>
        </View>
      ) : null}

      <Modal visible={!!failures} transparent animationType="fade" onRequestClose={() => setFailures(null)}>
        <View style={styles.backdrop}>
          <View style={styles.modal}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>Một số clip không xóa được</Text>
            <View style={[styles.tableRow, { borderBottomWidth: 1 }]}>
              <Text style={[styles.cell, { fontWeight: '700' }]}>Clip</Text>
              <Text style={[styles.cell, { fontWeight: '700' }]}>Lý do</Text>
            </View>
            {failures?.map((f) => (
              <View key={f.video_id} style={styles.tableRow}>
                <Text style={styles.cell} numberOfLines={1}>
                  {nameOf(f.video_id)} ({f.video_id})
                </Text>
                <Text style={styles.cell}>{REASONS[f.reason] ?? f.reason}</Text>
              </View>
            ))}
            <Button title="Đóng" onPress={() => setFailures(null)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  topBanner: { marginHorizontal: spacing.md, marginTop: spacing.sm },
  queue: { backgroundColor: colors.infoBg, borderRadius: radius.md, padding: spacing.md, gap: 6 },
  toolbar: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
    backgroundColor: colors.dark,
    borderRadius: radius.lg,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', justifyContent: 'center', padding: spacing.lg },
  modal: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  tableRow: { flexDirection: 'row', gap: spacing.sm, paddingVertical: 4, borderColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  cell: { flex: 1, color: colors.text, fontSize: 13 },
});
