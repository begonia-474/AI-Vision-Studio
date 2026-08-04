// 作品详情全屏覆盖层（哩布风格）
// 供图库与任务队列共用：数据来自调用方标准化的 DetailSource 列表，
// 支持左右切换（sources + index）、顶部操作（下载/收藏/更多）、
// 元信息 / 生成参数 / 基础信息 chips、底部动作（图生视频/作为参考图/重新编辑）。
// 收藏、删除、跳转等行为由 sources 内的回调承载（图库走历史任务，队列走会话结果）。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toAssetUrl } from "../api";
import { openPath } from "@tauri-apps/plugin-opener";
import { IconChevron, IconDownload, IconMore, IconStar, IconTrash, IconVideo } from "../lib/icons";
import { cn } from "../lib/utils";
import { XIcon } from "lucide-react";

export interface DetailSource {
  key: string;
  image: boolean;
  prompt: string;
  model: string;
  /** 元信息「创作工具」行，缺省回退到 model */
  tool?: string;
  createdAt: string;
  paths: string[];
  /** 当前展示的是 paths 中的第几张（批量任务点开第 N 张详情应显示第 N 张），缺省 0 */
  pathIndex?: number;
  thumbnailPath?: string;
  size?: string;
  ratio?: string;
  quality?: string;
  duration?: string;
  n?: number;
  starred?: boolean;
  onToggleStar?: () => void;
  onDelete?: () => void;
  onImageToVideo?: (src: string, prompt: string) => void;
  onImageToImage?: (src: string, prompt: string) => void;
  onReEdit?: () => void;
}

interface DetailPanelProps {
  sources: DetailSource[];
  index: number;
  onClose: () => void;
  onNavigate: (delta: number) => void;
}

const dayKey = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
  return Promise.resolve();
}

