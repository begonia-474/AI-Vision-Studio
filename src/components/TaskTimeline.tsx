// 对话式任务时间线
// 每条任务 = 一条"消息"：用户气泡（prompt + 参数 chips + 提交时间）+ 生成区
//   loading → 假进度百分比 + 阶段文案；error → 红条错误；done → 结果图网格（批量 n 图）。
// 新任务追加到底部并自动贴底滚动；用户上滚查看历史时停止跟随（聊天式直觉）。
// 多任务并行：每个任务独立状态，进度事件按 taskId 路由（见 useStudio）。

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openPath } from "@tauri-apps/plugin-opener";
import { IconDownload, IconMore, IconPlay, IconRefresh, IconTrash, IconVideo } from "../lib/icons";
import { cn } from "../lib/utils";
import type { ResultItem, ResultStatus } from "../studios/sessionStore";
import type { ModelDef } from "../models/registry";

interface TaskTimelineProps {
  results: ResultItem[];
  studio: "image" | "video";
  model: ModelDef;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onBottomStateChange?: (atBottom: boolean) => void;
  onImageToVideo?: (src: string, prompt: string) => void;
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
  extra: string;
  phase?: string;
  items: ResultItem[];
}

const phaseLabel = (t: (k: string) => string, phase?: string) => {
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

const mediaAspect = (ar: string) => {
  const [w, h] = ar.split(":").map(Number);
  return w > 0 && h > 0 ? `${w} / ${h}` : "1 / 1";
};

// 装饰性进度动画：厂商无法提供真实进度（只能等完成取结果），
// 模拟"快速爬升 → 在 ~90% 附近减速停住"的自然形态，不无限循环；
// 真实完成后任务切换为 done，百分比自然消失。
function FakePct() {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    let v = 0;
    const id = setInterval(() => {
      if (v < 3) {
        v = 3 + Math.random() * 4; // 起步
      } else {
        v = 90 - (90 - v) * (0.82 + Math.random() * 0.08); // 渐近收敛到 ~90
      }
      setPct(Math.floor(v));
    }, 150);
    return () => clearInterval(id);
  }, []);
  return <span className="text-[30px] font-extrabold tracking-wide text-primary drop-shadow-[0_0_24px_rgba(59,130,246,.40)]">{pct}%</span>;
}

const FLOAT_TINT = [
  "radial-gradient(circle at 50% 40%, rgba(59,130,246,.18), transparent 70%)",
  "radial-gradient(circle at 50% 40%, rgba(96,165,250,.18), transparent 70%)",
  "radial-gradient(circle at 50% 40%, rgba(59,130,246,.18), transparent 70%)",
  "radial-gradient(circle at 50% 40%, rgba(96,165,250,.18), transparent 70%)",
];

const FC_BASE =
  "h-[112px] w-24 shrink-0 overflow-hidden rounded-2xl border border-border-4 bg-chip shadow-[0_10px_30px_var(--shadow)] transition-all duration-300 hover:z-20 hover:scale-110 hover:rotate-0";
const FC_POS = ["-rotate-12", "-rotate-4 -ml-4", "size-24 rounded-full rotate-6 -ml-4", "rotate-12 -ml-4"];

