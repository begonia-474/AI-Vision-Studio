// 底部胶囊输入区
// 顶部：参考图缩略行 + 自动增高 textarea
// 底部：控件行（模型 / 比例 / 画质 / 时长 / 批量 / Draw）+ Generate
// 弹层基于 shadcn/Radix Popover，互斥打开由 openOne 统一管理。

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelDropdown } from "./ModelDropdown";
import { ParamPopover } from "./Popover";
import {
  IconAspect,
  IconChevron,
  IconDuration,
  IconQuality,
  IconSparkles,
  IconUpload,
} from "../lib/icons";
import { PROVIDERS, providerMeta } from "../models/registry";
import type { StudioApi } from "../studios/useStudio";
import { Progress } from "./ui/progress";

interface PromptComposerProps {
  api: StudioApi;
}

export function PromptComposer({ api }: PromptComposerProps) {
  const { t } = useTranslation();
  const isVideo = api.studio === "video";
  const provider = PROVIDERS[api.model.providerId] ?? providerMeta(api.model.providerId);
  const [openModel, setOpenModel] = useState(false);
  const [openAr, setOpenAr] = useState(false);
  const [openQuality, setOpenQuality] = useState(false);
  const [openDuration, setOpenDuration] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 弹层互斥：打开一个前先关掉其余（保证任意时刻只有一个 Radix 弹层在场，
  // 避免旧弹层 deferPointerDownOutside 的焦点回迁把新弹层误关）。
  const closeOthers = () => {
    setOpenModel(false);
    setOpenAr(false);
    setOpenQuality(false);
    setOpenDuration(false);
  };
  const openOne = (set: (v: boolean) => void) => (o: boolean) => {
    if (o) {
      closeOthers();
      requestAnimationFrame(() => set(true));
    } else {
      set(false);
    }
  };

  const supportRef =
    isVideo ? api.model.capabilities.includes("i2v") : api.model.capabilities.includes("i2i");
  const maxRef = api.model.maxRef ?? 0;
  const canAddRef = supportRef && api.refs.length < Math.max(maxRef, 1);

  const onTextareaInput = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 250) + "px";
  };

  // 本地选图：用 FileReader 转 data url 作为参考图（演示用；真实链路可改为落盘路径）。
  const onPickRef = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => api.addRef(String(reader.result));
      reader.readAsDataURL(f);
    };
    input.click();
  };

  const phaseLabel = (phase: string) => {
    switch (phase) {
      case "submitting":
        return t("prompt.phaseSubmitting");
      case "downloading":
        return t("prompt.phaseDownloading");
      case "done":
        return t("prompt.phaseDone");
      case "failed":
        return t("prompt.phaseFailed");
      default:
        return phase;
    }
  };

  const showProgress = api.generating && api.progress;
  const failed = api.progress?.phase === "failed";

  return (
    <div className="prompt-composer">
      <div className="pc-top">
        {/* 参考图行 */}
        {(api.refs.length > 0 || canAddRef) && (
          <div className="upload-row">
            {api.refs.map((r, i) => (
              <div className="thumb-circle" key={i}>
                <img src={r} alt="" />
                <button
                  className="rmv"
                  aria-label={t("prompt.removeRef")}
                  onClick={() => api.removeRef(i)}
                >
                  ×
                </button>
              </div>
            ))}
            {canAddRef && (
              <button
                className="upload-btn"
                title={isVideo ? t("prompt.uploadI2v") : t("prompt.uploadI2i")}
                aria-label={isVideo ? t("prompt.uploadI2v") : t("prompt.uploadI2i")}
                onClick={onPickRef}
              >
                <IconUpload size={16} />
              </button>
            )}
          </div>
        )}

        <textarea
          ref={taRef}
          className="pc-textarea"
          placeholder={isVideo ? t("prompt.placeholderVideo") : t("prompt.placeholderImage")}
          aria-label={t("prompt.textareaLabel")}
          rows={1}
          value={api.prompt}
          onInput={onTextareaInput}
          onChange={(e) => api.setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              api.handleGenerate();
            }
          }}
        />
      </div>

      <div className="pc-footer">
        <div className="pc-controls">
          {/* 模型 */}
          <ModelDropdown
            open={openModel}
            onOpenChange={openOne(setOpenModel)}
            studio={api.studio}
            current={api.model}
            onSelect={api.selectModel}
            trigger={
              <button
                type="button"
                className={"ctrl-btn" + (openModel ? " active" : "")}
              >
                <span className="provider-logo" style={{ background: provider.color }}>
                  {provider.abbr}
                </span>
                <span className="ctrl-label">{api.model.name}</span>
                <IconChevron className="ctrl-chev" size={10} />
              </button>
            }
          />

          {/* 比例 */}
          <ParamPopover
            open={openAr}
            onOpenChange={openOne(setOpenAr)}
            title={t("prompt.aspectRatio")}
            options={api.model.aspectRatios}
            current={api.ar}
            onSelect={api.setAr}
            trigger={
              <button
                type="button"
                className={"ctrl-btn" + (openAr ? " active" : "")}
              >
                <IconAspect className="ctrl-ico" size={16} />
                <span className="ctrl-label">{api.ar}</span>
              </button>
            }
          />

          {/* 画质 */}
          <ParamPopover
            open={openQuality}
            onOpenChange={openOne(setOpenQuality)}
            title={t("prompt.resolution")}
            options={api.model.qualities}
            current={api.quality}
            onSelect={api.setQuality}
            trigger={
              <button
                type="button"
                className={"ctrl-btn" + (openQuality ? " active" : "")}
              >
                <IconQuality className="ctrl-ico" size={16} />
                <span className="ctrl-label">{api.quality}</span>
              </button>
            }
          />

          {/* 时长（仅视频） */}
          {isVideo && (
            <ParamPopover
              open={openDuration}
              onOpenChange={openOne(setOpenDuration)}
              title={t("prompt.duration")}
              options={(api.model.durations ?? []).map((d) => ({ value: d, label: `${d}s` }))}
              current={api.duration}
              onSelect={api.setDuration}
              trigger={
                <button
                  type="button"
                  className={"ctrl-btn" + (openDuration ? " active" : "")}
                >
                  <IconDuration className="ctrl-ico" size={16} />
                  <span className="ctrl-label">{api.duration}s</span>
                </button>
              }
            />
          )}

          {/* 批量（仅图像） */}
          {!isVideo && (
            <div className="ctrl-stepper">
              <button
                type="button"
                aria-label={t("prompt.lessBatch")}
                onClick={(e) => {
                  e.stopPropagation();
                  api.setBatch(Math.max(1, api.batch - 1));
                }}
              >
                −
              </button>
              <span className="stepper-val">
                {api.batch}/{api.model.maxRef ?? 4}
              </span>
              <button
                type="button"
                aria-label={t("prompt.moreBatch")}
                onClick={(e) => {
                  e.stopPropagation();
                  api.setBatch(Math.min(api.model.maxRef ?? 4, api.batch + 1));
                }}
              >
                +
              </button>
            </div>
          )}

          {/* Draw（仅图像，占位） */}
          {!isVideo && (
            <button
              className="ctrl-btn"
              onClick={(e) => {
                e.stopPropagation();
                alert(t("prompt.drawAlert"));
              }}
              title={t("prompt.drawTitle")}
            >
                <svg
                  className="ctrl-ico"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                <span className="ctrl-label">{t("prompt.draw")}</span>
              </button>
          )}
        </div>

        {/* Generate */}
        <button
          className="gen-action"
          disabled={api.generating || !provider.wired}
          onClick={(e) => {
            e.stopPropagation();
            api.handleGenerate();
          }}
          title={provider.wired ? t("prompt.shortcut") : t("prompt.notWired")}
        >
          <span>{api.generating ? t("prompt.generating") : t("prompt.generate")}</span>
          <IconSparkles size={14} />
        </button>
      </div>

      {/* 进度提示 */}
      {showProgress && (
        <div className={"gen-progress" + (failed ? " failed" : "")}>
          <span>{phaseLabel(api.progress!.phase)}</span>
          {!failed && <Progress className="pb" value={api.progress!.progress} />}
          {failed && <span style={{ color: "var(--danger)" }}>{api.progress!.message}</span>}
        </div>
      )}
    </div>
  );
}
