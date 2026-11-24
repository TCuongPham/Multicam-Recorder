import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Modal, RefreshControl, ScrollView, SectionList, StyleSheet, Text, View } from 'react-native';
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
import { Badge, Banner, Button, Empty, IconButton, Loading, Muted, ProgressBar, Row, SpinningIcon } from '../../ui/components';
import { VideoRow } from '../../ui/VideoRow';
import { colors, font, radius, spacing } from '../../ui/theme';
import type { AppStackParams } from '../../navigation/types';

const REASONS: Record<string, string> = {
  NOT_FOUND: 'Không tồn tại',
  FORBIDDEN: 'Không có quyền',
};

/** Giới hạn số trang nạp thêm khi "Chọn tất cả" (tránh vòng lặp vô hạn nếu server trả sai total). */
const MAX_PAGES = 500;

export function ControllerLibraryScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParams>>();
  const queryClient = useQueryClient();
  const lib = useVideoLibrary(api, kv, { sort: 'created_at_desc', pageSize: 20 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<string | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
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
        title: g.session_id ? `Phiên ${g.session_id}` : 'Quay lẻ',
        subtitle: `${formatDateTime(g.recorded_at)} · ${g.videos.length} góc máy`,
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

  /** Chọn / bỏ chọn mọi clip của một phiên. */
  const toggleMany = (ids: string[]) =>
    setSelected((s) => {
      const n = new Set(s);
      const all = ids.every((id) => n.has(id));
      for (const id of ids) {
        if (all) n.delete(id);
        else n.add(id);
      }
      return n;
    });

  const exitSelection = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const allSelected = lib.videos.length > 0 && !lib.hasNextPage && lib.videos.every((v) => selected.has(v.id));

  /** Chọn tất cả: nạp nốt các trang còn lại rồi chọn toàn bộ clip trên server. */
  async function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
      return;
    }
    setLoadingAll(true);
    try {
      let videos = lib.videos;
      let hasNext = !!lib.hasNextPage;
      for (let i = 0; hasNext && i < MAX_PAGES; i++) {
        const r = await lib.fetchNextPage();
        if (r.isError) break;
        videos = r.data?.pages.flatMap((p) => p.videos) ?? videos;
        hasNext = !!r.hasNextPage;
      }
      setSelected(new Set(videos.map((v) => v.id)));
    } finally {
      setLoadingAll(false);
    }
  }

  const selectedVideos = lib.videos.filter((v) => selected.has(v.id));

  async function doDelete() {
    const ids = [...selected];
    const failed: BulkDeleteResult['failed'] = [];
    setDeleting(true);
    try {
      if (ids.length === 1) {
        // Một clip → delete_video
        try {
          await api.deleteVideo(ids[0]);
        } catch (e) {
          // Đã bị xóa trước đó → coi như gỡ khỏi danh sách.
          if (!isApiError(e, Codes.VIDEO_NOT_FOUND)) failed.push({ video_id: ids[0], reason: errorMessage(e) });
        }
      } else {
        // Từ hai clip → delete_videos_bulk, chia lô tối đa 50 clip; lô lỗi không làm dừng các lô sau.
        const batches = Math.ceil(ids.length / BULK_DELETE_MAX);
        for (let b = 0; b < batches; b++) {
          const batch = ids.slice(b * BULK_DELETE_MAX, (b + 1) * BULK_DELETE_MAX);
          if (batches > 1) setDeleteProgress(`Đang xóa ${b + 1}/${batches}`);
          try {
            const r = await api.deleteVideosBulk(batch);
            failed.push(...(r.failed ?? []));
          } catch (e) {
            const reason = errorMessage(e);
            failed.push(...batch.map((video_id) => ({ video_id, reason })));
          }
        }
      }
      if (failed.length) setFailures(failed);
      exitSelection();
    } finally {
      setDeleting(false);
      setDeleteProgress(null);
      void queryClient.invalidateQueries({ queryKey: ['videos'] });
    }
  }

  function confirmDelete() {
    const n = selected.size;
    Alert.alert(`Xóa ${n} clip?`, 'Clip trên máy quay không bị xóa.', [
      { text: 'Hủy', style: 'cancel' },
      { text: 'Xóa', style: 'destructive', onPress: () => void doDelete() },
    ]);
  }

  function startDownload() {
    queue.enqueue(selectedVideos);
    exitSelection();
  }

  const nameOf = (id: string) => lib.videos.find((v) => v.id === id)?.camera_name ?? id;
  const refreshing = lib.isRefetching && !lib.isFetchingNextPage;

  if (lib.isLoading) return <Loading />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {lib.fromCache ? (
        <Banner kind="warning" style={styles.topBanner}>
          Ngoại tuyến · dữ liệu đã lưu
        </Banner>
      ) : null}
      {queue.active ? (
        <View style={[styles.queue, styles.topBanner]}>
          <Row>
            <ActivityIndicator color={colors.accent} size="small" />
            <Text style={{ fontWeight: font.heading, color: colors.text, fontVariant: font.tabular }}>{queue.label}</Text>
          </Row>
          <Muted numberOfLines={1}>{queue.current?.camera_name}</Muted>
          <ProgressBar percent={((queue.position - 1) / Math.max(1, queue.total)) * 100} />
          <Button title="Hủy" small variant="ghost" onPress={queue.cancel} style={{ alignSelf: 'flex-start', paddingHorizontal: spacing.sm }} />
        </View>
      ) : null}
      {!queue.active && queue.errors.length ? (
        <Banner kind="danger" style={styles.topBanner}>
          <Text style={{ color: colors.danger, fontWeight: font.heading }}>Không tải được {queue.errors.length} clip</Text>
          {queue.errors.slice(0, 20).map((e) => (
            <Text key={e.video.id} style={{ color: colors.danger, fontSize: 12 }}>
              {e.video.camera_name} · {e.message}
            </Text>
          ))}
          {queue.errors.length > 20 ? <Text style={{ color: colors.danger, fontSize: 12 }}>+{queue.errors.length - 20}</Text> : null}
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
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: selecting ? 120 : spacing.xl }}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void lib.refetch()} tintColor={colors.muted} colors={[colors.accent]} />
        }
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (lib.hasNextPage && !lib.isFetchingNextPage) void lib.fetchNextPage();
        }}
        ListHeaderComponent={
          <View style={{ gap: spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Muted style={{ fontVariant: font.tabular }}>
                {lib.total} clip
              </Muted>
              <Row style={{ gap: spacing.sm }}>
                <IconButton
                  label="Làm mới"
                  size={32}
                  iconNode={<SpinningIcon spinning={refreshing} color={colors.text} />}
                  onPress={() => void lib.refetch()}
                />
                {selecting ? (
                  <Button title="Xong" small variant="secondary" onPress={exitSelection} />
                ) : (
                  <Button title="Chọn" small variant="secondary" onPress={() => setSelecting(true)} disabled={!lib.videos.length} />
                )}
              </Row>
            </Row>
            {selecting ? (
              <Row style={{ justifyContent: 'space-between' }}>
                <Button
                  title={allSelected ? 'Bỏ chọn' : 'Chọn tất cả'}
                  small
                  variant="ghost"
                  icon={allSelected ? 'x' : 'select-all'}
                  loading={loadingAll}
                  onPress={() => void toggleAll()}
                  style={{ paddingHorizontal: 0 }}
                />
              </Row>
            ) : null}
          </View>
        }
        renderSectionHeader={({ section }) => {
          const ids = section.data.map((v) => v.id);
          const sessionAll = ids.length > 0 && ids.every((id) => selected.has(id));
          return (
            <Row style={styles.sectionHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionTitle} numberOfLines={1}>
                  {section.title}
                </Text>
                <Muted style={{ fontVariant: font.tabular }}>{section.subtitle}</Muted>
              </View>
              {selecting ? (
                <Button title={sessionAll ? 'Bỏ chọn phiên' : 'Chọn phiên'} small variant="ghost" onPress={() => toggleMany(ids)} />
              ) : null}
            </Row>
          );
        }}
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
                {downloaded.has(item.id) ? <Badge text="Đã tải về" icon="check" color={colors.success} bg={colors.successBg} /> : null}
                {queue.current?.id === item.id ? <Badge text="Đang tải…" color={colors.accent} bg={colors.accentSoft} /> : null}
              </Row>
            </VideoRow>
          </View>
        )}
        ListEmptyComponent={lib.error ? null : <Empty text="Chưa có video nào" />}
        ListFooterComponent={lib.isFetchingNextPage ? <ActivityIndicator style={{ margin: spacing.lg }} color={colors.muted} /> : null}
      />

      {selecting ? (
        <View style={styles.toolbar}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontWeight: font.heading, fontVariant: font.tabular }}>{selected.size} đã chọn</Text>
            {deleteProgress ? <Muted>{deleteProgress}</Muted> : null}
          </View>
          <Row>
            <Button title="Tải về" small variant="secondary" icon="download" disabled={!selected.size || deleting} onPress={startDownload} />
            <Button title="Xóa" small variant="danger" icon="trash" disabled={!selected.size} loading={deleting} onPress={confirmDelete} />
          </Row>
        </View>
      ) : null}

      <Modal visible={!!failures} transparent animationType="fade" onRequestClose={() => setFailures(null)}>
        <View style={styles.backdrop}>
          <View style={styles.modal}>
            <Text style={{ fontSize: 16, fontWeight: font.heading, color: colors.text }}>
              Không xóa được {failures?.length ?? 0} clip
            </Text>
            <ScrollView style={{ maxHeight: 320 }}>
              {failures?.map((f) => (
                <View key={f.video_id} style={styles.tableRow}>
                  <Text style={styles.cell} numberOfLines={1}>
                    {nameOf(f.video_id)}
                  </Text>
                  <Text style={[styles.cell, { color: colors.muted, textAlign: 'right' }]}>{REASONS[f.reason] ?? f.reason}</Text>
                </View>
              ))}
            </ScrollView>
            <Button title="Đóng" variant="tonal" onPress={() => setFailures(null)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  topBanner: { marginHorizontal: spacing.lg, marginTop: spacing.sm },
  queue: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  sectionHeader: { marginTop: spacing.lg, marginBottom: spacing.sm },
  sectionTitle: { fontSize: 15, fontWeight: font.heading, color: colors.text },
  toolbar: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
    backgroundColor: colors.surface2,
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingLeft: spacing.xl,
    paddingRight: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  backdrop: { flex: 1, backgroundColor: colors.backdrop, justifyContent: 'center', padding: spacing.lg },
  modal: {
    backgroundColor: colors.surface,
    borderRadius: radius.xxl,
    padding: spacing.xl,
    gap: spacing.sm,
  },
  tableRow: { flexDirection: 'row', gap: spacing.sm, paddingVertical: 6, borderColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  cell: { flex: 1, color: colors.text, fontSize: 13 },
});
