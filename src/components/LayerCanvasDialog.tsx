// Seedream 5.0 Pro 图层画布（3.3 v1）。
// 原生 Canvas2D 预览：底图按 bounding_box.absolute 摆放透明图层；
// 支持图层显隐、拖拽排序；合成 PNG 由后端 image crate 完成（避免 WebView canvas 跨域污染）。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { revealInFolder } from "../lib/reveal";
import { exportLayerComposition, getLayerComposition, toAssetUrl } from "../api";
import { cn } from "../lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import type { LayerComposition } from "../types";

interface LayerCanvasDialogProps {
  historyId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${src}`));
    img.src = src;
  });

export function LayerCanvasDialog({ historyId, open, onOpenChange }: LayerCanvasDialogProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [comp, setComp] = useState<LayerComposition | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<(HTMLImageElement | null)[]>([]);
  const [order, setOrder] = useState<number[]>([]);
  const [visible, setVisible] = useState<boolean[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // 打开时拉取图层上下文；关闭后清空，避免大尺寸底图持续驻留内存。
  useEffect(() => {
    if (!open) {
      setComp(null);
      setImages([]);
      setOrder([]);
      setVisible([]);
      setExportPath(null);
      setExportError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    setExportPath(null);
    setExportError(null);
    getLayerComposition(historyId)
      .then((c) => {
        if (!alive) return;
        if (!c) {
          setError(t("prompt.layerCanvasNotFound"));
          return;
        }
        setComp(c);
        setOrder(c.layers.map((_, i) => i));
        setVisible(c.layers.map(() => true));
      })
      .catch((e) => {
        if (alive) setError(typeof e === "string" ? e : (e as Error)?.message ?? "error");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, historyId, t]);

  // 预加载全部图层图像；asset 协议本地文件，加载失败由错误态承接。
  useEffect(() => {
    if (!comp) return;
    let alive = true;
    setImages([]);
    Promise.all(comp.paths.map((p) => loadImage(toAssetUrl(p))))
      .then((imgs) => {
        if (alive) setImages(imgs);
      })
      .catch((e) => {
        if (alive) setError(typeof e === "string" ? e : (e as Error)?.message ?? "error");
      });
    return () => {
      alive = false;
    };
  }, [comp]);

  const baseIndex = comp?.layers.findIndex((m) => m.z_index === 0) ?? 0;

  // 按当前顺序与显隐重绘画布。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !comp || images.length !== comp.paths.length) return;
    const base = images[baseIndex];
    if (!base) return;
    canvas.width = base.naturalWidth;
    canvas.height = base.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (visible[baseIndex]) ctx.drawImage(base, 0, 0);
    for (const idx of order) {
      if (idx === baseIndex || idx < 0 || idx >= comp.paths.length) continue;
      if (!visible[idx]) continue;
      const img = images[idx];
      if (!img) continue;
      const bbox = comp.layers[idx]?.bounding_box_absolute;
      if (bbox && bbox.length === 4) {
        const [l, t, r, b] = bbox;
        ctx.drawImage(img, l, t, Math.max(1, r - l), Math.max(1, b - t));
      } else {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }
    }
  }, [comp, images, order, visible, baseIndex]);

  const toggleVisible = (idx: number) =>
    setVisible((prev) => prev.map((v, i) => (i === idx ? !v : v)));

  const onDropTo = (targetIndex: number) => {
    if (dragIndex == null || targetIndex === dragIndex) return;
    if (dragIndex === baseIndex || targetIndex <= 0) return; // 底图固定最底
    setOrder((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    setDragIndex(null);
  };

  const doExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const path = await exportLayerComposition(historyId, order, visible);
      setExportPath(path);
    } catch (e) {
      setExportError(typeof e === "string" ? e : (e as Error)?.message ?? "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[980px] w-[94vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader className="gap-2">
          <DialogTitle className="text-base">{t("prompt.layerCanvasTitle")}</DialogTitle>
          <span className="text-[12px] text-muted-foreground">{t("prompt.layerCanvasHint")}</span>
        </DialogHeader>

        {loading && <span className="text-[13px] text-text-2">{t("prompt.layerCanvasLoading")}</span>}
        {error && <span className="text-[13px] text-destructive">{error}</span>}

        {comp && (
          <div className="flex flex-col gap-4 lg:flex-row">
            {/* 画布预览 */}
            <div className="flex min-h-[320px] flex-1 items-center justify-center overflow-hidden rounded-lg border border-border-2 bg-[#151515] p-3">
              <canvas
                ref={canvasRef}
                className="max-h-[56vh] max-w-full rounded-sm object-contain"
                style={{ background: "repeating-conic-gradient(#1f1f1f 0% 25%, #181818 0% 50%) 0 0 / 20px 20px" }}
              />
            </div>

            {/* 图层面板 */}
            <div className="flex w-full shrink-0 flex-col gap-2 lg:w-[300px]">
              {order.map((idx, pos) => {
                const meta = comp.layers[idx];
                const isBase = idx === baseIndex;
                return (
                  <div
                    key={idx}
                    draggable={!isBase}
                    onDragStart={() => setDragIndex(pos)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => onDropTo(pos)}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border bg-soft px-2.5 py-2 transition-colors",
                      dragIndex === pos ? "border-primary" : "border-border-2",
                      !isBase && "cursor-grab active:cursor-grabbing",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={visible[idx] ?? true}
                      onChange={() => toggleVisible(idx)}
                      aria-label={t("prompt.layerVisible")}
                    />
                    <img src={toAssetUrl(comp.paths[idx])} alt="" className="size-10 rounded object-contain" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-foreground">
                        {isBase ? t("prompt.layerBase") : t("prompt.layerItem", { n: pos })}
                      </div>
                      <div className="truncate text-[11px] text-text-2">
                        {meta?.name ?? `z=${meta?.z_index ?? idx}`}
                      </div>
                    </div>
                    {isBase && <span className="text-[10px] text-faint">{t("prompt.layerBaseFixed")}</span>}
                  </div>
                );
              })}

              <button
                type="button"
                disabled={exporting}
                onClick={doExport}
                className="mt-2 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-black transition-opacity disabled:opacity-50"
              >
                {exporting ? t("prompt.layerExporting") : t("prompt.layerExport")}
              </button>
              {exportError && <span className="text-[12px] text-destructive">{exportError}</span>}
              {exportPath && (
                <div className="flex items-center gap-2 rounded-lg border border-border-2 bg-soft px-2.5 py-2">
                  <img src={toAssetUrl(exportPath)} alt="" className="size-12 rounded object-contain" />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-text-2">{exportPath}</span>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-primary hover:underline"
                    onClick={() => revealInFolder(exportPath)}
                  >
                    {t("prompt.layerExportReveal")}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
