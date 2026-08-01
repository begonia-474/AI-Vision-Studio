// 模型选择弹层（shadcn Popover + Command）
// 左侧厂商圆形 tab（All 用星形 + 各厂首字母）+ 右侧搜索框 + 模型列表。
// cmdk 提供键盘导航（方向键 + Enter）；搜索由自身过滤（shouldFilter=false，保留厂商 tab 过滤）。
// 数据源 registry.ts；wired=false 的厂商标记「未接入」。

import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Command, CommandEmpty, CommandItem, CommandList } from "./ui/command";
import { IconSearch, IconStar } from "../lib/icons";
import {
  PROVIDERS,
  type ModelDef,
  type Studio,
  modelsForStudio,
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
  const all = useMemo(() => modelsForStudio(studio), [studio]);
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
      <PopoverContent side="top" align="start" className="popover wide">
        <div className="model-pop">
          {/* 厂商 tab */}
          <div className="providers">
            <button
              className={"prov-btn all" + (selProvider === "all" ? " active" : "")}
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
              const p = PROVIDERS[pid];
              const sel = selProvider === pid;
              return (
                <button
                  key={pid}
                  className={"prov-btn" + (sel ? " active" : "")}
                  title={t(p.name)}
                  aria-label={t("model.providerTab", { name: t(p.name) })}
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
          <div className="list">
            <Command shouldFilter={false}>
              <div className="model-search">
                <IconSearch size={14} style={{ color: "var(--muted)" }} />
                <input
                  type="text"
                  placeholder={t("model.search")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="model-list-title">
                <span>{t("model.available")}</span>
                {selProvider !== "all" && <span className="prov-name">{t(PROVIDERS[selProvider].name)}</span>}
              </div>
              <CommandList className="model-list-scroll">
                {filtered.length === 0 ? (
                  <CommandEmpty className="empty-models">{t("model.none")}</CommandEmpty>
                ) : (
                  filtered.map((m) => {
                    const sel = current.id === m.id;
                    const p = PROVIDERS[m.providerId];
                    const i2iLabel =
                      studio === "image"
                        ? m.capabilities.includes("i2i")
                          ? t("model.supportsI2i")
                          : ""
                        : m.capabilities.includes("i2v")
                          ? t("model.supportsI2v")
                          : "";
                    return (
                      <CommandItem
                        key={m.id}
                        value={m.id}
                        onSelect={() => pick(m)}
                        className="model-item"
                      >
                        <div className="mi-left">
                          <div className="mi-logo" style={{ background: p.color }}>
                            {p.abbr}
                          </div>
                          <div className="mi-name">
                            <span className="nm">
                              {m.name}
                              {!p.wired && <span style={{ color: "var(--warn)", marginLeft: 6 }}>{t("model.notWired")}</span>}
                            </span>
                            {selProvider === "all" && (
                              <span className="pv">
                                {t(p.name)}
                                {i2iLabel}
                              </span>
                            )}
                          </div>
                        </div>
                        {sel && (
                          <svg className="mi-check" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={4}>
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
