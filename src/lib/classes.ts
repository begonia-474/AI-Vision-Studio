// 共享工具类常量（由 global.css 手写组件样式迁移而来）

export const BTN =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border-2 bg-soft px-3.5 py-2 text-xs font-semibold text-text-2 transition-all duration-150 hover:border-primary hover:text-primary disabled:pointer-events-none disabled:opacity-50";
export const BTN_PRIMARY =
  BTN + " border-primary bg-primary text-black hover:border-primary hover:text-black";

export const MODAL =
  "w-full max-w-[480px] max-h-[85vh] overflow-y-auto rounded-lg border border-border-4 bg-card p-8 shadow-[0_20px_60px_var(--shadow-lg)]";
export const MDESC = "mt-0 mb-6 text-[13px] leading-relaxed text-muted-foreground";

export const BADGE = "rounded-full bg-soft px-2.5 py-1 text-[10px] font-semibold text-muted-foreground";
export const BADGE_OK = "bg-[rgba(34,197,94,.12)] text-success";
export const BADGE_WARN = "bg-[rgba(245,158,11,.12)] text-warn";
export const TAG = "rounded-full bg-soft px-2.5 py-1 text-[10px] text-muted-foreground";

export const SEG = "inline-flex overflow-hidden rounded-md border border-border-2 bg-chip";
export const SEG_BTN =
  "cursor-pointer border-0 bg-transparent px-3 py-1.5 text-[11px] font-semibold text-text-3 transition-all duration-150 data-[state=on]:bg-[rgba(59,130,246,.12)] data-[state=on]:text-primary disabled:cursor-not-allowed disabled:opacity-40";

export const G_CHIP =
  "inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full border border-border-2 bg-chip px-3 text-[11px] font-semibold text-text-3 transition-all duration-150 hover:bg-hover hover:text-foreground";
export const G_CHIP_ON =
  "border-[rgba(250,204,21,.30)] bg-[rgba(250,204,21,.10)] text-[#facc15] hover:border-[rgba(250,204,21,.30)] hover:bg-[rgba(250,204,21,.10)] hover:text-[#facc15]";

export const MODEL_TAG =
  "rounded-[6px] border border-[rgba(59,130,246,.20)] bg-[rgba(59,130,246,.10)] px-2 py-0.5 text-[10px] font-bold capitalize text-primary";
export const AR_TAG = "text-[10px] text-muted-foreground";

export const CM_BADGE =
  "ml-1.5 inline-block align-middle rounded-full bg-soft px-1.5 py-px text-[9px] font-bold text-muted-foreground";
export const CM_BADGE_ACCENT = "bg-accent text-primary";

export const PROVIDER_LOGO =
  "grid size-4 shrink-0 place-items-center rounded-[6px] text-[8px] font-extrabold text-black";
