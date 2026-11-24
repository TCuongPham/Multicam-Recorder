import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Codes, formatBytes, formatDateTime, formatDuration } from '@multicam/shared';
import { api, errorMessage, isApiError } from '../../services/api';
import { Banner, Loading, Muted } from '../../ui/components';
import { colors, font } from '../../ui/theme';
import type { AppScreenProps } from '../../navigation/types';

function Player({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  return <VideoView style={styles.video} player={player} nativeControls contentFit="contain" />;
}

/** Xem clip trong ứng dụng: URL có chữ ký từ get_video, hoặc file cục bộ của máy Remote. */
export function PlayerScreen({ route, navigation }: AppScreenProps<'Player'>) {
  const { videoId, uri } = route.params;
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['video', videoId],
    enabled: !!videoId,
    queryFn: () => api.getVideo(videoId!),
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    // Clip đã bị xóa → gỡ khỏi danh sách và làm mới Thư viện.
    if (isApiError(detail.error, Codes.VIDEO_NOT_FOUND)) void queryClient.invalidateQueries({ queryKey: ['videos'] });
  }, [detail.error, queryClient]);

  if (uri) {
    return (
      <View style={styles.container}>
        <Player uri={uri} />
      </View>
    );
  }
  if (detail.isLoading) return <Loading />;
  if (detail.error || !detail.data) {
    return (
      <View style={{ padding: 16, gap: 12, flex: 1, backgroundColor: colors.bg }}>
        <Banner kind="danger">{errorMessage(detail.error)}</Banner>
        <Text style={{ color: colors.primary }} onPress={() => navigation.goBack()}>
          Quay lại
        </Text>
      </View>
    );
  }
  const v = detail.data;
  return (
    <View style={styles.container}>
      <Player uri={v.url} />
      <View style={{ padding: 16, gap: 4 }}>
        <Text style={{ color: colors.onMedia, fontWeight: font.heading, fontSize: 16 }}>{v.camera_name}</Text>
        <Muted style={styles.meta}>
          {formatDuration(v.duration_ms)} · {formatBytes(v.size)} · {v.resolution} · {v.fps} fps · {v.codec}
        </Muted>
        <Muted style={styles.meta}>
          {formatDateTime(v.recorded_at || v.created_at)} · {v.session_id ? `Phiên ${v.session_id}` : 'Quay lẻ'}
        </Muted>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.media },
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: colors.media },
  meta: { color: colors.onMediaMuted, fontVariant: font.tabular },
});
