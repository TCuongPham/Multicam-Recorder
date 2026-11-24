import React, { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { Icon, type IconName } from './icons';
import { colors, font, radius, spacing } from './theme';

export { Icon, Logo, type IconName } from './icons';

// ---------------------------------------------------------------------------
// Nhấn: mọi nút thu nhỏ còn 0.97 trong ~120 ms
// ---------------------------------------------------------------------------

const PRESS_MS = 120;

/** Pressable có phản hồi thu nhỏ khi nhấn (dùng cho mọi nút). */
export function PressableScale({
  children,
  style,
  disabled,
  onPressIn,
  onPressOut,
  ...props
}: Omit<PressableProps, 'style' | 'children'> & { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number) => Animated.timing(scale, { toValue: v, duration: PRESS_MS, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  // Style (kể cả flex/margin) và transform cùng nằm trên Pressable để bố cục không đổi.
  return (
    <AnimatedPressable
      {...props}
      disabled={disabled}
      onPressIn={(e) => {
        to(0.97);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        to(1);
        onPressOut?.(e);
      }}
      style={[style, { transform: [{ scale }] }]}
    >
      {children}
    </AnimatedPressable>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Biểu tượng quay 180° mỗi lần `turns` tăng (nút lật camera). */
export function RotatingIcon({ name, turns, size = 18, color }: { name: IconName; turns: number; size?: number; color?: string }) {
  const v = useRef(new Animated.Value(turns)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: turns, duration: 320, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }).start();
  }, [turns, v]);
  const rotate = v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Icon name={name} size={size} color={color} />
    </Animated.View>
  );
}

/** Biểu tượng xoay tròn liên tục khi `spinning` (nút làm mới: 360° / 600 ms). */
export function SpinningIcon({ name = 'refresh', spinning, size = 18, color }: { name?: IconName; spinning: boolean; size?: number; color?: string }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!spinning) return;
    v.setValue(0);
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 600, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => {
      loop.stop();
      Animated.timing(v, { toValue: 1, duration: 200, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(() => v.setValue(0));
    };
  }, [spinning, v]);
  const rotate = v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Icon name={name} size={size} color={color} />
    </Animated.View>
  );
}

/** Chấm đỏ nhấp nháy — chỉ dùng làm dấu hiệu đang quay. */
export function RecDot({ size = 8, color = colors.rec }: { size?: number; color?: string }) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.25, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(v, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: v }} />;
}

// ---------------------------------------------------------------------------
// Bố cục
// ---------------------------------------------------------------------------

/** Cuộn để ô đang nhập không bị bàn phím che (Screen cung cấp, Field gọi khi được focus). */
const RevealInputContext = createContext<(() => void) | null>(null);

/** Mép trên bàn phím (tọa độ màn hình), null khi bàn phím đóng. */
export function useKeyboardTop(): number | null {
  const [top, setTop] = useState<number | null>(null);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) => setTop(e.endCoordinates.screenY));
    const hide = Keyboard.addListener(hideEvt, () => setTop(null));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return top;
}

