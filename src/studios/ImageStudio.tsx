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
    <div className="studio-root">
      <div className="results-stream" ref={streamRef}>
        <TaskTimeline
          key={session.activeId}
          results={api.results}
          studio="image"
          model={api.model}
          scrollRef={streamRef}
          onBottomStateChange={handleBottomChange}
          onImageToVideo={onImageToVideo}
          onDeleteTask={api.removeTask}
          onDeleteItem={api.removeResult}
          onRegenerate={api.regenerate}
        />
      </div>
      {!atBottom && (
        <button
          className={"back-bottom" + (composerCollapsed ? " compact" : "")}
          type="button"
          onClick={scrollToBottom}
        >
          <IconChevron className="back-bottom-icon" size={14} />
          <span>{t("prompt.backToBottom")}</span>
        </button>
      )}
      <PromptComposer api={api} collapsed={composerCollapsed} onExpand={() => setComposerCollapsed(false)} />
    </div>
  );
}
