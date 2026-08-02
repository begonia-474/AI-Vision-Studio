// Sidebar —— 侧栏
// 顶栏：logo + 程序名 + 折叠按钮（原 Header 并入）；
// 中部：Image / Video Studio / Gallery 三个入口 + 当前工作室的会话列表（类 ChatGPT/豆包，仅展开态显示）；
// 底部：自定义厂商 / BYOK / Settings 入口。collapsed 时仅显示图标。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconBox, IconImage, IconKey, IconLibrary, IconSettings, IconSidebar, IconVideo } from "../lib/icons";
import { cn } from "../lib/utils";
import type { View } from "../App";
import type { SessionApi } from "../studios/sessionStore";

interface SidebarProps {
  activeView: View;
  collapsed: boolean;
  sessions: SessionApi; // 当前（或最近）工作室的会话，图库视图常驻展示
  onActivateStudio: () => void; // 点击/新建会话时跳回会话所属工作室
  onSwitch: (v: View) => void;
  onToggleSidebar: () => void;
  onOpenByok: () => void;
  onOpenCustomProvider: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({ activeView, collapsed, sessions, onActivateStudio, onSwitch, onToggleSidebar, onOpenByok, onOpenCustomProvider, onOpenSettings }: SidebarProps) {
  const { t } = useTranslation();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commit = () => {
    if (renamingId && draft.trim() && sessions) sessions.renameSession(renamingId, draft.trim());
    setRenamingId(null);
  };

  const catBtn =
    "relative flex w-full cursor-pointer items-center gap-3 rounded-xl border border-transparent bg-transparent px-3 py-2.5 text-left text-xs font-semibold tracking-tight text-text-3 transition-all duration-300 ease-[cubic-bezier(.4,0,.2,1)] hover:bg-hover hover:text-foreground";
  const catBtnActive =
    "border-[rgba(59,130,246,.20)] bg-[linear-gradient(90deg,rgba(59,130,246,.15),rgba(96,165,250,.10))] text-primary shadow-[var(--shadow-glow)] hover:border-[rgba(59,130,246,.20)] hover:bg-[linear-gradient(90deg,rgba(59,130,246,.15),rgba(96,165,250,.10))] hover:text-primary before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:content-[''] before:rounded-r-full before:bg-[linear-gradient(to_bottom,var(--accent),var(--accent-2))] before:shadow-[0_0_8px_rgba(59,130,246,.60)]";

  return (
    <aside
      className={cn(
        "group/sb flex h-full shrink-0 flex-col overflow-hidden border-r border-border-2 bg-sidebar-bg transition-[width] duration-300 ease-[cubic-bezier(.4,0,.2,1)]",
        collapsed ? "collapsed w-16" : "w-52",
      )}
    >
      {/* 顶栏：logo + 程序名 + 折叠按钮 */}
      <div className={cn("flex h-14 shrink-0 items-center gap-2.5 border-b border-border-1 px-3", collapsed && "justify-center px-2")}>
        <div className={cn("grid size-8 shrink-0 place-items-center rounded-md bg-primary text-black", collapsed && "hidden")}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        </div>
        <span className={cn("min-w-0 flex-1 truncate text-sm font-extrabold tracking-tight", collapsed && "hidden")}>AI Vision Studio</span>
        <button
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border-1 bg-soft text-text-3 transition-colors duration-150 hover:bg-hover-2 hover:text-foreground"
          title={t("header.toggleSidebar")}
          aria-label={t("header.toggleSidebar")}
          onClick={onToggleSidebar}
        >
          <IconSidebar size={18} />
        </button>
      </div>

      <nav aria-label="Studio navigation" className="scrollbar-none flex flex-1 flex-col overflow-x-hidden overflow-y-auto p-2">
        <div className="flex flex-col gap-1">
          <button
            className={cn(catBtn, "group-[.collapsed]/sb:mx-auto group-[.collapsed]/sb:size-11 group-[.collapsed]/sb:justify-center group-[.collapsed]/sb:p-0", activeView === "image" && catBtnActive)}
            onClick={() => onSwitch("image")}
          >
            <IconImage className="size-[19px] shrink-0" size={19} />
            <span className="min-w-0 flex-1 truncate transition-opacity duration-300 group-[.collapsed]/sb:opacity-0">{t("sidebar.imageStudio")}</span>
          </button>
          <button
            className={cn(catBtn, "group-[.collapsed]/sb:mx-auto group-[.collapsed]/sb:size-11 group-[.collapsed]/sb:justify-center group-[.collapsed]/sb:p-0", activeView === "video" && catBtnActive)}
            onClick={() => onSwitch("video")}
          >
            <IconVideo className="size-[19px] shrink-0" size={19} />
            <span className="min-w-0 flex-1 truncate transition-opacity duration-300 group-[.collapsed]/sb:opacity-0">{t("sidebar.videoStudio")}</span>
          </button>
          <button
            className={cn(catBtn, "group-[.collapsed]/sb:mx-auto group-[.collapsed]/sb:size-11 group-[.collapsed]/sb:justify-center group-[.collapsed]/sb:p-0", activeView === "gallery" && catBtnActive)}
            title={t("sidebar.galleryTitle")}
            onClick={() => onSwitch("gallery")}
          >
            <IconLibrary className="size-[19px] shrink-0" size={19} />
            <span className="min-w-0 flex-1 truncate transition-opacity duration-300 group-[.collapsed]/sb:opacity-0">{t("sidebar.gallery")}</span>
          </button>
        </div>

        {/* 当前工作室的会话列表（ChatGPT/豆包风格，常驻） */}
        {!collapsed && (
          <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2 border-t border-line-2 pt-3">
            <div className="flex items-center justify-between px-1.5">
              <span className="text-[11px] font-bold uppercase tracking-[.08em] text-faint">{t("sessions.title")}</span>
              <button
                className="grid size-[22px] cursor-pointer place-items-center rounded-full border-0 bg-transparent text-[15px] leading-none text-faint-2 transition-all duration-150 hover:bg-accent hover:text-primary"
                title={t("sessions.new")}
                aria-label={t("sessions.new")}
                onClick={() => {
                  sessions.createSession();
                  onActivateStudio();
                }}
              >
                +
              </button>
            </div>
            <div className="scrollbar-none flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
              {sessions.sessions.map((s) => (
                <div
                  className={cn(
                    "group/ss flex items-center gap-0.5 rounded-md px-1.5 pl-2.5 hover:bg-hover",
                    s.id === sessions.activeId && "bg-accent hover:bg-accent",
                  )}
                  key={s.id}
                >
                  {renamingId === s.id ? (
                    <input
                      className="flex-1 min-w-0 rounded-[6px] border border-[rgba(59,130,246,.45)] bg-soft px-2 py-1 text-xs text-foreground outline-none"
                      value={draft}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={commit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commit();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                    />
                  ) : (
                    <button
                      className={cn(
                        "flex-1 min-w-0 cursor-pointer truncate border-0 bg-transparent py-[7px] text-left text-xs text-text-3 group-hover/ss:text-foreground",
                        s.id === sessions.activeId && "font-semibold text-primary group-hover/ss:text-primary",
                      )}
                      title={t("sessions.rename")}
                      onClick={() => {
                        sessions.switchSession(s.id);
                        onActivateStudio();
                      }}
                      onDoubleClick={() => {
                        setRenamingId(s.id);
                        setDraft(s.title);
                      }}
                    >
                      {s.title}
                    </button>
                  )}
                  {sessions.sessions.length > 1 && (
                    <button
                      className="grid size-[22px] shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-[13px] leading-none text-faint-2 opacity-0 transition-all duration-150 hover:bg-[rgba(239,68,68,.10)] hover:text-destructive group-hover/ss:opacity-100"
                      title={t("sessions.delete")}
                      aria-label={t("sessions.delete")}
                      onClick={() => sessions.deleteSession(s.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-auto flex flex-col gap-1 border-t border-line-2 pt-3">
          <button className={cn(catBtn, "group-[.collapsed]/sb:mx-auto group-[.collapsed]/sb:size-11 group-[.collapsed]/sb:justify-center group-[.collapsed]/sb:p-0")} title={t("sidebar.customProviderTitle")} onClick={onOpenCustomProvider}>
            <IconBox className="size-[19px] shrink-0" size={19} />
            <span className="min-w-0 flex-1 truncate transition-opacity duration-300 group-[.collapsed]/sb:opacity-0">{t("sidebar.customProvider")}</span>
          </button>
          <button className={cn(catBtn, "group-[.collapsed]/sb:mx-auto group-[.collapsed]/sb:size-11 group-[.collapsed]/sb:justify-center group-[.collapsed]/sb:p-0")} title={t("sidebar.byokTitle")} onClick={onOpenByok}>
            <IconKey className="size-[19px] shrink-0" size={19} />
            <span className="min-w-0 flex-1 truncate transition-opacity duration-300 group-[.collapsed]/sb:opacity-0">{t("sidebar.byok")}</span>
          </button>
          <button className={cn(catBtn, "group-[.collapsed]/sb:mx-auto group-[.collapsed]/sb:size-11 group-[.collapsed]/sb:justify-center group-[.collapsed]/sb:p-0")} title={t("sidebar.settingsTitle")} onClick={onOpenSettings}>
            <IconSettings className="size-[19px] shrink-0" size={19} />
            <span className="min-w-0 flex-1 truncate transition-opacity duration-300 group-[.collapsed]/sb:opacity-0">{t("sidebar.settings")}</span>
          </button>
        </div>
      </nav>
    </aside>
  );
}