/**
 * Bàn phím: KeyboardAvoidingView 'padding' trên cả iOS lẫn Android. Từ Android 15 / Expo SDK 54 ứng dụng chạy
 * edge-to-edge nên cửa sổ không còn tự co lại (adjustResize) khi bàn phím mở → phải tự chừa chỗ.
 * KAV chỉ đệm đúng phần bị bàn phím đè lên nên vẫn đúng ở máy cũ có co cửa sổ.
 */
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
  const scrollRef = useRef<ScrollView>(null);
  const offsetY = useRef(0);
  const keyboardTop = useKeyboardTop();
  const keyboardTopRef = useRef(keyboardTop);
  keyboardTopRef.current = keyboardTop;

  const reveal = useCallback(() => {
    const kbTop = keyboardTopRef.current;
    const input = TextInput.State.currentlyFocusedInput();
    if (kbTop === null || !input || !scrollRef.current) return;
    input.measureInWindow((_x, y, _w, h) => {
      const overlap = y + h + spacing.xl - kbTop; // chừa thêm chỗ cho dòng lỗi / gợi ý dưới ô
      if (overlap > 0) scrollRef.current?.scrollTo({ y: offsetY.current + overlap, animated: true });
    });
  }, []);

  // Bàn phím vừa mở: chờ KAV đệm xong rồi cuộn tới ô đang nhập.
  useEffect(() => {
    if (keyboardTop === null) return;
    const t = setTimeout(reveal, Platform.OS === 'ios' ? 280 : 80);
    return () => clearTimeout(t);
  }, [keyboardTop, reveal]);

  return (
    <SafeAreaView style={[styles.screen, style]} edges={edges}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {scroll ? (
          <RevealInputContext.Provider value={reveal}>
            <ScrollView
              ref={scrollRef}
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              scrollEventThrottle={32}
              onScroll={(e) => {
                offsetY.current = e.nativeEvent.contentOffset.y;
              }}
            >
              {children}
            </ScrollView>
          </RevealInputContext.Provider>
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

export function SectionTitle({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.section, style]}>{children}</Text>;
}

export function Muted({ children, style, numberOfLines }: { children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  return (
    <Text style={[styles.muted, style]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }, style]}>{children}</View>;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

// ---------------------------------------------------------------------------
// Nút
// ---------------------------------------------------------------------------

/**
 * Nút dạng viên (Material 3): primary = tô accent · tonal = nền accentSoft, chữ accent ·
 * secondary = nền surface2 · danger = tô màu nguy hiểm · ghost = chỉ chữ.
 */
type ButtonVariant = 'primary' | 'tonal' | 'secondary' | 'danger' | 'ghost';

function variantColors(variant: ButtonVariant) {
  switch (variant) {
    case 'primary':
      return { bg: colors.accent, fg: colors.accentInk };
    case 'tonal':
      return { bg: colors.accentSoft, fg: colors.accent };
    case 'danger':
      return { bg: colors.danger, fg: colors.dangerInk };
    case 'secondary':
      return { bg: colors.surface2, fg: colors.text };
    default:
      return { bg: 'transparent', fg: colors.accent };
  }
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
  small,
  icon,
  iconNode,
  accessibilityLabel,
  textColor,
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
  icon?: IconName;
  /** Biểu tượng tùy biến (vd. biểu tượng có hiệu ứng xoay). */
  iconNode?: ReactNode;
  accessibilityLabel?: string;
  /** Đổi màu chữ/biểu tượng (vd. nút ghost màu nguy hiểm). */
  textColor?: string;
}) {
  const isDisabled = disabled || loading;
  const v = variantColors(variant);
  const c = textColor ? { ...v, fg: textColor } : v;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!isDisabled }}
      onPress={onPress}
      disabled={isDisabled}
      style={[
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: c.bg, opacity: isDisabled ? 0.45 : 1 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={c.fg} size="small" />
      ) : (
        <View style={styles.buttonInner}>
          {iconNode ?? (icon ? <Icon name={icon} size={small ? 16 : 18} color={c.fg} /> : null)}
          {title ? <Text style={[styles.buttonText, small && styles.buttonTextSmall, { color: c.fg }]}>{title}</Text> : null}
        </View>
      )}
    </PressableScale>
  );
}

/** Nút tròn chỉ có biểu tượng. */
export function IconButton({
  icon,
  iconNode,
  onPress,
  disabled,
  label,
  size = 36,
  style,
  color = colors.text,
}: {
  icon?: IconName;
  iconNode?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  label: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
  color?: string;
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={[styles.iconButton, { width: size, height: size, opacity: disabled ? 0.45 : 1 }, style]}
    >
      {iconNode ?? (icon ? <Icon name={icon} size={18} color={color} /> : null)}
    </PressableScale>
  );
}

// ---------------------------------------------------------------------------
// Nhập liệu
// ---------------------------------------------------------------------------

