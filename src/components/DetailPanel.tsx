// 作品详情全屏覆盖层（哩布风格）
// 供图库与任务队列共用：数据来自调用方标准化的 DetailSource 列表，
// 支持左右切换（sources + index）、顶部操作（下载/收藏/更多）、
// 元信息 / 生成参数 / 基础信息 chips、底部动作（图生视频/作为参考图/重新编辑）。
// 收藏、删除、跳转等行为由 sources 内的回调承载（图库走历史任务，队列走会话结果）。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { toAssetUrl } from "../api";
import { openPath } from "@tauri-apps/plugin-opener";
import { IconChevron, IconDownload, IconMore, IconStar, IconTrash, IconVideo } from "../lib/icons";
import { cn } from "../lib/utils";
import type { LoraEntry } from "../types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
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
  /** 像素尺寸 "WxH"（params_json.size；非像素厂商为比例原值，与 ratio 重复时不再展示） */
  size?: string;
  ratio?: string;
  quality?: string;
  duration?: string;
  n?: number;
  /** 图像输出格式（params_json.output_format） */
  format?: string;
  /** 魔搭自由参数快照（steps/guidance/seed/negative_prompt 等，params_json 剩余键） */
  params?: Record<string, unknown>;
  /** LoRA 列表（魔搭模型） */
  loras?: LoraEntry[];
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

