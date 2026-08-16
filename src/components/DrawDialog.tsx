// Seedream 5.0 Pro 交互编辑画板（Draw v1）。
// 官方约定：归一化坐标范围 0..999，左上角 (0,0)、右下角 (999,999)；
// 点选生成 `<point>x y</point>`，框选生成 `<bbox>x1 y1 x2 y2</bbox>`。
// 本组件只生成坐标 token 并写回 prompt；参考图提交复用现有 refs 通路，后端无需改动。

import { useEffect, useRef, useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { toAssetUrl } from "../api";
import { cn, uid } from "../lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import type { StudioApi } from "../studios/useStudio";

interface DrawAnnotation {
  id: string;
  kind: "point" | "bbox";
  /** 标注所属参考图在 refs 中的下标（token 中显示为 图{index+1}） */
  imageIndex: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  token: string;
}

interface DrawDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  api: StudioApi;
}

const clamp1000 = (v: number) => Math.max(0, Math.min(999, Math.round(v)));

const refSrc = (r: string) =>
  r.startsWith("http") || r.startsWith("data:") ? r : toAssetUrl(r);

const imageLabel = (index: number) => `图${index + 1}`;

function pointToken(imageIndex: number, x: number, y: number) {
  return `${imageLabel(imageIndex)}<point>${x} ${y}</point>`;
}

function bboxToken(imageIndex: number, x1: number, y1: number, x2: number, y2: number) {
  return `${imageLabel(imageIndex)}<bbox>${x1} ${y1} ${x2} ${y2}</bbox>`;
}