export function TaskTimeline({
  results,
  studio,
  model,
  scrollRef,
  onBottomStateChange,
  onImageToVideo,
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
          extra: it.extra,
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
  const [menuTask, setMenuTask] = useState<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const next = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      stick.current = next;
      onBottomStateChange?.(next);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [onBottomStateChange, scrollRef]);

  // ⋯ 菜单：点击外部关闭
  useEffect(() => {
    if (!menuTask) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-tl-menu]")) setMenuTask(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuTask]);

  // 贴底跟随 + 挂载时强制回到底部：
  // - 挂载（重启 / 切换会话 / 历史恢复）时强制滚到底，并等图片加载、布局稳定后补滚；
  // - 后续结果变化仅在用户位于底部附近时跟随；
  // - 所有补滚回调都在执行时校验 stick：用户已上滚则放弃，避免"突然跳回底部"。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const scroll = () => {
      if (!stick.current) return;
      el.scrollTop = el.scrollHeight;
    };
    if (!stick.current) return;
    scroll();
    const raf = requestAnimationFrame(scroll);
    const onLoad = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    };
    const imgs = Array.from(el.querySelectorAll("img"));
    imgs.forEach((img) => img.addEventListener("load", onLoad, { once: true }));
    const t = window.setTimeout(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
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
          <span className="text-[40px] font-black uppercase tracking-tight text-primary">{model.name}</span>
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
              <button
                className="w-fit min-w-48 max-w-96 cursor-pointer rounded-xl bg-chip p-5 text-left text-sm leading-relaxed text-foreground transition-[background-color,scale] duration-200 ease-out active:scale-[0.995] hover:bg-hover"
                title={t("common.open")}
                onClick={() => {
                  const first = g.items.find((it) => it.url);
                  if (first?.url) window.open(first.url, "_blank");
                }}
              >
                <div className="max-h-[200px] overflow-y-auto [scrollbar-color:var(--scroll-thumb)_transparent] [scrollbar-width:thin] hover:[scrollbar-color:var(--scroll-thumb)_transparent]">
                  {g.prompt}
                </div>
              </button>
              <div className="mt-2 flex w-full flex-wrap items-center justify-between gap-1.5 pl-1">
                <div className="ml-1 flex flex-wrap justify-end gap-1.5">
                  <span className="flex w-fit items-center gap-1 rounded-lg bg-chip px-2 py-1 text-xs font-medium text-text-3">{g.model}</span>
                  <span className="flex w-fit items-center gap-1 rounded-lg bg-chip px-2 py-1 text-[11px] font-medium text-text-3">{g.ar}</span>
                  <span className="flex w-fit items-center gap-1 rounded-lg bg-chip px-2 py-1 text-[11px] font-medium text-text-3">{g.extra}</span>
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
                <div className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-2">
                  {g.items.map((it) => (
                    <div
                      className="grid min-w-0 place-items-center overflow-hidden rounded-xl border border-dashed border-border-3 bg-card-shade"
                      key={it.id}
                      style={{ aspectRatio: mediaAspect(g.ar) }}
                    >
                      <FakePct />
                    </div>
                  ))}
                </div>
                {g.phase && <span className="self-end text-[11px] text-text-2">{phaseLabel(t, g.phase)}</span>}
              </div>
            )}
            {g.status === "error" && (
              <div className="min-w-0 rounded-md border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.06)] px-4 py-3.5 text-xs leading-relaxed break-words text-destructive" role="alert">
                {g.items[0]?.error ?? t("common.generationFailed")}
              </div>
            )}
            {g.status === "done" && (
              <>
                <div className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-2">
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
                            <img
                              src={it.url}
                              alt=""
                              className="block w-full object-contain xl:max-h-[45vh]"
                              style={{ aspectRatio: mediaAspect(g.ar), position: "absolute", inset: 0 }}
                            />
                            <div className="absolute inset-0 grid place-items-center before:absolute before:inset-0 before:content-[''] before:bg-black/25">
                              <IconPlay size={16} className="relative size-12 rounded-full border border-border-4 bg-btn-dark p-4 text-foreground backdrop-blur-[8px]" />
                            </div>
                          </>
                        )}

                        {/* hover 渐变遮罩 */}
                        <div className="pointer-events-none absolute inset-x-0 top-0 h-24 rounded-t-xl bg-linear-to-b from-black/30 via-black/15 via-40% to-transparent opacity-0 transition-opacity duration-150 group-hover/image:opacity-100" />
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-44 rounded-b-xl bg-linear-to-t from-black/30 via-black/15 via-40% to-transparent opacity-0 transition-opacity duration-150 group-hover/image:opacity-100" />

                        {/* 右上 ⋯ 菜单 */}
                        <div className="absolute top-0.5 right-1 z-10 opacity-0 transition-opacity duration-100 group-hover/image:opacity-100">
                          <div className="relative" data-tl-menu>
                            <button
                              className="grid h-9 w-9 cursor-pointer place-items-center border-0 bg-transparent text-white [filter:drop-shadow(0_0_4px_rgba(0,0,0,0.5))]"
                              title={t("gallery.more")}
                              aria-label={t("gallery.more")}
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenuTask((v) => (v === g.taskId ? null : g.taskId));
                              }}
                            >
                              <IconMore size={18} />
                            </button>
                            {menuTask === g.taskId && (
                              <div className="absolute top-9 right-0 z-30 min-w-[140px] rounded-lg border border-border-3 bg-overlay p-1.5 text-xs shadow-[0_10px_30px_var(--shadow-lg)] backdrop-blur-xl">
                                <button
                                  className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-text-2 hover:bg-accent hover:text-primary"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (it.url) window.open(it.url, "_blank");
                                    setMenuTask(null);
                                  }}
                                >
                                  <IconDownload size={13} /> {t("common.open")}
                                </button>
                                <button
                                  className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-destructive hover:bg-[rgba(239,68,68,.10)]"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setMenuTask(null);
                                    onDeleteTask(g.taskId);
                                  }}
                                >
                                  <IconTrash size={13} /> {t("result.deleteTask")}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* 底部操作条：Vary / Edit / Video + Download（krea 风格：无底色，hover 才浮现黑底） */}
                        <div className="absolute inset-x-1 bottom-1 z-10 flex items-end justify-between text-xs font-medium text-white opacity-0 transition-[translate,opacity] duration-150 ease-out translate-y-2 group-hover/image:translate-y-0 group-hover/image:opacity-100">
                          <div className="pointer-events-none flex flex-col-reverse">
                            <button
                              className="pointer-events-auto flex w-fit cursor-pointer items-center gap-1 rounded-lg p-1.5 transition-[background-color,backdrop-filter] duration-100 hover:bg-black/40 hover:backdrop-blur-lg [filter:drop-shadow(0_0_4px_rgba(0,0,0,0.5))]"
                              title={t("result.regenerate")}
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
                              title={t("gallery.reEdit")}
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
                            {studio === "image" && onImageToVideo && (
                              <button
                                className="group/arrowbtn pointer-events-auto flex w-fit cursor-pointer items-center gap-1 rounded-lg p-1.5 transition-[background-color,backdrop-filter] duration-100 hover:bg-black/40 hover:backdrop-blur-lg [filter:drop-shadow(0_0_4px_rgba(0,0,0,0.5))]"
                                title={t("result.imgToVideo")}
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
                            title={t("common.open")}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (it.url) window.open(it.url, "_blank");
                            }}
                          >
                            <IconDownload size={14} />
                            <span>{t("gallery.download")}</span>
                          </button>
                        </div>
                    </div>
                  ))}
                </div>

                {/* 行级操作栏（整行 hover 上浮）：下载全部 / 删除 */}
                <div className="flex min-h-[28px] w-full flex-wrap items-center justify-end gap-1 text-xs font-medium text-text-3 transition-[translate,opacity] duration-150 ease-out translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100">
                  <button
                    className="flex w-fit cursor-pointer items-center gap-1 rounded-lg p-1.5 transition-colors duration-100 hover:bg-hover"
                    title={t("gallery.download")}
                    onClick={() => {
                      const first = g.items.find((x) => x.path);
                      if (first?.path) {
                        void openPath(first.path, "reveal").catch(() => {});
                      }
                    }}
                  >
                    <IconDownload size={12} /> {t("gallery.downloadAll")}
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
}