// 魔搭自由参数键 → i18n 标题（与 registry msSections 声明一致）；未收录键直接显示键名。
const PARAM_TITLES: Record<string, string> = {
  steps: "prompt.paramSteps",
  guidance: "prompt.paramGuidance",
  seed: "prompt.paramSeed",
  negative_prompt: "prompt.paramNegativePrompt",
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
  // 折叠态遮罩：选中文本时透明化——白雾渐变会盖住选区高亮，产生"高亮被切断"的假分隔线
  const [hasSelection, setHasSelection] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);

  const source = sources[index];

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

  // 有文本选区时标记（折叠遮罩据此透明化，避免盖住选区高亮）
  useEffect(() => {
    const onSelection = () =>
      setHasSelection((window.getSelection()?.toString().length ?? 0) > 0);
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);

  if (!source) return null;

  const copyPrompt = async (prompt: string) => {
    await copyText(prompt);
    setCopied(true);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  // 哩布式参数表：结构化字段（画质/时长/张数/格式）+ 魔搭自由参数，label/value 行式排布；
  // 负向提示词独立展示（与提示词同级），不混入参数表。
  const negativePrompt =
    typeof source.params?.negative_prompt === "string" ? source.params.negative_prompt : undefined;
  const paramRows: { label: string; value: string }[] = [];
  if (source.quality) {
    paramRows.push({
      label: t(source.image ? "prompt.resolution" : "prompt.videoQuality"),
      value: source.quality,
    });
  }
  if (!source.image && source.duration) {
    paramRows.push({ label: t("prompt.videoDuration"), value: `${source.duration}s` });
  }
  if (source.image && source.n != null && source.n > 1) {
    paramRows.push({ label: t("prompt.imageCount"), value: String(source.n) });
  }
  if (source.image && source.format) {
    paramRows.push({ label: t("prompt.imageFormat"), value: source.format });
  }
  for (const [k, v] of Object.entries(source.params ?? {})) {
    if (k === "negative_prompt") continue;
    paramRows.push({ label: t((PARAM_TITLES[k] ?? k) as ParseKeys), value: String(v) });
  }

  // 复制全部参数（提示词 + 负向提示词 + 参数表）
  const copyParams = async () => {
    const lines = [source.prompt];
    if (negativePrompt) {
      lines.push(`${t((PARAM_TITLES.negative_prompt ?? "prompt.paramNegativePrompt") as ParseKeys)}：${negativePrompt}`);
    }
    lines.push(...paramRows.map((r) => `${r.label}：${r.value}`));
    await copyText(lines.join("\n"));
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
                <IconDownload size={13} /> {t("common.revealInFolder")}
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
                <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="grid size-8 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-[#6b7280] transition-colors hover:bg-[#f3f4f6]"
                      title={t("gallery.more")}
                      aria-label={t("gallery.more")}
                    >
                      <IconMore size={16} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => copyPrompt(source.prompt)}>
                      {copyIcon} {t("gallery.copyPrompt")}
                    </DropdownMenuItem>
                    {source.onDelete && (
                      <DropdownMenuItem variant="destructive" onClick={source.onDelete}>
                        <IconTrash size={13} /> {t("gallery.delete")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
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

            {/* 生成参数（可折叠：折叠时底部渐隐 + 遮罩点击展开） */}
            <div className="mt-5 pb-4">
              <div className="flex items-center justify-between">
                <span className="text-[14px] font-medium text-[#111827]">{t("gallery.params")}</span>
                <div className="flex items-center gap-1">
                  {paramRows.length > 0 && (
                    <button
                      className="flex h-7 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 text-xs text-[#787878] hover:bg-[#f3f4f6] hover:text-[#111827]"
                      title={t("gallery.copyParams")}
                      aria-label={t("gallery.copyParams")}
                      onClick={copyParams}
                    >
                      {copied ? <span className="text-[11px] text-[#2563eb]">{t("gallery.copied")}</span> : copyIcon}
                    </button>
                  )}
                  <button
                    className="grid size-7 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-[#9ca3af] hover:bg-[#f3f4f6]"
                    aria-label={paramsOpen ? t("gallery.collapse") : t("gallery.expand")}
                    onClick={() => setParamsOpen((v) => !v)}
                  >
                    <IconChevron className={cn("transition-transform duration-300", paramsOpen && "rotate-180")} size={13} />
                  </button>
                </div>
              </div>
              <div className={cn("relative", !paramsOpen && "max-h-[150px] overflow-hidden")}>
                <div className="mt-2 flex flex-col gap-4">
                  <div>
                    <div className="flex items-center gap-1">
                      <span className="text-[12px] font-medium text-[#929292]">{t("gallery.prompt")}</span>
                      <button
                        className="grid size-5 cursor-pointer place-items-center rounded border-0 bg-transparent text-[#999] hover:text-[#2563eb]"
                        title={t("gallery.copyPrompt")}
                        aria-label={t("gallery.copyPrompt")}
                        onClick={() => copyPrompt(source.prompt)}
                      >
                        {copied ? <span className="text-[11px] text-[#2563eb]">{t("gallery.copied")}</span> : copyIcon}
                      </button>
                    </div>
                    <p className="mt-2 text-[13px] leading-[21px] break-words text-[#424242]">{source.prompt}</p>
                  </div>
                  {negativePrompt && (
                    <div>
                      <div className="flex items-center gap-1">
                        <span className="text-[12px] font-medium text-[#929292]">{t("prompt.paramNegativePrompt")}</span>
                        <button
                          className="grid size-5 cursor-pointer place-items-center rounded border-0 bg-transparent text-[#999] hover:text-[#2563eb]"
                          title={t("gallery.copyPrompt")}
                          aria-label={t("gallery.copyPrompt")}
                          onClick={() => copyPrompt(negativePrompt)}
                        >
                          {copied ? <span className="text-[11px] text-[#2563eb]">{t("gallery.copied")}</span> : copyIcon}
                        </button>
                      </div>
                      <p className="mt-2 text-[13px] leading-[21px] break-words text-[#424242]">{negativePrompt}</p>
                    </div>
                  )}
                  {paramRows.length > 0 && (
                    <div className="rounded-[8px] bg-[#f8f8f8] px-3 py-4">
                      {paramRows.map((r) => (
                        <div key={r.label} className="mb-3 flex items-start justify-between gap-4 last:mb-0">
                          <span className="shrink-0 text-xs text-[#424242]">{r.label}</span>
                          <span className="min-w-0 text-right text-xs break-words whitespace-pre-wrap text-[#303030]">
                            {r.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {!paramsOpen && (
                  <button
                    className={cn(
                      "absolute inset-x-0 bottom-0 h-16 w-full cursor-pointer border-0",
                      !hasSelection && "bg-gradient-to-t from-white to-transparent",
                    )}
                    aria-label={t("gallery.expand")}
                    onClick={() => setParamsOpen(true)}
                  />
                )}
              </div>
            </div>

            {/* 模型信息（哩布：LoRA 卡片；本项目无模型跳转，不 truncate——单列完整显示） */}
            {source.loras && source.loras.length > 0 && (
              <div className="pb-4">
                <div className="pb-3 text-[12px] text-[#929292]">{t("gallery.modelInfo")}</div>
                <div className="flex flex-col gap-2">
                  {source.loras
                    .filter((l) => l.repo.trim())
                    .map((l) => (
                      <div key={l.repo} className="flex items-center gap-2 rounded-[6px] bg-[#f8f8f8] p-1.5 pr-2">
                        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#000]/50 text-[10px] font-medium text-white">
                          {l.weight}
                        </span>
                        <span className="min-w-0 text-[12px] break-words text-[#787878]">{l.repo}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* 基础信息（哩布：checkpoint 主模型卡片 + 尺寸） */}
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
                {source.size && source.size !== source.ratio && <div className="flex h-[28px] items-center rounded-[6px] bg-[#f8f8f8] px-2 text-[12px] text-[#787878]">{source.size}</div>}
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
