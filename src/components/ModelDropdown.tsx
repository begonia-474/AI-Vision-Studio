// 模型选择弹层（shadcn Popover + Command）
// 左侧厂商圆形 tab（All 用星形 + 各厂首字母）+ 右侧搜索框 + 模型列表。
// cmdk 提供键盘导航（方向键 + Enter）；搜索由自身过滤（shouldFilter=false，保留厂商 tab 过滤）。
// 数据源 registry.ts；wired=false 的厂商标记「未接入」。

import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Command, CommandEmpty, CommandItem, CommandList } from "./ui/command";
import { IconSearch, IconStar } from "../lib/icons";
import { cn } from "../lib/utils";
import { CM_BADGE, CM_BADGE_ACCENT } from "../lib/classes";
import {
  providerDisplayName,
  providerMeta,
  type ModelDef,
  type Studio,
  modelsForStudio,
  useCustomProviders,
} from "../models/registry";

interface ModelDropdownProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  trigger: ReactNode;
  studio: Studio;
  current: ModelDef;
  onSelect: (m: ModelDef) => void;
}

export function ModelDropdown({ open, onOpenChange, trigger, studio, current, onSelect }: ModelDropdownProps) {
  const { t } = useTranslation();
  const customProviders = useCustomProviders();
  const all = useMemo(() => modelsForStudio(studio), [studio, customProviders]);
  const [selProvider, setSelProvider] = useState<string>("all");
  const [search, setSearch] = useState("");

  const providersInStudio = useMemo(
    () => Array.from(new Set(all.map((m) => m.providerId))),
    [all],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter(
      (m) =>
        (selProvider === "all" || m.providerId === selProvider) &&
        (q === "" || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)),
    );
  }, [all, selProvider, search]);

  const pick = (m: ModelDef) => {
    onSelect(m);
    onOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-auto min-w-[480px] max-w-[calc(100vw-32px)] max-h-[40vh] overflow-y-auto rounded-lg border border-border-3 bg-overlay p-3.5 shadow-[0_10px_40px_var(--shadow-lg)] backdrop-blur-[24px] animate-[fadeInUp_.2s]">
        <div className="flex max-h-[60vh] min-h-[350px] gap-4 overflow-x-hidden">
          {/* 厂商 tab */}
          <div className="scrollbar-none flex w-14 shrink-0 flex-col items-center gap-2.5 overflow-y-auto border-r border-border-1 py-0.5 pr-2">
            <button
              className={cn(
                "grid size-8 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-full border border-border-1 bg-chip text-[10px] font-extrabold text-muted-foreground transition-all duration-150 hover:bg-hover hover:text-foreground",
                selProvider === "all" && "scale-105 border-[rgba(250,204,21,.30)] bg-hover-2 text-[#facc15]",
              )}
              title={t("model.allProviders")}
              aria-label={t("model.allTab")}
              aria-pressed={selProvider === "all"}
              onClick={(e) => {
                e.stopPropagation();
                setSelProvider("all");
              }}
            >
              <IconStar size={15} />
            </button>
            {providersInStudio.map((pid) => {
              const p = providerMeta(pid);
              const sel = selProvider === pid;
              return (
                <button
                  key={pid}
                  className={cn(
                    "grid size-8 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-full border border-border-1 bg-chip text-[10px] font-extrabold text-muted-foreground transition-all duration-150 hover:bg-hover hover:text-foreground",
                    sel && "scale-105 border-[rgba(255,255,255,.25)] shadow-[0_4px_12px_var(--shadow-xs)]",
                  )}
                  title={providerDisplayName(pid, t)}
                  aria-label={t("model.providerTab", { name: providerDisplayName(pid, t) })}
                  aria-pressed={sel}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelProvider(pid);
                  }}
                  style={
                    sel
                      ? { background: `${p.color}1a`, color: p.color, borderColor: `${p.color}40` }
                      : undefined
                  }
                >
                  {p.abbr}
                </button>
              );
            })}
          </div>

          {/* 列表区 */}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Command shouldFilter={false}>
              <div className="flex items-center gap-3 rounded-lg border border-border-1 bg-soft px-4 py-2 transition-colors duration-150 focus-within:border-[rgba(59,130,246,.50)]">
                <IconSearch size={14} style={{ color: "var(--muted)" }} />
                <input
                  type="text"
                  className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                  placeholder={t("model.search")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="flex shrink-0 items-center justify-between px-1 py-1 text-xs font-semibold text-text-2">
                <span>{t("model.available")}</span>
                {selProvider !== "all" && (
                  <span className="rounded-[6px] bg-soft px-2 py-0.5 text-[10px] text-muted-foreground">{providerDisplayName(selProvider, t)}</span>
                )}
              </div>
              <CommandList className="scrollbar-none flex flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
                {filtered.length === 0 ? (
                  <CommandEmpty className="py-6 text-center text-xs text-muted-foreground">
                    {selProvider.startsWith("custom:")
                      ? t("customProvider.empty")
                      : t("model.none")}
                  </CommandEmpty>
                ) : (
                  filtered.map((m) => {
                    const sel = current.id === m.id;
                    const p = providerMeta(m.providerId);
                    const isCustom = m.providerId.startsWith("custom:");
                    const i2iLabel =
                      studio === "image"
                        ? m.capabilities.includes("i2i")
                          ? m.edit
                            ? t("model.supportsEdit")
                            : t("model.supportsI2i")
                          : ""
                        : m.capabilities.includes("i2v")
                          ? t("model.supportsI2v")
                          : "";
                    return (
                      <CommandItem
                        key={`${m.providerId}:${m.id}`}
                        value={`${m.providerId}:${m.id}`}
                        onSelect={() => pick(m)}
                        className={cn(
                          "flex cursor-pointer items-center justify-between gap-3 rounded-md border border-transparent bg-transparent px-3 py-3 transition-all duration-150 hover:border-border-1 hover:bg-hover",
                          sel && "border-border-1 bg-hover",
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="grid size-8 shrink-0 place-items-center rounded-full border border-border-1 text-[11px] font-extrabold text-black" style={{ background: p.color }}>
                            {p.abbr}
                          </div>
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-xs font-bold tracking-tight text-foreground">
                              {m.name}
                              {!p.wired && <span style={{ color: "var(--warn)", marginLeft: 6 }}>{t("model.notWired")}</span>}
                              {isCustom && <span className={cn(CM_BADGE, CM_BADGE_ACCENT)}>{t("customProvider.badge")}</span>}
                            </span>
                            {selProvider === "all" && (
                              <span className="text-[9px] text-muted-foreground">
                                {providerDisplayName(m.providerId, t)}
                                {i2iLabel}
                              </span>
                            )}
                          </div>
                        </div>
                        {sel && (
                          <svg className="size-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={4}>
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </CommandItem>
                    );
                  })
                )}
              </CommandList>
            </Command>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