/** Ô nhập nền surface2, không viền; viền accent 2 px khi đang nhập, viền đỏ khi lỗi. */
export function Field({
  label,
  error,
  hint,
  style,
  onFocus,
  onBlur,
  ...props
}: TextInputProps & { label: string; error?: string | null; hint?: string | null; style?: StyleProp<ViewStyle> }) {
  const [focused, setFocused] = useState(false);
  const reveal = useContext(RevealInputContext);
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        cursorColor={colors.accent}
        autoCorrect={false}
        {...props}
        onFocus={(e) => {
          setFocused(true);
          // Chuyển sang ô khác khi bàn phím đang mở: cuộn ô mới lên trên bàn phím.
          if (reveal) setTimeout(reveal, 120);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        style={[
          styles.input,
          focused && { borderColor: colors.accent },
          error ? { borderColor: colors.danger } : null,
          props.editable === false && { opacity: 0.6 },
        ]}
      />
      {error ? <Text style={styles.fieldError}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function CheckMark({ checked, round }: { checked: boolean; round?: boolean }) {
  return (
    <View style={[styles.checkbox, round && { borderRadius: radius.pill }, checked && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
      {checked ? <Icon name="check" size={14} color={colors.accentInk} strokeWidth={2.5} /> : null}
    </View>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={() => onChange(!checked)} style={styles.checkboxRow}>
      <CheckMark checked={checked} />
      <Text style={{ flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 }}>{label}</Text>
    </Pressable>
  );
}

/** Nhóm lựa chọn dạng viên (độ phân giải, FPS...). */
export function Chips<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <Row style={{ flexWrap: 'wrap' }}>
      {options.map((o) => {
        const active = o === value;
        return (
          <PressableScale
            key={String(o)}
            disabled={disabled}
            onPress={() => onChange(o)}
            style={[styles.chip, active && styles.chipActive, disabled && { opacity: 0.45 }]}
          >
            <Text style={[styles.chipText, active && { color: colors.accent }]}>{String(o)}</Text>
          </PressableScale>
        );
      })}
    </Row>
  );
}

/** Thanh chọn hai/ba mục dạng viên (Trên máy / Đã tải lên). */
export function Segmented<K extends string>({
  items,
  value,
  onChange,
  style,
}: {
  items: readonly (readonly [K, string])[];
  value: K;
  onChange: (k: K) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.segment, style]}>
      {items.map(([key, label]) => {
        const active = key === value;
        return (
          <Pressable key={key} onPress={() => onChange(key)} style={[styles.segItem, active && styles.segActive]}>
            <Text style={{ color: active ? colors.accent : colors.muted, fontWeight: font.medium, fontSize: 14 }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Hiển thị trạng thái
// ---------------------------------------------------------------------------

export function ProgressBar({ percent, color = colors.accent, height = 4 }: { percent: number; color?: string; height?: number }) {
  const p = Math.max(0, Math.min(100, percent || 0));
  return (
    <View style={[styles.progressTrack, { height, borderRadius: height }]}>
      <View style={{ width: `${p}%`, height, backgroundColor: color, borderRadius: height }} />
    </View>
  );
}

type BannerKind = 'danger' | 'warning' | 'success' | 'info';
const BANNER: Record<BannerKind, { fg: string; bg: string }> = {
  danger: { fg: colors.danger, bg: colors.dangerBg },
  warning: { fg: colors.warning, bg: colors.warningBg },
  success: { fg: colors.success, bg: colors.successBg },
  info: { fg: colors.text, bg: colors.surface2 },
};

export function Banner({ kind = 'info', children, style }: { kind?: BannerKind; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = BANNER[kind];
  return (
    <View style={[styles.banner, { backgroundColor: c.bg }, style]}>
      {typeof children === 'string' ? <Text style={{ color: c.fg, fontSize: 13, lineHeight: 18 }}>{children}</Text> : children}
    </View>
  );
}

export function Badge({ text, color = colors.muted, bg = colors.surface2, icon }: { text: string; color?: string; bg?: string; icon?: IconName }) {
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      {icon ? <Icon name={icon} size={12} color={color} strokeWidth={2.25} /> : null}
      <Text style={{ color, fontSize: 11, fontWeight: font.medium }}>{text}</Text>
    </View>
  );
}

/** Một thông số nhỏ có biểu tượng (pin, bộ nhớ...). */
export function Stat({ icon, text, color = colors.muted, level }: { icon: IconName; text: string; color?: string; level?: number | null }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Icon name={icon} size={14} color={color} level={level} />
      <Text style={{ color, fontSize: 12, fontVariant: font.tabular }}>{text}</Text>
    </View>
  );
}

export function Empty({ text, sub }: { text: string; sub?: string }) {
  return (
    <View style={{ padding: spacing.xl, alignItems: 'center', gap: spacing.xs }}>
      <Text style={sub ? styles.emptyTitle : styles.muted}>{text}</Text>
      {sub ? <Text style={styles.muted}>{sub}</Text> : null}
    </View>
  );
}

export function Loading() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.bg }}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scrollContent: { padding: spacing.lg, gap: spacing.md, flexGrow: 1 },
  title: { fontSize: 24, fontWeight: font.heading, color: colors.text, letterSpacing: -0.2 },
  section: { fontSize: 16, fontWeight: font.heading, color: colors.text },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: font.medium },
  button: {
    minHeight: 44,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSmall: { minHeight: 36, paddingHorizontal: spacing.lg },
  buttonInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  buttonText: { fontSize: 15, fontWeight: font.medium },
  buttonTextSmall: { fontSize: 14, fontWeight: font.medium },
  iconButton: {
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface2,
  },
  field: { gap: 6 },
  label: { fontSize: 13, color: colors.muted, fontWeight: font.medium },
  input: {
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 12 : 8,
    fontSize: 15,
    color: colors.text,
  },
  fieldError: { color: colors.danger, fontSize: 12 },
  hint: { color: colors.muted, fontSize: 12 },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
  },
  chipActive: { backgroundColor: colors.accentSoft },
  chipText: { color: colors.text, fontWeight: font.medium, fontSize: 13, fontVariant: font.tabular },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surface2,
    borderRadius: radius.pill,
    padding: 4,
  },
  segItem: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm, borderRadius: radius.pill },
  segActive: { backgroundColor: colors.accentSoft },
  progressTrack: { backgroundColor: colors.surface3, overflow: 'hidden', width: '100%' },
  banner: { borderRadius: radius.md, padding: spacing.md },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
});
