// 对话式任务时间线
// 每条任务 = 一条"消息"：用户气泡（prompt + 参数 chips + 提交时间）+ 生成区
//   loading → 假进度百分比 + 阶段文案；error → 红条错误；done → 结果图网格（批量 n 图）。
// 新任务追加到底部并自动贴底滚动；用户上滚查看历史时停止跟随（聊天式直觉）。
// 多任务并行：每个任务独立状态，进度事件按 taskId 路由（见 useStudio）。

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconDownload, IconPlay, IconRefresh, IconTrash } from "../lib/icons";
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

const tlHoverBtn =
  "grid size-8 cursor-pointer place-items-center rounded-full border border-border-4 bg-btn-dark text-foreground backdrop-blur-[8px] transition-all duration-150 hover:bg-primary hover:text-black";

export function TaskTimeline({
  results,
  studio,
  model,
  scrollRef,
  onBottomStateChange,
  onImageToVideo,
  onDeleteTask,
  onRegenerate,
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
  const stick = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const next = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      stick.current = next;
      onBottomStateChange?.(next);
    };
    onScroll();
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [onBottomStateChange, scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
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
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-[30px] px-1 pb-6 pt-4 animate-[fadeInUp_.4s]">
      {groups.map((g) => (
        <div className="grid items-start gap-x-[18px] grid-cols-[minmax(220px,.36fr)_minmax(0,1fr)] max-[760px]:flex max-[760px]:flex-col max-[760px]:gap-2.5" key={g.taskId}>
          {/* 用户气泡：prompt + 参数 + 时间（删除入口在产物卡右上角，整任务删除） */}
          <div className="flex justify-start">
            <div className="flex w-full max-w-none flex-col gap-1.5 rounded-[16px_16px_16px_4px] border border-border-2 bg-chip px-3.5 py-2.5">
              <div className="relative min-w-0">
                <p className="m-0 aspect-square overflow-y-auto whitespace-pre-wrap break-words pr-1 text-[13px] leading-relaxed text-foreground [scrollbar-color:var(--scroll-thumb)_transparent] [scrollbar-width:thin]">{g.prompt}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-[6px] border border-[rgba(59,130,246,.20)] bg-[rgba(59,130,246,.10)] px-2 py-0.5 text-[10px] font-bold capitalize text-primary">{g.model}</span>
                <span className="text-[10px] text-muted-foreground">
                  {g.ar} · {g.extra}
                </span>
                <span className="text-[10px] text-faint-2">
                  {new Date(g.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            </div>
          </div>

          {/* 生成区 */}
          {g.status === "loading" && (
            <div className="flex min-w-0 flex-col gap-2" aria-busy="true">
              <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
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
            <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {g.items.map((it) => (
                <div
                  className="group/img relative cursor-pointer overflow-hidden rounded-xl border border-border-4 bg-card transition-colors duration-300 hover:border-[rgba(59,130,246,.50)]"
                  key={it.id}
                  role="group"
                  aria-label={t("result.cardGroup")}
                  style={{ aspectRatio: mediaAspect(g.ar) }}
                >
                  {studio === "image" ? (
                    <img src={it.url} alt="" loading="lazy" className="block h-full w-full object-cover" />
                  ) : (
                    <>
                      <img src={it.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", position: "absolute", inset: 0 }} />
                      <div className="absolute inset-0 grid place-items-center before:absolute before:inset-0 before:content-[''] before:bg-black/25">
                        <IconPlay size={16} className="relative size-12 rounded-full border border-border-4 bg-btn-dark p-4 text-foreground backdrop-blur-[8px]" />
                      </div>
                    </>
                  )}
                  <div className="absolute top-2 right-2 z-10 flex flex-col gap-2 opacity-0 transition-opacity duration-200 group-hover/img:opacity-100">
                    <button
                      className={tlHoverBtn}
                      title={t("common.open")}
                      aria-label={t("common.open")}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (it.url) window.open(it.url, "_blank");
                      }}
                    >
                      <IconDownload size={14} />
                    </button>
                    <button
                      className={cn(tlHoverBtn, "hover:bg-destructive hover:text-white")}
                      title={t("result.deleteTask")}
                      aria-label={t("result.deleteTask")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteTask(g.taskId);
                      }}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                  <div className="absolute bottom-2 left-2 flex items-center gap-1.5 opacity-0 transition-opacity duration-200 group-hover/img:opacity-100">
                    <button
                      className="flex cursor-pointer items-center gap-1 rounded-full border border-border-4 bg-btn-dark px-3 py-1.5 text-[11px] font-bold text-foreground backdrop-blur-[8px] transition-all duration-150 hover:border-primary hover:bg-primary hover:text-black"
                      title={t("result.regenerate")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRegenerate(g.taskId);
                      }}
                    >
                      <IconRefresh size={12} />
                      {t("result.regenerate")}
                    </button>
                    {studio === "image" && onImageToVideo && (
                      <button
                        className="flex cursor-pointer items-center gap-1 rounded-full border border-[rgba(59,130,246,.10)] bg-primary px-3 py-1.5 text-[11px] font-bold text-black transition-all duration-150 hover:bg-accent-h"
                        onClick={(e) => {
                          e.stopPropagation();
                          onImageToVideo(it.path ?? it.url ?? "", g.prompt);
                        }}
                      >
                        {t("result.imgToVideo")}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
