// 结果网格 + 空态
// loading 卡显示 spinner；done 卡显示本地产物 + hover 操作（下载/删除/图生视频）；
// error 卡显示错误信息。空 results 时渲染 4 漂浮卡空态。

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
                <div className="spinner" />
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
                    <button className="i2v" onClick={(e) => { e.stopPropagation(); onImageToVideo(it.url ?? "", it.prompt); }}>
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
