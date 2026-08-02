// 结果网格 + 空态
// loading 卡显示阶段文案 + 假进度百分比动画（后端进度跳变/不精确，装饰性动画体验更好）；
// done 卡显示本地产物 + hover 操作（下载/删除/图生视频）；
// error 卡显示错误信息。空 results 时渲染 4 漂浮卡空态。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconDownload, IconPlay, IconTrash } from "../lib/icons";
import type { ResultItem } from "../studios/useStudio";
import type { ModelDef } from "../models/registry";

interface ResultGridProps {
  results: ResultItem[];
  studio: "image" | "video";
  model: ModelDef;
  onImageToVideo?: (src: string, prompt: string) => void;
  onDelete: (id: string) => void;
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

// 装饰性进度动画：厂商无法提供真实进度（只能等完成取结果），
// 模拟"快速爬升 → 在 ~90% 附近减速停住"的自然形态，不无限循环；
// 真实完成后卡片切换为 done，百分比自然消失。
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

// 空态漂浮卡占位（纯渐变色块，无网络依赖）
const FLOAT_TINT = [
  "radial-gradient(circle at 50% 40%, rgba(34,211,238,.18), transparent 70%)",
  "radial-gradient(circle at 50% 40%, rgba(168,85,247,.18), transparent 70%)",
  "radial-gradient(circle at 50% 40%, rgba(34,211,238,.18), transparent 70%)",
  "radial-gradient(circle at 50% 40%, rgba(168,85,247,.18), transparent 70%)",
];

export function ResultGrid({ results, studio, model, onImageToVideo, onDelete }: ResultGridProps) {
  const { t } = useTranslation();

  if (results.length === 0) {
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
    <div className="results-grid">
      {results.map((it) => {
        if (it.status === "loading") {
          return (
            <div className="result-card loading" key={it.id} aria-busy="true" role="group" aria-label={t("result.cardGroup")}>
              <div className="rimg">
                <FakePct />
              </div>
              <div className="rmeta">
                <p className="rprompt">{it.prompt}</p>
                <div className="rfoot">
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="model-tag">{it.model}</span>
                    <span className="ar-tag">
                      {it.ar} · {it.extra}
                    </span>
                  </div>
                </div>
                {it.phase && <span className="rphase">{phaseLabel(t, it.phase)}</span>}
              </div>
            </div>
          );
        }
        if (it.status === "error") {
          return (
            <div className="result-card err-card" key={it.id}>
              <div className="rimg" role="alert">{it.error ?? t("common.generationFailed")}</div>
              <div className="rmeta">
                <p className="rprompt">{it.prompt}</p>
                <div className="rfoot">
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="model-tag" style={{ color: "var(--danger)", background: "rgba(239,68,68,.10)", borderColor: "rgba(239,68,68,.20)" }}>
                      {t("common.failed")}
                    </span>
                    <span className="ar-tag">{it.ar}</span>
                  </div>
                  <div className="ract">
                    <button
                      title={t("common.delete")}
                      aria-label={t("common.delete")}
                      className="del"
                      onClick={() => onDelete(it.id)}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        }
        // done
        return (
          <div className="result-card" key={it.id} role="group" aria-label={t("result.cardGroup")}>
            {studio === "image" ? (
              <img className="rimg" src={it.url} alt="" />
            ) : (
              <div className="rimg" style={{ position: "relative", display: "grid", placeItems: "center" }}>
                <img src={it.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", position: "absolute", inset: 0 }} />
                <div
                  style={{
                    position: "relative", width: 48, height: 48, borderRadius: "50%",
                    background: "var(--btn-dark)", backdropFilter: "blur(8px)", border: "1px solid var(--border-4)",
                    display: "grid", placeItems: "center", color: "var(--text)",
                  }}
                >
                  <IconPlay size={16} />
                </div>
              </div>
            )}
            <div className="rhover">
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
                onClick={(e) => { e.stopPropagation(); onDelete(it.id); }}
              >
                <IconTrash size={14} />
              </button>
            </div>
            <div className="rmeta">
              <p className="rprompt">{it.prompt}</p>
              <div className="rfoot">
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="model-tag">{it.model}</span>
                  <span className="ar-tag">
                    {it.ar} · {it.extra}
                  </span>
                </div>
                {studio === "image" && onImageToVideo && (
                  <div className="ract">
                    <button className="i2v" onClick={(e) => { e.stopPropagation(); onImageToVideo(it.path ?? it.url ?? "", it.prompt); }}>
                      {t("result.imgToVideo")}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
