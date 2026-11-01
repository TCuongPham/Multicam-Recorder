import React, { type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { colors, radius, spacing } from './theme';

export function Screen({
  children,
  scroll = true,
  edges = ['bottom', 'left', 'right'],
  style,
}: {
  children: ReactNode;
  scroll?: boolean;
  edges?: Edge[];
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <SafeAreaView style={[styles.screen, style]} edges={edges}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {scroll ? (
          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        ) : (
          <View style={{ flex: 1 }}>{children}</View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Title({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.title, style]}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
  small,
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
}) {
  const isDisabled = disabled || loading;
  const bg =
    variant === 'primary' ? colors.primary : variant === 'danger' ? colors.danger : variant === 'secondary' ? colors.card : 'transparent';
  const fg = variant === 'primary' || variant === 'danger' ? colors.primaryText : variant === 'secondary' ? colors.text : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: bg, opacity: isDisabled ? 0.5 : pressed ? 0.8 : 1 },
        variant === 'secondary' && { borderWidth: 1, borderColor: colors.border },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, small && { fontSize: 13 }, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({
  label,
  error,
  hint,
  style,
  ...props
}: TextInputProps & { label: string; error?: string | null; hint?: string | null; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        autoCorrect={false}
        {...props}
        style={[styles.input, error ? { borderColor: colors.danger } : null]}
      />
      {error ? <Text style={styles.fieldError}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={() => onChange(!checked)}
      style={styles.checkboxRow}
    >
      <View style={[styles.checkbox, checked && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
        {checked ? <Text style={{ color: '#fff', fontWeight: '700' }}>✓</Text> : null}
      </View>
      <Text style={{ flex: 1, color: colors.text }}>{label}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function ProgressBar({ percent, color = colors.primary, height = 6 }: { percent: number; color?: string; height?: number }) {
  const p = Math.max(0, Math.min(100, percent || 0));
  return (
    <View style={[styles.progressTrack, { height }]}>
      <View style={{ width: `${p}%`, height, backgroundColor: color, borderRadius: height }} />
    </View>
  );
}

type BannerKind = 'danger' | 'warning' | 'success' | 'info';
export function Banner({ kind = 'info', children, style }: { kind?: BannerKind; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const bg = kind === 'danger' ? colors.dangerBg : kind === 'warning' ? colors.warningBg : kind === 'success' ? colors.successBg : colors.infoBg;
  const fg = kind === 'danger' ? colors.danger : kind === 'warning' ? colors.warning : kind === 'success' ? colors.success : colors.primary;
  return (
    <View style={[styles.banner, { backgroundColor: bg }, style]}>
      {typeof children === 'string' ? <Text style={{ color: fg, fontWeight: '600' }}>{children}</Text> : children}
    </View>
  );
}

export function Badge({ text, color = colors.muted, bg = colors.border }: { text: string; color?: string; bg?: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={{ color, fontSize: 11, fontWeight: '600' }}>{text}</Text>
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <View style={{ padding: spacing.xl, alignItems: 'center' }}>
      <Text style={styles.muted}>{text}</Text>
    </View>
  );
}

export function Loading() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl }}>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }, style]}>{children}</View>;
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scrollContent: { padding: spacing.lg, gap: spacing.md, flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  muted: { color: colors.muted, fontSize: 13 },
  button: {
    minHeight: 46,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSmall: { minHeight: 34, paddingHorizontal: spacing.md, borderRadius: radius.sm },
  buttonText: { fontSize: 15, fontWeight: '600' },
  field: { gap: 4 },
  label: { fontSize: 13, color: colors.text, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 12 : 8,
    fontSize: 15,
    color: colors.text,
  },
  fieldError: { color: colors.danger, fontSize: 12 },
  hint: { color: colors.muted, fontSize: 12 },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  progressTrack: { backgroundColor: colors.border, borderRadius: 6, overflow: 'hidden', width: '100%' },
  banner: { borderRadius: radius.md, padding: spacing.md },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' },
});
