// 哩布风格模型选择弹层（Dialog 全屏弹窗）
// 顶部 sticky 标题「选择模型」+ 搜索框 + 关闭；主体 2 列模型卡片网格（窄屏 1 列）。
// 卡片：厂商色块图标（hover/选中放大）+ 名称（选中打勾）+ 描述 + 能力标签（左尖胶囊）。
// 点击卡片立即完成选择并关闭（无 footer 确认按钮，与哩布一致）。

import { useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { IconCheck, IconSearch } from "../lib/icons";
import { cn } from "../lib/utils";
import { AddModelDialog } from "./AddModelDialog";
import { removeUserModel } from "../models/registry";
import {
  modelsForStudio,
  providerDisplayName,
  providerMeta,
  useUserModels,
  type ModelDef,
  type Studio,
} from "../models/registry";

interface ModelSelectModalProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  studio: Studio;
  current: ModelDef;
  onSelect: (m: ModelDef) => void;
}

const CARD =
  "group flex w-full cursor-pointer items-start gap-3 rounded-[12px] border border-border-2 bg-transparent px-[10px] py-3 text-left transition-all duration-150 hover:bg-[rgba(59,130,246,.10)] active:border-[#217EFD]";
const CARD_SEL = "cursor-default bg-[rgba(59,130,246,.10)]";
const TAG =
  "rounded-r-full rounded-l-none whitespace-nowrap bg-[rgba(59,130,246,.10)] py-1 pl-[6px] pr-2 text-[11px] font-medium text-primary";

/** 能力标签（≤3 个，对齐哩布）：能力 → 多参考图 → 超清4K → 组图模式。 */
function modelTags(m: ModelDef, t: TFunction): string[] {
  const tags: string[] = [];
  if (m.studio === "video") {
    if (m.capabilities.includes("t2v")) tags.push(t("model.tag.t2v"));
    if (m.capabilities.includes("i2v")) tags.push(t("model.tag.i2v"));
  } else {
    if (m.capabilities.includes("t2i")) tags.push(t("model.tag.t2i"));
    if (m.capabilities.includes("i2i")) tags.push(m.edit ? t("model.tag.edit") : t("model.tag.i2i"));
  }
  if ((m.maxRef ?? 0) > 1) tags.push(t("model.tag.multiRef"));
  if (m.qualities.some((q) => /4k/i.test(q))) tags.push(t("model.tag.ultraHD"));
  const groupMode =
    m.maxBatch != null || m.sections?.some((s) => s.type === "segmented" && s.key === "mode");
  if (groupMode) tags.push(t("model.tag.group"));
  return tags.slice(0, 3);
}

