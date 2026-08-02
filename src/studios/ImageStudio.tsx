// 图像工作室
// 对话式任务时间线 + 底部 PromptComposer。会话状态由 App 注入（侧边栏展示会话列表）。
// 交互：上滑浏览历史时输入框收起；点击收起栏在当前位置原地展开；「回到底部」按钮平滑滚回底部。

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevron } from "../lib/icons";
import { PromptComposer } from "../components/PromptComposer";
import { TaskTimeline } from "../components/TaskTimeline";
import { useStudio } from "./useStudio";
import type { SessionApi } from "./sessionStore";

interface ImageStudioProps {
  session: SessionApi;
  onImageToVideo?: (src: string, prompt: string) => void;
}

export function ImageStudio({ session, onImageToVideo }: ImageStudioProps) {
  const api = useStudio("image", session);
  const streamRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const { t } = useTranslation();

  // 时间线汇报底部状态：到顶/中间时输入框收起，回到底部时展开。
  const handleBottomChange = useCallback((bottom: boolean) => {
    setAtBottom(bottom);
    setComposerCollapsed(!bottom);
  }, []);

  // 回到底部：仅滚动，展开交给滚动事件（滚动到位后 handleBottomChange 会展开输入框）。
  const scrollToBottom = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center bg-background p-4">
      <div className="m-0 flex-1 w-full overflow-y-auto px-2 pb-[220px]" ref={streamRef}>
        <TaskTimeline
          key={session.activeId}
          results={api.results}
          studio="image"
          model={api.model}
          scrollRef={streamRef}
          onBottomStateChange={handleBottomChange}
          onImageToVideo={onImageToVideo}
          onDeleteTask={api.removeTask}
          onRegenerate={api.regenerate}
        />
      </div>
      {!atBottom && (
        <button
          className={
            "absolute left-1/2 z-[35] flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-border-3 bg-overlay px-3.5 py-[7px] text-[11px] text-text-2 shadow-[0_8px_24px_var(--shadow-lg)] backdrop-blur-[16px] transition-colors duration-150 animate-[fadeInUp_.2s] hover:border-primary hover:text-primary" +
            (composerCollapsed ? " bottom-[88px]" : " bottom-[300px]")
          }
          type="button"
          onClick={scrollToBottom}
        >
          <IconChevron className="rotate-180" size={14} />
          <span>{t("prompt.backToBottom")}</span>
        </button>
      )}
      <PromptComposer api={api} collapsed={composerCollapsed} onExpand={() => setComposerCollapsed(false)} />
    </div>
  );
}
