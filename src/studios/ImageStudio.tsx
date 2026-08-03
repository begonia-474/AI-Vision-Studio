// 图像工作室
// 对话式任务时间线 + 底部 PromptComposer。会话状态由 App 注入（侧边栏展示会话列表）。
// 交互：上滑浏览历史时输入框收起；点击收起栏在当前位置原地展开；「回到底部」按钮平滑滚回底部。
// 接收来自图库的「作为参考图」跳转（jump），通过 effect 注入参考图 + prompt。
// 点击任务队列完成结果卡打开作品详情（DetailPanel，与图库共用）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevron } from "../lib/icons";
import { PromptComposer } from "../components/PromptComposer";
import { TaskTimeline } from "../components/TaskTimeline";
import { DetailPanel, type DetailSource } from "../components/DetailPanel";
import { useStudio } from "./useStudio";
import type { SessionApi } from "./sessionStore";
import type { StudioJump } from "../types";

interface ImageStudioProps {
  session: SessionApi;
  onImageToVideo?: (src: string, prompt: string) => void;
  jump: StudioJump | null;
  onJumpConsumed: () => void;
  onReEdit?: (j: StudioJump & { studio: "image" | "video" }) => void;
}

export function ImageStudio({ session, onImageToVideo, jump, onJumpConsumed, onReEdit }: ImageStudioProps) {
  const api = useStudio("image", session);
  const streamRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const [composerH, setComposerH] = useState(0);
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  const { t } = useTranslation();

  // 底部预留：输入条本体 + bottom-4 偏移(16) + 与任务时间线一致的间距(pb-6 = 24)。
  // 折叠时贴合胶囊条（~52 + 40 ≈ 92），不残留死空间；展开时内容末尾始终停在输入条上方 24px。
  const bottomPadding = Math.max(composerH + 40, 92);

  // 输入条高度变化：滚动区底部让位，长提示词展开时不被遮住（即梦/krea 行为）。
  const handleComposerHeight = useCallback((h: number) => setComposerH(h), []);

  useEffect(() => {
    if (jump) {
      api.applyJump(jump);
      onJumpConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  // 详情数据源：当前会话的完成结果（删除整任务；跳转与重新编辑走会话参数快照）。
  const detailSources = useMemo<DetailSource[]>(
    () =>
      api.results
        .filter((r) => r.status === "done")
        .map((r) => {
          const n = api.results.filter((x) => x.taskId === r.taskId && x.status === "done").length;
          return {
            key: r.id,
            image: true,
            prompt: r.prompt,
            model: r.model,
            createdAt: new Date(r.at).toISOString(),
            paths: r.path ? [r.path] : [],
            ratio: r.ar,
            quality: r.quality,
            duration: r.duration,
            n,
            onDelete: () => {
              setDetailIdx(null);
              api.removeTask(r.taskId);
            },
            onImageToVideo: (src, prompt) => {
              setDetailIdx(null);
              onImageToVideo?.(src, prompt);
            },
            onReEdit: () => {
              setDetailIdx(null);
              onReEdit?.({ studio: "image", prompt: r.prompt, modelId: r.modelId, ar: r.ar, quality: r.quality, duration: r.duration, n, refs: r.refs });
            },
          };
        }),
    [api.results, api.removeTask, onImageToVideo, onReEdit],
  );

  // 时间线汇报底部状态：上滑离开底部时输入条收起（即梦式折叠），回到底部时展开。
  // layout 事件 = 折叠动画让位引发的被动回滚：用户实际已在底部，只同步位置，
  // 不触发展开，否则折叠到一半又被展开、输入条持续遮挡结果网格。
  const handleBottomChange = useCallback((bottom: boolean, layout = false) => {
    setAtBottom(bottom);
    if (layout && bottom) return;
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
      <div className="m-0 flex-1 w-full overflow-y-auto px-2" ref={streamRef} style={{ paddingBottom: bottomPadding }}>
        <TaskTimeline
          key={session.activeId}
          results={api.results}
          studio="image"
          model={api.model}
          scrollRef={streamRef}
          bottomPadding={bottomPadding}
          onBottomStateChange={handleBottomChange}
          onImageToVideo={onImageToVideo}
          onDeleteTask={api.removeTask}
          onRegenerate={api.regenerate}
          onOpenDetail={(item) => {
            const idx = detailSources.findIndex((s) => s.key === item.id);
            if (idx >= 0) setDetailIdx(idx);
          }}
          onReEdit={(item) => {
            const n = api.results.filter((x) => x.taskId === item.taskId && x.status === "done").length;
            onReEdit?.({ studio: "image", prompt: item.prompt, modelId: item.modelId, ar: item.ar, quality: item.quality, duration: item.duration, n, refs: item.refs });
          }}
        />
      </div>
      {!atBottom && (
        <button
          className="absolute left-1/2 z-[35] flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-border-3 bg-overlay px-3.5 py-[7px] text-[11px] text-text-2 shadow-[0_8px_24px_var(--shadow-lg)] backdrop-blur-[16px] transition-colors duration-150 animate-[fadeInUp_.2s] hover:border-primary hover:text-primary"
          style={{ bottom: composerCollapsed ? 88 : composerH + 28 }}
          type="button"
          onClick={scrollToBottom}
        >
          <IconChevron className="rotate-180" size={14} />
          <span>{t("prompt.backToBottom")}</span>
        </button>
      )}
      <PromptComposer
        api={api}
        collapsed={composerCollapsed}
        onExpand={() => setComposerCollapsed(false)}
        onHeightChange={handleComposerHeight}
        onWheelOutside={(e) => {
          streamRef.current?.scrollBy({ top: e.deltaY });
        }}
      />

      {detailIdx != null && (
        <DetailPanel
          sources={detailSources}
          index={detailIdx}
          onClose={() => setDetailIdx(null)}
          onNavigate={(delta) =>
            setDetailIdx((i) => (i == null ? i : Math.min(Math.max(0, i + delta), detailSources.length - 1)))
          }
        />
      )}
    </div>
  );
}
