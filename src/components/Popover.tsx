// 多分区参数弹层（哩布风格）：内容按模型 sections 声明渲染，不同模型呈现不同分区。
// 支持 segmented 分段（质量/张数）、比例网格（迷你矩形缩略图）、W/H 自定义尺寸（锁定联动）、时长刻度 slider。
// 基于 shadcn/Radix Popover：焦点管理、外点关闭、Esc 均由 Radix 处理。
// open 受控，trigger 由调用方传入（asChild 包裹）；面板内选择不自动关闭，方便连续调整。

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "../lib/utils";
import {
  aspectToSize,
  batchCap,
  defaultSections,
  parseSizePx,
  pixelBounds,
  type ModelDef,
  type ParamSectionDef,
} from "../models/registry";
import type { StudioApi } from "../studios/useStudio";

const SIZE_MIN = 512;
const SIZE_MAX = 4096; // 单边输入上限；合规性以官方总像素区间（volcarkPixelBounds）为准
const SIZE_STEP = 8;

interface ParamPanelProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  trigger: ReactNode;
  model: ModelDef;
  api: StudioApi;
}

export function ParamPanel({ open, onOpenChange, trigger, model, api }: ParamPanelProps) {
  const sections = model.sections ?? defaultSections(model);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-[min(348px,80dvw)] max-h-[40dvh] min-w-[250px] overflow-y-auto rounded-lg border border-border-3 bg-overlay p-3.5 shadow-[0_10px_40px_var(--shadow-lg)] backdrop-blur-[24px] animate-[fadeInUp_.2s]"
      >
        <div className="flex flex-col gap-5">
          {sections.map((s) => (
            <Section key={s.key} section={s} model={model} api={api} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============ 分区渲染 ============

function Section({ section, model, api }: { section: ParamSectionDef; model: ModelDef; api: StudioApi }) {
  const { t } = useTranslation();
  return (
    <div>
      <h3 className="mb-2 text-[13px] font-medium text-foreground">{t(section.title)}</h3>
      {section.type === "segmented" && (
        <SegmentedRow
          options={
            section.options ??
            (section.key === "batch"
              ? batchOptions(model, api.mode)
              : section.key === "mode"
                ? ["single", "group"]
                : model.qualities)
          }
          current={
            section.key === "batch"
              ? String(api.batch)
              : section.key === "mode"
                ? api.mode
                : api.quality
          }
          onSelect={(v) =>
            section.key === "batch"
              ? api.setBatch(Number(v))
              : section.key === "mode"
                ? api.setMode(v as "single" | "group")
                : api.setQuality(v)
          }
          labelOf={(v) => (section.i18n ? t(v) : v)}
        />
      )}
      {section.type === "ratio" && <RatioSection section={section} model={model} api={api} />}
      {section.type === "size" && <SizeRow model={model} api={api} />}
      {section.type === "param" && <ParamRow section={section} api={api} />}
      {section.type === "duration" && <DurationSection model={model} api={api} />}
    </div>
  );
}

function batchOptions(m: ModelDef, mode?: string): string[] {
  const cap = batchCap(m, mode === "group" ? "group" : "single");
  return Array.from({ length: cap }, (_, i) => String(i + 1));
}

/** "3:4" → 迷你矩形像素（最长边 16px）；非 x:y 格式（如 1024x1024）回退方形。 */
function ratioBox(ratio: string): { w: number; h: number } {
  const m = /^(\d+):(\d+)$/.exec(ratio);
  if (!m) return { w: 12, h: 12 };
  const a = Number(m[1]);
  const b = Number(m[2]);
  const s = 16 / Math.max(a, b);
  return { w: Math.max(3, Math.round(a * s)), h: Math.max(3, Math.round(b * s)) };
}

// —— segmented 分段切换（模式 / 质量 / 张数） ——
function SegmentedRow({
  options,
  current,
  onSelect,
  labelOf,
}: {
  options: string[];
  current: string;
  onSelect: (v: string) => void;
  labelOf: (v: string) => string;
}) {
  return (
    <div className="flex w-full gap-1 rounded-lg bg-soft p-[2px]">
      {options.map((v) => {
        const sel = current === v;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onSelect(v)}
            className={cn(
              "flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1 rounded-md px-1 py-2 text-xs font-medium transition-all duration-[120ms]",
              sel ? "bg-accent text-black" : "text-text-3 hover:bg-hover hover:text-foreground",
            )}
          >
            <span className="truncate">{labelOf(v)}</span>
          </button>
        );
      })}
    </div>
  );
}

// —— 比例网格（迷你矩形缩略图，可选 W/H 自定义尺寸） ——
function RatioSection({
  section,
  model,
  api,
}: {
  section: Extract<ParamSectionDef, { type: "ratio" }>;
  model: ModelDef;
  api: StudioApi;
}) {
  const options = section.options ?? model.aspectRatios;
  return (
    <>
      <div className="flex w-full flex-wrap gap-1 rounded-lg bg-soft p-[2px]">
        {options.map((v) => {
          const sel = api.ar === v;
          const box = ratioBox(v);
          return (
            <button
              key={v}
              type="button"
              onClick={() => api.setAr(v)}
              className={cn(
                "flex flex-1 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md py-2 transition-all duration-[120ms]",
                sel ? "bg-accent text-black" : "text-text-3 hover:bg-hover hover:text-foreground",
              )}
            >
              <span
                className={cn("block rounded-[2px] border", sel ? "border-black/40" : "border-current opacity-60")}
                style={{ width: box.w, height: box.h }}
              />
              <span className="text-xs leading-none">{v}</span>
            </button>
          );
        })}
      </div>
      {section.size && <SizeRow model={model} api={api} />}
    </>
  );
}

// —— W/H 自定义尺寸（基准随画质档位，锁定比例联动；合规性按官方总像素区间） ——
function SizeRow({ model, api }: { model: ModelDef; api: StudioApi }) {
  const base = api.size ?? parseSizePx(aspectToSize(model.providerId, model.id, api.ar, api.quality));
  const locked = api.sizeLocked;
  const bounds = pixelBounds(model);

  const clamp = (v: number) =>
    Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(v / SIZE_STEP) * SIZE_STEP));

  /** 总像素越界（官方区间）时拒绝提交，保持原值。 */
  const commit = (w: number, h: number) => {
    const px = w * h;
    if (px < bounds.min || px > bounds.max) return;
    api.setSize(w, h);
  };

  const commitW = (raw: string) => {
    const w = clamp(Number(raw) || base.w);
    commit(w, locked ? clamp(Math.round((w * base.h) / base.w)) : base.h);
  };
  const commitH = (raw: string) => {
    const h = clamp(Number(raw) || base.h);
    commit(locked ? clamp(Math.round((h * base.w) / base.h)) : base.w, h);
  };

  return (
    <div className="mt-2 flex items-center gap-2">
      <NumberBox label="W" value={base.w} onCommit={commitW} />
      <button
        type="button"
        onClick={() => api.setSizeLocked(!locked)}
        title={locked ? "解除锁定" : "锁定比例"}
        className={cn(
          "grid size-9 shrink-0 cursor-pointer place-items-center rounded-md transition-all duration-150",
          locked ? "bg-accent text-black" : "bg-soft text-text-3 hover:bg-hover hover:text-foreground",
        )}
      >
        {locked ? <LockIcon /> : <UnlockIcon />}
      </button>
      <NumberBox label="H" value={base.h} onCommit={commitH} />
    </div>
  );
}

