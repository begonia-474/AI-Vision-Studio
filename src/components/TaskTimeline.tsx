// 对话式任务时间线
// 每条任务 = 一条"消息"：用户气泡（prompt + 参数 chips + 提交时间）+ 生成区
//   loading → 假进度百分比 + 阶段文案；error → 红条错误；done → 结果图网格（批量 n 图）。
// 新任务追加到底部并自动贴底滚动；用户上滚查看历史时停止跟随（聊天式直觉）。
// 多任务并行：每个任务独立状态，进度事件按 taskId 路由（见 useStudio）。

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconDownload, IconPlay, IconRefresh, IconTrash } from "../lib/icons";
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
  onDeleteItem: (id: string) => void;
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
  return <span className="fake-pct">{pct}%</span>;
}

const FLOAT_TINT = [
  "radial-gradient(circle at 50% 40%, rgba(34,211,238,.18), transparent 70%)",
  "radial-gradient(circle at 50% 40%, rgba(168,85,247,.18), transparent 70%)",
  "radial-gradient(circle at 50% 40%, rgba(34,211,238,.18), transparent 70%)",
  "radial-gradient(circle at 50% 40%, rgba(168,85,247,.18), transparent 70%)",
];

export function TaskTimeline({
  results,
  studio,
  model,
  scrollRef,
  onBottomStateChange,
  onImageToVideo,
  onDeleteTask,
  onDeleteItem,
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
      <div className="empty-state">
        <div className="float-cards">
          {FLOAT_TINT.map((tint, i) => (
            <div className="fc" key={i} style={{ background: "var(--empty-card)" }}>
              <div style={{ width: "100%", height: "100%", background: tint }} />
            </div>
          ))}
        </div>
        <h1 className="empty-title">
          <span className="pre">{t("result.startWith")}</span>
          <span className="big">{model.name}</span>
        </h1>
        <p className="empty-desc">
          {studio === "video" ? t("result.descVideo") : t("result.descImage")}
        </p>
      </div>
    );
  }

  return (
    <div className="tl-stream">
      {groups.map((g) => (
        <div className="tl-item" key={g.taskId}>
          {/* 用户气泡：prompt + 参数 + 时间 + 删除 */}
          <div className="tl-user">
            <div className="tl-bubble">
              <div className="tl-prompt-wrap">
                <p className="tl-prompt">{g.prompt}</p>
              </div>
              <div className="tl-meta">
                <span className="model-tag">{g.model}</span>
                <span className="ar-tag">
                  {g.ar} · {g.extra}
                </span>
                <span className="tl-time">
                  {new Date(g.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                </span>
                <button
                  className="tl-del"
                  title={t("common.delete")}
                  aria-label={t("common.delete")}
                  onClick={() => onDeleteTask(g.taskId)}
                >
                  <IconTrash size={12} />
                </button>
              </div>
            </div>
          </div>

          {/* 生成区 */}
          {g.status === "loading" && (
            <div className="tl-gen tl-loading-wrap" aria-busy="true">
              <div className="tl-loading-grid">
                {g.items.map((it) => (
                  <div
                    className="tl-placeholder"
                    key={it.id}
                    style={{ aspectRatio: mediaAspect(g.ar) }}
                  >
                    <FakePct />
                  </div>
                ))}
              </div>
              {g.phase && <span className="tl-phase">{phaseLabel(t, g.phase)}</span>}
            </div>
          )}
          {g.status === "error" && (
            <div className="tl-gen tl-error" role="alert">
              {g.items[0]?.error ?? t("common.generationFailed")}
            </div>
          )}
          {g.status === "done" && (
            <div className="tl-gen tl-images">
              {g.items.map((it) => (
                <div
                  className="tl-img"
                  key={it.id}
                  role="group"
                  aria-label={t("result.cardGroup")}
                  style={{ aspectRatio: mediaAspect(g.ar) }}
                >
                  {studio === "image" ? (
                    <img src={it.url} alt="" loading="lazy" />
                  ) : (
                    <>
                      <img src={it.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", position: "absolute", inset: 0 }} />
                      <div className="tl-play">
                        <IconPlay size={16} />
                      </div>
                    </>
                  )}
                  <div className="tl-hover">
                    <button
                      className="dl"
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
                      className="del"
                      title={t("common.delete")}
                      aria-label={t("common.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteItem(it.id);
                      }}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                  <div className="tl-bottom">
                    <button
                      className="tl-regen"
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
                        className="tl-i2v"
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
