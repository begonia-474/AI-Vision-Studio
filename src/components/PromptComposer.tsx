// 底部胶囊输入区
// 顶部：参考图缩略行 + 自动增高 textarea
// 底部：控件行（模型 / 比例 / 画质 / 时长 / 批量 / Draw）+ Generate
// 弹层基于 shadcn/Radix Popover，互斥打开由 openOne 统一管理。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelSelectModal } from "./ModelSelectModal";
import { ParamPanel } from "./Popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { cn } from "../lib/utils";
import { ProviderLogo } from "./ProviderLogo";
import {
  IconAspect,
  IconChevron,
  IconSparkles,
  IconUpload,
} from "../lib/icons";
import { PROVIDERS, providerMeta } from "../models/registry";
import type { StudioApi } from "../studios/useStudio";

interface PromptComposerProps {
  api: StudioApi;
  collapsed?: boolean;
  onExpand?: () => void;
  /** 高度变化上报（用于滚动区动态让位） */
  onHeightChange?: (h: number) => void;
  /** 悬停输入条时的滚轮事件（转发给时间线滚动区，krea 行为） */
  onWheelOutside?: (e: React.WheelEvent) => void;
}

// 折叠/展开动画参数对齐即梦：
// --content-generator-collapse-transition-duration: 350ms;
// --content-generator-collapse-transition-timing-function: cubic-bezier(0.15, 0.75, 0.3, 1);
const COLLAPSE = "duration-[350ms] ease-[cubic-bezier(.15,.75,.3,1)]";

