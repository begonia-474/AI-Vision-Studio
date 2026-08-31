// 图库视图（哩布风格）
// 顶部导航（生成历史 / 画布）+ 类型 tab（图片/视频）+ 筛选/时间/排序下拉，
// 右侧搜索与批量操作；内容按日期分组的 172px 方格图片墙，居中布局。
// 管理模式：批量操作展开面板（删除/下载/发布/收藏/取消选择）+ 鼠标左键框选。
// 画布尚未接入，点击弹窗提示；收藏/删除仍作用于原任务。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { deleteHistories, ensureThumbnails, listHistoryPage, onProgress, setStar, toAssetUrl } from "../api";
import { revealInFolder } from "../lib/reveal";
import type { HistoryTask, StudioJump } from "../types";
import { providerDisplayName } from "../models/registry";
import { freeParams, editJumpToStudio, parseLoras } from "../studios/sessionStore";
import type { SessionApi } from "../studios/sessionStore";
import { parseHistoryParams } from "../api";
import { IconChevron, IconDownload, IconLibrary, IconPlay, IconSearch, IconStar, IconTrash, IconUpload } from "../lib/icons";
import { cn } from "../lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { DetailPanel, type DetailSource } from "./DetailPanel";

type TypeFilter = "all" | "image" | "video";
type SortOrder = "newest" | "oldest";

interface GalleryViewProps {
  imageSession: SessionApi;
  videoSession: SessionApi;
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
  /** 该图在任务 local_paths 中的下标（详情面板按此显示对应张） */
  index: number;
  /** 归一化缓存中的日期分组键（审计#12：随条目携带，分组不再重复 dayKey） */
  day: string;
  thumbnail?: string;
  /** 缩略图缺失（旧数据）时回退显示的原图 URL */
  fallback?: string;
}

/** 条目标准化缓存（审计#12）：原先 visible/sorted/entries/groups/resOptions/ratioOptions
 *  六条 useMemo 链各自对每条历史重复 JSON.parse 与 Date/尺寸推导（996 条时每次
 *  刷新数十万次解析）；此处按 id 单遍解析，所有派生链共用。 */
interface NormEntry {
  item: HistoryTask;
  paths: string[];
  params: Record<string, unknown> | null;
  day: string;
  ts: number;
  res: string | null;
  ratio: string | null;
}

/** 「重新编辑」：从数据库 params_json 还原参数快照（model 字段即 ModelDef.id）。
 *  与时间线入口共用 parse_history_params 命令，保证图库/时间线回填同源（解析权威在 Rust
 *  params.rs）。审计#12：改为消费 NormEntry（解析结果），避免再次 JSON.parse。 */
const buildReEditFrom = async (norm: NormEntry): Promise<StudioJump & { studio: "image" | "video" }> => {
  const it = norm.item;
  const isImg = isImage(it);
  const first = norm.paths[0];
  // 参考图优先取数据库 params_json.references（i2i/i2v 都保留原参考图，与时间线同源）；
  // 旧数据无该字段时按能力回退：i2i 用第一张产物当参考图，i2v 无参考图（按 t2v 生成）。
  if (it.params_json) {
    try {
      const e = await parseHistoryParams({
        studio: isImg ? "image" : "video",
        model: it.model,
        prompt: it.prompt,
        paramsJson: it.params_json,
      });
      const refs =
        e.refs && e.refs.length > 0
          ? e.refs
          : it.capability === "i2i" && first
            ? [toAssetUrl(first)]
            : undefined;
      return { studio: isImg ? "image" : "video", ...editJumpToStudio(e), refs };
    } catch {
      // paramsJson 损坏回退散装快照
    }
  }
  const refs = it.capability === "i2i" && first ? [toAssetUrl(first)] : undefined;
  return { studio: isImg ? "image" : "video", prompt: it.prompt, modelId: it.model, refs };
};

