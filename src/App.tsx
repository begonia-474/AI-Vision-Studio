// App = Shell
// header + body(sidebar + content)。两个 studio 常驻挂载，用 hidden 类切换以保留状态。
// BYOK / Settings 为独立 modal，由 sidebar 底部入口触发。
// 图像 → 视频 跳转：ImageStudio 触发 onImageToVideo，App 切换 tab 并向 VideoStudio 注入 jump。

import { useState } from "react";
import { Header } from "./shell/Header";
import { Sidebar } from "./shell/Sidebar";
import { ImageStudio } from "./studios/ImageStudio";
import { VideoStudio } from "./studios/VideoStudio";
import { ByokModal } from "./components/ByokModal";
import { SettingsModal } from "./components/SettingsModal";
import { IMAGE_MODELS, VIDEO_MODELS } from "./models/registry";

export default function App() {
  const [activeStudio, setActiveStudio] = useState<"image" | "video">("image");
  const [collapsed, setCollapsed] = useState(false);
  const [byokOpen, setByokOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [videoJump, setVideoJump] = useState<{ src: string; prompt: string } | null>(null);

  const handleImageToVideo = (src: string, prompt: string) => {
    setVideoJump({ src, prompt });
    setActiveStudio("video");
  };

  return (
    <div className="shell">
      <Header activeStudio={activeStudio} onToggleSidebar={() => setCollapsed((v) => !v)} />

      <div className="body">
        <Sidebar
          activeStudio={activeStudio}
          collapsed={collapsed}
          onSwitch={setActiveStudio}
          onOpenByok={() => setByokOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <div className="content">
          <div className={"studio" + (activeStudio === "image" ? "" : " hidden")}>
            <ImageStudio onImageToVideo={handleImageToVideo} />
          </div>
          <div className={"studio" + (activeStudio === "video" ? "" : " hidden")}>
            <VideoStudio jump={videoJump} onJumpConsumed={() => setVideoJump(null)} />
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
