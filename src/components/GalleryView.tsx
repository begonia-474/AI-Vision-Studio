// 图库视图（哩布风格）
// 顶部导航（生成历史 / 画布）+ 类型 tab（图片/视频）+ 筛选/时间/排序下拉，
// 右侧搜索与批量操作；内容按日期分组的 172px 方格图片墙，居中布局。
// 管理模式：批量操作展开面板（删除/下载/发布/收藏/取消选择）+ 鼠标左键框选。
// 画布尚未接入，点击弹窗提示；收藏/删除仍作用于原任务。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { deleteHistories, listHistory, onProgress, setStar, toAssetUrl } from "../api";
import { openPath } from "@tauri-apps/plugin-opener";
import type { HistoryTask, StudioJump } from "../types";
import { providerDisplayName } from "../models/registry";
import { IconChevron, IconDownload, IconLibrary, IconPlay, IconSearch, IconStar, IconTrash, IconUpload } from "../lib/icons";
import { cn } from "../lib/utils";
import { DetailPanel, type DetailSource } from "./DetailPanel";

type TypeFilter = "all" | "image" | "video";
type SortOrder = "newest" | "oldest";

interface GalleryViewProps {
  onImageToVideo?: (src: string, prompt: string) => void;
  onImageToImage?: (src: string, prompt: string) => void;
  onReEdit?: (j: StudioJump & { studio: "image" | "video" }) => void;
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

interface GalleryEntry {
  key: string;
  item: HistoryTask;
  thumbnail?: string;
}

// 按本地日期分组：返回 "YYYY-MM-DD"
const dayKey = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const dayNumber = (key: string): number => {
  const [year, month, day] = key.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
};

const dateLabel = (t: (k: string, options?: Record<string, unknown>) => string, key: string): string => {
  const now = new Date();
  const daysAgo = Math.round((dayNumber(dayKey(now.toISOString())) - dayNumber(key)) / 86400000);
  if (daysAgo === 0) return t("gallery.today");
  if (daysAgo === 1) return t("gallery.yesterday");
  if (daysAgo > 1 && daysAgo < 7) return t("gallery.daysAgo", { n: daysAgo });
  return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

// 分辨率 / 比例（来自 params.size "WxH"）
const sizeOf = (it: HistoryTask): { w: number; h: number } | null => {
  const s = paramsOf(it)?.size;
  if (typeof s !== "string") return null;
  const m = /^(\d+)\s*[xX*]\s*(\d+)$/.exec(s.trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : null;
};
const resOf = (it: HistoryTask): string | null => {
  const s = sizeOf(it);
  if (!s) return null;
  const max = Math.max(s.w, s.h);
  if (max <= 1024) return "1K";
  if (max <= 2048) return "2K";
  if (max <= 4096) return "4K";
  return "8K";
};
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const ratioOf = (it: HistoryTask): string | null => {
  const s = sizeOf(it);
  if (!s) return null;
  const g = gcd(s.w, s.h);
  return `${s.w / g}:${s.h / g}`;
};
const presetRange = (days: number): { start: string; end: string } => {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { start: dayKey(start.toISOString()), end: dayKey(end.toISOString()) };
};
const activePreset = (range: { start: string; end: string }, days: number): boolean => {
  const p = presetRange(days);
  return range.start === p.start && range.end === p.end;
};

// 菜单勾选标记（方形 checkbox）
function CheckMark({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "grid size-[15px] shrink-0 place-items-center rounded-[3px] border transition-colors",
        on ? "border-[#2563eb] bg-[#2563eb] text-white" : "border-[#d1d5db] bg-white text-transparent",
      )}
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  );
}

const MENU =
  "absolute top-7 left-0 z-50 rounded-lg border border-[#e5e7eb] bg-white text-[12px] shadow-[0_10px_30px_rgba(15,23,42,.12)]";

export function GalleryView({ onImageToVideo, onImageToImage, onReEdit }: GalleryViewProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<HistoryTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<TypeFilter>("image");
  const [starredOnly, setStarredOnly] = useState(false);
  const [range, setRange] = useState<{ start: string; end: string }>({ start: "", end: "" });
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [resSel, setResSel] = useState<Set<string>>(new Set());
  const [ratioSel, setRatioSel] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<"filter" | "time" | "sort" | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const aliveRef = useRef(true);
  const searchRef = useRef<HTMLDivElement | null>(null);
  const row2Ref = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
    }).then((u) => {
      // 竞态防护：listen 注册完成前若已卸载，立即注销，避免监听器残留
      if (!aliveRef.current) {
        u();
      } else {
        un = u;
      }
    });
    return () => {
      aliveRef.current = false;
      un?.();
    };
  }, [refresh]);

  // 点击搜索区 / 菜单区外部时收回；Escape 也收回
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node;
      if (searchRef.current && !searchRef.current.contains(node)) setSearchOpen(false);
      if (row2Ref.current && !row2Ref.current.contains(node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSearchOpen(false);
        setOpenMenu(null);
        setDetailIdx(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      items.filter((it) => {
        if (type !== "all" && isImage(it) !== (type === "image")) return false;
        if (starredOnly && !it.starred) return false;
        if (range.start && dayKey(it.created_at) < range.start) return false;
        if (range.end && dayKey(it.created_at) > range.end) return false;
        if (resSel.size > 0) {
          const r = resOf(it);
          if (!r || !resSel.has(r)) return false;
        }
        if (ratioSel.size > 0) {
          const r = ratioOf(it);
          if (!r || !ratioSel.has(r)) return false;
        }
        if (q) {
          const hay = `${it.prompt} ${it.model} ${it.provider}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [items, type, starredOnly, range, resSel, ratioSel, q],
  );

  const sorted = useMemo(
    () =>
      [...visible].sort((a, b) => {
        const diff = Date.parse(a.created_at) - Date.parse(b.created_at);
        return sortOrder === "newest" ? -diff : diff;
      }),
    [visible, sortOrder],
  );

  // 一次批量生成可能包含多个文件，图库按单张结果铺开，但收藏/删除仍作用于原任务。
  const entries = useMemo<GalleryEntry[]>(
    () =>
      sorted.flatMap((it) => {
        const paths = localPaths(it);
        const count = Math.max(paths.length, 1);
        return Array.from({ length: count }, (_, index) => {
          const image = isImage(it);
          const path = index === 0 && it.thumbnail_path ? it.thumbnail_path : image ? paths[index] : undefined;
          return {
            key: `${it.id}-${index}`,
            item: it,
            thumbnail: path ? toAssetUrl(path) : undefined,
          };
        });
      }),
    [sorted],
  );

  const groups = useMemo(() => {
    const map = new Map<string, GalleryEntry[]>();
    for (const entry of entries) {
      const key = dayKey(entry.item.created_at);
      const group = map.get(key);
      if (group) group.push(entry);
      else map.set(key, [entry]);
    }
    return [...map.entries()].map(([key, items]) => ({ key, items }));
  }, [entries]);

  // 筛选面板的可选分辨率 / 比例（来自全部条目，随数据变化）
  const resOptions = useMemo(() => {
    const set = new Set<string>();
    items.forEach((it) => {
      const r = resOf(it);
      if (r) set.add(r);
    });
    return [...set].sort((a, b) => Number(a.replace("K", "")) - Number(b.replace("K", "")));
  }, [items]);
  const ratioOptions = useMemo(() => {
    const set = new Set<string>();
    items.forEach((it) => {
      const r = ratioOf(it);
      if (r) set.add(r);
    });
    return [...set].sort((a, b) => {
      const [aw, ah] = a.split(":").map(Number);
      const [bw, bh] = b.split(":").map(Number);
      return bw / bh - aw / ah;
    });
  }, [items]);

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
      closeDetail();
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

  // 下载 = 在文件管理器中定位第一个产物
  const downloadSelected = async () => {
    const targets = items.filter((x) => selected.has(x.id));
    for (const it of targets) {
      const p = localPaths(it)[0] ?? it.thumbnail_path;
      if (p) {
        try {
          await openPath(p, "reveal");
        } catch {
          /* 浏览器环境忽略 */
        }
      }
    }
  };

  const starSelected = async () => {
    const targets = items.filter((x) => selected.has(x.id));
    if (targets.length === 0) return;
    const next = !targets.every((x) => x.starred);
    setItems((prev) => prev.map((x) => (selected.has(x.id) ? { ...x, starred: next } : x)));
    try {
      await Promise.all(targets.map((x) => setStar(x.id, next)));
    } catch {
      refresh();
    }
  };

  const cancelSelect = () => {
    setSelected(new Set());
    setManage(false);
  };

  const toggleFilterSet = (kind: "res" | "ratio", value: string) => {
    if (kind === "res") {
      setResSel((prev) => {
        const next = new Set(prev);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
    } else {
      setRatioSel((prev) => {
        const next = new Set(prev);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
    }
  };

  const cardAction = (e: React.MouseEvent, fn: () => void) => {
    e.stopPropagation();
    fn();
  };

  // 打开详情：记录当前所在网格位置，供详情左右切换
  const openDetail = (entry: GalleryEntry) => {
    const idx = entries.findIndex((e) => e.key === entry.key);
    setDetailIdx(idx);
  };

  const closeDetail = () => {
    setDetailIdx(null);
  };

  const goDetail = (delta: number) => {
    if (detailIdx == null) return;
    const next = detailIdx + delta;
    if (next < 0 || next >= entries.length) return;
    setDetailIdx(next);
  };

  // 详情数据源：由历史任务标准化而来（收藏/删除/跳转绑定原任务）
  const detailSources = entries.map((entry): DetailSource => {
    const it = entry.item;
    const paths = localPaths(it);
    const params = paramsOf(it);
    const size = typeof params?.size === "string" ? params.size : undefined;
    const image = isImage(it);
    return {
      key: entry.key,
      image,
      prompt: it.prompt,
      model: it.model,
      tool: providerName(it),
      createdAt: it.created_at,
      paths,
      thumbnailPath: it.thumbnail_path ?? undefined,
      size,
      ratio: size ? (ratioOf(it) ?? undefined) : undefined,
      quality: typeof params?.quality === "string" ? params.quality : undefined,
      duration: typeof params?.duration === "string" ? params.duration : undefined,
      n: typeof params?.n === "number" ? params.n : undefined,
      starred: it.starred,
      onToggleStar: () => toggleStar(it),
      onDelete: () => removeOne(it),
      onImageToVideo: (src, prompt) => {
        closeDetail();
        onImageToVideo?.(src, prompt);
      },
      onImageToImage: (src, prompt) => {
        closeDetail();
        onImageToImage?.(src, prompt);
      },
      onReEdit: () => {
        closeDetail();
        onReEdit?.(buildReEdit(it));
      },
    };
  });

  // 「重新编辑」：从历史任务还原参数快照（model 字段即 ModelDef.id）。
  const buildReEdit = (it: HistoryTask): StudioJump & { studio: "image" | "video" } => {
    const params = paramsOf(it);
    const first = localPaths(it)[0];
    const refs = it.capability === "i2i" && first ? [toAssetUrl(first)] : undefined;
    return {
      studio: isImage(it) ? "image" : "video",
      prompt: it.prompt,
      modelId: it.model,
      ar: typeof params?.aspect_ratio === "string" ? params.aspect_ratio : undefined,
      quality: typeof params?.quality === "string" ? params.quality : undefined,
      duration: typeof params?.duration === "string" ? params.duration : undefined,
      n: typeof params?.n === "number" ? params.n : undefined,
      refs,
    };
  };

  // ===== 框选（仅管理模式）=====
  const onGridPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!manage || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-gid]")) return;
    setMarquee({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onGridPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    setMarquee((m) => (m ? { ...m, x1: e.clientX, y1: e.clientY } : m));
  };
  const onGridPointerUp = () => {
    if (!marquee) return;
    const x0 = Math.min(marquee.x0, marquee.x1);
    const x1 = Math.max(marquee.x0, marquee.x1);
    const y0 = Math.min(marquee.y0, marquee.y1);
    const y1 = Math.max(marquee.y0, marquee.y1);
    if (x1 - x0 > 2 || y1 - y0 > 2) {
      const els = scrollRef.current?.querySelectorAll<HTMLElement>("[data-gid]") ?? [];
      const added: number[] = [];
      els.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.left < x1 && r.right > x0 && r.top < y1 && r.bottom > y0) added.push(Number(el.dataset.gid));
      });
      if (added.length > 0) {
        setSelected((prev) => {
          const next = new Set(prev);
          added.forEach((id) => next.add(id));
          return next;
        });
      }
    }
    setMarquee(null);
  };

  const batchBtn =
    "flex h-7 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-2 text-[12px] font-medium text-[#374151] transition-colors hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex h-full flex-col bg-[#f7f8fa] text-[#111827]">
      <header className="relative z-30 shrink-0 bg-[#f7f8fa]">
        <div className="mx-auto flex w-full max-w-[1280px] items-center justify-between gap-4 px-2 pt-3">
          <nav className="flex items-center gap-2" aria-label={t("gallery.history")}>
            <button className="h-9 rounded-[9px] bg-[#e9eaec] px-4 text-[13px] font-medium text-[#111827]" aria-current="page">
              {t("gallery.history")}
            </button>
            <button
              className="h-9 cursor-pointer rounded-[9px] border-0 bg-transparent px-3 text-[13px] text-[#4b5563] transition-colors hover:bg-[#eceef1] hover:text-[#111827]"
              onClick={() => window.alert(t("gallery.canvasAlert"))}
            >
              {t("gallery.canvas")}
            </button>
          </nav>

          {manage ? (
            <div className="ml-auto flex h-9 shrink-0 items-center gap-1 rounded-[9px] border border-[#e5e7eb] bg-white px-2 shadow-[0_1px_4px_rgba(15,23,42,.08)] animate-[fadeInUp_.15s]">
              <span className="px-1.5 text-[12px] font-medium whitespace-nowrap text-[#111827]">
                {t("gallery.selectedItems", { n: selected.size })}
              </span>
              <button className={batchBtn} disabled={selected.size === 0} onClick={removeSelected}>
                <IconTrash size={13} /> {t("common.delete")}
              </button>
              <button className={batchBtn} disabled={selected.size === 0} onClick={downloadSelected}>
                <IconDownload size={13} /> {t("gallery.download")}
              </button>
              <button className={batchBtn} disabled>
                <IconUpload size={13} /> {t("gallery.publish")}
              </button>
              <button className={batchBtn} disabled={selected.size === 0} onClick={starSelected}>
                <IconStar size={13} filled /> {t("gallery.star")}
              </button>
              <span className="mx-1 h-4 w-px bg-[#e5e7eb]" />
              <button
                className="flex h-7 cursor-pointer items-center rounded-md border-0 bg-transparent px-2 text-[12px] text-[#4b5563] transition-colors hover:bg-[#f3f4f6] hover:text-[#dc2626]"
                onClick={cancelSelect}
              >
                {t("gallery.cancelSelect")}
              </button>
            </div>
          ) : (
            <div ref={searchRef} className="ml-auto flex h-9 items-center rounded-[9px] border border-[#e5e7eb] bg-white text-[13px] shadow-[0_1px_2px_rgba(15,23,42,.03)]">
              {searchOpen ? (
                <div className="flex items-center gap-2 px-3">
                  <IconSearch size={15} style={{ color: "#4b5563" }} />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("gallery.search")}
                    className="w-[190px] bg-transparent text-[12px] text-[#111827] outline-none placeholder:text-[#9ca3af]"
                  />
                </div>
              ) : (
                <button
                  className="grid size-9 cursor-pointer place-items-center border-0 bg-transparent text-[#111827] hover:text-[#2563eb]"
                  title={t("gallery.search")}
                  aria-label={t("gallery.search")}
                  onClick={() => setSearchOpen(true)}
                >
                  <IconSearch size={15} />
                </button>
              )}
              <button
                className="h-full cursor-pointer border-0 bg-transparent px-3 font-medium text-[#111827] hover:text-[#2563eb]"
                onClick={() => {
                  setManage((v) => !v);
                  if (manage) setSelected(new Set());
                }}
              >
                {t("gallery.batch")}
              </button>
            </div>
          )}
        </div>

        <div ref={row2Ref} className="mx-auto flex w-full max-w-[1280px] min-h-[46px] items-center gap-6 px-2 pb-2 text-[12px] text-[#374151]">
          <div className="flex shrink-0 items-center gap-6" role="tablist">
            {(["image", "video"] as TypeFilter[]).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={type === k}
                className={cn(
                  "cursor-pointer border-0 bg-transparent p-0 font-normal transition-colors hover:text-[#111827]",
                  type === k ? "font-medium text-[#111827]" : "text-[#6b7280]",
                )}
                onClick={() => setType(k)}
              >
                {t(`gallery.${k}`)}
              </button>
            ))}
          </div>

          <div className="relative shrink-0">
            <button
              className={cn(
                "flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[#4b5563] hover:text-[#111827]",
                (starredOnly || type === "all" || resSel.size > 0 || ratioSel.size > 0) && "font-medium text-[#111827]",
              )}
              onClick={() => setOpenMenu((v) => (v === "filter" ? null : "filter"))}
            >
              {t("gallery.filter")} <IconChevron size={11} />
            </button>
            {openMenu === "filter" && (
              <div className={cn(MENU, "min-w-[216px] py-2")}>
                <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-[#9ca3af]">{t("gallery.fGroupAction")}</div>
                <button
                  className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md border-0 bg-transparent px-3 py-[7px] text-left text-[#374151] transition-colors hover:bg-[#f3f4f6]"
                  onClick={() => setStarredOnly((v) => !v)}
                >
                  <span>{t("gallery.starredOnly")}</span>
                  <CheckMark on={starredOnly} />
                </button>
                <div className="mx-3 my-1.5 h-px bg-[#f0f1f3]" />
                <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-[#9ca3af]">{t("gallery.fGroupType")}</div>
                {(["image", "video"] as TypeFilter[]).map((k) => (
                  <button
                    key={k}
                    className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md border-0 bg-transparent px-3 py-[7px] text-left text-[#374151] transition-colors hover:bg-[#f3f4f6]"
                    onClick={() => setType(type === k ? "all" : k)}
                  >
                    <span>{t(`gallery.${k}`)}</span>
                    <CheckMark on={type === k} />
                  </button>
                ))}
                {resOptions.length > 0 && (
                  <>
                    <div className="mx-3 my-1.5 h-px bg-[#f0f1f3]" />
                    <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-[#9ca3af]">{t("gallery.fGroupRes")}</div>
                    {resOptions.map((r) => (
                      <button
                        key={r}
                        className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md border-0 bg-transparent px-3 py-[7px] text-left text-[#374151] transition-colors hover:bg-[#f3f4f6]"
                        onClick={() => toggleFilterSet("res", r)}
                      >
                        <span>{r}</span>
                        <CheckMark on={resSel.has(r)} />
                      </button>
                    ))}
                  </>
                )}
                {ratioOptions.length > 0 && (
                  <>
                    <div className="mx-3 my-1.5 h-px bg-[#f0f1f3]" />
                    <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-[#9ca3af]">{t("gallery.fGroupRatio")}</div>
                    {ratioOptions.map((r) => (
                      <button
                        key={r}
                        className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md border-0 bg-transparent px-3 py-[7px] text-left text-[#374151] transition-colors hover:bg-[#f3f4f6]"
                        onClick={() => toggleFilterSet("ratio", r)}
                      >
                        <span>{r}</span>
                        <CheckMark on={ratioSel.has(r)} />
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>

          <div className="relative shrink-0">
            <button
              className={cn(
                "flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[#4b5563] hover:text-[#111827]",
                (range.start || range.end) && "font-medium text-[#111827]",
              )}
              onClick={() => setOpenMenu((v) => (v === "time" ? null : "time"))}
            >
              {t("gallery.time")} <IconChevron size={11} />
            </button>
            {openMenu === "time" && (
              <div className={cn(MENU, "min-w-[264px] p-2")}>
                <div className="flex items-center gap-1.5 rounded-md bg-[#f3f4f6] px-2.5 py-2">
                  <input
                    type="date"
                    className="w-full min-w-0 bg-transparent text-[12px] text-[#111827] outline-none [color-scheme:light]"
                    value={range.start}
                    max={range.end || undefined}
                    onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
                  />
                  <span className="text-[#9ca3af]">-</span>
                  <input
                    type="date"
                    className="w-full min-w-0 bg-transparent text-[12px] text-[#111827] outline-none [color-scheme:light]"
                    value={range.end}
                    min={range.start || undefined}
                    onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
                  />
                </div>
                {([
                  { label: t("gallery.allTime"), active: !range.start && !range.end, apply: () => setRange({ start: "", end: "" }) },
                  { label: t("gallery.last7Days"), active: activePreset(range, 7), apply: () => setRange(presetRange(7)) },
                  { label: t("gallery.last30Days"), active: activePreset(range, 30), apply: () => setRange(presetRange(30)) },
                  { label: t("gallery.last3Months"), active: activePreset(range, 90), apply: () => setRange(presetRange(90)) },
                ] as const).map((o) => (
                  <button
                    key={o.label}
                    className="mt-1 flex w-full cursor-pointer items-center justify-between gap-3 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-[#374151] transition-colors hover:bg-[#f3f4f6]"
                    onClick={() => {
                      o.apply();
                      setOpenMenu(null);
                    }}
                  >
                    <span>{o.label}</span>
                    {o.active && <CheckMark on />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative shrink-0">
            <button
              className="flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[#4b5563] hover:text-[#111827]"
              onClick={() => setOpenMenu((v) => (v === "sort" ? null : "sort"))}
            >
              {t("gallery.sort")} <IconChevron size={11} />
            </button>
            {openMenu === "sort" && (
              <div className={cn(MENU, "min-w-[180px] py-1.5")}>
                <div className="px-3 pt-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-[#9ca3af]">{t("gallery.order")}</div>
                {(["newest", "oldest"] as SortOrder[]).map((k) => (
                  <button
                    key={k}
                    className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md border-0 bg-transparent px-3 py-[7px] text-left text-[#374151] transition-colors hover:bg-[#f3f4f6]"
                    onClick={() => {
                      setSortOrder(k);
                      setOpenMenu(null);
                    }}
                  >
                    <span className={cn(sortOrder === k && "font-medium text-[#111827]")}>{t(`gallery.${k}`)}</span>
                    {sortOrder === k && <CheckMark on />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      <div
        ref={scrollRef}
        className={cn("scrollbar-none flex-1 overflow-y-auto bg-[#f7f8fa]", manage && "select-none")}
        onPointerDown={onGridPointerDown}
        onPointerMove={onGridPointerMove}
        onPointerUp={onGridPointerUp}
        onPointerCancel={() => setMarquee(null)}
      >
        {loading ? (
          <div className="grid min-h-[50vh] place-items-center text-[#9ca3af]">
            <div className="size-7 animate-spin rounded-full border-2 border-[#dbeafe] border-t-[#2563eb]" />
          </div>
        ) : error ? (
          <div className="grid min-h-[50vh] place-items-center text-xs text-[#dc2626]">
            {t("gallery.failed")}：{error}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex min-h-[50vh] flex-col items-center justify-center p-4 text-center animate-[fadeInUp_.7s]">
            <IconLibrary size={38} style={{ color: "#cbd5e1", marginBottom: 14 }} />
            <h1 className="m-0 mb-3 text-[24px] font-semibold tracking-tight text-[#1f2937]">
              {items.length === 0 ? t("gallery.empty") : t("gallery.emptySearch")}
            </h1>
            <p className="m-0 max-w-[480px] text-[13px] leading-relaxed text-[#6b7280]">
              {items.length === 0 ? t("gallery.emptySearch") : t("gallery.empty")}
            </p>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[1280px] px-2 pt-3 pb-8 animate-[fadeInUp_.35s]">
            {groups.map((g) => (
              <section key={g.key} className="mb-8 last:mb-0">
                <h2 className="mb-3 text-[23px] font-normal leading-none tracking-[-.03em] text-[#111827]">{dateLabel(t, g.key)}</h2>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[2px]">
                  {g.items.map((entry) => {
                    const it = entry.item;
                    const img = isImage(it);
                    return (
                      <div
                        data-gid={it.id}
                        className={cn(
                          "group/gallery-card relative aspect-square cursor-pointer overflow-hidden rounded-[2px] bg-[#e5e7eb] transition-[box-shadow] duration-150 hover:z-10 hover:shadow-[0_3px_14px_rgba(15,23,42,.18)]",
                          selected.has(it.id) && "z-[2] shadow-[0_0_0_2px_#2563eb]",
                        )}
                        key={entry.key}
                        onClick={() => (manage ? toggleSelect(it.id) : openDetail(entry))}
                      >
                        {entry.thumbnail && img ? (
                          <img className="block h-full w-full object-cover" src={entry.thumbnail} alt="" loading="lazy" />
                        ) : entry.thumbnail && !img ? (
                          <>
                            <img className="block h-full w-full object-cover" src={entry.thumbnail} alt="" loading="lazy" />
                            <div className="absolute inset-0 grid place-items-center bg-black/10">
                              <span className="grid size-9 place-items-center rounded-full bg-black/55 text-white">
                                <IconPlay size={14} />
                              </span>
                            </div>
                          </>
                        ) : (
                          <div className="grid h-full w-full place-items-center bg-[#e5e7eb] text-[#6b7280]">
                            <span className="grid size-9 place-items-center rounded-full bg-white/80">
                              {img ? <IconLibrary size={14} /> : <IconPlay size={14} />}
                            </span>
                          </div>
                        )}

                        {manage && (
                          <div
                            className={cn(
                              "absolute top-1.5 left-1.5 z-[3] grid size-5 place-items-center rounded-full border border-white bg-white/80 text-[11px] font-bold text-white shadow-sm",
                              selected.has(it.id) && "border-[#2563eb] bg-[#2563eb]",
                            )}
                          >
                            {selected.has(it.id) && "✓"}
                          </div>
                        )}

                        <div className="absolute top-1.5 right-1.5 z-[3] flex gap-1 opacity-0 transition-opacity duration-150 group-hover/gallery-card:opacity-100 group-focus-within/gallery-card:opacity-100">
                          <button
                            title={it.starred ? t("gallery.unstar") : t("gallery.star")}
                            className={cn(
                              "grid size-7 cursor-pointer place-items-center rounded-full border border-white/70 bg-black/45 text-white backdrop-blur-sm hover:bg-white hover:text-[#111827]",
                              it.starred && "opacity-100 text-[#f9a8d4]",
                            )}
                            onClick={(e) => cardAction(e, () => toggleStar(it))}
                          >
                            <IconStar size={13} filled={it.starred} />
                          </button>
                          <button
                            title={t("gallery.delete")}
                            className="grid size-7 cursor-pointer place-items-center rounded-full border border-white/70 bg-black/45 text-white backdrop-blur-sm hover:bg-[#dc2626]"
                            onClick={(e) => cardAction(e, () => removeOne(it))}
                          >
                            <IconTrash size={12} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {marquee && (
        <div
          className="pointer-events-none fixed z-[60] border border-[#2563eb] bg-[#2563eb]/10"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}

      {detailIdx != null && (
        <DetailPanel
          sources={detailSources}
          index={detailIdx}
          onClose={closeDetail}
          onNavigate={goDetail}
        />
      )}
    </div>
  );
}
