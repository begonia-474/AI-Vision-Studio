// App = Shell
// header + body(sidebar + content)。两个 studio 与图库常驻挂载，用 hidden 类切换以保留状态。
// BYOK / Settings 为独立 modal，由 sidebar 底部入口触发。
// 图像 → 视频跳转：ImageStudio/GalleryView 触发 onImageToVideo，App 切换 tab 并向 VideoStudio 注入 jump。

import { useState } from "react";
import { Header } from "./shell/Header";
import { Sidebar } from "./shell/Sidebar";
import { ImageStudio } from "./studios/ImageStudio";
import { VideoStudio } from "./studios/VideoStudio";
import { GalleryView } from "./components/GalleryView";
import { ByokModal } from "./components/ByokModal";
import { SettingsModal } from "./components/SettingsModal";
import { IMAGE_MODELS, VIDEO_MODELS } from "./models/registry";

export type View = "image" | "video" | "gallery";

export default function App() {
  const [activeView, setActiveView] = useState<View>("image");
  const [collapsed, setCollapsed] = useState(false);
  const [byokOpen, setByokOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [videoJump, setVideoJump] = useState<{ src: string; prompt: string } | null>(null);

  const handleImageToVideo = (src: string, prompt: string) => {
    setVideoJump({ src, prompt });
    setActiveView("video");
  };

  return (
    <div className="shell">
      <Header activeView={activeView} onToggleSidebar={() => setCollapsed((v) => !v)} />

      <div className="body">
        <Sidebar
          activeView={activeView}
          collapsed={collapsed}
          onSwitch={setActiveView}
          onOpenByok={() => setByokOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <div className="content">
          <div className={"studio" + (activeView === "image" ? "" : " hidden")}>
            <ImageStudio onImageToVideo={handleImageToVideo} />
          </div>
          <div className={"studio" + (activeView === "video" ? "" : " hidden")}>
            <VideoStudio jump={videoJump} onJumpConsumed={() => setVideoJump(null)} />
          </div>
          <div className={"studio" + (activeView === "gallery" ? "" : " hidden")}>
            <GalleryView onImageToVideo={handleImageToVideo} />
          </div>
        </div>
      </div>

      <ByokModal open={byokOpen} onClose={() => setByokOpen(false)} />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        defaultImage={IMAGE_MODELS[0].name}
        defaultVideo={VIDEO_MODELS[1].name}
      />
    </div>
  );
}
