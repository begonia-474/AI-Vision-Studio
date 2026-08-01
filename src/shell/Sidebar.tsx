// Sidebar —— 侧栏
// 三个入口（Image / Video Studio / Gallery）+ 底部 BYOK / Settings 入口。
// collapsed 时仅显示图标（CSS 控制宽度与 label 隐藏）。

import { useTranslation } from "react-i18next";
import { IconImage, IconKey, IconLibrary, IconSettings, IconVideo } from "../lib/icons";
import type { View } from "../App";

interface SidebarProps {
  activeView: View;
  collapsed: boolean;
  onSwitch: (v: View) => void;
  onOpenByok: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({ activeView, collapsed, onSwitch, onOpenByok, onOpenSettings }: SidebarProps) {
  const { t } = useTranslation();

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

        <div className="nav-sep">
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