function NumberBox({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (raw: string) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const submit = () => onCommit(text);
  return (
    <div className="flex h-9 min-w-0 flex-1 items-center gap-1 rounded-lg bg-soft px-2.5">
      <span className="w-3 shrink-0 text-xs text-faint">{label}</span>
      <input
        className="min-w-0 flex-1 border-0 bg-transparent py-1 text-xs font-medium text-foreground outline-none"
        type="text"
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={submit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            submit();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <div className="flex shrink-0 flex-col">
        <button
          type="button"
          aria-label="+"
          className="grid h-3.5 w-4 cursor-pointer place-items-center rounded-sm text-faint hover:bg-hover hover:text-foreground"
          onClick={() => onCommit(String(value + SIZE_STEP))}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round">
            <polyline points="6 15 12 9 18 15" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="−"
          className="grid h-3.5 w-4 cursor-pointer place-items-center rounded-sm text-faint hover:bg-hover hover:text-foreground"
          onClick={() => onCommit(String(value - SIZE_STEP))}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// —— 自定义厂商自由参数（popover 运行时调整，提交覆盖 params 默认） ——
function ParamRow({
  section,
  api,
}: {
  section: Extract<ParamSectionDef, { type: "param" }>;
  api: StudioApi;
}) {
  const v = api.paramValues[section.key] ?? section.def ?? "";
  return (
    <div className="flex h-9 items-center gap-2 rounded-lg bg-soft px-2.5">
      <span className="w-[88px] shrink-0 truncate text-xs font-semibold text-text-2">{section.title}</span>
      <input
        className="min-w-0 flex-1 border-0 bg-transparent py-1 text-xs font-medium text-foreground outline-none"
        type={section.kind === "number" ? "number" : "text"}
        value={v}
        onChange={(e) => api.setParamValue(section.key, e.target.value)}
      />
    </div>
  );
}

// —— 时长：刻度 slider + 数值输入联动（哩布 seedance 样式） ——
function DurationSection({ model, api }: { model: ModelDef; api: StudioApi }) {
  const { t } = useTranslation();
  const durations = model.durations ?? ["5", "10"];
  const idx = Math.max(0, durations.indexOf(api.duration));
  const pos = durations.length > 1 ? idx / (durations.length - 1) : 0;
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const pick = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const i = Math.round(ratio * (durations.length - 1));
    api.setDuration(durations[i]);
  };

  const commitText = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    api.setDuration(durations.reduce((a, b) => (Math.abs(Number(b) - n) < Math.abs(Number(a) - n) ? b : a)));
  };

  return (
    <div className="flex items-center gap-3">
      <div
        ref={trackRef}
        className="relative h-1.5 flex-1 cursor-pointer rounded-full bg-soft"
        onPointerDown={(e) => {
          dragging.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          pick(e.clientX);
        }}
        onPointerMove={(e) => dragging.current && pick(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent"
          style={{ width: `${pos * 100}%` }}
        />
        <div
          className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_0_3px_var(--overlay),0_2px_8px_rgba(0,0,0,.5)]"
          style={{ left: `${pos * 100}%` }}
        />
      </div>
      <div className="flex h-9 w-[96px] shrink-0 items-center justify-center gap-0.5 rounded-lg bg-soft px-2">
        <input
          className="min-w-0 flex-1 border-0 bg-transparent py-1 text-center text-xs font-semibold text-foreground outline-none"
          type="text"
          inputMode="decimal"
          value={api.duration}
          onChange={(e) => {
            const v = e.target.value.replace(/[^\d.]/g, "");
            if (Number.isFinite(Number(v))) api.setDuration(v);
          }}
          onBlur={(e) => commitText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitText((e.target as HTMLInputElement).value);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <span className="shrink-0 text-xs text-faint">{t("prompt.seconds")}</span>
      </div>
    </div>
  );
}

function LockIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </svg>
  );
}

function UnlockIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 017.5-1.5" />
    </svg>
  );
}
