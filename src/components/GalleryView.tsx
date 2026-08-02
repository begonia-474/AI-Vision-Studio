// 图库视图
// 读取后端 list_history（SQLite 持久化的全部作品），提供类型/收藏/搜索筛选、
// 网格展示（缩略图/视频占位）、详情弹窗（参数 + 复制提示词 + 图生视频）、
// 管理模式（多选批量删除）与收藏。生成完成事件触发自动刷新。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { deleteHistories, listHistory, onProgress, setStar, toAssetUrl } from "../api";
import type { HistoryTask } from "../types";
import { providerDisplayName } from "../models/registry";
import { IconLibrary, IconPlay, IconSearch, IconStar, IconTrash } from "../lib/icons";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { AR_TAG, BTN, BTN_PRIMARY, MODEL_TAG, SEG, SEG_BTN } from "../lib/classes";

type TypeFilter = "all" | "image" | "video";

interface GalleryViewProps {
  onImageToVideo?: (src: string, prompt: string) => void;
}

const isImage = (t: HistoryTask) => t.capability === "t2i" || t.capability === "i2i";
const localPaths = (t: HistoryTask): string[] => {
  try {
    return JSON.parse(t.local_paths_json) as string[];
  } catch {
    return [];
  }
};
const paramsOf = (t: HistoryTask): Record<string, unknown> | null => {
  try {
    return t.params_json ? (JSON.parse(t.params_json) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
  return Promise.resolve();
}

export function GalleryView({ onImageToVideo }: GalleryViewProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<HistoryTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<TypeFilter>("all");
  const [starredOnly, setStarredOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [detail, setDetail] = useState<HistoryTask | null>(null);
  const [copied, setCopied] = useState(false);
  const aliveRef = useRef(true);
  const copyTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await listHistory();
      if (aliveRef.current) {
        setItems(list);
        setSelected((prev) => new Set([...prev].filter((id) => list.some((x) => x.id === id))));
      }
    } catch (e) {
      if (aliveRef.current) {
        setError(typeof e === "string" ? e : (e as Error)?.message ?? "error");
      }
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  // 挂载时加载；生成结束（done / failed）后自动刷新
  useEffect(() => {
    aliveRef.current = true;
    refresh();
    let un: (() => void) | undefined;
    onProgress((p) => {
      if (p.phase === "done" || p.phase === "failed") refresh();
    }).then((u) => (un = u));
    return () => {
      aliveRef.current = false;
      un?.();
      window.clearTimeout(copyTimer.current);
    };
  }, [refresh]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      items.filter((it) => {
        if (type !== "all" && isImage(it) !== (type === "image")) return false;
        if (starredOnly && !it.starred) return false;
        if (q) {
          const hay = `${it.prompt} ${it.model} ${it.provider}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [items, type, starredOnly, q],
  );

  const providerName = useCallback((it: HistoryTask) => providerDisplayName(it.provider, t), [t]);

  const toggleSelect = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleStar = async (it: HistoryTask) => {
    const next = !it.starred;
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, starred: next } : x)));
    setDetail((prev) => (prev && prev.id === it.id ? { ...prev, starred: next } : prev));
    try {
      await setStar(it.id, next);
    } catch {
      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, starred: !next } : x)));
    }
  };

  const removeOne = async (it: HistoryTask) => {
    if (!window.confirm(t("gallery.deleteConfirm"))) return;
    try {
      await deleteHistories([it.id]);
      setItems((prev) => prev.filter((x) => x.id !== it.id));
      setDetail(null);
    } catch {
      /* 忽略，刷新兜底 */
    }
  };

  const removeSelected = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(t("gallery.deleteConfirmMany", { n: selected.size }))) return;
    try {
      await deleteHistories([...selected]);
      setItems((prev) => prev.filter((x) => !selected.has(x.id)));
      setSelected(new Set());
      setManage(false);
    } catch {
      /* 忽略 */
    }
  };

  const copyPrompt = async (prompt: string) => {
    await copyText(prompt);
    setCopied(true);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const cardAction = (e: React.MouseEvent, fn: () => void) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border-2 px-4 py-3">
        <div className={SEG} role="tablist">
          {(["all", "image", "video"] as TypeFilter[]).map((k) => (
            <button
              key={k}
              role="tab"
              className={SEG_BTN}
              aria-selected={type === k}
              data-state={type === k ? "on" : "off"}
              onClick={() => setType(k)}
            >
              {t(`gallery.${k}`)}
            </button>
          ))}
        </div>

        <button
          className={cn(
            "inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full border border-border-2 bg-chip px-3 text-[11px] font-semibold text-text-3 transition-all duration-150 hover:bg-hover hover:text-foreground",
            starredOnly &&
              "border-[rgba(250,204,21,.30)] bg-[rgba(250,204,21,.10)] text-[#facc15] hover:border-[rgba(250,204,21,.30)] hover:bg-[rgba(250,204,21,.10)] hover:text-[#facc15]",
          )}
          onClick={() => setStarredOnly((v) => !v)}
        >
          <IconStar size={12} filled={starredOnly} />
          {t("gallery.starredOnly")}
        </button>

        <div className="flex h-[30px] min-w-[200px] max-w-[360px] flex-1 items-center gap-2 rounded-full border border-border-2 bg-soft px-3.5 text-muted-foreground transition-colors duration-150 focus-within:border-[rgba(59,130,246,.50)]">
          <IconSearch size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("gallery.search")}
            className="flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button className={BTN} title={t("gallery.refresh")} onClick={refresh}>
            {t("gallery.refresh")}
          </button>
          <button
            className={manage ? BTN_PRIMARY : BTN}
            onClick={() => {
              setManage((v) => !v);
              if (manage) setSelected(new Set());
            }}
          >
            {manage ? t("gallery.exitManage") : t("gallery.manage")}
          </button>
        </div>
      </div>

      {manage && selected.size > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[rgba(59,130,246,.20)] bg-[rgba(59,130,246,.08)] px-4 py-2 text-xs font-semibold text-primary animate-[fadeInUp_.2s]">
          <span>{t("gallery.selected", { n: selected.size })}</span>
          <button className={BTN} style={{ color: "var(--danger)", borderColor: "rgba(239,68,68,.35)" }} onClick={removeSelected}>
            <IconTrash size={13} /> {t("gallery.deleteSelected")}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="grid flex-1 place-items-center text-muted-foreground">
            <div className="size-8 animate-spin rounded-full border-2 border-[rgba(59,130,246,.30)] border-t-primary" />
          </div>
        ) : error ? (
          <div className="grid flex-1 place-items-center text-muted-foreground" style={{ color: "var(--danger)", fontSize: 12 }}>
            {t("gallery.failed")}：{error}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full min-h-[50vh] flex-col items-center justify-center p-4 text-center animate-[fadeInUp_.7s]">
            <IconLibrary size={40} style={{ color: "var(--muted)", marginBottom: 16 }} />
            <h1 className="m-0 mb-4 flex flex-col items-center gap-1 text-4xl font-extrabold tracking-tight">
              <span className="text-[30px] font-black uppercase tracking-[.05em] text-foreground/90">{t("gallery.empty")}</span>
            </h1>
            <p className="m-0 max-w-[480px] text-sm leading-relaxed text-muted-foreground">{t("gallery.emptySearch")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 animate-[fadeInUp_.4s]">
            {visible.map((it) => {
              const img = isImage(it);
              const thumb = it.thumbnail_path
                ? toAssetUrl(it.thumbnail_path)
                : img
                  ? toAssetUrl(localPaths(it)[0] ?? "")
                  : undefined;
              return (
                <div
                  className={cn(
                    "group/g relative aspect-square cursor-pointer overflow-hidden rounded-xl border border-border-3 bg-card transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-[rgba(59,130,246,.50)]",
                    selected.has(it.id) && "border-primary shadow-[0_0_0_2px_rgba(59,130,246,.35)]",
                  )}
                  key={it.id}
                  onClick={() => (manage ? toggleSelect(it.id) : setDetail(it))}
                >
                  {img ? (
                    <img className="block h-full w-full bg-card-shade object-cover" src={thumb} alt="" loading="lazy" />
                  ) : (
                    <div className="grid h-full w-full place-items-center bg-[linear-gradient(135deg,var(--surface-3),var(--surface))]">
                      <div className="grid size-[52px] place-items-center rounded-full border border-border-4 bg-btn-dark text-foreground backdrop-blur-[8px]">
                        <IconPlay size={18} />
                      </div>
                    </div>
                  )}

                  <div className="absolute inset-x-0 bottom-0 bg-[linear-gradient(to_top,rgba(0,0,0,.85),transparent)] px-2.5 pt-[26px] pb-2">
                    <p className="m-0 mb-1.5 line-clamp-2 text-[11px] leading-snug text-white/90">{it.prompt}</p>
                    <div className="flex items-center justify-between gap-1.5">
                      <span className={cn(MODEL_TAG, "px-[7px] py-px text-[9px]")}>{it.model}</span>
                      <span className={cn(AR_TAG, "text-[9px] text-white/55")}>{new Date(it.created_at).toLocaleString()}</span>
                    </div>
                  </div>

                  {manage && (
                    <div
                      className={cn(
                        "absolute top-2 left-2 z-[3] grid size-[22px] place-items-center rounded-full border-2 border-white/70 bg-black/35 text-xs font-extrabold text-black",
                        selected.has(it.id) && "border-primary bg-primary",
                      )}
                    >
                      {selected.has(it.id) && "✓"}
                    </div>
                  )}

                  <div className="absolute top-2 right-2 z-[3] flex flex-col gap-1.5 opacity-0 transition-opacity duration-200 group-hover/g:opacity-100 group-focus-within/g:opacity-100">
                    <button
                      title={it.starred ? t("gallery.unstar") : t("gallery.star")}
                      className={cn(
                        "grid size-[30px] cursor-pointer place-items-center rounded-full border border-border-4 bg-btn-dark text-foreground backdrop-blur-[8px] transition-all duration-150 hover:bg-primary hover:text-black",
                        it.starred && "text-[#facc15]",
                      )}
                      onClick={(e) => cardAction(e, () => toggleStar(it))}
                    >
                      <IconStar size={14} filled={it.starred} />
                    </button>
                    <button
                      title={t("gallery.delete")}
                      className="grid size-[30px] cursor-pointer place-items-center rounded-full border border-border-4 bg-btn-dark text-foreground backdrop-blur-[8px] transition-all duration-150 hover:bg-destructive hover:text-white"
                      onClick={(e) => cardAction(e, () => removeOne(it))}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <DetailDialog
        item={detail}
        providerName={providerName}
        copied={copied}
        onClose={() => setDetail(null)}
        onToggleStar={toggleStar}
        onCopyPrompt={copyPrompt}
        onDelete={removeOne}
        onImageToVideo={(src, prompt) => {
          setDetail(null);
          onImageToVideo?.(src, prompt);
        }}
      />
    </div>
  );
}

interface DetailDialogProps {
  item: HistoryTask | null;
  providerName: (it: HistoryTask) => string;
  copied: boolean;
  onClose: () => void;
  onToggleStar: (it: HistoryTask) => void;
  onCopyPrompt: (prompt: string) => void;
  onDelete: (it: HistoryTask) => void;
  onImageToVideo: (src: string, prompt: string) => void;
}

function DetailDialog({
  item,
  providerName,
  copied,
  onClose,
  onToggleStar,
  onCopyPrompt,
  onDelete,
  onImageToVideo,
}: DetailDialogProps) {
  const { t } = useTranslation();
  if (!item) return null;

  const img = isImage(item);
  const paths = localPaths(item);
  const params = paramsOf(item);
  const first = paths[0];
  const fmt = (v: unknown): string => (v == null ? "-" : String(v));

  return (
    <Dialog open={!!item} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-[92vw] max-w-[920px] p-6" showCloseButton={false}>
        <DialogTitle>{t("gallery.type")} · {t(`gallery.capability.${item.capability}`)}</DialogTitle>
        <DialogDescription className="mt-0 mb-4 text-[13px] leading-relaxed text-muted-foreground">
          {providerName(item)} · {item.model}
        </DialogDescription>

        <div className="flex gap-5 max-[760px]:flex-col">
          <div className="relative grid min-w-0 flex-[1.2] place-items-center overflow-hidden rounded-xl bg-card-shade">
            {img ? (
              <img src={toAssetUrl(first ?? "")} alt="" className="w-full max-h-[62vh] object-contain" />
            ) : (
              <video src={toAssetUrl(first ?? "")} controls className="w-full max-h-[62vh] rounded-xl" />
            )}
            {paths.length > 1 && <span className="absolute top-2.5 right-2.5 rounded-full border border-border-4 bg-btn-dark px-2.5 py-0.5 text-[11px] font-bold text-foreground backdrop-blur-[8px]">×{paths.length}</span>}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-3.5">
            <div>
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[.06em] text-faint">{t("gallery.prompt")}</span>
              <div className="relative">
                <p className="m-0 max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border-2 bg-chip p-2.5 pr-[90px] text-xs leading-relaxed text-text-2">{item.prompt}</p>
                <button className={cn(BTN, "absolute top-2 right-2 h-[26px] px-2.5 text-[10px]")} onClick={() => onCopyPrompt(item.prompt)}>
                  {copied ? t("gallery.copied") : t("gallery.copyPrompt")}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-0.5 rounded-md border border-border-2 bg-chip p-2 px-2.5"><span className="text-[9px] uppercase tracking-[.05em] text-muted-foreground">{t("gallery.model")}</span><b className="text-[11px] font-semibold break-all text-text-2">{item.model}</b></div>
              <div className="flex flex-col gap-0.5 rounded-md border border-border-2 bg-chip p-2 px-2.5"><span className="text-[9px] uppercase tracking-[.05em] text-muted-foreground">{t("gallery.type")}</span><b className="text-[11px] font-semibold break-all text-text-2">{t(`gallery.capability.${item.capability}`)}</b></div>
              <div className="flex flex-col gap-0.5 rounded-md border border-border-2 bg-chip p-2 px-2.5"><span className="text-[9px] uppercase tracking-[.05em] text-muted-foreground">{t("gallery.createdAt")}</span><b className="text-[11px] font-semibold break-all text-text-2">{new Date(item.created_at).toLocaleString()}</b></div>
              {params?.size != null && <div className="flex flex-col gap-0.5 rounded-md border border-border-2 bg-chip p-2 px-2.5"><span className="text-[9px] uppercase tracking-[.05em] text-muted-foreground">Size</span><b className="text-[11px] font-semibold break-all text-text-2">{fmt(params.size)}</b></div>}
              {params?.quality != null && <div className="flex flex-col gap-0.5 rounded-md border border-border-2 bg-chip p-2 px-2.5"><span className="text-[9px] uppercase tracking-[.05em] text-muted-foreground">{t("prompt.resolution")}</span><b className="text-[11px] font-semibold break-all text-text-2">{fmt(params.quality)}</b></div>}
              {params?.duration != null && <div className="flex flex-col gap-0.5 rounded-md border border-border-2 bg-chip p-2 px-2.5"><span className="text-[9px] uppercase tracking-[.05em] text-muted-foreground">{t("prompt.duration")}</span><b className="text-[11px] font-semibold break-all text-text-2">{fmt(params.duration)}s</b></div>}
              {params?.n != null && <div className="flex flex-col gap-0.5 rounded-md border border-border-2 bg-chip p-2 px-2.5"><span className="text-[9px] uppercase tracking-[.05em] text-muted-foreground">N</span><b className="text-[11px] font-semibold break-all text-text-2">{fmt(params.n)}</b></div>}
              {params?.references != null && <div className="flex flex-col gap-0.5 rounded-md border border-border-2 bg-chip p-2 px-2.5"><span className="text-[9px] uppercase tracking-[.05em] text-muted-foreground">{t("gallery.refs")}</span><b className="text-[11px] font-semibold break-all text-text-2">{fmt(params.references)}</b></div>}
            </div>

            <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
              <Button className={cn(BTN, "h-8 text-[11px]", item.starred && "border-[rgba(250,204,21,.40)] text-[#facc15]")} variant={item.starred ? "default" : "outline"} onClick={() => onToggleStar(item)}>
                <IconStar size={14} filled={item.starred} /> {item.starred ? t("gallery.unstar") : t("gallery.star")}
              </Button>
              {img && first && onImageToVideo && (
                <Button className={cn(BTN, "h-8 border-primary bg-primary text-[11px] text-black hover:border-primary hover:bg-accent-h hover:text-black")} variant="default" onClick={() => onImageToVideo(first, item.prompt)}>
                  {t("gallery.imgToVideo")}
                </Button>
              )}
              <Button className={cn(BTN, "h-8 text-[11px]")} variant="outline" style={{ color: "var(--danger)", borderColor: "rgba(239,68,68,.35)" }} onClick={() => onDelete(item)}>
                <IconTrash size={14} /> {t("gallery.delete")}
              </Button>
              <span className="flex-1" />
              <DialogClose asChild>
                <Button className={cn(BTN, "h-8 text-[11px]")}>{t("common.close")}</Button>
              </DialogClose>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
