// 对话式任务时间线
// 每条任务 = 一条"消息"：用户气泡（prompt + 参数 chips + 提交时间）+ 生成区
//   loading → 生成中动画（点阵画布 + 阶段文案）；error → 红条错误；done → 结果图网格（批量 n 图）。
// 新任务追加到底部并自动贴底滚动；用户上滚查看历史时停止跟随（聊天式直觉）。
// 多任务并行：每个任务独立状态，进度事件按 taskId 路由（见 useStudio）。

import { memo, useEffect, useMemo, useRef } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { openPath } from "@tauri-apps/plugin-opener";
import { IconDownload, IconImage, IconPlay, IconRefresh, IconTrash, IconVideo } from "../lib/icons";
import { cn } from "../lib/utils";
import { ImageGeneration, ImageGenerationLabel } from "./ImageGeneration";
import type { ResultItem, ResultStatus } from "../studios/sessionStore";

interface TaskTimelineProps {
  results: ResultItem[];
  studio: "image" | "video";
  /** 空状态页展示的当前模型名（仅文本，不含模型对象——时间线渲染的是任务快照，
   *  表单状态（选模型/改参数）变化时此 prop 必须稳定，保证 memo 跳过整树重渲染） */
  emptyModelName: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** 是否位于底部附近（滚动区让输入条展开/收起）。layout=true 表示该次变化由布局收缩（折叠动画让位）被动钳制产生，非用户滚动 */
  onBottomStateChange?: (atBottom: boolean, layout?: boolean) => void;
  onImageToVideo?: (src: string, prompt: string) => void;
  /** 以图生图：把该结果作为参考图带回工作室（i2i），可直接改提示词重新生成 */
  onImageToImage?: (src: string, prompt: string) => void;
  onDeleteTask: (taskId: string) => void;
  onRegenerate: (taskId: string) => void;
  /** 点击完成结果卡：打开作品详情 */
  onOpenDetail?: (item: ResultItem) => void;
  /** 编辑（krea Edit）：携带该结果参数跳转对应工作室 */
  onReEdit?: (item: ResultItem) => void;
}

interface TaskGroup {
  taskId: string;
  status: ResultStatus;
  at: number;
  prompt: string;
  model: string;
  ar: string;
  phase?: string;
  items: ResultItem[];
}

const phaseLabel = (t: TFunction, phase?: string) => {
  switch (phase) {
    case "submitting":
      return t("prompt.phaseSubmitting");
    case "running":
      return t("prompt.phaseRunning");
    case "downloading":
      return t("prompt.phaseDownloading");
    case "done":
      return t("prompt.phaseDone");
    case "failed":
      return t("prompt.phaseFailed");
    default:
      return phase || "";
  }
};

// 同时支持比例（"9:16"）与自定义像素尺寸（"1080x1920"）两种 ar 格式；
// 无法解析时回退正方形，避免卡片塌陷。
const parseAspect = (ar: string): [number, number] => {
  const [w, h] = ar.split(/[:x×]/).map(Number);
  return w > 0 && h > 0 ? [w, h] : [1, 1];
};
const mediaAspect = (ar: string) => {
  const [w, h] = parseAspect(ar);
  return `${w} / ${h}`;
};

// 网格列数自适应（完成态共用）：
// 竖图且 4 张及以上 → xl 4 列一行（每格窄、高度低于 45vh，纯图无卡片背景）；
// 其余（1-3 张 / 横图）→ 2 列（每格宽、竖图被 45vh 压缩露出卡片背景）。
const gridCols = (count: number, ar: string) => {
  const [w, h] = parseAspect(ar);
  const fourCols = count >= 4 && w <= h;
  return fourCols ? "grid-cols-1 gap-1 sm:grid-cols-2 xl:grid-cols-4" : "grid-cols-1 gap-1 sm:grid-cols-2";
};

// 分辨率徽标文本："1080x1920" → "1080 × 1920"；比例（"9:16"）原样显示。
const resolutionLabel = (ar: string) => {
  const m = /^(\d+)x(\d+)$/.exec(ar);
  return m ? `${m[1]} × ${m[2]}` : ar;
};

const FLOAT_TINT = [
  "radial-gradient(circle at 50% 40%, rgba(59,130,246,.18), transparent 70%)",
  "radial-gradient(circle at 50% 40%, rgba(96,165,250,.18), transparent 70%)",
  "radial-gradient(circle at 50% 40%, rgba(59,130,246,.18), transparent 70%)",
  "radial-gradient(circle at 50% 40%, rgba(96,165,250,.18), transparent 70%)",
];