// 缩略图命名约定：thumbs 目录 `{stem}.thumb.webp`（后端 make_thumbnail 输出，镜像产物日期子路径
// outputs\YYYY\MM\DD → thumbs\YYYY\MM\DD；旧平铺数据回退 thumbs 根），
// 网格按产物路径推导渲染（产物父目录 outputs → thumbs），缺缩略图时由 <img onError> 回退原图。
const thumbOf = (p: string): string => {
  const i = p.lastIndexOf(".");
  if (i <= 0) return p;
  const sep = p.includes("/") ? "/" : "\\";
  const dirEnd = p.lastIndexOf(sep);
  if (dirEnd < 0) return p;
  const stem = p.slice(dirEnd + 1, i);
  // 替换 outputs 目录段为 thumbs（保留日期子路径），兼容旧平铺（outputs 在尾部）
  const dir = p.slice(0, dirEnd).replace(/(^|[\\/])outputs([\\/]|$)/i, "$1thumbs$2");
  return `${dir}${sep}${stem}.thumb.webp`;
};

// 按本地日期分组：返回 "YYYY-MM-DD"
const dayKey = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const dayNumber = (key: string): number => {
  const [year, month, day] = key.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
};

const dateLabel = (t: TFunction, key: string): string => {
  const now = new Date();
  const daysAgo = Math.round((dayNumber(dayKey(now.toISOString())) - dayNumber(key)) / 86400000);
  if (daysAgo === 0) return t("gallery.today");
  if (daysAgo === 1) return t("gallery.yesterday");
  if (daysAgo > 1 && daysAgo < 7) return t("gallery.daysAgo", { n: daysAgo });
  return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

// 分辨率 / 比例（来自 params.size "WxH"）。审计#12：原 sizeOf/resOf/ratioOf 各自
// 对同一任务反复 JSON.parse params_json；改为按已解析 params 入参的纯函数，
// 解析统一由 normCache 单遍完成。
const sizeFromParams = (params: Record<string, unknown> | null): { w: number; h: number } | null => {
  const s = params?.size;
  if (typeof s !== "string") return null;
  const m = /^(\d+)\s*[xX*]\s*(\d+)$/.exec(s.trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : null;
};
const resFromSize = (s: { w: number; h: number }): string => {
  const max = Math.max(s.w, s.h);
  if (max <= 1024) return "1K";
  if (max <= 2048) return "2K";
  if (max <= 4096) return "4K";
  return "8K";
};
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const ratioFromParams = (
  params: Record<string, unknown> | null,
  s: { w: number; h: number } | null,
): string | null => {
  // 优先提交时声明的 aspect_ratio（对所有模型准确）；旧数据缺失时按像素 gcd 推导。
  const ar = params?.aspect_ratio;
  if (typeof ar === "string" && ar) return ar;
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
        on ? "border-accent bg-accent text-white" : "border-border-3 bg-card text-transparent",
      )}
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  );
}

// 下拉菜单浅色样式（图库为浅色视图；主题令牌迁移后再统一）
const MENU =
  "rounded-lg border border-border-2 bg-card text-[12px] shadow-[var(--shadow-lg)]";
const MENU_ITEM = "justify-between text-text-2 focus:bg-surface-2 focus:text-text-2";
const MENU_LABEL = "px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-faint";
const MENU_SEP = "mx-3 my-1.5 h-px bg-line-soft";

