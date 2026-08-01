// 底部胶囊输入区
// 顶部：参考图缩略行 + 自动增高 textarea
// 底部：控件行（模型 / 比例 / 画质 / 时长 / 批量 / Draw）+ Generate
// 各控件 popover 独立 open 状态，点击外部自动关闭（Popover 内置）。

import { useRef, useState } from "react";
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
import { PROVIDERS } from "../models/registry";
import type { StudioApi } from "../studios/useStudio";

interface PromptComposerProps {
  api: StudioApi;
}

export function PromptComposer({ api }: PromptComposerProps) {
  const isVideo = api.studio === "video";
  const provider = PROVIDERS[api.model.providerId];
  const [openModel, setOpenModel] = useState(false);
  const [openAr, setOpenAr] = useState(false);
  const [openQuality, setOpenQuality] = useState(false);
  const [openDuration, setOpenDuration] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

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
        return "正在提交生成请求...";
      case "downloading":
        return "正在下载生成结果...";
      case "done":
        return "完成";
      case "failed":
        return "生成失败";
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
                <button className="rmv" onClick={() => api.removeRef(i)}>
                  ×
                </button>
              </div>
            ))}
            {canAddRef && (
              <button
                className="upload-btn"
                title={isVideo ? "Upload first frame (i2v)" : "Upload reference image (i2i)"}
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
          placeholder={isVideo ? "Describe the video you want to create" : "Describe the image you want to create"}
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
          <div className="popover-wrap">
            <button
              className={"ctrl-btn" + (openModel ? " active" : "")}
              onClick={(e) => {
                e.stopPropagation();
                setOpenModel((v) => !v);
                setOpenAr(false);
                setOpenQuality(false);
                setOpenDuration(false);
              }}
            >
              <span className="provider-logo" style={{ background: provider.color }}>
                {provider.abbr}
              </span>
              <span className="ctrl-label">{api.model.name}</span>
              <IconChevron className="ctrl-chev" size={10} />
            </button>
            <ModelDropdown
              open={openModel}
              onClose={() => setOpenModel(false)}
              studio={api.studio}
              current={api.model}
              onSelect={api.selectModel}
            />
          </div>

          {/* 比例 */}
          <div className="popover-wrap">
            <button
              className={"ctrl-btn" + (openAr ? " active" : "")}
              onClick={(e) => {
                e.stopPropagation();
                setOpenAr((v) => !v);
                setOpenModel(false);
                setOpenQuality(false);
                setOpenDuration(false);
              }}
            >
              <IconAspect className="ctrl-ico" size={16} />
              <span className="ctrl-label">{api.ar}</span>
            </button>
            <ParamPopover
              open={openAr}
              onClose={() => setOpenAr(false)}
              title="Aspect Ratio"
              options={api.model.aspectRatios}
              current={api.ar}
              onSelect={api.setAr}
            />
          </div>

          {/* 画质 */}
          <div className="popover-wrap">
            <button
              className={"ctrl-btn" + (openQuality ? " active" : "")}
              onClick={(e) => {
                e.stopPropagation();
                setOpenQuality((v) => !v);
                setOpenModel(false);
                setOpenAr(false);
                setOpenDuration(false);
              }}
            >
              <IconQuality className="ctrl-ico" size={16} />
              <span className="ctrl-label">{api.quality}</span>
            </button>
            <ParamPopover
              open={openQuality}
              onClose={() => setOpenQuality(false)}
              title="Resolution"
              options={api.model.qualities}
              current={api.quality}
              onSelect={api.setQuality}
            />
          </div>

          {/* 时长（仅视频） */}
          {isVideo && (
            <div className="popover-wrap">
              <button
                className={"ctrl-btn" + (openDuration ? " active" : "")}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenDuration((v) => !v);
                  setOpenModel(false);
                  setOpenAr(false);
                  setOpenQuality(false);
                }}
              >
                <IconDuration className="ctrl-ico" size={16} />
                <span className="ctrl-label">{api.duration}s</span>
              </button>
              <ParamPopover
                open={openDuration}
                onClose={() => setOpenDuration(false)}
                title="Duration"
                options={(api.model.durations ?? []).map((d) => ({ value: d, label: `${d}s` }))}
                current={api.duration}
                onSelect={api.setDuration}
              />
            </div>
          )}

          {/* 批量（仅图像） */}
          {!isVideo && (
            <div className="ctrl-stepper">
              <button
                type="button"
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
            <div className="popover-wrap">
              <button
                className="ctrl-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  alert("Draw canvas (DrawModal) — 待接入画板");
                }}
                title="画板（待接入）"
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
                <span className="ctrl-label">Draw</span>
              </button>
            </div>
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
          title={provider.wired ? "Ctrl/⌘ + Enter 生成" : "该厂商后端尚未接入"}
        >
          <span>{api.generating ? "Generating..." : "Generate"}</span>
          <IconSparkles size={14} />
        </button>
      </div>

      {/* 进度提示 */}
      {showProgress && (
        <div className={"gen-progress" + (failed ? " failed" : "")}>
          <span>{phaseLabel(api.progress!.phase)}</span>
          {!failed && (
            <span className="pb">
              <i style={{ width: `${api.progress!.progress}%` }} />
            </span>
          )}
          {failed && <span style={{ color: "var(--danger)" }}>{api.progress!.message}</span>}
        </div>
      )}
    </div>
  );
}
