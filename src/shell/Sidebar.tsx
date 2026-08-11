// Sidebar —— 侧栏
// 顶栏：logo + 程序名 + 折叠按钮（原 Header 并入）；
// 中部：Image / Video Studio / Gallery 三个入口 + 当前工作室的会话列表（类 ChatGPT/豆包，仅展开态显示）；
// 底部：Settings 入口。collapsed 时仅显示图标，悬停经 Radix Tooltip 显示入口名（展开态无悬停信息）。

import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { IconImage, IconKey, IconLibrary, IconSettings, IconSidebar, IconVideo } from "../lib/icons";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import type { View } from "../App";
import type { SessionApi } from "../studios/sessionStore";
import logo from "../assets/logo.png";

/** 折叠态悬停提示：展开态原样返回（不显示任何额外信息），折叠态包一层右侧 Tooltip */
function TooltipIf({ show, label, children }: { show: boolean; label: string; children: ReactElement }) {
  if (!show) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

interface SidebarProps {
  activeView: View;
  collapsed: boolean;
  sessions: SessionApi; // 当前（或最近）工作室的会话，图库视图常驻展示
  onActivateStudio: () => void; // 点击/新建会话时跳回会话所属工作室
  onSwitch: (v: View) => void;
  onToggleSidebar: () => void;
  onOpenByok: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({ activeView, collapsed, sessions, onActivateStudio, onSwitch, onToggleSidebar, onOpenByok, onOpenSettings }: SidebarProps) {
  const { t } = useTranslation();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commit = () => {
    // 手动重命名：标记 nameManuallyEdited，自动命名不得覆盖（对齐 Codex）
    if (renamingId && draft.trim() && sessions) sessions.renameSession(renamingId, draft.trim(), true);
    setRenamingId(null);
  };

  const catBtn =
    "relative flex w-full cursor-pointer items-center gap-3 rounded-lg border border-transparent bg-transparent px-3 py-2 text-left text-xs font-semibold tracking-tight text-text-3 transition-all duration-300 ease-[cubic-bezier(.4,0,.2,1)] hover:bg-hover hover:text-foreground";
  const catBtnActive =
    "border-[rgba(59,130,246,.20)] bg-[linear-gradient(90deg,rgba(59,130,246,.15),rgba(96,165,250,.10))] text-primary shadow-[var(--shadow-glow)] hover:border-[rgba(59,130,246,.20)] hover:bg-[linear-gradient(90deg,rgba(59,130,246,.15),rgba(96,165,250,.10))] hover:text-primary before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:content-[''] before:rounded-r-full before:bg-[linear-gradient(to_bottom,var(--accent),var(--accent-2))] before:shadow-[0_0_8px_rgba(59,130,246,.60)]";
  // 折叠态：标签移出文档流（absolute），图标才能真正居中（opacity-0 仍在布局内会把图标挤偏）
  const catBtnCollapsed =
    "group-[.collapsed]/sb:justify-center group-[.collapsed]/sb:gap-0 group-[.collapsed]/sb:rounded-lg group-[.collapsed]/sb:px-0 group-[.collapsed]/sb:py-2";
  const catLabelCollapsed = "group-[.collapsed]/sb:absolute group-[.collapsed]/sb:opacity-0";

  return (
    <TooltipProvider delayDuration={150}>
      <aside
        className={cn(
          "group/sb flex h-full shrink-0 flex-col overflow-hidden border-r border-border-2 bg-sidebar-bg transition-[width] duration-300 ease-[cubic-bezier(.4,0,.2,1)]",
          collapsed ? "collapsed w-[68px]" : "w-52",
        )}
      >
      {/* 顶栏：logo + 程序名 + 折叠按钮（哩布式：成对居中，折叠时仅留居中的折叠钮） */}
      <div className="flex h-[68px] shrink-0 items-center justify-center gap-4 border-b border-border-1 px-2">
        <div className={cn("flex min-w-0 items-center gap-2", collapsed && "hidden")}>
          <img src={logo} alt="AI Vision Studio" draggable={false} className="size-7 shrink-0 rounded-md object-contain" />
          <span className="truncate text-[13px] font-bold tracking-tight">AI Vision Studio</span>
        </div>
        <button
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg border border-border-1 bg-soft text-text-3 transition-colors duration-150 hover:bg-hover-2 hover:text-foreground"
          title={t("header.toggleSidebar")}
          aria-label={t("header.toggleSidebar")}
          onClick={onToggleSidebar}
        >
          <IconSidebar size={18} />
        </button>
      </div>

      <nav aria-label="Studio navigation" className="scrollbar-none flex flex-1 flex-col overflow-x-hidden overflow-y-auto p-2">
        <div className="flex flex-col gap-1">
          <TooltipIf show={collapsed} label={t("sidebar.imageStudio")}>
            <button
              className={cn(catBtn, catBtnCollapsed, activeView === "image" && catBtnActive)}
              onClick={() => onSwitch("image")}
            >
              <IconImage className="size-[19px] shrink-0" size={19} />
              <span className={cn("min-w-0 flex-1 truncate transition-opacity duration-300 group-[.collapsed]/sb:opacity-0", catLabelCollapsed)}>{t("sidebar.imageStudio")}</span>
            </button>
          </TooltipIf>
          <TooltipIf show={collapsed} label={t("sidebar.videoStudio")}>
            <button
              className={cn(catBtn, catBtnCollapsed, activeView === "video" && catBtnActive)}
              onClick={() => onSwitch("video")}
            >
              <IconVideo className="size-[19px] shrink-0" size={19} />
              <span className={cn("min-w-0 flex-1 truncate transition-opacity duration-300 group-[.collapsed]/sb:opacity-0", catLabelCollapsed)}>{t("sidebar.videoStudio")}</span>
            </button>
          </TooltipIf>
          <TooltipIf show={collapsed} label={t("sidebar.gallery")}>
            <button
              className={cn(catBtn, catBtnCollapsed, activeView === "gallery" && catBtnActive)}
              onClick={() => onSwitch("gallery")}
            >
              <IconLibrary className="size-[19px] shrink-0" size={19} />
              <span className={cn("min-w-0 flex-1 truncate transition-opacity duration-300 group-[.collapsed]/sb:opacity-0", catLabelCollapsed)}>{t("sidebar.gallery")}</span>
            </button>
          </TooltipIf>
        </div>

        {/* 当前工作室的会话列表（ChatGPT/豆包风格；折叠时收成首字符圆点列） */}
        <div className={cn("mt-3 flex min-h-0 flex-1 flex-col gap-2 border-t border-line-2 pt-3", collapsed && "items-center gap-2.5")}>
          {collapsed ? (
            <>
              <button
                className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-soft text-[15px] leading-none text-faint-2 transition-all duration-150 hover:bg-accent hover:text-primary"
                title={t("sessions.new")}
                aria-label={t("sessions.new")}
                onClick={() => {
                  sessions.createSession();
                  onActivateStudio();
                }}
              >
                +
              </button>
              <div className="scrollbar-none flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto">
                {sessions.sessions.map((s) => (
                  <button
                    className={cn(
                      "grid size-7 shrink-0 cursor-pointer place-items-center rounded-full border border-border-2 bg-soft text-[11px] font-bold text-text-3 transition-colors duration-150 hover:bg-hover-2 hover:text-foreground",
                      s.id === sessions.activeId && "border-[rgba(59,130,246,.35)] bg-accent text-primary",
                    )}
                    title={s.title}
                    aria-label={s.title}
                    key={s.id}
                    onClick={() => {
                      sessions.switchSession(s.id);
                      onActivateStudio();
                    }}
                  >
                    {s.title.charAt(0).toUpperCase()}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>

        <div className="mt-auto flex flex-col gap-1 border-t border-line-2 pt-3">
          <TooltipIf show={collapsed} label={t("sidebar.byok")}>
            <button className={cn(catBtn, catBtnCollapsed)} onClick={onOpenByok}>
              <IconKey className="size-[19px] shrink-0" size={19} />
              <span className={cn("min-w-0 flex-1 truncate transition-opacity duration-300 group-[.collapsed]/sb:opacity-0", catLabelCollapsed)}>{t("sidebar.byok")}</span>
            </button>
          </TooltipIf>
          <TooltipIf show={collapsed} label={t("sidebar.settings")}>
            <button className={cn(catBtn, catBtnCollapsed)} onClick={onOpenSettings}>
              <IconSettings className="size-[19px] shrink-0" size={19} />
              <span className={cn("min-w-0 flex-1 truncate transition-opacity duration-300 group-[.collapsed]/sb:opacity-0", catLabelCollapsed)}>{t("sidebar.settings")}</span>
            </button>
          </TooltipIf>
        </div>
      </nav>
      </aside>
    </TooltipProvider>
  );
}
