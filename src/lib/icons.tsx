// 共享 SVG 图标
// 统一风格：fill=none stroke=currentColor strokeWidth=2，size 由 props.size 控制
import type { CSSProperties } from "react";

interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

const base = (size: number): React.SVGProps<SVGSVGElement> => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
});

export const IconImage = ({ size = 18, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
  </svg>
);

export const IconVideo = ({ size = 18, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
  </svg>
);

export const IconKey = ({ size = 19, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </svg>
);

export const IconSettings = ({ size = 19, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export const IconChevron = ({ size = 10, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

// PromptAspectRatioIcon —— rect 18x14 rx=2
export const IconAspect = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
  </svg>
);

// PromptQualityIcon —— 钻石
export const IconQuality = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <path d="M6.5 3.5h11L22 9 12 21 2 9l4.5-5.5Z" />
  </svg>
);

// PromptDurationIcon —— 时钟
export const IconDuration = ({ size = 16, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" />
  </svg>
);

export const IconSearch = ({ size = 14, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

export const IconCheck = ({ size = 14, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style} stroke="#22d3ee">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const IconDownload = ({ size = 14, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

export const IconTrash = ({ size = 14, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

export const IconUpload = ({ size = 18, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

export const IconSparkles = ({ size = 14, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
  </svg>
);

export const IconSidebar = ({ size = 18, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /><path d="M14 9l-3 3 3 3" />
  </svg>
);

// All-providers 星形 tab
export const IconStar = ({ size = 16, className, style, filled = false }: IconProps & { filled?: boolean }) => (
  <svg {...base(size)} className={className} style={style} fill={filled ? "currentColor" : "none"}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

// 图库（书架）
export const IconLibrary = ({ size = 18, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <path d="m16 6 4 14" /><path d="M12 6v14" /><path d="M8 8v12" /><path d="M4 4v16" />
  </svg>
);

// 自定义厂商（盒子）
export const IconBox = ({ size = 18, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
    <line x1="12" y1="22.08" x2="12" y2="12" />
  </svg>
);

export const IconPlay = ({ size = 14, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

// 重新生成（rotate-cw）
export const IconRefresh = ({ size = 14, className, style }: IconProps) => (
  <svg {...base(size)} className={className} style={style}>
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
);
