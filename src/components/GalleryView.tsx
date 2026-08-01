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
    <div className="gallery-root">
      <div className="g-toolbar">
        <div className="seg" role="tablist">
          {(["all", "image", "video"] as TypeFilter[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={type === k}
              data-state={type === k ? "on" : "off"}
              onClick={() => setType(k)}
            >
              {t(`gallery.${k}`)}
            </button>
          ))}
        </div>

        <button
          className={"g-chip" + (starredOnly ? " on" : "")}
          onClick={() => setStarredOnly((v) => !v)}
        >
          <IconStar size={12} filled={starredOnly} />
          {t("gallery.starredOnly")}
        </button>

        <div className="g-search">
          <IconSearch size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("gallery.search")}
          />
        </div>

        <div className="g-toolbar-right">
          <button className="btn" title={t("gallery.refresh")} onClick={refresh}>
            {t("gallery.refresh")}
          </button>
          <button
            className={"btn" + (manage ? " primary" : "")}
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
        <div className="g-batchbar">
          <span>{t("gallery.selected", { n: selected.size })}</span>
          <button className="btn" style={{ color: "var(--danger)", borderColor: "rgba(239,68,68,.35)" }} onClick={removeSelected}>
            <IconTrash size={13} /> {t("gallery.deleteSelected")}
          </button>
        </div>
      )}

      <div className="g-grid-wrap">
        {loading ? (
          <div className="g-loading">
            <div className="spinner" />
          </div>
        ) : error ? (
          <div className="g-loading" style={{ color: "var(--danger)", fontSize: 12 }}>
            {t("gallery.failed")}：{error}
          </div>
        ) : visible.length === 0 ? (
          <div className="empty-state">
            <IconLibrary size={40} style={{ color: "var(--muted)", marginBottom: 16 }} />
            <h1 className="empty-title">
              <span className="pre">{t("gallery.empty")}</span>
            </h1>
            <p className="empty-desc">{t("gallery.emptySearch")}</p>
          </div>
        ) : (
          <div className="g-grid">
            {visible.map((it) => {
              const img = isImage(it);
              const thumb = it.thumbnail_path
                ? toAssetUrl(it.thumbnail_path)
                : img
                  ? toAssetUrl(localPaths(it)[0] ?? "")
                  : undefined;
              return (
                <div
                  className={"g-card" + (selected.has(it.id) ? " sel" : "")}
                  key={it.id}
                  onClick={() => (manage ? toggleSelect(it.id) : setDetail(it))}
                >
                  {img ? (
                    <img className="g-img" src={thumb} alt="" loading="lazy" />
                  ) : (
                    <div className="g-video">
                      <div className="g-play">
                        <IconPlay size={18} />
                      </div>
                    </div>
                  )}

                  <div className="g-cap">
                    <p className="g-prompt">{it.prompt}</p>
                    <div className="g-cap-foot">
                      <span className="model-tag">{it.model}</span>
                      <span className="ar-tag">{new Date(it.created_at).toLocaleString()}</span>
                    </div>
                  </div>

                  {manage && (
                    <div className={"g-check" + (selected.has(it.id) ? " on" : "")}>
                      {selected.has(it.id) && "✓"}
                    </div>
                  )}

                  <div className="g-hover">
                    <button
                      title={it.starred ? t("gallery.unstar") : t("gallery.star")}
                      className={it.starred ? "on" : ""}
                      onClick={(e) => cardAction(e, () => toggleStar(it))}
                    >
                      <IconStar size={14} filled={it.starred} />
                    </button>
                    <button
                      title={t("gallery.delete")}
                      className="del"
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
      <DialogContent className="modal gd-modal" showCloseButton={false}>
        <DialogTitle>{t("gallery.type")} · {t(`gallery.capability.${item.capability}`)}</DialogTitle>
        <DialogDescription className="mdesc" style={{ marginBottom: 16 }}>
          {providerName(item)} · {item.model}
        </DialogDescription>

        <div className="gd-body">
          <div className="gd-media">
            {img ? (
              <img src={toAssetUrl(first ?? "")} alt="" className="gd-img" />
            ) : (
              <video src={toAssetUrl(first ?? "")} controls className="gd-video" />
            )}
            {paths.length > 1 && <span className="gd-count">×{paths.length}</span>}
          </div>

          <div className="gd-info">
            <div className="gd-row">
              <span className="gd-label">{t("gallery.prompt")}</span>
              <div className="gd-prompt-box">
                <p className="gd-prompt">{item.prompt}</p>
                <button className="btn gd-copy" onClick={() => onCopyPrompt(item.prompt)}>
                  {copied ? t("gallery.copied") : t("gallery.copyPrompt")}
                </button>
              </div>
            </div>

            <div className="gd-grid2">
              <div className="gd-kv"><span>{t("gallery.model")}</span><b>{item.model}</b></div>
              <div className="gd-kv"><span>{t("gallery.type")}</span><b>{t(`gallery.capability.${item.capability}`)}</b></div>
              <div className="gd-kv"><span>{t("gallery.createdAt")}</span><b>{new Date(item.created_at).toLocaleString()}</b></div>
              {params?.size != null && <div className="gd-kv"><span>Size</span><b>{fmt(params.size)}</b></div>}
              {params?.quality != null && <div className="gd-kv"><span>{t("prompt.resolution")}</span><b>{fmt(params.quality)}</b></div>}
              {params?.duration != null && <div className="gd-kv"><span>{t("prompt.duration")}</span><b>{fmt(params.duration)}s</b></div>}
              {params?.n != null && <div className="gd-kv"><span>N</span><b>{fmt(params.n)}</b></div>}
              {params?.references != null && <div className="gd-kv"><span>{t("gallery.refs")}</span><b>{fmt(params.references)}</b></div>}
            </div>

            <div className="gd-actions">
              <Button className="btn gd-act-star" variant={item.starred ? "default" : "outline"} onClick={() => onToggleStar(item)}>
                <IconStar size={14} filled={item.starred} /> {item.starred ? t("gallery.unstar") : t("gallery.star")}
              </Button>
              {img && first && onImageToVideo && (
                <Button className="btn gd-act-i2v" variant="default" onClick={() => onImageToVideo(first, item.prompt)}>
                  {t("gallery.imgToVideo")}
                </Button>
              )}
              <Button className="btn gd-act-del" variant="outline" style={{ color: "var(--danger)", borderColor: "rgba(239,68,68,.35)" }} onClick={() => onDelete(item)}>
                <IconTrash size={14} /> {t("gallery.delete")}
              </Button>
              <span className="g-spacer" />
              <DialogClose asChild>
                <Button className="btn">{t("common.close")}</Button>
              </DialogClose>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