const FC_BASE =
  "h-[112px] w-24 shrink-0 overflow-hidden rounded-2xl border border-border-4 bg-chip shadow-[0_10px_30px_var(--shadow)] transition-all duration-300 hover:z-20 hover:scale-110 hover:rotate-0";
const FC_POS = ["-rotate-12", "-rotate-4 -ml-4", "size-24 rounded-full rotate-6 -ml-4", "rotate-12 -ml-4"];

// memo：折叠/展开动画期间（仅输入条高度变化）时间线 props 不变则跳过重渲染，
// 避免几百张卡的 JSX 每帧重建导致卡顿。语言切换由 useTranslation 的
// useSyncExternalStore 订阅驱动，不受 memo 影响。
export const TaskTimeline = memo(function TaskTimeline({
  results,
  studio,
  emptyModelName,
  scrollRef,
  onBottomStateChange,
  onImageToVideo,
  onImageToImage,
  onDeleteTask,
  onRegenerate,
  onOpenDetail,
  onReEdit,
}: TaskTimelineProps) {
  const { t } = useTranslation();

  // 按 taskId 分组：一次提交（批量 n 图 / 单图）合并为一条时间线消息。
  const groups = useMemo(() => {
    const map = new Map<string, TaskGroup>();
    for (const it of results) {
      let g = map.get(it.taskId);
      if (!g) {
        g = {
          taskId: it.taskId,
          status: it.status,
          at: it.at,
          prompt: it.prompt,
          model: it.model,
          ar: it.ar,
          phase: it.phase,
          items: [],
        };
        map.set(it.taskId, g);
      }
      g.items.push(it);
    }
    const list = [...map.values()];
    for (const g of list) {
      g.phase = g.items[0]?.phase;
      g.status = g.items.some((x) => x.status === "loading")
        ? "loading"
        : g.items.some((x) => x.status === "error")
          ? "error"
          : "done";
    }
    return list;
  }, [results]);

  // 贴底滚动：在底部附近时跟随内容滚动；用户上滚则停止跟随。
  // 每次滚动都上报状态（不做去重），保证「原地展开」后一滚动就重新收起。
  // 注意：不在挂载时立即调用 onScroll()——否则高内容会把 stick 置为 false，
  // 导致重启 / 切换会话后无法自动回到底部。
  const stick = useRef(true);
  const lastScrollHeight = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      // 参照「内容末尾」（滚动区底部减去输入条预留）而非滚动区底部：预留随折叠动画伸缩时
      // 内容末尾固定不动，atBottom 判定不会被动画推远/拉近——否则展开把底部推远，
      // 继续滚动误判「离开底部」→ 折叠，形成「像没有最底部」的循环。
      // 预留高度由上层直写 DOM（style.paddingBottom），这里实时读取。
      const pad = parseFloat(getComputedStyle(el).paddingBottom) || 0;
      const near = el.scrollHeight - pad - el.scrollTop - el.clientHeight;
      // 滞回：已在底部时需上滚更远才判定离开，离开后回到底部附近即恢复跟随，
      // 避免停在阈值边缘时值翻转、折叠动画反复触发（卡顿源）。
      // 容差 = 输入条预留 padding + 40：用户滚到内容末尾（near≈pad）即视为贴底；
      // 固定 240px 会把「上滚停在最后两个任务之间」误判为贴底（loading 卡矮时距底 <240px），
      // 导致生成中任务的进度事件把已上滚的用户拉回底部。
      const next = near < (stick.current ? pad + 40 : 80);
      stick.current = next;
      // 折叠动画期间滚动区 padding 随输入条收缩 → scrollHeight 变小，
      // 浏览器会把 scrollTop 被动钳制回新底部并派发 scroll 事件。
      // 这类布局事件不算「用户滚回底部」，标记 layout 交给上层：只同步位置、不触发展开，
      // 否则会出现折叠到一半又被展开的抖动（且展开态输入条会一直遮挡结果网格）。
      const layoutShrink = el.scrollHeight < lastScrollHeight.current;
      lastScrollHeight.current = el.scrollHeight;
      onBottomStateChange?.(next, layoutShrink);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [onBottomStateChange, scrollRef]);

  // 贴底跟随 + 挂载时强制回到底部：
  // - 挂载（重启 / 切换会话 / 历史恢复）时强制滚到底，并等图片加载、布局稳定后补滚；
  // - 后续结果变化仅在用户位于底部附近时跟随；
  // - 布局签名过滤：进度事件（phase/msg 更新）不改变卡片布局，跳过跟随——
  //   生成中任务每 3-5s 收到 gen-progress，results 引用变化会重跑本 effect，
  //   用户上滚停住（容差内 stick 残留 true）时会被进度事件拉回底部（"过几秒突然跳底"）。
  // - 延迟补滚（图片加载/300ms 布局稳定）前实时校验贴底：图片可能加载数秒，
  //   期间用户已上滚——仅查 stick 会把已离开底部的用户拉回。
  const lastLayoutKey = useRef("");
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const key = results
      .map((r) => `${r.id}:${r.status}:${r.url ?? ""}:${r.taskId}:${r.prompt}:${r.ar}:${r.at}`)
      .join("~");
    if (key === lastLayoutKey.current) return;
    lastLayoutKey.current = key;
    const scroll = () => {
      if (!stick.current) return;
      el.scrollTop = el.scrollHeight;
    };
    if (!stick.current) return;
    scroll();
    const raf = requestAnimationFrame(scroll);
    const nearBottom = () => {
      if (!stick.current) return false;
      const pad = parseFloat(getComputedStyle(el).paddingBottom) || 0;
      return el.scrollHeight - pad - el.scrollTop - el.clientHeight < 80;
    };
    const onLoad = () => {
      if (nearBottom()) el.scrollTop = el.scrollHeight;
    };
    const imgs = Array.from(el.querySelectorAll("img"));
    imgs.forEach((img) => img.addEventListener("load", onLoad, { once: true }));
    const t = window.setTimeout(() => {
      if (nearBottom()) el.scrollTop = el.scrollHeight;
    }, 300);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
      imgs.forEach((img) => img.removeEventListener("load", onLoad));
    };
  }, [results, scrollRef]);

  if (groups.length === 0) {
    return (
      <div className="flex h-full min-h-[50vh] flex-col items-center justify-center p-4 text-center animate-[fadeInUp_.7s]">
        <div className="mb-10 flex items-center justify-center gap-3">
          {FLOAT_TINT.map((tint, i) => (
            <div className={cn(FC_BASE, FC_POS[i])} key={i} style={{ background: "var(--empty-card)" }}>
              <div style={{ width: "100%", height: "100%", background: tint }} />
            </div>
          ))}
        </div>
        <h1 className="m-0 mb-4 flex flex-col items-center gap-1 text-4xl font-extrabold tracking-tight">
          <span className="text-[30px] font-black uppercase tracking-[.05em] text-foreground/90">{t("result.startWith")}</span>
          <span className="text-[40px] font-black uppercase tracking-tight text-primary">{emptyModelName}</span>
        </h1>
        <p className="m-0 max-w-[480px] text-sm leading-relaxed text-muted-foreground">
          {studio === "video" ? t("result.descVideo") : t("result.descImage")}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1300px] flex-col gap-[30px] px-1 pb-6 pt-4 animate-[fadeInUp_.4s]">
      {groups.map((g) => (
        <div className="flex max-w-[1300px] flex-col items-start justify-end gap-4 p-1 md:flex-row md:gap-8" key={g.taskId}>
          {/* 左列：prompt 卡 + 模型徽章（krea 队列布局） */}
          <div className="flex w-full justify-end lg:w-1/4">
            <div className="group/metadata flex w-full flex-col items-end sm:w-fit">
              {/* 提示词卡：用 div（非 button）保证文本可拖选复制；
                  滚动隔离靠内层 overflow-y-auto + overscroll-contain（滚轮在卡片内滚动、不带动时间线）；
                  拖选结束（存在选区）时不触发点击打开，避免复制时误跳转 */}
              <div
                className="w-fit min-w-48 max-w-96 cursor-pointer select-text rounded-xl bg-chip p-5 text-left text-sm leading-relaxed text-foreground transition-[background-color,scale] duration-200 ease-out active:scale-[0.995] hover:bg-hover"
                role="button"
                tabIndex={0}
                title={t("common.open")}
                onClick={() => {
                  const sel = window.getSelection();
                  if (sel && sel.toString().trim()) return;
                  const first = g.items.find((it) => it.url);
                  if (first?.url) window.open(first.url, "_blank");
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  const first = g.items.find((it) => it.url);
                  if (first?.url) window.open(first.url, "_blank");
                }}
              >
                <div className="max-h-[200px] overflow-y-auto overscroll-contain [scrollbar-color:var(--scroll-thumb)_transparent] [scrollbar-width:thin] hover:[scrollbar-color:var(--scroll-thumb)_transparent]">
                  {g.prompt}
                </div>
              </div>
              <div className="mt-2 flex w-full flex-wrap items-center justify-between gap-1.5 pl-1">
                <div className="ml-1 flex flex-wrap justify-end gap-1.5">
                  <span className="flex w-fit items-center gap-1 rounded-lg bg-chip px-2 py-1 text-xs font-medium text-text-3">{g.model}</span>
                  <span className="flex w-fit items-center gap-1 rounded-lg bg-chip px-2 py-1 text-[11px] font-medium text-text-3">{g.ar}</span>
                  <span className="px-1 text-[11px] text-faint-2">
                    {new Date(g.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 右列：结果网格 + 行级操作（krea 队列布局） */}
          <div className="group relative w-full grow pt-2 md:pt-0 lg:w-2/3">
            {g.status === "loading" && (
              <div className="flex min-w-0 flex-col gap-2" aria-busy="true">
                {/* 生成中动画：与完成网格同布局同比例（每格一块生成画布，max-h 45vh 对齐结果卡），
                    完成后原格替换为结果图，无布局跳动。提示词在左侧气泡，这里不再重复。 */}
                <div className={cn("grid min-w-0", gridCols(g.items.length, g.ar))}>
                  {g.items.map((it) => (
                    <ImageGeneration
                      key={it.id}
                      resolution={resolutionLabel(g.ar)}
                      ratio={mediaAspect(g.ar)}
                    />
                  ))}
                </div>
                {g.phase && (
                  <div className="flex justify-end">
                    <ImageGenerationLabel text={phaseLabel(t, g.phase)} />
                  </div>
                )}
              </div>
            )}
            {g.status === "error" && (
              <div className="min-w-0 rounded-md border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.06)] px-4 py-3.5 text-xs leading-relaxed break-words text-destructive" role="alert">
                {g.items[0]?.error ?? t("common.generationFailed")}
              </div>
            )}
            {g.status === "done" && (
              <>
                <div className={cn("grid min-w-0", gridCols(g.items.length, g.ar))}>
                  {g.items.map((it) => (
                    <div
                      className="group/image relative min-w-0 cursor-pointer overflow-hidden rounded-xl bg-card transition-transform duration-250 ease-[cubic-bezier(.19,0,0,1)] hover:scale-[1.01] active:scale-[0.99]"
                      key={it.id}
                      role="group"
                      aria-label={t("result.cardGroup")}
                      onClick={() => onOpenDetail?.(it)}
                    >
                        {studio === "image" ? (
                          <img
                            src={it.url}
                            alt=""
                            loading="lazy"
                            className="block w-full object-contain xl:max-h-[45vh]"
                            style={{ aspectRatio: mediaAspect(g.ar) }}
                          />
                        ) : (
                          <>
                            {/* 视频卡：img 保持 in-flow 撑起卡片高度（absolute 会让网格行塌陷为 0，视频不可见） */}
                            <img
                              src={it.url}
                              alt=""
                              className="block w-full object-contain xl:max-h-[45vh]"
                              style={{ aspectRatio: mediaAspect(g.ar) }}
                            />
                            <div className="absolute inset-0 grid place-items-center before:absolute before:inset-0 before:content-[''] before:bg-black/25">
                              <IconPlay size={16} className="relative size-12 rounded-full border border-border-4 bg-btn-dark p-4 text-foreground backdrop-blur-[8px]" />
                            </div>
                          </>
                        )}

                        {/* hover 渐变遮罩 */}
                        <div className="pointer-events-none absolute inset-x-0 top-0 h-24 rounded-t-xl bg-linear-to-b from-black/30 via-black/15 via-40% to-transparent opacity-0 transition-opacity duration-150 group-hover/image:opacity-100" />
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-44 rounded-b-xl bg-linear-to-t from-black/30 via-black/15 via-40% to-transparent opacity-0 transition-opacity duration-150 group-hover/image:opacity-100" />

                        {/* 底部操作条：重新生成 / 编辑 / 以图生图 / 图生视频 + 在文件夹中显示
                            （产物在本地，不做"下载"，与图库/详情面板约定一致）。点卡片本体打开作品详情。 */}
                        <div className="absolute inset-x-1 bottom-1 z-10 flex items-end justify-between text-xs font-medium text-white opacity-0 transition-[translate,opacity] duration-150 ease-out translate-y-2 group-hover/image:translate-y-0 group-hover/image:opacity-100">
                          <div className="pointer-events-none flex flex-col-reverse">
                            <button
                              className="pointer-events-auto flex w-fit cursor-pointer items-center gap-1 rounded-lg p-1.5 transition-[background-color,backdrop-filter] duration-100 hover:bg-black/40 hover:backdrop-blur-lg [filter:drop-shadow(0_0_4px_rgba(0,0,0,0.5))]"
                              onClick={(e) => {
                                e.stopPropagation();
                                onRegenerate(g.taskId);
                              }}
                            >
                              <IconRefresh size={12} />
                              <span>{t("result.regenerate")}</span>
                            </button>
                            <button
                              className="group/arrowbtn pointer-events-auto flex w-fit cursor-pointer items-center gap-1 rounded-lg p-1.5 transition-[background-color,backdrop-filter] duration-100 hover:bg-black/40 hover:backdrop-blur-lg [filter:drop-shadow(0_0_4px_rgba(0,0,0,0.5))]"
                              onClick={(e) => {
                                e.stopPropagation();
                                onReEdit?.(it);
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                              </svg>
                              <span>{t("gallery.reEdit")}</span>
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={1.5}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="-ml-1 w-0 overflow-hidden opacity-0 transition-all duration-150 group-hover/arrowbtn:ml-0 group-hover/arrowbtn:w-3 group-hover/arrowbtn:opacity-50"
                              >
                                <path d="M7 7h10v10" />
                                <path d="M7 17 17 7" />
                              </svg>
                            </button>
                            {studio === "image" && onImageToImage && (
                              <button
                                className="group/arrowbtn pointer-events-auto flex w-fit cursor-pointer items-center gap-1 rounded-lg p-1.5 transition-[background-color,backdrop-filter] duration-100 hover:bg-black/40 hover:backdrop-blur-lg [filter:drop-shadow(0_0_4px_rgba(0,0,0,0.5))]"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onImageToImage(it.path ?? it.url ?? "", g.prompt);
                                }}
                              >
                                <IconImage size={15} />
                                <span>{t("result.imgToImage")}</span>
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth={1.5}
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  className="-ml-1 w-0 overflow-hidden opacity-0 transition-all duration-150 group-hover/arrowbtn:ml-0 group-hover/arrowbtn:w-3 group-hover/arrowbtn:opacity-50"
                                >
                                  <path d="M7 7h10v10" />
                                  <path d="M7 17 17 7" />
                                </svg>
                              </button>
                            )}
                            {studio === "image" && onImageToVideo && (
                              <button
                                className="group/arrowbtn pointer-events-auto flex w-fit cursor-pointer items-center gap-1 rounded-lg p-1.5 transition-[background-color,backdrop-filter] duration-100 hover:bg-black/40 hover:backdrop-blur-lg [filter:drop-shadow(0_0_4px_rgba(0,0,0,0.5))]"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onImageToVideo(it.path ?? it.url ?? "", g.prompt);
                                }}
                              >
                                <IconVideo size={15} />
                                <span>{t("result.imgToVideo")}</span>
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth={1.5}
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  className="-ml-1 w-0 overflow-hidden opacity-0 transition-all duration-150 group-hover/arrowbtn:ml-0 group-hover/arrowbtn:w-3 group-hover/arrowbtn:opacity-50"
                                >
                                  <path d="M7 7h10v10" />
                                  <path d="M7 17 17 7" />
                                </svg>
                              </button>
                            )}
                          </div>
                          <span className="flex-grow" />
                          <button
                            className="pointer-events-auto flex w-fit min-w-[28px] cursor-pointer items-center gap-1 rounded-lg p-1.5 transition-[background-color,backdrop-filter] duration-100 hover:bg-black/40 hover:backdrop-blur-lg [filter:drop-shadow(0_0_4px_rgba(0,0,0,0.5))]"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (it.path) void openPath(it.path, "reveal").catch(() => {});
                            }}
                          >
                            <IconDownload size={14} />
                            <span>{t("common.revealInFolder")}</span>
                          </button>
                        </div>
                    </div>
                  ))}
                </div>

                {/* 行级操作栏（整行 hover 上浮）：在文件夹中显示 / 删除 */}
                <div className="flex min-h-[28px] w-full flex-wrap items-center justify-end gap-1 text-xs font-medium text-text-3 transition-[translate,opacity] duration-150 ease-out translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100">
                  <button
                    className="flex w-fit cursor-pointer items-center gap-1 rounded-lg p-1.5 transition-colors duration-100 hover:bg-hover"
                    onClick={() => {
                      const first = g.items.find((x) => x.path);
                      if (first?.path) {
                        void openPath(first.path, "reveal").catch(() => {});
                      }
                    }}
                  >
                    <IconDownload size={12} /> {t("common.revealInFolder")}
                  </button>
                  <button
                    className="flex w-fit cursor-pointer items-center gap-1 rounded-lg p-1.5 transition-colors duration-100 hover:bg-red-500/15 hover:text-red-600"
                    onClick={() => onDeleteTask(g.taskId)}
                  >
                    <IconTrash size={14} /> {t("result.deleteTask")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
});
