import type { SVGProps } from 'react';

// Bộ icon nét mảnh (stroke 1.75, 24×24) — thay cho emoji để giao diện gọn và nhất quán.
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 18, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...rest,
  };
}

export const IconRefresh = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4" />
  </svg>
);
export const IconFlip = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 7h11a5 5 0 0 1 0 10H9" />
    <path d="M7 4 4 7l3 3" />
    <path d="M12 20l-3-3 3-3" />
  </svg>
);
export const IconBattery = (p: IconProps & { level?: number | null }) => {
  const { level, ...rest } = p;
  const w = Math.max(0, Math.min(1, (level ?? 0) / 100)) * 12;
  return (
    <svg {...base(rest)}>
      <rect x="2.5" y="7" width="17" height="10" rx="2.5" />
      <path d="M21.5 10.5v3" />
      {level !== null && level !== undefined ? <rect x="5" y="9.5" width={w} height="5" rx="1" fill="currentColor" stroke="none" /> : null}
    </svg>
  );
};
export const IconStorage = (p: IconProps) => (
  <svg {...base(p)}>
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
    <path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </svg>
);
export const IconCamera = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2.5" y="6.5" width="13" height="11" rx="2.5" />
    <path d="m15.5 10.5 6-3.5v10l-6-3.5" />
  </svg>
);
export const IconCameraOff = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M15.5 13v2a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 15V9A2.5 2.5 0 0 1 5 6.5h1.5M10 6.5h3A2.5 2.5 0 0 1 15.5 9v1.5l6-3.5v10" />
    <path d="M3 3l18 18" />
  </svg>
);
export const IconTrash = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </svg>
);
export const IconDownload = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </svg>
);
export const IconCheck = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
export const IconX = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
export const IconChevronLeft = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m15 6-6 6 6 6" />
  </svg>
);
export const IconChevronRight = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);
export const IconUserMinus = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 11h6" />
  </svg>
);
export const IconExpand = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </svg>
);
export const IconBolt = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z" />
  </svg>
);
export const IconSelectAll = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="m8 12 3 3 5-6" />
  </svg>
);
export const IconStop = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" />
  </svg>
);
export const IconLogout = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" />
  </svg>
);

/** Logo: tam giác "play" bo góc nằm ngang. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className="logo">
      <path d="M5 3.9v12.2a1.4 1.4 0 0 0 2.1 1.2l10.1-6.1a1.4 1.4 0 0 0 0-2.4L7.1 2.7A1.4 1.4 0 0 0 5 3.9Z" fill="var(--accent)" />
    </svg>
  );
}