export function GalleryView({ imageSession, videoSession, onImageToVideo, onImageToImage, onReEdit }: GalleryViewProps) {
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
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<"filter" | "time" | "sort" | null>(null);
  const [canvasOpen, setCanvasOpen] = useState(false);
  // 审计#12：框选拖动原先每帧 setState（整墙重渲染）；改为 ref 保存拖拽矩形 +
  // 直写 fixed overlay 的 style（不触发任何 React 渲染），pointerup 时一次性求交选中
  // （与 ImageStudio 输入条高度直写 DOM 同一先例）。
  const marqueeRef = useRef<HTMLDivElement | null>(null);
  const marqueeDragRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const aliveRef = useRef(true);
  const searchRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 审计#12：图库由一次全量 list_history（上千行 × 大字段 JSON 的单次序列化峰值）
  // 改为逐页拉满（每页 200 行，单次 payload 有界），筛选/排序语义不变（仍全量聚合）。
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const PAGE = 200;
      const rows: HistoryTask[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await listHistoryPage(PAGE, offset);
        rows.push(...page);
        if (page.length < PAGE) break;
      }
      if (aliveRef.current) {
        setItems(rows);
        setSelected((prev) => new Set([...prev].filter((id) => rows.some((x) => x.id === id))));
      }
    } catch (e) {
      if (aliveRef.current) {
        setError(typeof e === "string" ? e : (e as Error)?.message ?? "error");
      }
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  // 审计#12：图库打开期间后台任务完成事件可能密集（并行任务各自 done），每次
  // 都全量 listHistory + 重建标准化缓存（996 条）；用 1.2s 尾沿收敛合并刷新。
  const refreshTimerRef = useRef<number | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current != null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refresh();
    }, 1200);
  }, [refresh]);

  // 挂载时加载；生成结束（done / failed）后收敛刷新
  useEffect(() => {
    aliveRef.current = true;
    refresh();
    let un: (() => void) | undefined;
    onProgress((p) => {
      if (p.phase === "done" || p.phase === "failed") scheduleRefresh();
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
      if (refreshTimerRef.current != null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [refresh, scheduleRefresh]);

  // 旧数据补缩略图：后台生成缺失缩略图，完成后刷新列表让网格切到缩略图
  useEffect(() => {
    let alive = true;
    ensureThumbnails()
      .then((n) => {
        if (alive && n > 0) refresh();
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [refresh]);

  // 点击搜索区外部时收回；Escape 收回搜索/菜单并关闭详情
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node;
      if (searchRef.current && !searchRef.current.contains(node)) setSearchOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSearchOpen(false);
        setOpenMenu(null);
        setDetailKey(null);
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

  // 审计#12：条目一次标准化——visible/sorted/entries/groups/resOptions/ratioOptions
  // 六条 useMemo 链原先各自对每条历史重复 JSON.parse（local_paths_json/params_json）
  // 与 Date/尺寸推导（996 条时每次刷新数十万次解析）；此处按 id 单遍解析缓存，
  // 所有派生链共用，逐条消费时零解析。
  const normCache = useMemo(() => {
    const m = new Map<number, NormEntry>();
    for (const it of items) {
      const params = paramsOf(it);
      const s = sizeFromParams(params);
      m.set(it.id, {
        item: it,
        paths: localPaths(it),
        params,
        day: dayKey(it.created_at),
        ts: Date.parse(it.created_at),
        res: s ? resFromSize(s) : null,
        ratio: ratioFromParams(params, s),
      });
    }
    return m;
  }, [items]);
  const norms = useMemo(() => [...normCache.values()], [normCache]);

  const visible = useMemo(
    () =>
      norms.filter((n) => {
        const it = n.item;
        if (it.status !== "succeeded") return false; // 图库只展示成功产物（running/failed 行仅时间线可见）
        if (type !== "all" && isImage(it) !== (type === "image")) return false;
        if (starredOnly && !it.starred) return false;
        if (range.start && n.day < range.start) return false;
        if (range.end && n.day > range.end) return false;
        if (resSel.size > 0 && (!n.res || !resSel.has(n.res))) return false;
        if (ratioSel.size > 0 && (!n.ratio || !ratioSel.has(n.ratio))) return false;
        if (q) {
          const hay = (it.prompt + " " + it.model + " " + it.provider).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [norms, type, starredOnly, range, resSel, ratioSel, q],
  );

  const sorted = useMemo(
    () =>
      [...visible].sort((a, b) =>
        sortOrder === "newest" ? b.ts - a.ts : a.ts - b.ts,
      ),
    [visible, sortOrder],
  );

  // 一次批量生成可能包含多个文件，图库按单张结果铺开，但收藏/删除仍作用于原任务。
  const entries = useMemo<GalleryEntry[]>(
    () =>
      sorted.flatMap((n) => {
        const it = n.item;
        const paths = n.paths;
        const count = Math.max(paths.length, 1);
        return Array.from({ length: count }, (_, index) => {
          const image = isImage(it);
          // 第 1 张优先 thumbnail_path 字段（webp/png 兼容），其余按命名约定推导缩略图；
          // 旧数据推导的文件不存在时由 <img onError> 回退原图（fallback）。
          const thumb = image
            ? index === 0 && it.thumbnail_path
              ? it.thumbnail_path
              : thumbOf(paths[index] ?? "")
            : undefined;
          return {
            key: it.id + "-" + index,
            item: it,
            index,
            day: n.day,
            thumbnail: thumb ? toAssetUrl(thumb) : undefined,
            fallback: image && paths[index] ? toAssetUrl(paths[index]) : undefined,
          };
        });
      }),
    [sorted],
  );

  const groups = useMemo(() => {
    const map = new Map<string, GalleryEntry[]>();
    for (const entry of entries) {
      const group = map.get(entry.day);
      if (group) group.push(entry);
      else map.set(entry.day, [entry]);
    }
    return [...map.entries()].map(([key, items]) => ({ key, items }));
  }, [entries]);

  // 筛选面板的可选分辨率 / 比例（来自全部条目，随数据变化；消费 normCache 不再重复解析）
  const resOptions = useMemo(() => {
    const set = new Set<string>();
    for (const n of norms) if (n.res) set.add(n.res);
    return [...set].sort((a, b) => Number(a.replace("K", "")) - Number(b.replace("K", "")));
  }, [norms]);
  const ratioOptions = useMemo(() => {
    const set = new Set<string>();
    for (const n of norms) if (n.ratio) set.add(n.ratio);
    return [...set].sort((a, b) => {
      const [aw, ah] = a.split(":").map(Number);
      const [bw, bh] = b.split(":").map(Number);
      return bw / bh - aw / ah;
    });
  }, [norms]);

  const providerName = useCallback((it: HistoryTask) => providerDisplayName(it.provider, t), [t]);

  const toggleSelect = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // useCallback：detailSources 的 useMemo 依赖它（审计#12），引用必须稳定。
  const toggleStar = useCallback(async (it: HistoryTask) => {
    const next = !it.starred;
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, starred: next } : x)));
    try {
      await setStar(it.id, next);
    } catch {
      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, starred: !next } : x)));
    }
  }, []);

  // 删除确认（AGENTS.md：占位提示一律用 Dialog，禁原生 confirm）
  const [confirmDel, setConfirmDel] = useState<{ ids: number[]; n: number } | null>(null);

  const doDelete = async (ids: number[]) => {
    const idSet = new Set(ids);
    setConfirmDel(null);
    try {
      await deleteHistories(ids);
      setItems((prev) => prev.filter((x) => !idSet.has(x.id)));
      // 同步两个工作室会话时间线：产物已被后端删除，时间线里对应卡一并移除
      for (const id of ids) {
        imageSession.removeByHistoryId(id);
        videoSession.removeByHistoryId(id);
      }
      setSelected(new Set());
      setManage(false);
      closeDetail();
    } catch {
      /* 忽略，刷新兜底 */
    }
  };

  // useCallback：同上（审计#12），供 detailSources useMemo 依赖。
  const removeOne = useCallback((it: HistoryTask) => {
    setConfirmDel({ ids: [it.id], n: 1 });
  }, []);

  const removeSelected = () => {
    if (selected.size === 0) return;
    setConfirmDel({ ids: [...selected], n: selected.size });
  };

  // 下载 = 在文件管理器中定位第一个产物（审计#12：消费 normCache，不再重复解析）
  const downloadSelected = () => {
    const targets = items.filter((x) => selected.has(x.id));
    for (const it of targets) {
      const p = normCache.get(it.id)?.paths[0] ?? it.thumbnail_path;
      if (p) void revealInFolder(p);
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

  // 详情锚定：按条目 key 定位当前索引（entries 在后台任务完成刷新时重排，
  // 纯索引会让打开的面板静默切到别的作品）；条目消失（删除/筛选排除）时自动关闭。
  const detailIdx = detailKey ? entries.findIndex((e) => e.key === detailKey) : null;

  // 打开详情：记录当前所在网格位置，供详情左右切换
  const openDetail = (entry: GalleryEntry) => {
    setDetailKey(entry.key);
  };

  // useCallback：同上（审计#12），供 detailSources useMemo 依赖。
  const closeDetail = useCallback(() => {
    setDetailKey(null);
  }, []);

  const goDetail = (delta: number) => {
    if (detailIdx == null || detailIdx < 0) return;
    const next = detailIdx + delta;
    if (next < 0 || next >= entries.length) return;
    setDetailKey(entries[next].key);
  };

  // 详情数据源：由历史任务标准化而来（收藏/删除/跳转绑定原任务）。
  // 审计#12：原先每次渲染都全量 entries.map + 每条多次 JSON.parse，详情框关闭也在跑
  // （996 条时拖慢所有交互）；改为按 detailKey 门控的 useMemo——仅打开详情时计算一次，
  // 且消费 normCache 零解析。
  const detailSources = useMemo<DetailSource[]>(() => {
    if (detailKey == null) return [];
    return entries.map((entry): DetailSource => {
      const it = entry.item;
      const norm = normCache.get(it.id)!;
      const paths = norm.paths;
      const params = norm.params;
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
        pathIndex: entry.index,
        historyId: it.id,
        thumbnailPath: it.thumbnail_path ?? undefined,
        size,
        ratio: size ? (norm.ratio ?? undefined) : undefined,
        quality: typeof params?.quality === "string" ? params.quality : undefined,
        duration: typeof params?.duration === "string" ? params.duration : undefined,
        format: typeof params?.output_format === "string" ? params.output_format : undefined,
        optimizePromptMode:
          typeof params?.optimize_prompt_mode === "string" ? params.optimize_prompt_mode : undefined,
        background: typeof params?.background === "string" ? params.background : undefined,
        webSearch: typeof params?.web_search === "boolean" ? params.web_search : undefined,
        n: typeof params?.n === "number" ? params.n : undefined,
        params: freeParams(params ?? {}),
        loras: parseLoras(params?.loras),
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
          void buildReEditFrom(norm).then((j) => onReEdit?.(j));
        },
      };
    });
  }, [detailKey, entries, normCache, providerName, toggleStar, removeOne, closeDetail, onImageToVideo, onImageToImage, onReEdit]);

  // ===== 框选（仅管理模式）=====
  // 审计#12：拖动过程零 setState——overlay 位置经 ref 直写 style。
  const paintMarquee = () => {
    const d = marqueeDragRef.current;
    const el = marqueeRef.current;
    if (!d || !el) return;
    el.style.left = String(Math.min(d.x0, d.x1)) + "px";
    el.style.top = String(Math.min(d.y0, d.y1)) + "px";
    el.style.width = String(Math.abs(d.x1 - d.x0)) + "px";
    el.style.height = String(Math.abs(d.y1 - d.y0)) + "px";
    el.style.display = "block";
  };
  const hideMarquee = () => {
    marqueeDragRef.current = null;
    if (marqueeRef.current) marqueeRef.current.style.display = "none";
  };
  const onGridPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!manage || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-gid]")) return;
    marqueeDragRef.current = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    paintMarquee();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onGridPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = marqueeDragRef.current;
    if (!d) return;
    d.x1 = e.clientX;
    d.y1 = e.clientY;
    paintMarquee();
  };
  const onGridPointerUp = () => {
    const d = marqueeDragRef.current;
    hideMarquee();
    if (!d) return;
    const x0 = Math.min(d.x0, d.x1);
    const x1 = Math.max(d.x0, d.x1);
    const y0 = Math.min(d.y0, d.y1);
    const y1 = Math.max(d.y0, d.y1);
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
  };

  const batchBtn =
    "h-7 gap-1 rounded-md px-2 text-[12px] font-medium text-text-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex h-full flex-col bg-surface text-foreground">
      <header className="relative z-30 shrink-0 bg-surface">
        <div className="mx-auto flex w-full max-w-[1280px] items-center justify-between gap-4 px-2 pt-3">
          <nav className="flex items-center gap-2" aria-label={t("gallery.history")}>
            <Button variant="secondary" size="sm" className="h-9 rounded-[9px] px-4 text-[13px]" aria-current="page">
              {t("gallery.history")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 rounded-[9px] px-3 text-[13px] text-text-3 hover:bg-surface-2 hover:text-foreground"
              onClick={() => setCanvasOpen(true)}
            >
              {t("gallery.canvas")}
            </Button>
          </nav>

          {manage ? (
            <div className="ml-auto flex h-9 shrink-0 items-center gap-1 rounded-[9px] border border-border-2 bg-card px-2 shadow-[var(--shadow-xs)] animate-[fadeInUp_.15s]">
              <span className="px-1.5 text-[12px] font-medium whitespace-nowrap text-foreground">
                {t("gallery.selectedItems", { n: selected.size })}
              </span>
              <Button variant="ghost" className={batchBtn} disabled={selected.size === 0} onClick={removeSelected}>
                <IconTrash size={13} /> {t("common.delete")}
              </Button>
              <Button variant="ghost" className={batchBtn} disabled={selected.size === 0} onClick={downloadSelected}>
                <IconDownload size={13} /> {t("common.revealInFolder")}
              </Button>
              <Button variant="ghost" className={batchBtn} disabled>
                <IconUpload size={13} /> {t("gallery.publish")}
              </Button>
              <Button variant="ghost" className={batchBtn} disabled={selected.size === 0} onClick={starSelected}>
                <IconStar size={13} filled /> {t("gallery.star")}
              </Button>
              <span className="mx-1 h-4 w-px bg-muted" />
              <Button
                variant="ghost"
                className="h-7 rounded-md px-2 text-[12px] text-text-3 hover:bg-surface-2 hover:text-destructive"
                onClick={cancelSelect}
              >
                {t("gallery.cancelSelect")}
              </Button>
            </div>
          ) : (
            <div ref={searchRef} className="ml-auto flex h-9 items-center rounded-[9px] border border-border-2 bg-card text-[13px] shadow-[var(--shadow-xs)]">
              {searchOpen ? (
                <div className="flex items-center gap-2 px-3">
                  <IconSearch size={15} className="text-text-3" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("gallery.search")}
                    className="w-[190px] bg-transparent text-[12px] text-foreground outline-none placeholder:text-faint"
                  />
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-foreground hover:text-accent"
                  title={t("gallery.search")}
                  aria-label={t("gallery.search")}
                  onClick={() => setSearchOpen(true)}
                >
                  <IconSearch size={15} />
                </Button>
              )}
              <Button
                variant="ghost"
                className="h-full px-3 font-medium text-foreground hover:text-accent"
                onClick={() => {
                  setManage((v) => !v);
                  if (manage) setSelected(new Set());
                }}
              >
                {t("gallery.batch")}
              </Button>
            </div>
          )}
        </div>

        <div className="mx-auto flex w-full max-w-[1280px] min-h-[46px] items-center gap-6 px-2 pb-2 text-[12px] text-text-2">
          <div className="flex shrink-0 items-center gap-6" role="tablist">
            {(["image", "video"] as TypeFilter[]).map((k) => (
              <Button
                key={k}
                variant="ghost"
                role="tab"
                aria-selected={type === k}
                className={cn(
                  "h-auto gap-0 rounded-none p-0 font-normal transition-colors hover:text-foreground",
                  type === k ? "font-medium text-foreground" : "text-muted-foreground",
                )}
                onClick={() => setType(k)}
              >
                {t(`gallery.${k}`)}
              </Button>
            ))}
          </div>

          <div className="relative shrink-0">
            <DropdownMenu open={openMenu === "filter"} onOpenChange={(o) => setOpenMenu(o ? "filter" : null)}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className={cn(
                    "h-auto gap-1 rounded-none p-0 text-text-3 hover:text-foreground",
                    (starredOnly || type === "all" || resSel.size > 0 || ratioSel.size > 0) && "font-medium text-foreground",
                  )}
                >
                  {t("gallery.filter")} <IconChevron size={11} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className={cn(MENU, "min-w-[216px] py-2")}>
                <div className={MENU_LABEL}>{t("gallery.fGroupAction")}</div>
                <DropdownMenuItem className={MENU_ITEM} onSelect={(e) => e.preventDefault()} onClick={() => setStarredOnly((v) => !v)}>
                  <span>{t("gallery.starredOnly")}</span>
                  <CheckMark on={starredOnly} />
                </DropdownMenuItem>
                <DropdownMenuSeparator className={MENU_SEP} />
                <div className={MENU_LABEL}>{t("gallery.fGroupType")}</div>
                {(["image", "video"] as TypeFilter[]).map((k) => (
                  <DropdownMenuItem
                    key={k}
                    className={MENU_ITEM}
                    onSelect={(e) => e.preventDefault()}
                    onClick={() => setType(type === k ? "all" : k)}
                  >
                    <span>{t(`gallery.${k}`)}</span>
                    <CheckMark on={type === k} />
                  </DropdownMenuItem>
                ))}
                {resOptions.length > 0 && (
                  <>
                    <DropdownMenuSeparator className={MENU_SEP} />
                    <div className={MENU_LABEL}>{t("gallery.fGroupRes")}</div>
                    {resOptions.map((r) => (
                      <DropdownMenuItem key={r} className={MENU_ITEM} onSelect={(e) => e.preventDefault()} onClick={() => toggleFilterSet("res", r)}>
                        <span>{r}</span>
                        <CheckMark on={resSel.has(r)} />
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
                {ratioOptions.length > 0 && (
                  <>
                    <DropdownMenuSeparator className={MENU_SEP} />
                    <div className={MENU_LABEL}>{t("gallery.fGroupRatio")}</div>
                    {ratioOptions.map((r) => (
                      <DropdownMenuItem key={r} className={MENU_ITEM} onSelect={(e) => e.preventDefault()} onClick={() => toggleFilterSet("ratio", r)}>
                        <span>{r}</span>
                        <CheckMark on={ratioSel.has(r)} />
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="relative shrink-0">
            <DropdownMenu open={openMenu === "time"} onOpenChange={(o) => setOpenMenu(o ? "time" : null)}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className={cn(
                    "h-auto gap-1 rounded-none p-0 text-text-3 hover:text-foreground",
                    (range.start || range.end) && "font-medium text-foreground",
                  )}
                >
                  {t("gallery.time")} <IconChevron size={11} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className={cn(MENU, "min-w-[264px] p-2")}>
                <div className="flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-2">
                  <input
                    type="date"
                    className="w-full min-w-0 bg-transparent text-[12px] text-foreground outline-none [color-scheme:light]"
                    value={range.start}
                    max={range.end || undefined}
                    onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
                  />
                  <span className="text-faint">-</span>
                  <input
                    type="date"
                    className="w-full min-w-0 bg-transparent text-[12px] text-foreground outline-none [color-scheme:light]"
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
                  <DropdownMenuItem key={o.label} className={cn(MENU_ITEM, "mt-1 justify-between")} onClick={o.apply}>
                    <span>{o.label}</span>
                    {o.active && <CheckMark on />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="relative shrink-0">
            <DropdownMenu open={openMenu === "sort"} onOpenChange={(o) => setOpenMenu(o ? "sort" : null)}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-auto gap-1 rounded-none p-0 text-text-3 hover:text-foreground">
                  {t("gallery.sort")} <IconChevron size={11} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className={cn(MENU, "min-w-[180px] py-1.5")}>
                <div className={MENU_LABEL}>{t("gallery.order")}</div>
                {(["newest", "oldest"] as SortOrder[]).map((k) => (
                  <DropdownMenuItem
                    key={k}
                    className={cn(MENU_ITEM, "justify-between")}
                    onClick={() => setSortOrder(k)}
                  >
                    <span className={cn(sortOrder === k && "font-medium text-foreground")}>{t(`gallery.${k}`)}</span>
                    {sortOrder === k && <CheckMark on />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div
        ref={scrollRef}
        className={cn("scrollbar-none flex-1 overflow-y-auto bg-surface", manage && "select-none")}
        onPointerDown={onGridPointerDown}
        onPointerMove={onGridPointerMove}
        onPointerUp={onGridPointerUp}
        onPointerCancel={hideMarquee}
      >
        {loading ? (
          <div className="grid min-h-[50vh] place-items-center text-faint">
            <div className="size-7 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
          </div>
        ) : error ? (
          <div className="grid min-h-[50vh] place-items-center text-xs text-destructive">
            {t("gallery.failed")}：{error}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex min-h-[50vh] flex-col items-center justify-center p-4 text-center animate-[fadeInUp_.7s]">
            <IconLibrary size={38} className="text-faint-2" style={{ marginBottom: 14 }} />
            <h1 className="m-0 mb-3 text-[24px] font-semibold tracking-tight text-foreground">
              {items.length === 0 ? t("gallery.empty") : t("gallery.emptySearch")}
            </h1>
            <p className="m-0 max-w-[480px] text-[13px] leading-relaxed text-muted-foreground">
              {items.length === 0 ? t("gallery.emptyDesc") : t("gallery.emptySearchDesc")}
            </p>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[1280px] px-2 pt-3 pb-8 animate-[fadeInUp_.35s]">
            {groups.map((g) => (
              <section key={g.key} className="mb-8 last:mb-0">
                <h2 className="mb-3 text-[23px] font-normal leading-none tracking-[-.03em] text-foreground">{dateLabel(t, g.key)}</h2>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[2px]">
                  {g.items.map((entry) => {
                    const it = entry.item;
                    const img = isImage(it);
                    return (
                      <div
                        data-gid={it.id}
                        className={cn(
                          "group/gallery-card relative aspect-square cursor-pointer overflow-hidden rounded-[2px] bg-muted transition-[box-shadow] duration-150 hover:z-10 hover:shadow-[0_3px_14px_var(--shadow)]",
                          selected.has(it.id) && "z-[2] shadow-[0_0_0_2px_var(--accent)]",
                        )}
                        key={entry.key}
                        onClick={() => (manage ? toggleSelect(it.id) : openDetail(entry))}
                      >
                        {entry.thumbnail && img ? (
                          <img
                            className="block h-full w-full object-cover"
                            src={entry.thumbnail}
                            alt=""
                            loading="lazy"
                            onError={(e) => {
                              if (entry.fallback && e.currentTarget.src !== entry.fallback) {
                                e.currentTarget.src = entry.fallback;
                              }
                            }}
                          />
                        ) : entry.thumbnail && !img ? (
                          <>
                            <img
                              className="block h-full w-full object-cover"
                              src={entry.thumbnail}
                              alt=""
                              loading="lazy"
                              onError={(e) => {
                                if (entry.fallback && e.currentTarget.src !== entry.fallback) {
                                  e.currentTarget.src = entry.fallback;
                                }
                              }}
                            />
                            <div className="absolute inset-0 grid place-items-center bg-black/10">
                              <span className="grid size-9 place-items-center rounded-full bg-black/55 text-white">
                                <IconPlay size={14} />
                              </span>
                            </div>
                          </>
                        ) : (
                          <div className="grid h-full w-full place-items-center bg-muted text-muted-foreground">
                            <span className="grid size-9 place-items-center rounded-full bg-card/80">
                              {img ? <IconLibrary size={14} /> : <IconPlay size={14} />}
                            </span>
                          </div>
                        )}

                        {manage && (
                          <div
                            className={cn(
                              "absolute top-1.5 left-1.5 z-[3] grid size-5 place-items-center rounded-full border border-white bg-card/80 text-[11px] font-bold text-white shadow-sm",
                              selected.has(it.id) && "border-accent bg-accent",
                            )}
                          >
                            {selected.has(it.id) && "✓"}
                          </div>
                        )}

                        <div className="absolute top-1.5 right-1.5 z-[3] flex gap-1 opacity-0 transition-opacity duration-150 group-hover/gallery-card:opacity-100 group-focus-within/gallery-card:opacity-100">
                          <button
                            title={it.starred ? t("gallery.unstar") : t("gallery.star")}
                            className={cn(
                              "grid size-7 cursor-pointer place-items-center rounded-full border border-white/70 bg-black/45 text-white backdrop-blur-sm hover:bg-card hover:text-foreground",
                              it.starred && "opacity-100 text-[#f9a8d4]",
                            )}
                            onClick={(e) => cardAction(e, () => toggleStar(it))}
                          >
                            <IconStar size={13} filled={it.starred} />
                          </button>
                          <button
                            title={t("gallery.delete")}
                            className="grid size-7 cursor-pointer place-items-center rounded-full border border-white/70 bg-black/45 text-white backdrop-blur-sm hover:bg-destructive"
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

      {/* 框选 overlay：固定渲染、默认隐藏，拖动期经 ref 直写 style（审计#12，零 setState） */}
      <div
        ref={marqueeRef}
        className="pointer-events-none fixed z-[60] hidden border border-accent bg-accent/10"
      />

      {detailIdx != null && detailIdx >= 0 && (
        <DetailPanel
          sources={detailSources}
          index={detailIdx}
          onClose={closeDetail}
          onNavigate={goDetail}
        />
      )}

      {/* 删除确认 Dialog（替代原生 confirm） */}
      {confirmDel && (
        <Dialog open onOpenChange={(o) => !o && setConfirmDel(null)}>
          <DialogContent className="max-w-[340px] text-center">
            <DialogHeader>
              <DialogTitle className="text-sm">
                {confirmDel.n > 1
                  ? t("gallery.deleteConfirmMany", { n: confirmDel.n })
                  : t("gallery.deleteConfirm")}
              </DialogTitle>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:justify-center">
              <Button variant="outline" onClick={() => setConfirmDel(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="destructive" onClick={() => void doDelete(confirmDel.ids)}>
                {t("common.delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* 画布占位提示（待接入功能，Dialog 替代原生 alert） */}
      <Dialog open={canvasOpen} onOpenChange={setCanvasOpen}>
        <DialogContent className="max-w-[360px] text-center">
          <DialogHeader className="gap-3">
            <DialogTitle className="text-base">{t("gallery.canvas")}</DialogTitle>
            <span className="text-[13px] text-muted-foreground">{t("gallery.canvasAlert")}</span>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </div>
  );
}