export function DetailPanel({ sources, index, onClose, onNavigate }: DetailPanelProps) {
  const { t } = useTranslation();
  const [paramsOpen, setParamsOpen] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);

  const source = sources[index];

  // 更多菜单：点击外部关闭
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [moreOpen]);

  // 左右方向键切换上一张 / 下一张；Escape 关闭
  useEffect(() => {
    if (!source) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onNavigate(-1);
      if (e.key === "ArrowRight" && index < sources.length - 1) onNavigate(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [source, index, sources.length, onNavigate, onClose]);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  if (!source) return null;

  const copyPrompt = async (prompt: string) => {
    await copyText(prompt);
    setCopied(true);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const canPrev = index > 0;
  const canNext = index < sources.length - 1;

  const download = async () => {
    const p = source.paths[source.pathIndex ?? 0] ?? source.thumbnailPath;
    if (!p) return;
    try {
      await openPath(p, "reveal");
    } catch {
      /* 浏览器环境忽略 */
    }
  };

  const navBtn = (side: "left" | "right", disabled: boolean, onClick: () => void) => (
    <button
      className={cn(
        "absolute top-1/2 z-10 grid h-12 w-8 -translate-y-1/2 cursor-pointer place-items-center rounded-[100px] border-0 bg-[rgba(13,13,13,.30)] text-white transition-opacity duration-300 hover:opacity-100",
        side === "left" ? "left-5" : "right-5",
        disabled ? "opacity-25 group-hover/detail:opacity-25" : "opacity-0 group-hover/detail:opacity-100",
      )}
      disabled={disabled}
      onClick={onClick}
      aria-label={side === "left" ? t("gallery.prev") : t("gallery.next")}
    >
      <IconChevron className={side === "left" ? "rotate-90" : "-rotate-90"} size={18} />
    </button>
  );

  const copyIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );

  return (
    <div className="fixed inset-0 z-50 bg-white text-[#111827] animate-[fadeInUp_.15s]">
      <div className="flex h-full w-full bg-white text-[#111827]">
        {/* 左：图片区 */}
        <div className="group/detail relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-[#f8f8f8] px-10 py-16">
          {source.image ? (
            <img src={toAssetUrl(source.paths[source.pathIndex ?? 0] ?? source.thumbnailPath ?? "")} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
          ) : (
            <video src={toAssetUrl(source.paths[source.pathIndex ?? 0] ?? "")} controls className="max-h-full max-w-full rounded-lg" />
          )}
          {source.paths.length > 1 && (
            <span className="absolute top-4 left-4 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-bold text-white">×{source.paths.length}</span>
          )}
          {navBtn("left", !canPrev, () => onNavigate(-1))}
          {navBtn("right", !canNext, () => onNavigate(1))}
          <button
            className="absolute top-4 right-4 z-10 grid size-9 cursor-pointer place-items-center rounded-full border-0 bg-white/80 text-[#6b7280] transition-colors hover:bg-white hover:text-[#111827]"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="w-px shrink-0 bg-[#e5e7eb]" />

        {/* 右：信息栏 */}
        <div className="flex w-[456px] shrink-0 flex-col max-[1120px]:w-[400px]">
          <div className="flex-1 overflow-y-auto px-8 pt-5 pb-4">
            {/* 顶部操作行 */}
            <div className="flex items-center justify-between pb-4">
              <button
                className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-[#f0f1f3] px-2.5 text-[13px] font-medium text-[#111827] transition-colors hover:bg-[#e5e7eb]"
                onClick={download}
              >
                <IconDownload size={13} /> {t("gallery.download")}
              </button>
              <div className="flex items-center">
                {source.starred != null && source.onToggleStar && (
                  <button
                    className={cn(
                      "grid size-8 cursor-pointer place-items-center rounded-lg border-0 bg-transparent transition-colors hover:bg-[#f3f4f6]",
                      source.starred ? "text-[#f59e0b]" : "text-[#6b7280]",
                    )}
                    title={source.starred ? t("gallery.unstar") : t("gallery.star")}
                    aria-label={source.starred ? t("gallery.unstar") : t("gallery.star")}
                    onClick={source.onToggleStar}
                  >
                    <IconStar size={16} filled={source.starred} />
                  </button>
                )}
                <div className="relative" ref={moreRef}>
                  <button
                    className="grid size-8 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-[#6b7280] transition-colors hover:bg-[#f3f4f6]"
                    title={t("gallery.more")}
                    aria-label={t("gallery.more")}
                    onClick={() => setMoreOpen((v) => !v)}
                  >
                    <IconMore size={16} />
                  </button>
                  {moreOpen && (
                    <div className="absolute top-9 right-0 z-50 min-w-[150px] rounded-lg border border-[#e5e7eb] bg-white p-1.5 text-[12px] shadow-[0_10px_30px_rgba(15,23,42,.12)]">
                      <button
                        className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-[#374151] hover:bg-[#f3f4f6]"
                        onClick={() => {
                          copyPrompt(source.prompt);
                          setMoreOpen(false);
                        }}
                      >
                        {copyIcon} {t("gallery.copyPrompt")}
                      </button>
                      {source.onDelete && (
                        <button
                          className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-[#dc2626] hover:bg-[#fef2f2]"
                          onClick={() => {
                            setMoreOpen(false);
                            source.onDelete?.();
                          }}
                        >
                          <IconTrash size={13} /> {t("gallery.delete")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 元信息行 */}
            <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-5 text-[12px] text-[#787878]">
              <span className="flex items-center gap-1.5">
                {dayKey(source.createdAt)}
                <span>|</span>
                <span>{t("gallery.tool", { provider: source.tool ?? source.model })}</span>
              </span>
              <span>{t("gallery.aiGenerated")}</span>
            </div>

            {/* 生成参数（可折叠） */}
            <div className="mt-5 pb-4">
              <div className="flex items-center justify-between">
                <span className="text-[14px] font-medium text-[#111827]">{t("gallery.params")}</span>
                <button
                  className="grid size-7 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-[#9ca3af] hover:bg-[#f3f4f6]"
                  aria-label={paramsOpen ? t("gallery.collapse") : t("gallery.expand")}
                  onClick={() => setParamsOpen((v) => !v)}
                >
                  <IconChevron className={cn("transition-transform duration-300", paramsOpen && "rotate-180")} size={13} />
                </button>
              </div>
              {paramsOpen && (
                <div className="mt-2 max-h-[120px] overflow-y-auto opacity-90">
                  <div className="text-[12px] text-[#6b7280]">{t("gallery.prompt")}</div>
                  <p className="relative mt-2 text-[14px] leading-relaxed text-[#111827] indent-[18px] line-clamp-3">
                    <button
                      className="absolute top-[5px] left-0 cursor-pointer border-0 bg-transparent p-0 text-[#999] hover:text-[#2563eb]"
                      title={t("gallery.copyPrompt")}
                      aria-label={t("gallery.copyPrompt")}
                      onClick={() => copyPrompt(source.prompt)}
                    >
                      {copied ? <span className="text-[11px] text-[#2563eb]">{t("gallery.copied")}</span> : copyIcon}
                    </button>
                    {source.prompt}
                  </p>
                </div>
              )}
            </div>

            {/* 基础信息 */}
            <div className="pb-4">
              <div className="pb-3 text-[12px] text-[#929292]">{t("gallery.basicInfo")}</div>
              <div className="flex flex-wrap gap-2">
                <div className="flex h-[28px] items-center gap-2 rounded-[6px] bg-[#f8f8f8] p-[2px] pr-2">
                  <span className="grid size-6 place-items-center rounded-[4px] bg-gradient-to-b from-[#929292] to-[#5c5c5c] text-white">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                      <line x1="12" y1="22.08" x2="12" y2="12" />
                    </svg>
                  </span>
                  <span className="text-[12px] text-[#787878]">{source.model}</span>
                </div>
                {source.size && <div className="flex h-[28px] items-center rounded-[6px] bg-[#f8f8f8] px-2 text-[12px] text-[#787878]">{source.size}</div>}
                {source.ratio && <div className="flex h-[28px] items-center rounded-[6px] bg-[#f8f8f8] px-2 text-[12px] text-[#787878]">{source.ratio}</div>}
              </div>
            </div>
          </div>

          {/* 底部动作区 */}
          <div className="shrink-0 px-8 pb-6">
            <div className="rounded-lg bg-[#f8f8f8] px-1 pb-4">
              <h1 className="px-3 pt-4 text-[14px] font-medium text-[#929292]">
                {source.image ? t("gallery.imgGen") : t("gallery.videoGen")}
              </h1>
              <div className="mt-2 flex gap-2 px-2 pb-1">
                {source.image && source.onImageToVideo && (
                  <button
                    className="flex h-11 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg p-3 text-[14px] transition-colors hover:bg-[#efeff1]"
                    onClick={() => source.onImageToVideo?.(source.paths[0] ?? "", source.prompt)}
                  >
                    <IconVideo size={15} />
                    <span className="truncate bg-gradient-to-b from-[#00bbef] to-[#1f6dff] bg-clip-text font-medium text-transparent">
                      {t("gallery.imgToVideo")}
                    </span>
                  </button>
                )}
                {source.image && source.onImageToImage && (
                  <button
                    className="flex h-11 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg p-3 text-[14px] text-[#111827] transition-colors hover:bg-[#efeff1]"
                    onClick={() => source.onImageToImage?.(source.paths[0] ?? "", source.prompt)}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path d="M21 15l-5-5L5 21" />
                      <path d="M19 2v6M16 5h6" />
                    </svg>
                    <span className="truncate">{t("gallery.asRef")}</span>
                  </button>
                )}
                {source.onReEdit && (
                  <button
                    className="flex h-11 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg p-3 text-[14px] text-[#111827] transition-colors hover:bg-[#efeff1]"
                    onClick={source.onReEdit}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                    </svg>
                    <span className="truncate">{t("gallery.reEdit")}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