export function ModelSelectModal({ open, onOpenChange, studio, current, onSelect }: ModelSelectModalProps) {
  const { t } = useTranslation();
  const userModels = useUserModels();
  const all = useMemo(() => modelsForStudio(studio), [studio, userModels]);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);

  // 关闭时清空搜索，下次打开回到全量列表。
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
  }, [all, search]);

  // 按厂商分组（保持注册表顺序），每组一个厂商行 + 卡片网格。
  const groups = useMemo(() => {
    const map = new Map<string, ModelDef[]>();
    for (const m of filtered) {
      const list = map.get(m.providerId);
      if (list) list.push(m);
      else map.set(m.providerId, [m]);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const pick = (m: ModelDef) => {
    onSelect(m);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-w-[min(800px,calc(100%-2rem))] gap-0 overflow-hidden rounded-[10px] p-0 sm:max-w-[min(800px,calc(100%-2rem))]"
      >
        <DialogTitle className="sr-only">{t("model.select")}</DialogTitle>
        <div className="flex flex-col">
          {/* 标题栏（sticky）：标题 + 搜索 + 关闭 */}
          <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line-soft bg-background/95 px-3 py-3 backdrop-blur-[16px] md:px-6">
            <span className="shrink-0 text-[16px] font-medium text-text-2 md:text-[18px]">
              {t("model.select")}
            </span>
            <div className="flex min-w-0 flex-1 justify-end">
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="mr-2 flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-border-2 bg-chip px-2.5 py-1.5 text-xs font-medium text-text-2 transition-colors hover:bg-hover hover:text-foreground"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                {t("model.addModel")}
              </button>
              <div className="flex w-full max-w-[240px] items-center gap-2 rounded-lg border border-border-2 bg-soft px-3 py-1.5 transition-colors duration-150 focus-within:border-[rgba(59,130,246,.50)]">
                <IconSearch size={13} style={{ color: "var(--muted)" }} />
                <input
                  type="text"
                  className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                  placeholder={t("model.search")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
            <button
              type="button"
              aria-label={t("common.close")}
              onClick={() => onOpenChange(false)}
              className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-hover hover:text-foreground"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M0.75 12.75L12.75 0.75M0.75 0.75L12.75 12.75"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>

          {/* 卡片网格（按厂商分组） */}
          <div className="h-[70dvh] overflow-y-auto px-3 py-3 md:h-[470px] md:px-6 md:py-6" data-scrollable>
            {filtered.length === 0 ? (
              <div className="py-12 text-center text-xs text-muted-foreground">{t("model.none")}</div>
            ) : (
              <div className="flex flex-col gap-6">
                {groups.map(([pid, models]) => {
                  const p = providerMeta(pid);
                  return (
                    <section key={pid}>
                      <div className="mb-3 flex items-center gap-2">
                        <span
                          className="grid size-5 shrink-0 place-items-center rounded-md text-[9px] font-extrabold text-black"
                          style={{ background: p.color }}
                        >
                          {p.abbr}
                        </span>
                        <h3 className="text-xs font-semibold text-text-2">
                          {providerDisplayName(pid, t)}
                        </h3>
                        <span className="text-[10px] text-muted-foreground">{models.length}</span>
                      </div>
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
                        {models.map((m) => {
                          const sel = current.id === m.id;
                          const isUser = userModels.some((u) => u.id === m.id);
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => pick(m)}
                              className={cn("group relative", CARD, sel && CARD_SEL)}
                            >
                              {isUser && (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  title={t("model.addModelDelete")}
                                  aria-label={t("model.addModelDelete")}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (window.confirm(t("model.addModelDeleteConfirm", { name: m.name }))) {
                                      void removeUserModel(m.id).catch(() => {});
                                    }
                                  }}
                                  className="absolute top-1 right-1 z-10 grid size-6 cursor-pointer place-items-center rounded-md bg-transparent text-[11px] leading-none text-faint opacity-0 transition-all hover:bg-[rgba(239,68,68,.12)] hover:text-destructive group-hover:opacity-100"
                                >
                                  ×
                                </span>
                              )}
                              <div className="grid size-[50px] shrink-0 place-items-center overflow-hidden rounded-[16px] bg-[#F9FAFC] p-2 dark:bg-[#1B1B20]">
                                <span
                                  className={cn(
                                    "grid size-full place-items-center text-[13px] font-extrabold text-black transition-transform duration-300",
                                    sel ? "scale-[1.2]" : "group-hover:scale-[1.2]",
                                  )}
                                  style={{ background: p.color }}
                                >
                                  {p.abbr}
                                </span>
                              </div>
                              <div className="flex min-w-0 flex-1 flex-col items-start gap-[6px]">
                                <div className="flex w-full items-center gap-2">
                                  <span className="truncate text-[15px] font-medium text-foreground">
                                    {m.name}
                                  </span>
                                  {sel && <IconCheck size={14} className="shrink-0 text-primary" />}
                                  {!p.wired && (
                                    <span className="shrink-0 text-[10px] font-semibold text-warn">
                                      {t("model.notWired")}
                                    </span>
                                  )}
                                </div>
                                <div className="w-full truncate text-xs text-muted-foreground">
                                  {m.blurb}
                                </div>
                                <div className="flex gap-[6px]">
                                  {modelTags(m, t).map((tag) => (
                                    <span key={tag} className={TAG}>
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <AddModelDialog open={addOpen} onClose={() => setAddOpen(false)} studio={studio} />
      </DialogContent>
    </Dialog>
  );
}
