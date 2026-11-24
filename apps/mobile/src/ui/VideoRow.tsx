import React, { type ReactNode } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { CheckMark, Icon, PressableScale } from './components';
import { colors, font, radius, spacing } from './theme';

export function VideoRow({
  thumbnail,
  title,
  subtitle,
  meta,
  right,
  selected,
  selecting,
  onPress,
  onLongPress,
  children,
}: {
  thumbnail: string | null;
  title: string;
  subtitle?: string;
  meta?: string;
  right?: ReactNode;
  selected?: boolean;
  selecting?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  children?: ReactNode;
}) {
  return (
    <PressableScale onPress={onPress} onLongPress={onLongPress} style={[styles.row, selected && styles.selected]}>
      {selecting ? <CheckMark checked={!!selected} round /> : null}
      <View style={styles.thumbBox}>
        {thumbnail ? (
          <Image source={{ uri: thumbnail }} style={styles.thumb} resizeMode="cover" />
        ) : (
          <Icon name="video" size={20} color={colors.muted} />
        )}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? <Text style={styles.sub}>{subtitle}</Text> : null}
        {meta ? <Text style={styles.sub}>{meta}</Text> : null}
        {children}
      </View>
      {right}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.sm,
  },
  selected: { backgroundColor: colors.accentSoft },
  thumbBox: {
    width: 96,
    height: 54,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumb: { width: '100%', height: '100%' },
  title: { fontSize: 15, fontWeight: font.heading, color: colors.text },
  sub: { fontSize: 12, color: colors.muted, fontVariant: font.tabular },
});
