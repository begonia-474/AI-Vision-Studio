// Sidebar —— 侧栏
// 扁平两项（Image / Video Studio）+ 底部 BYOK / Settings 入口。
// collapsed 时仅显示图标（CSS 控制宽度与 label 隐藏）。

import { IconImage, IconKey, IconSettings, IconVideo } from "../lib/icons";

interface SidebarProps {
  activeStudio: "image" | "video";
  collapsed: boolean;
  onSwitch: (s: "image" | "video") => void;
  onOpenByok: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({ activeStudio, collapsed, onSwitch, onOpenByok, onOpenSettings }: SidebarProps) {
  return (
    <aside className={"sidebar" + (collapsed ? " collapsed" : "")}>
      <nav aria-label="Studio navigation">
        <div className="nav-group">
          <button
            className={"cat-btn" + (activeStudio === "image" ? " active" : "")}
            onClick={() => onSwitch("image")}
          >
            <IconImage className="cat-ico" size={19} />
            <span className="cat-label">Image Studio</span>
          </button>
          <button
            className={"cat-btn" + (activeStudio === "video" ? " active" : "")}
            onClick={() => onSwitch("video")}
          >
            <IconVideo className="cat-ico" size={19} />
            <span className="cat-label">Video Studio</span>
          </button>
        </div>

        <div className="nav-sep">
          <button className="apps-btn" title="BYOK 厂商 Key 管理" onClick={onOpenByok}>
            <IconKey className="apps-ico" size={19} />
            <span className="cat-label">BYOK</span>
          </button>
          <button className="apps-btn" title="设置" onClick={onOpenSettings}>
            <IconSettings className="apps-ico" size={19} />
            <span className="cat-label">Settings</span>
          </button>
        </div>
      </nav>
    </aside>
  );
}