export function DrawDialog({ open, onOpenChange, api }: DrawDialogProps) {
  const { t } = useTranslation();
  const [refIndex, setRefIndex] = useState(0);
  const [mode, setMode] = useState<"point" | "bbox">("bbox");
  const [annotations, setAnnotations] = useState<DrawAnnotation[]>([]);
  const [instruction, setInstruction] = useState("");
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [draft, setDraft] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    startClientX: number;
    startClientY: number;
    start: { x: number; y: number };
  } | null>(null);

  const refCount = api.refs.length;
  const currentRef = api.refs[refIndex];
  const canAddRef = refCount < Math.max(api.model.maxRef ?? 0, 1);

  // 打开时重置本次编辑上下文；参考图选择保持有界。
  useEffect(() => {
    if (open) {
      setAnnotations([]);
      setDraft(null);
      setInstruction("");
      setRefIndex((prev) => (refCount > 0 ? Math.min(prev, refCount - 1) : 0));
    }
    // refCount 仅用于打开瞬间收敛一次，不在编辑途中清空标注。
    // eslint 不在此项目启用；依赖保持打开状态单一触发。
  }, [open]);

  useEffect(() => {
    if (refCount > 0 && refIndex >= refCount) setRefIndex(refCount - 1);
  }, [refCount, refIndex]);

  // 切换参考图时重置自然尺寸，避免旧图宽高短暂参与新图坐标换算。
  useEffect(() => {
    setNatural({ w: 0, h: 0 });
  }, [refIndex]);

  // 画布容器尺寸（ResizeObserver），用于计算图片 contain 显示矩形。
  // Radix Dialog 关闭时内容不在 DOM；依赖 open 在每次打开后重新观察。
  useEffect(() => {
    if (!open) return;
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setStage({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [open]);

  const scale =
    natural.w > 0 && natural.h > 0 && stage.w > 0 && stage.h > 0
      ? Math.min(stage.w / natural.w, stage.h / natural.h)
      : 0;
  const display = {
    w: natural.w * scale,
    h: natural.h * scale,
    x: (stage.w - natural.w * scale) / 2,
    y: (stage.h - natural.h * scale) / 2,
  };

  /** 屏幕坐标 → 图片内 0..999 归一化坐标（官方公式，按显示矩形换算）。 */
  const toNorm = (e: React.PointerEvent): { x: number; y: number } | null => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || display.w <= 0 || display.h <= 0) return null;
    const rawX = ((e.clientX - rect.left - display.x) / display.w) * 1000;
    const rawY = ((e.clientY - rect.top - display.y) / display.h) * 1000;
    // 只接受图片显示区域内的操作，画布黑边上的点击不生成标注。
    if (rawX < 0 || rawY < 0 || rawX > 1000 || rawY > 1000) return null;
    return { x: clamp1000(rawX), y: clamp1000(rawY) };
  };

  const addPoint = (p: { x: number; y: number }) => {
    setAnnotations((prev) => [
      ...prev,
      {
        id: uid(),
        kind: "point",
        imageIndex: refIndex,
        x1: p.x,
        y1: p.y,
        x2: p.x,
        y2: p.y,
        token: pointToken(refIndex, p.x, p.y),
      },
    ]);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (display.w <= 0 || e.button !== 0) return;
    const p = toNorm(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (mode === "point") {
      addPoint(p);
      return;
    }
    dragRef.current = { startClientX: e.clientX, startClientY: e.clientY, start: p };
    setDraft({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = toNorm(e);
    if (!p) return;
    setDraft({ x1: drag.start.x, y1: drag.start.y, x2: p.x, y2: p.y });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDraft(null);
    if (!drag) return;
    const p = toNorm(e);
    if (!p) return;
    // 小于 4px 视为误触，不生成框选。
    if (Math.abs(e.clientX - drag.startClientX) <= 4 && Math.abs(e.clientY - drag.startClientY) <= 4) {
      return;
    }
    const x1 = Math.min(drag.start.x, p.x);
    const y1 = Math.min(drag.start.y, p.y);
    const x2 = Math.max(drag.start.x, p.x);
    const y2 = Math.max(drag.start.y, p.y);
    setAnnotations((prev) => [
      ...prev,
      {
        id: uid(),
        kind: "bbox",
        imageIndex: refIndex,
        x1,
        y1,
        x2,
        y2,
        token: bboxToken(refIndex, x1, y1, x2, y2),
      },
    ]);
  };

  const removeAnnotation = (id: string) =>
    setAnnotations((prev) => prev.filter((a) => a.id !== id));

  const apply = () => {
    const tokenText = annotations.map((a) => a.token).join(" ");
    // 移除旧的 <point>/<bbox> token 后重新拼接，避免反复进入画板造成重复。
    const cleanPrompt = api.prompt
      .replace(/图\s?\d+<(point|bbox)>[^<]*<\/\1>/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    const next = [cleanPrompt, instruction.trim(), tokenText].filter(Boolean).join(" ");
    api.setPrompt(next);
    onOpenChange(false);
  };

  const pickRef = async () => {
    const sel = await openFileDialog({
      multiple: false,
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif", "heic", "heif"],
        },
      ],
    });
    if (typeof sel === "string" && sel) api.addRef(sel);
  };

  const rectStyle = (x1: number, y1: number, x2: number, y2: number) => ({
    left: display.x + (Math.min(x1, x2) / 1000) * display.w,
    top: display.y + (Math.min(y1, y2) / 1000) * display.h,
    width: (Math.abs(x1 - x2) / 1000) * display.w,
    height: (Math.abs(y1 - y2) / 1000) * display.h,
  });

  const pointStyle = (x: number, y: number) => ({
    left: display.x + (x / 1000) * display.w - 5,
    top: display.y + (y / 1000) * display.h - 5,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[780px] w-[92vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader className="gap-2">
          <DialogTitle className="text-base">{t("prompt.drawTitle")}</DialogTitle>
          <span className="text-[12px] text-muted-foreground">{t("prompt.drawHint")}</span>
        </DialogHeader>

        {/* 参考图选择 */}
        <div className="flex flex-wrap items-center gap-2">
          {api.refs.map((r, i) => (
            <button
              key={`${r}-${i}`}
              type="button"
              onClick={() => setRefIndex(i)}
              className={cn(
                "relative size-12 overflow-hidden rounded-lg border bg-soft transition-colors",
                i === refIndex
                  ? "border-primary ring-1 ring-primary"
                  : "border-border-2 hover:border-border-3",
              )}
            >
              <img src={refSrc(r)} alt="" className="h-full w-full object-cover" />
              <span className="absolute right-0 bottom-0 rounded-tl bg-black/60 px-1 text-[9px] text-white">
                {imageLabel(i)}
              </span>
            </button>
          ))}
          {canAddRef && (
            <button
              type="button"
              onClick={pickRef}
              className="grid size-12 place-items-center rounded-lg border border-dashed border-border-2 text-xs text-text-2 transition-colors hover:border-primary hover:text-primary"
            >
              +
            </button>
          )}
        </div>

        {/* 画布 */}
        <div
          ref={stageRef}
          className="relative h-[46vh] min-h-[320px] max-h-[560px] w-full overflow-hidden rounded-lg border border-border-2 bg-[#151515]"
        >
          {currentRef ? (
            <>
              <img
                key={`${refIndex}-${currentRef}`}
                src={refSrc(currentRef)}
                alt=""
                className="pointer-events-none absolute inset-0 h-full w-full object-contain select-none"
                onLoad={(e) => {
                  const img = e.target as HTMLImageElement;
                  setNatural({ w: img.naturalWidth, h: img.naturalHeight });
                }}
              />
              <div
                ref={overlayRef}
                className="absolute inset-0 touch-none"
                style={{ cursor: mode === "point" ? "crosshair" : "cell" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              >
                {draft && (
                  <span
                    className="absolute rounded-sm border border-dashed border-[#3b82f6] bg-[rgba(59,130,246,.15)]"
                    style={rectStyle(draft.x1, draft.y1, draft.x2, draft.y2)}
                  />
                )}
                {annotations
                  .filter((a) => a.imageIndex === refIndex)
                  .map((a) =>
                    a.kind === "bbox" ? (
                      <span
                        key={a.id}
                        className="absolute rounded-sm border border-[#3b82f6] bg-[rgba(59,130,246,.15)]"
                        style={rectStyle(a.x1, a.y1, a.x2, a.y2)}
                      />
                    ) : (
                      <span
                        key={a.id}
                        className="absolute size-[10px] rounded-full border border-white bg-[#3b82f6] shadow-[0_0_0_2px_rgba(59,130,246,.35)]"
                        style={pointStyle(a.x1, a.y1)}
                      />
                    ),
                  )}
              </div>
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-text-3">
              <span className="text-[13px]">{t("prompt.drawNoRef")}</span>
              {canAddRef && (
                <button
                  type="button"
                  onClick={pickRef}
                  className="rounded-full border border-border-2 px-3 py-1.5 text-xs text-primary hover:bg-accent"
                >
                  {t("prompt.uploadI2i")}
                </button>
              )}
            </div>
          )}
        </div>

        {/* 标注工具与指令 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-lg bg-soft p-[2px]">
            {(["bbox", "point"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  mode === m ? "bg-accent text-black" : "text-text-3 hover:bg-hover hover:text-foreground",
                )}
              >
                {m === "point" ? t("prompt.drawPoint") : t("prompt.drawBox")}
              </button>
            ))}
          </div>
          <input
            className="h-9 min-w-0 flex-1 rounded-lg bg-soft px-3 text-xs text-foreground outline-none placeholder:text-faint"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={t("prompt.drawInstructionPh")}
            aria-label={t("prompt.drawInstruction")}
          />
        </div>

        {/* 已添加的坐标 token */}
        {annotations.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {annotations.map((a) => (
              <span
                key={a.id}
                className="flex items-center gap-1.5 rounded-full border border-border-2 bg-soft px-2.5 py-1 text-[11px] text-text-2"
              >
                <span className="max-w-[240px] truncate">{a.token}</span>
                <button
                  type="button"
                  className="text-faint hover:text-destructive"
                  aria-label={t("prompt.drawRemove")}
                  onClick={() => removeAnnotation(a.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setAnnotations([])}
            className="rounded-lg px-3 py-2 text-xs text-text-3 transition-colors hover:bg-hover hover:text-foreground"
          >
            {t("prompt.drawClear")}
          </button>
          <button
            type="button"
            disabled={annotations.length === 0}
            onClick={apply}
            className="rounded-full bg-primary px-4 py-2 text-xs font-semibold text-black transition-opacity disabled:opacity-40"
          >
            {t("prompt.drawApply")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
