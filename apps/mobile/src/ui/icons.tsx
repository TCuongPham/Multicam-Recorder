import React from 'react';
import Svg, { Circle, Ellipse, Path, Rect } from 'react-native-svg';
import { colors } from './theme';

export type IconName =
  | 'refresh'
  | 'flip'
  | 'battery'
  | 'bolt'
  | 'storage'
  | 'camera'
  | 'trash'
  | 'download'
  | 'check'
  | 'x'
  | 'chevron-left'
  | 'chevron-right'
  | 'user'
  | 'logout'
  | 'settings'
  | 'video'
  | 'library'
  | 'grid'
  | 'lock'
  | 'qr'
  | 'key'
  | 'maximize'
  | 'select-all';

/** Bộ biểu tượng nét mảnh (viewBox 24, nét 1.75). */
export function Icon({
  name,
  size = 18,
  color = colors.text,
  strokeWidth = 1.75,
  level,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  /** Chỉ dùng cho `battery`: 0–100 để vẽ mức pin. */
  level?: number | null;
}) {
  const s = { stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  let body: React.ReactNode;
  switch (name) {
    case 'refresh':
      body = (
        <>
          <Path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.5" {...s} />
          <Path d="M20 3.5v5h-5" {...s} />
        </>
      );
      break;
    case 'flip':
      body = (
        <>
          <Path d="M4 11a8 8 0 0 1 14-4.5L20 8.5" {...s} />
          <Path d="M20 3.5v5h-5" {...s} />
          <Path d="M20 13a8 8 0 0 1-14 4.5L4 15.5" {...s} />
          <Path d="M4 20.5v-5h5" {...s} />
        </>
      );
      break;
    case 'battery': {
      const pct = level == null ? null : Math.max(0, Math.min(100, level));
      body = (
        <>
          <Rect x={2.5} y={7} width={17} height={10} rx={2.5} {...s} />
          <Path d="M22 10.5v3" {...s} />
          {pct !== null && pct > 0 ? (
            <Rect x={4.75} y={9.25} width={Math.max(1, (12.5 * pct) / 100)} height={5.5} rx={1} fill={color} />
          ) : null}
        </>
      );
      break;
    }
    case 'bolt':
      body = <Path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3z" {...s} />;
      break;
    case 'storage':
      body = (
        <>
          <Ellipse cx={12} cy={5.5} rx={7.5} ry={2.75} {...s} />
          <Path d="M4.5 5.5v13c0 1.52 3.36 2.75 7.5 2.75s7.5-1.23 7.5-2.75v-13" {...s} />
          <Path d="M4.5 12c0 1.52 3.36 2.75 7.5 2.75s7.5-1.23 7.5-2.75" {...s} />
        </>
      );
      break;
    case 'camera':
      body = (
        <>
          <Path d="M3 8.5A2 2 0 0 1 5 6.5h2.2l1.6-2h6.4l1.6 2H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.5z" {...s} />
          <Circle cx={12} cy={13} r={3.5} {...s} />
        </>
      );
      break;
    case 'trash':
      body = (
        <>
          <Path d="M4 7h16" {...s} />
          <Path d="M9 7V4.5h6V7" {...s} />
          <Path d="M6.5 7l.9 12.1a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9L17.5 7" {...s} />
          <Path d="M10 11v6M14 11v6" {...s} />
        </>
      );
      break;
    case 'download':
      body = (
        <>
          <Path d="M12 4v11" {...s} />
          <Path d="M7 10.5l5 5 5-5" {...s} />
          <Path d="M5 20h14" {...s} />
        </>
      );
      break;
    case 'check':
      body = <Path d="M5 12.5l4.5 4.5L19 7.5" {...s} />;
      break;
    case 'x':
      body = <Path d="M6.5 6.5l11 11M17.5 6.5l-11 11" {...s} />;
      break;
    case 'chevron-left':
      body = <Path d="M14.5 6l-6 6 6 6" {...s} />;
      break;
    case 'chevron-right':
      body = <Path d="M9.5 6l6 6-6 6" {...s} />;
      break;
    case 'user':
      body = (
        <>
          <Circle cx={12} cy={8} r={4} {...s} />
          <Path d="M4.5 20.5c.6-3.7 3.7-6 7.5-6s6.9 2.3 7.5 6" {...s} />
        </>
      );
      break;
    case 'logout':
      body = (
        <>
          <Path d="M9.5 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.5" {...s} />
          <Path d="M15.5 16.5L20 12l-4.5-4.5" {...s} />
          <Path d="M20 12H9.5" {...s} />
        </>
      );
      break;
    case 'settings':
      body = (
        <>
          <Path d="M4 7h9M17 7h3M4 17h3M11 17h9" {...s} />
          <Circle cx={15} cy={7} r={2} {...s} />
          <Circle cx={9} cy={17} r={2} {...s} />
        </>
      );
      break;
    case 'video':
      body = (
        <>
          <Rect x={2.5} y={6} width={13} height={12} rx={2.5} {...s} />
          <Path d="M15.5 10.2l6-3.2v10l-6-3.2z" {...s} />
        </>
      );
      break;
    case 'library':
      body = (
        <>
          <Rect x={3} y={7} width={18} height={13} rx={2.5} {...s} />
          <Path d="M6 4h12" {...s} />
          <Path d="M10.5 11v5l4-2.5-4-2.5z" {...s} />
        </>
      );
      break;
    case 'grid':
      body = (
        <>
          <Rect x={3.5} y={3.5} width={7} height={7} rx={1.75} {...s} />
          <Rect x={13.5} y={3.5} width={7} height={7} rx={1.75} {...s} />
          <Rect x={3.5} y={13.5} width={7} height={7} rx={1.75} {...s} />
          <Rect x={13.5} y={13.5} width={7} height={7} rx={1.75} {...s} />
        </>
      );
      break;
    case 'lock':
      body = (
        <>
          <Rect x={5} y={10.5} width={14} height={10} rx={2.5} {...s} />
          <Path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" {...s} />
        </>
      );
      break;
    case 'qr':
      body = (
        <>
          <Rect x={4} y={4} width={6} height={6} rx={1} {...s} />
          <Rect x={14} y={4} width={6} height={6} rx={1} {...s} />
          <Rect x={4} y={14} width={6} height={6} rx={1} {...s} />
          <Path d="M14 14h2v2M20 14v.01M14 20h.01M17 17h3v3h-3z" {...s} />
        </>
      );
      break;
    case 'key':
      body = (
        <>
          <Circle cx={8} cy={15} r={4} {...s} />
          <Path d="M11 12l8.5-8.5M16.5 6.5l2.5 2.5M14 9l2 2" {...s} />
        </>
      );
      break;
    case 'maximize':
      body = <Path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" {...s} />;
      break;
    case 'select-all':
      body = (
        <>
          <Rect x={3.5} y={3.5} width={17} height={17} rx={3} {...s} />
          <Path d="M8 12.3l2.8 2.7L16 9.5" {...s} />
        </>
      );
      break;
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {body}
    </Svg>
  );
}

/** Logo: chỉ tam giác phát bo góc, tô màu accent (nét cùng màu + góc tròn làm mềm đỉnh). */
export function Logo({ size, width }: { size?: number; /** Tên cũ của `size`. */ width?: number }) {
  const s = size ?? width ?? 18;
  return (
    <Svg width={s} height={s} viewBox="0 0 18 18">
      <Path d="M5 3.25v11.5L15 9z" fill={colors.accent} stroke={colors.accent} strokeWidth={2.25} strokeLinejoin="round" />
    </Svg>
  );
}
