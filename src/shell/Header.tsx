// Header —— 顶栏
// 左：折叠键 + logo + 品牌名；中：面包屑（当前 studio）；不放设置按钮（避免双入口）。

import { useTranslation } from "react-i18next";
import { IconSidebar } from "../lib/icons";

interface HeaderProps {
  activeStudio: "image" | "video";
  onToggleSidebar: () => void;
}

export function Header({ activeStudio, onToggleSidebar }: HeaderProps) {
  const { t } = useTranslation();

  return (
    <header className="header">
      <div className="h-left">
        <button
          className="sidebar-toggle"
          title={t("header.toggleSidebar")}
          aria-label={t("header.toggleSidebar")}
          onClick={onToggleSidebar}
        >
          <IconSidebar size={18} />
        </button>
        <div className="logo-row">
          <div className="logo">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <span className="brand-name">AI Vision Studio</span>
        </div>
      </div>

      <div className="crumb">
        <span className="dot" />
        <b>{activeStudio === "video" ? t("header.videoStudio") : t("header.imageStudio")}</b>
      </div>
    </header>
  );
}
