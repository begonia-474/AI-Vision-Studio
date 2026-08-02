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
    <div className="studio-root">
      <div className="results-stream" ref={streamRef}>
        <TaskTimeline
          key={session.activeId}
          results={api.results}
          studio="video"
          model={api.model}
          scrollRef={streamRef}
          onBottomStateChange={handleBottomChange}
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