export function PromptComposer({ api, collapsed = false, onExpand, onHeightChange, onWheelOutside }: PromptComposerProps) {
  const { t } = useTranslation();
  const isVideo = api.studio === "video";
  const provider = PROVIDERS[api.model.providerId] ?? providerMeta(api.model.providerId);
  const [openModel, setOpenModel] = useState(false);
  const [openParams, setOpenParams] = useState(false);
  const [drawOpen, setDrawOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 高度变化上报：输入条是 absolute 定位，滚动区用它让出底部空间，
  // 长提示词展开时不会被输入条遮住。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onHeightChange?.(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeightChange]);

  // 弹层互斥：打开一个前先关掉其余（保证任意时刻只有一个 Radix 弹层在场，
  // 避免旧弹层 deferPointerDownOutside 的焦点回迁把新弹层误关）。
  const closeOthers = () => {
    setOpenModel(false);
    setOpenParams(false);
  };
  const openOne = (set: (v: boolean) => void) => (o: boolean) => {
    if (o) {
      closeOthers();
      requestAnimationFrame(() => set(true));
    } else {
      set(false);
    }
  };

  // 折叠时关闭所有弹层：时间线上滚触发折叠后，模型/比例/画质/时长弹层
  // 若仍悬空会漂浮在输入条上方（锚点已随内容收起），一并关掉。
  useEffect(() => {
    if (collapsed) {
      setOpenModel(false);
      setOpenParams(false);
    }
  }, [collapsed]);

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

  // 挂载 / prompt 变化（用户输入、跳转回填、会话恢复）时按内容自动撑高。
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 250) + "px";
  }, [api.prompt]);

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
  // krea 风格：圆胶囊控件（rounded-full h-9 bg-white/5）
  const ctrlBtn =
    "group/ctrl relative flex h-9 cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border border-border-2 bg-soft px-4 text-xs font-semibold text-foreground transition-all duration-150 hover:bg-hover-2";
  const ctrlBtnActive =
    ctrlBtn + " border-[rgba(59,130,246,.25)] bg-accent text-primary hover:bg-[rgba(59,130,246,.15)]";
  const ctrlIco = "size-4 shrink-0 opacity-70 transition-opacity group-hover/ctrl:opacity-100";
  const ctrlLabel =
    "text-xs font-semibold opacity-70 transition-opacity group-hover/ctrl:text-primary group-hover/ctrl:opacity-100";

  return (
    <div
      ref={rootRef}
      className={cn(
        "absolute bottom-4 left-1/2 z-30 flex w-[95%] max-w-[896px] -translate-x-1/2 flex-col rounded-[32px] border border-border-3 bg-[linear-gradient(to_bottom,var(--panel-from),var(--panel-via)_50%,var(--panel-to))] p-4 shadow-[0_15px_50px_var(--shadow-lg)] backdrop-blur-[24px] transition-[width,padding,border-radius] animate-[fadeInUp_.5s_.15s_backwards]",
        COLLAPSE,
        collapsed && "w-[min(560px,92%)] rounded-3xl px-3 py-2",
      )}
      onWheel={(e) => {
        e.stopPropagation();
        // 输入框（textarea）与弹层（PopoverContent 带 data-scrollable）内部来源的滚轮一律不转发：
        // 长提示词在框内原生滚动；弹层内滚动（模型列表等）不滚时间线。
        // role="dialog" 覆盖 Dialog portal：弹层经 React 合成事件冒泡到这里，必须拦截。
        // 滚动任务队列时把鼠标移到输入框外即可（krea 行为）。
        if ((e.target as HTMLElement).closest("textarea, [data-scrollable], [role='dialog']")) return;
        onWheelOutside?.(e);
      }}
    >
      <div
        className={cn(
          "grid grid-rows-[1fr] transition-[grid-template-rows]",
          COLLAPSE,
          collapsed && "grid-rows-[0fr]",
        )}
        aria-hidden={collapsed}
      >
        <div className="min-h-0 max-h-[60vh] overflow-y-auto scrollbar-none">
          <div
            className={cn(
              "flex flex-col gap-3 opacity-100 translate-y-0 pointer-events-auto",
              COLLAPSE,
              collapsed && "opacity-0 translate-y-[6px] pointer-events-none",
            )}
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
          className="min-h-[96px] w-full max-h-[250px] resize-none border-0 bg-transparent p-1 text-sm leading-relaxed text-foreground outline-none placeholder:text-faint-2"
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
          <ModelSelectModal
            open={openModel}
            onOpenChange={openOne(setOpenModel)}
            studio={api.studio}
            current={api.model}
            onSelect={api.selectModel}
          />
          <button
            type="button"
            className={cn(ctrlBtn, openModel && ctrlBtnActive)}
            onClick={() => openOne(setOpenModel)(true)}
          >
            <ProviderLogo provider={provider} size={16} />
            <span className={cn(ctrlLabel, openModel && "opacity-100")}>{api.model.name}</span>
            <IconChevron className="size-[10px] shrink-0 opacity-45 group-hover/ctrl:opacity-100" size={10} />
          </button>

          {/* 参数（哩布风格：单入口多分区面板，分区按模型 sections 声明渲染） */}
          <ParamPanel
            open={openParams}
            onOpenChange={openOne(setOpenParams)}
            model={api.model}
            api={api}
            trigger={
              <button
                type="button"
                className={cn(ctrlBtn, openParams && ctrlBtnActive)}
              >
                <IconAspect className={ctrlIco} size={16} />
                <span className={cn(ctrlLabel, openParams && "opacity-100")}>
                  {api.size ? `${api.size.w}×${api.size.h}` : api.ar}
                  {isVideo
                    ? ` | ${api.duration}${t("prompt.seconds")}`
                    : ` | ${api.batch}${t("prompt.countUnit")}`}
                </span>
                <IconChevron className="size-[10px] shrink-0 opacity-45 group-hover/ctrl:opacity-100" size={10} />
              </button>
            }
          />

          {/* Draw（仅图像，占位） */}
          {!isVideo && (
            <button
              className={ctrlBtn}
              onClick={(e) => {
                e.stopPropagation();
                setDrawOpen(true);
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

        {/* Generate（krea 风格圆形按钮） */}
        <button
          className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[rgba(59,130,246,.10)] bg-primary text-black shadow-[0_4px_14px_rgba(59,130,246,.25)] transition-all duration-150 hover:scale-105 hover:opacity-95 active:scale-95 disabled:pointer-events-none disabled:scale-100 disabled:opacity-50"
          disabled={!provider.wired}
          onClick={(e) => {
            e.stopPropagation();
            api.handleGenerate();
          }}
          title={provider.wired ? t("prompt.shortcut") : t("prompt.notWired")}
        >
          <IconSparkles size={18} />
        </button>
        </div>
      </div>
      </div>
      </div>

      {/* 进行中任务角标：输入框外右上角，x/y 正在生成中（x=已完成，y=本次会话任务总数） */}
      {api.running > 0 && (
        <div
          className={cn(
            "absolute -top-3.5 right-7 z-40 whitespace-nowrap rounded-full bg-[linear-gradient(90deg,var(--accent),var(--accent-2))] px-3.5 py-1.5 text-[11px] font-extrabold tracking-[.3px] text-black shadow-[0_6px_18px_rgba(59,130,246,.35)] animate-[fadeInUp_.2s]",
            COLLAPSE,
            collapsed && "pointer-events-none opacity-0 translate-y-[6px]",
          )}
          role="status"
        >
          {t("prompt.runningTasks", { done: api.finished, total: api.sessionTotal })}
        </div>
      )}

      {/* 折叠态展开栏（即梦 collapsed 态：点击展开，带过渡动画） */}
      <button
        type="button"
        className={cn(
          "pointer-events-none flex max-h-0 min-h-0 w-full cursor-pointer items-center justify-between gap-3 overflow-hidden border-0 bg-transparent px-1 text-left text-text-2 opacity-0 transition-[max-height,opacity]",
          COLLAPSE,
          collapsed && "pointer-events-auto max-h-9 min-h-9 opacity-100",
        )}
        onClick={onExpand}
        title={t("prompt.backToBottom")}
        aria-hidden={!collapsed}
      >
        <span className="min-w-0 truncate text-[13px]">{api.prompt.trim() || (isVideo ? t("prompt.placeholderVideo") : t("prompt.placeholderImage"))}</span>
        <IconSparkles size={14} className="shrink-0 text-primary" />
      </button>

      {/* Draw 占位提示（待接入功能，Dialog 替代原生 alert） */}
      <Dialog open={drawOpen} onOpenChange={setDrawOpen}>
        <DialogContent className="max-w-[360px] text-center">
          <DialogHeader className="gap-3">
            <DialogTitle className="text-base">{t("prompt.drawTitle")}</DialogTitle>
            <span className="text-[13px] text-muted-foreground">{t("prompt.drawAlert")}</span>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </div>
  );
}
