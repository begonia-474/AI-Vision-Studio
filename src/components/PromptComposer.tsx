// 底部胶囊输入区
// 顶部：参考图缩略行 + 自动增高 textarea
// 底部：控件行（模型 / 比例 / 画质 / 时长 / 批量 / Draw）+ Generate
// 弹层基于 shadcn/Radix Popover，互斥打开由 openOne 统一管理。

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelDropdown } from "./ModelDropdown";
import { ParamPopover } from "./Popover";
import { cn } from "../lib/utils";
import { PROVIDER_LOGO } from "../lib/classes";
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

interface PromptComposerProps {
  api: StudioApi;
  collapsed?: boolean;
  onExpand?: () => void;
}

export function PromptComposer({ api, collapsed = false, onExpand }: PromptComposerProps) {
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

  // 多任务并行：生成按钮始终可用，进行中的任务数用角标提示。
  const ctrlBtn =
    "group/ctrl relative flex h-[38px] cursor-pointer items-center gap-2 whitespace-nowrap rounded-[6px] border border-border-2 bg-ctrl-bg px-4 text-xs font-semibold text-foreground transition-all duration-150 hover:bg-ctrl-bg-h";
  const ctrlBtnActive =
    ctrlBtn + " border-[rgba(59,130,246,.25)] bg-accent text-primary hover:bg-[rgba(59,130,246,.15)]";
  const ctrlIco = "size-4 shrink-0 opacity-70 transition-opacity group-hover/ctrl:opacity-100";
  const ctrlLabel =
    "text-xs font-semibold opacity-70 transition-opacity group-hover/ctrl:text-primary group-hover/ctrl:opacity-100";

  return (
    <div
      className={cn(
        "absolute bottom-4 left-1/2 z-30 flex w-[95%] max-w-[896px] -translate-x-1/2 flex-col rounded-[32px] border border-border-3 bg-[linear-gradient(to_bottom,var(--panel-from),var(--panel-via)_50%,var(--panel-to))] p-4 shadow-[0_15px_50px_var(--shadow-lg)] backdrop-blur-[24px] transition-[width,padding,border-radius] duration-[280ms] ease-in-out animate-[fadeInUp_.5s_.15s_backwards]",
        collapsed && "w-[min(560px,92%)] rounded-3xl px-3 py-2",
      )}
    >
      <div
        className={cn(
          "flex max-h-[600px] flex-col gap-3 overflow-visible opacity-100 translate-y-0 transition-[max-height,opacity,transform] duration-[280ms] ease-in-out pointer-events-auto",
          collapsed && "max-h-0 overflow-hidden opacity-0 translate-y-[6px] pointer-events-none",
        )}
        aria-hidden={collapsed}
      >
        <div className="flex flex-col gap-3">
        {/* 参考图行 */}
        {(api.refs.length > 0 || canAddRef) && (
          <div className="flex flex-wrap items-center gap-2.5">
            {api.refs.map((r, i) => (
              <div className="relative size-10 shrink-0 overflow-hidden rounded-full border border-border-4 shadow-[0_4px_12px_var(--shadow-xs)]" key={i}>
                <img src={r} alt="" className="h-full w-full object-cover" />
                <button
                  className="absolute top-0.5 right-0.5 grid size-4 cursor-pointer place-items-center rounded-full border border-border-1 bg-btn-dark text-[9px] leading-none text-white"
                  aria-label={t("prompt.removeRef")}
                  onClick={() => api.removeRef(i)}
                >
                  ×
                </button>
              </div>
            ))}
            {canAddRef && (
              <button
                className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border border-border-2 bg-chip text-muted-foreground transition-all duration-150 hover:border-[rgba(59,130,246,.40)] hover:bg-[rgba(59,130,246,.05)] hover:text-primary"
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
          className="min-h-10 w-full max-h-[250px] resize-none border-0 bg-transparent p-1 text-sm leading-relaxed text-foreground outline-none placeholder:text-faint-2"
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

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line-soft pt-3">
        <div className="relative flex flex-wrap items-center gap-2">
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
                className={cn(ctrlBtn, openModel && ctrlBtnActive)}
              >
                <span className={cn(PROVIDER_LOGO, "size-4")} style={{ background: provider.color }}>
                  {provider.abbr}
                </span>
                <span className={cn(ctrlLabel, openModel && "opacity-100")}>{api.model.name}</span>
                <IconChevron className="size-[10px] shrink-0 opacity-45 group-hover/ctrl:opacity-100" size={10} />
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
                className={cn(ctrlBtn, openAr && ctrlBtnActive)}
              >
                <IconAspect className={ctrlIco} size={16} />
                <span className={cn(ctrlLabel, openAr && "opacity-100")}>{api.ar}</span>
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
                className={cn(ctrlBtn, openQuality && ctrlBtnActive)}
              >
                <IconQuality className={ctrlIco} size={16} />
                <span className={cn(ctrlLabel, openQuality && "opacity-100")}>{api.quality}</span>
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
                  className={cn(ctrlBtn, openDuration && ctrlBtnActive)}
                >
                  <IconDuration className={ctrlIco} size={16} />
                  <span className={cn(ctrlLabel, openDuration && "opacity-100")}>{api.duration}s</span>
                </button>
              }
            />
          )}

          {/* 批量（仅图像） */}
          {!isVideo && (
            <div className="flex h-[38px] select-none items-center gap-1 rounded-[6px] border border-border-2 bg-ctrl-bg px-3">
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 px-1 text-sm font-extrabold leading-none text-muted-foreground hover:text-foreground"
                aria-label={t("prompt.lessBatch")}
                onClick={(e) => {
                  e.stopPropagation();
                  api.setBatch(Math.max(1, api.batch - 1));
                }}
              >
                −
              </button>
              <span className="min-w-7 text-center text-xs font-semibold text-text-2">
                {api.batch}/{api.model.maxRef ?? 4}
              </span>
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 px-1 text-sm font-extrabold leading-none text-muted-foreground hover:text-foreground"
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
              className={ctrlBtn}
              onClick={(e) => {
                e.stopPropagation();
                alert(t("prompt.drawAlert"));
              }}
              title={t("prompt.drawTitle")}
            >
                <svg
                  className={ctrlIco}
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
                <span className={ctrlLabel}>{t("prompt.draw")}</span>
              </button>
          )}
        </div>

        {/* Generate */}
        <button
          className="flex cursor-pointer items-center gap-2 rounded-full border border-[rgba(59,130,246,.10)] bg-primary px-7 py-3 text-[13px] font-extrabold text-black shadow-[0_4px_12px_rgba(59,130,246,.20)] transition-all duration-150 hover:scale-[1.02] hover:opacity-95 active:scale-[.98] disabled:pointer-events-none disabled:scale-100 disabled:opacity-50"
          disabled={!provider.wired}
          onClick={(e) => {
            e.stopPropagation();
            api.handleGenerate();
          }}
          title={provider.wired ? t("prompt.shortcut") : t("prompt.notWired")}
        >
          <span>{t("prompt.generate")}</span>
          <IconSparkles size={14} />
        </button>
        </div>

        {/* 进行中任务角标：输入框外右上角，x/y 正在生成中（x=已完成，y=本次会话任务总数） */}
        {api.running > 0 && (
          <div
            className="absolute -top-3.5 right-7 z-40 whitespace-nowrap rounded-full bg-[linear-gradient(90deg,var(--accent),var(--accent-2))] px-3.5 py-1.5 text-[11px] font-extrabold tracking-[.3px] text-black shadow-[0_6px_18px_rgba(59,130,246,.35)] animate-[fadeInUp_.2s]"
            role="status"
          >
            {t("prompt.runningTasks", { done: api.finished, total: api.sessionTotal })}
          </div>
        )}
      </div>
      <button
        type="button"
        className={cn(
          "pointer-events-none flex max-h-0 min-h-0 w-full cursor-pointer items-center justify-between gap-3 overflow-hidden border-0 bg-transparent px-1 text-left text-text-2 opacity-0 transition-[max-height,opacity] duration-[280ms] ease-in-out",
          collapsed && "pointer-events-auto max-h-9 min-h-9 opacity-100",
        )}
        onClick={onExpand}
        title={t("prompt.backToBottom")}
        aria-hidden={!collapsed}
      >
        <span className="min-w-0 truncate text-[13px]">{api.prompt.trim() || (isVideo ? t("prompt.placeholderVideo") : t("prompt.placeholderImage"))}</span>
        <IconSparkles size={14} className="shrink-0 text-primary" />
      </button>
    </div>
  );
}
