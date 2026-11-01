import React, { type ReactNode } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from './theme';

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
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.row, selected && styles.selected, pressed && { opacity: 0.85 }]}
    >
      {selecting ? (
        <View style={[styles.check, selected && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
          {selected ? <Text style={{ color: '#fff', fontWeight: '800' }}>✓</Text> : null}
        </View>
      ) : null}
      <View style={styles.thumbBox}>
        {thumbnail ? <Image source={{ uri: thumbnail }} style={styles.thumb} resizeMode="cover" /> : <Text style={{ fontSize: 22 }}>🎞️</Text>}
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
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  selected: { borderColor: colors.primary, borderWidth: 2 },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbBox: {
    width: 96,
    height: 54,
    borderRadius: radius.sm,
    backgroundColor: colors.dark,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumb: { width: '100%', height: '100%' },
  title: { fontSize: 15, fontWeight: '700', color: colors.text },
  sub: { fontSize: 12, color: colors.muted },
});
