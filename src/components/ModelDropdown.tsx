// 模型选择 Popover
// 左侧厂商圆形 tab（All 用星形 + 各厂首字母）+ 右侧搜索框 + 模型列表。
// 数据源 registry.ts；wired=false 的厂商标记「未接入」。

import { useMemo, useState } from "react";
import { Popover } from "./Popover";
import { IconSearch, IconStar } from "../lib/icons";
import {
  PROVIDERS,
  type ModelDef,
  type Studio,
  modelsForStudio,
} from "../models/registry";

interface ModelDropdownProps {
  open: boolean;
  onClose: () => void;
  studio: Studio;
  current: ModelDef;
  onSelect: (m: ModelDef) => void;
}

export function ModelDropdown({ open, onClose, studio, current, onSelect }: ModelDropdownProps) {
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

  return (
    <Popover open={open} onClose={onClose} wide>
      <div className="model-pop">
        {/* 厂商 tab */}
        <div className="providers">
          <button
            className={"prov-btn all" + (selProvider === "all" ? " active" : "")}
            title="All Providers"
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
                title={p.name}
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
          <div className="model-search">
            <IconSearch size={14} style={{ color: "var(--muted)" }} />
            <input
              type="text"
              placeholder="Search models..."
              value={search}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="model-list-title">
            <span>Available models</span>
            {selProvider !== "all" && <span className="prov-name">{PROVIDERS[selProvider].name}</span>}
          </div>
          <div className="model-list-scroll">
            {filtered.length === 0 ? (
              <div className="empty-models">No models found</div>
            ) : (
              filtered.map((m) => {
                const sel = current.id === m.id;
                const p = PROVIDERS[m.providerId];
                const i2iLabel =
                  studio === "image"
                    ? m.capabilities.includes("i2i")
                      ? " · supports i2i"
                      : ""
                    : m.capabilities.includes("i2v")
                      ? " · supports i2v"
                      : "";
                return (
                  <div
                    key={m.id}
                    className={"model-item" + (sel ? " selected" : "")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(m);
                      onClose();
                    }}
                  >
                    <div className="mi-left">
                      <div className="mi-logo" style={{ background: p.color }}>
                        {p.abbr}
                      </div>
                      <div className="mi-name">
                        <span className="nm">
                          {m.name}
                          {!p.wired && <span style={{ color: "var(--warn)", marginLeft: 6 }}>· 未接入</span>}
                        </span>
                        {selProvider === "all" && (
                          <span className="pv">
                            {p.name}
                            {i2iLabel}
                          </span>
                        )}
                      </div>
                    </div>
                    {sel && (
                      <svg className="mi-check" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth={4}>
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </Popover>
  );
}
