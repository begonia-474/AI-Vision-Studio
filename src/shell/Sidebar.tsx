// Sidebar —— 侧栏
// 顶部：Image / Video Studio / Gallery 三个入口；
// 中部：当前工作室的会话列表（类 ChatGPT/豆包，仅展开态显示）；
// 底部：自定义厂商 / BYOK / Settings 入口。collapsed 时仅显示图标。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconBox, IconImage, IconKey, IconLibrary, IconSettings, IconVideo } from "../lib/icons";
import type { View } from "../App";
import type { SessionApi } from "../studios/sessionStore";

interface SidebarProps {
  activeView: View;
  collapsed: boolean;
  sessions: SessionApi; // 当前（或最近）工作室的会话，图库视图常驻展示
  onActivateStudio: () => void; // 点击/新建会话时跳回会话所属工作室
  onSwitch: (v: View) => void;
  onOpenByok: () => void;
  onOpenCustomProvider: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({ activeView, collapsed, sessions, onActivateStudio, onSwitch, onOpenByok, onOpenCustomProvider, onOpenSettings }: SidebarProps) {
  const { t } = useTranslation();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commit = () => {
    if (renamingId && draft.trim() && sessions) sessions.renameSession(renamingId, draft.trim());
    setRenamingId(null);
  };

  return (
    <aside className={"sidebar" + (collapsed ? " collapsed" : "")}>
      <nav aria-label="Studio navigation">
        <div className="nav-group">
          <button
            className={"cat-btn" + (activeView === "image" ? " active" : "")}
            onClick={() => onSwitch("image")}
          >
            <IconImage className="cat-ico" size={19} />
            <span className="cat-label">{t("sidebar.imageStudio")}</span>
          </button>
          <button
            className={"cat-btn" + (activeView === "video" ? " active" : "")}
            onClick={() => onSwitch("video")}
          >
            <IconVideo className="cat-ico" size={19} />
            <span className="cat-label">{t("sidebar.videoStudio")}</span>
          </button>
          <button
            className={"cat-btn" + (activeView === "gallery" ? " active" : "")}
            title={t("sidebar.galleryTitle")}
            onClick={() => onSwitch("gallery")}
          >
            <IconLibrary className="cat-ico" size={19} />
            <span className="cat-label">{t("sidebar.gallery")}</span>
          </button>
        </div>

        {/* 当前工作室的会话列表（ChatGPT/豆包风格，常驻） */}
        {!collapsed && (
          <div className="sidebar-sessions">
            <div className="sb-sess-head">
              <span>{t("sessions.title")}</span>
              <button
                className="sb-sess-new"
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
            <div className="sb-sess-list">
              {sessions.sessions.map((s) => (
                <div
                  className={"sb-sess-item" + (s.id === sessions.activeId ? " active" : "")}
                  key={s.id}
                >
                  {renamingId === s.id ? (
                    <input
                      className="sb-sess-rename"
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
                      className="sb-sess-name"
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
                      className="sb-sess-del"
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

        <div className="nav-sep">
          <button className="apps-btn" title={t("sidebar.customProviderTitle")} onClick={onOpenCustomProvider}>
            <IconBox className="apps-ico" size={19} />
            <span className="cat-label">{t("sidebar.customProvider")}</span>
          </button>
          <button className="apps-btn" title={t("sidebar.byokTitle")} onClick={onOpenByok}>
            <IconKey className="apps-ico" size={19} />
            <span className="cat-label">{t("sidebar.byok")}</span>
          </button>
          <button className="apps-btn" title={t("sidebar.settingsTitle")} onClick={onOpenSettings}>
            <IconSettings className="apps-ico" size={19} />
            <span className="cat-label">{t("sidebar.settings")}</span>
          </button>
        </div>
      </nav>
    </aside>
  );
}
