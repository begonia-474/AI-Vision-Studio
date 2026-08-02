// 视频工作室
// 对话式任务时间线 + 底部 PromptComposer。会话状态由 App 注入（侧边栏展示会话列表）。
// 差异：duration 控件、无批量、结果卡为视频（播放叠层）。
// 接收来自图像工作室的「图生视频」跳转（jump），通过 effect 注入首帧 + prompt。
// 交互：上滑浏览历史时输入框收起；点击收起栏在当前位置原地展开；「回到底部」按钮平滑滚回底部。

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevron } from "../lib/icons";
import { PromptComposer } from "../components/PromptComposer";
import { TaskTimeline } from "../components/TaskTimeline";
import { useStudio } from "./useStudio";
import type { SessionApi } from "./sessionStore";

interface VideoStudioProps {
  session: SessionApi;
  jump: { src: string; prompt: string } | null;
  onJumpConsumed: () => void;
}

export function VideoStudio({ session, jump, onJumpConsumed }: VideoStudioProps) {
  const api = useStudio("video", session);
  const streamRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const { t } = useTranslation();

  const handleBottomChange = useCallback((bottom: boolean) => {
    setAtBottom(bottom);
    setComposerCollapsed(!bottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (jump) {
      api.applyVideoJump(jump.src, jump.prompt);
      onJumpConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center bg-background p-4">
      <div className="m-0 flex-1 w-full overflow-y-auto px-2 pb-[220px]" ref={streamRef}>
        <TaskTimeline
          key={session.activeId}
          results={api.results}
          studio="video"
          model={api.model}
          scrollRef={streamRef}
          onBottomStateChange={handleBottomChange}
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
