// App = Shell（两区：侧边栏 + 功能区）
// 顶部无独立 header：logo/程序名/折叠按钮并入侧边栏顶栏（见 Sidebar）。
// 三个 studio 与图库、自定义厂商管理页常驻挂载，用 hidden 类切换以保留状态。
// BYOK / Settings 为独立 modal，由 sidebar 底部入口触发。
// 图像 → 视频跳转：ImageStudio/GalleryView 触发 onImageToVideo，App 切换 tab 并向 VideoStudio 注入 jump。
// 图库 → 图像跳转：GalleryView 触发 onImageToImage，App 切换 tab 并向 ImageStudio 注入 jump（作为参考图）。

import { useEffect, useState } from "react";
import { cn } from "./lib/utils";
import { Sidebar } from "./shell/Sidebar";
import { ImageStudio } from "./studios/ImageStudio";
import { VideoStudio } from "./studios/VideoStudio";
import { GalleryView } from "./components/GalleryView";
import { ProvidersPage } from "./components/ProvidersPage";
import { ByokModal } from "./components/ByokModal";
import { SettingsModal } from "./components/SettingsModal";
import { useSessionStore } from "./studios/sessionStore";
import { IMAGE_MODELS, VIDEO_MODELS, refreshCustomProviders } from "./models/registry";
import type { StudioJump } from "./types";

export type View = "image" | "video" | "gallery" | "providers";

export default function App() {
  const [activeView, setActiveView] = useState<View>("image");
  const [collapsed, setCollapsed] = useState(false);
  const [byokOpen, setByokOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [videoJump, setVideoJump] = useState<StudioJump | null>(null);
  const [imageJump, setImageJump] = useState<StudioJump | null>(null);

  // 会话存储提升到 App 层：工作室与侧边栏共享同一份状态。
  const imageSession = useSessionStore("image");
  const videoSession = useSessionStore("video");

  // 图库视图没有会话，侧边栏固定展示「最近所在工作室」的会话列表，
  // 避免布局跳动（ChatGPT/豆包等侧边栏会话区常驻）。
  const [lastStudio, setLastStudio] = useState<"image" | "video">("image");
  useEffect(() => {
    if (activeView === "image" || activeView === "video") setLastStudio(activeView);
  }, [activeView]);
  const effectiveStudio = activeView === "image" || activeView === "video" ? activeView : lastStudio;
  const sessions = effectiveStudio === "video" ? videoSession : imageSession;

  // 侧边栏点击会话 / 新建会话时，跳回该会话所属工作室。
  const activateStudio = () => setActiveView(effectiveStudio);

  // 启动加载自定义厂商（JSON 配置）→ 注册表 emitter 通知两个 studio 刷新列表
  useEffect(() => {
    refreshCustomProviders().catch(() => {});
  }, []);

  const handleImageToVideo = (src: string, prompt: string) => {
    setVideoJump({ prompt, refs: [src] });
    setActiveView("video");
  };

  // 图库「作为参考图」→ 图像工作室 i2i 跳转（与图生视频同模式）。
  const handleImageToImage = (src: string, prompt: string) => {
    setImageJump({ prompt, refs: [src] });
    setActiveView("image");
  };

  // 图库「重新编辑」→ 对应工作室，回填原任务参数。
  const handleReEdit = (j: StudioJump & { studio: "image" | "video" }) => {
    const { studio, ...params } = j;
    if (studio === "video") {
      setVideoJump(params);
      setActiveView("video");
    } else {
      setImageJump(params);
      setActiveView("image");
    }
  };

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeView={activeView}
          collapsed={collapsed}
          onSwitch={setActiveView}
          sessions={sessions}
          onActivateStudio={activateStudio}
          onToggleSidebar={() => setCollapsed((v) => !v)}
          onOpenByok={() => setByokOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <div className="relative flex-1 overflow-hidden bg-background">
          <div className={cn("h-full w-full", activeView !== "image" && "hidden")}>
            <ImageStudio session={imageSession} onImageToVideo={handleImageToVideo} jump={imageJump} onJumpConsumed={() => setImageJump(null)} onReEdit={handleReEdit} />
          </div>
          <div className={cn("h-full w-full", activeView !== "video" && "hidden")}>
            <VideoStudio session={videoSession} jump={videoJump} onJumpConsumed={() => setVideoJump(null)} onReEdit={handleReEdit} />
          </div>
          <div className={cn("h-full w-full", activeView !== "gallery" && "hidden")}>
            <GalleryView onImageToVideo={handleImageToVideo} onImageToImage={handleImageToImage} onReEdit={handleReEdit} />
          </div>
          <div className={cn("h-full w-full", activeView !== "providers" && "hidden")}>
            <ProvidersPage onBack={() => setActiveView(lastStudio)} />
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
