import { Appearance } from 'react-native';

/**
 * Bảng màu kiểu NotebookLM (Google Material 3), dùng chung với bản web.
 * Tối là mặc định; máy đặt giao diện sáng thì dùng bảng sáng.
 * Bảng màu được chọn lúc khởi động ứng dụng (StyleSheet tạo ở phạm vi module),
 * đổi chế độ sáng/tối của hệ thống sẽ áp dụng ở lần mở ứng dụng kế tiếp.
 */
const dark = {
  bg: '#131314',
  surface: '#1E1F20',
  surface2: '#282A2C',
  surface3: '#333537',
  border: '#3C4043',
  text: '#E3E3E3',
  muted: '#9AA0A6',
  accent: '#A8C7FA',
  /** Chữ trên nền accent. */
  accentInk: '#062E6F',
  accentSoft: 'rgba(168,199,250,0.14)',
  /** Nền chấm / nhãn REC. */
  rec: '#EE675C',
  /** Chữ báo lỗi / thao tác nguy hiểm. */
  danger: '#F28B82',
  /** Chữ trên nền danger. */
  dangerInk: '#601410',
  warning: '#FDD663',
  success: '#81C995',
};

const light: typeof dark = {
  bg: '#FFFFFF',
  surface: '#F0F4F9',
  surface2: '#E9EEF6',
  surface3: '#DDE3EA',
  border: '#DDE3EA',
  text: '#1F1F1F',
  muted: '#5F6368',
  accent: '#0B57D0',
  accentInk: '#FFFFFF',
  accentSoft: '#D3E3FD',
  rec: '#D93025',
  danger: '#D93025',
  dangerInk: '#FFFFFF',
  warning: '#B06000',
  success: '#188038',
};

export type ColorScheme = 'light' | 'dark';
export const scheme: ColorScheme = Appearance.getColorScheme() === 'light' ? 'light' : 'dark';
const p = scheme === 'light' ? light : dark;

/** Màu nền nhạt cho nhãn/biểu ngữ: cùng tông, độ phủ thấp (không gradient, không phát sáng). */
const tint = (hex: string, alpha: number) =>
  `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`;

export const colors = {
  ...p,
  // Tên cũ giữ lại để các màn hình hiện có dùng tiếp.
  accentText: p.accentInk,
  card: p.surface,
  primary: p.accent,
  primaryText: p.accentInk,
  recording: p.rec,
  dark: p.surface2,
  dangerBg: tint(p.danger, scheme === 'dark' ? 0.14 : 0.08),
  successBg: tint(p.success, scheme === 'dark' ? 0.14 : 0.1),
  warningBg: tint(p.warning, scheme === 'dark' ? 0.14 : 0.1),
  infoBg: p.accentSoft,
  /** Lớp phủ trên khung hình camera (luôn tối để chữ trắng dễ đọc). */
  overlay: 'rgba(19,19,20,0.62)',
  backdrop: scheme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(31,31,31,0.4)',
  onMedia: '#FFFFFF',
  onMediaMuted: 'rgba(255,255,255,0.72)',
  media: '#000000',
};

/** Lưới 8 pt (bước phụ 4 pt). */
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
/** sm: nhãn nhỏ · md: ô nhập · lg: ô/thẻ nhỏ · xl: thẻ · xxl: hộp thoại/sheet · pill: nút. */
export const radius = { sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, pill: 999 };
export const font = {
  heading: '600' as const,
  medium: '500' as const,
  tabular: ['tabular-nums'] as ('tabular-nums')[],
};
