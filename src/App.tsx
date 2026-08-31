// App = Shell（两区：侧边栏 + 功能区）
// 顶部无独立 header：logo/程序名/折叠按钮并入侧边栏顶栏（见 Sidebar）。
// 图像/视频工作室常驻挂载（hidden 切换以保留会话状态）；
// 图库为内容型视图，惰性挂载（激活才渲染）——常驻挂载会让图库
// 在后台持续渲染 996 条真实历史 + 补缩略图任务，占用主线程拖慢所有点击。
// Settings 为独立 modal，由 sidebar 底部入口触发。
// 图像 → 视频跳转：ImageStudio/GalleryView 触发 onImageToVideo，App 切换 tab 并向 VideoStudio 注入 jump。
// 图库 → 图像跳转：GalleryView 触发 onImageToImage，App 切换 tab 并向 ImageStudio 注入 jump（作为参考图）。

import { useCallback, useEffect, useState } from "react";
import { cn } from "./lib/utils";
import { Sidebar } from "./shell/Sidebar";
import { ImageStudio } from "./studios/ImageStudio";
import { VideoStudio } from "./studios/VideoStudio";
import { GalleryView } from "./components/GalleryView";
import { ByokModal } from "./components/ByokModal";
import { SettingsModal } from "./components/SettingsModal";
import { ToastHost } from "./components/ToastHost";
import { useSessionStore } from "./studios/sessionStore";
import { defaultModelForStudio, hydrateRegistry, refreshUserModels, useRegistryReady } from "./models/registry";
import type { StudioJump } from "./types";

export type View = "image" | "video" | "gallery";

export default function App() {
  const [activeView, setActiveView] = useState<View>("image");
  const [collapsed, setCollapsed] = useState(false);
  const [byokOpen, setByokOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 密钥配置版本号：BYOK 弹层关闭时自增，工作室据此重查密钥状态
  // （空状态「配置 API Key」入口在配置完成后自动消失）。
  const [keyRev, setKeyRev] = useState(0);
  const openByok = useCallback(() => setByokOpen(true), []);
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
  // useCallback：引用稳定，配合 Sidebar memo（审计#12），避免每次渲染重建 props。
  const activateStudio = useCallback(() => setActiveView(effectiveStudio), [effectiveStudio]);

  // 启动加载：先拉内置模型注册表（领域数据唯一事实源在 Rust），再刷新用户自添加模型。
  // 注册表就绪前不渲染工作室（模型列表/默认模型依赖它），避免首帧拿到空列表崩溃。
  const registryReady = useRegistryReady();
  useEffect(() => {
    if (registryReady) {
      void refreshUserModels();
    } else {
      void (async () => {
        await hydrateRegistry().catch(() => {});
        await refreshUserModels().catch(() => {});
      })();
    }
  }, [registryReady]);

  // 跳转信号：App 持有最近一次 jump 常驻（无需清除——studio 端用 prevJump
  // 记忆去重，同一信号不会重复应用），触发时切换视图。
  const handleImageToVideo = useCallback((src: string, prompt: string) => {
    setVideoJump({ prompt, refs: [src] });
    setActiveView("video");
  }, []);

  // 图库「作为参考图」→ 图像工作室 i2i 跳转（与图生视频同模式）。
  const handleImageToImage = useCallback((src: string, prompt: string) => {
    setImageJump({ prompt, refs: [src] });
    setActiveView("image");
  }, []);

  // 图库「重新编辑」→ 对应工作室，回填原任务参数。
  const handleReEdit = useCallback((j: StudioJump & { studio: "image" | "video" }) => {
    const { studio, ...params } = j;
    if (studio === "video") {
      setVideoJump(params);
      setActiveView("video");
    } else {
      setImageJump(params);
      setActiveView("image");
    }
  }, []);

  // 注册表门控：所有 hooks 已无条件执行完毕，此处才可提前返回加载态。
  if (!registryReady) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-text-2">
        加载模型注册表…
      </div>
    );
  }

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
          onOpenByok={openByok}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <div className="relative flex-1 overflow-hidden bg-background">
          <div className={cn("h-full w-full", activeView !== "image" && "hidden")}>
            <ImageStudio session={imageSession} onImageToVideo={handleImageToVideo} jump={imageJump} onReEdit={handleReEdit} onOpenByok={openByok} keyRev={keyRev} />
          </div>
          <div className={cn("h-full w-full", activeView !== "video" && "hidden")}>
            <VideoStudio session={videoSession} jump={videoJump} onReEdit={handleReEdit} onOpenByok={openByok} keyRev={keyRev} />
          </div>
          {activeView === "gallery" && (
            <div className="h-full w-full">
              <GalleryView
                imageSession={imageSession}
                videoSession={videoSession}
                onImageToVideo={handleImageToVideo}
                onImageToImage={handleImageToImage}
                onReEdit={handleReEdit}
              />
            </div>
          )}
        </div>
      </div>

      <ByokModal
        open={byokOpen}
        onClose={() => {
          setByokOpen(false);
          setKeyRev((v) => v + 1);
        }}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        defaultImage={defaultModelForStudio("image").name}
        defaultVideo={defaultModelForStudio("video").name}
      />
      <ToastHost />
    </div>
  );
}
