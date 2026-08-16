// 图像工作室
// 对话式任务时间线 + 底部 PromptComposer。会话状态由 App 注入（侧边栏展示会话列表）。
// 交互：上滑浏览历史时输入框收起；点击收起栏在当前位置原地展开；「回到底部」按钮平滑滚回底部。
// 接收来自图库的「作为参考图」跳转（jump），通过 effect 注入参考图 + prompt。
// 点击任务队列完成结果卡打开作品详情（DetailPanel，与图库共用）。

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { IconChevron } from "../lib/icons";
import { PromptComposer } from "../components/PromptComposer";
import { TaskTimeline } from "../components/TaskTimeline";
import { DetailPanel, type DetailSource } from "../components/DetailPanel";
import { useStudio } from "./useStudio";
import { jumpFromParams, type ResultItem, type SessionApi } from "./sessionStore";
import type { StudioJump } from "../types";

interface ImageStudioProps {
  session: SessionApi;
  onImageToVideo?: (src: string, prompt: string) => void;
  jump: StudioJump | null;
  onReEdit?: (j: StudioJump & { studio: "image" | "video" }) => void;
}

// memo：session（SessionApi）引用已稳定化（审计#12），视频工作室的进度事件不再
// 连带重渲染图像工作室；提示词输入只重渲染本工作室表单区，时间线由 TaskTimeline
// 自身的 memo 跳过。
export const ImageStudio = memo(function ImageStudio({ session, onImageToVideo, jump, onReEdit }: ImageStudioProps) {
  const api = useStudio("image", session);
  const streamRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const [composerH, setComposerH] = useState(0);
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  const { t } = useTranslation();

  // 输入条高度变化：滚动区底部让位，长提示词展开时不被遮住（即梦/krea 行为）。
  // 预留高度直写滚动容器 DOM（不经过 React 状态/重渲染）——折叠/展开动画期间
  // ResizeObserver 每帧回调，若走 setState 会每帧重建整个时间线树导致卡顿。
  // setComposerH 仅用于「回到底部」按钮的垂直定位。
  const handleComposerHeight = useCallback((h: number) => {
    setComposerH(h);
    const el = streamRef.current;
    if (el) el.style.paddingBottom = `${Math.max(h + 40, 92)}px`;
  }, []);

  // 渲染期消费跳转信号（React 官方 "adjusting state when a prop changes" 模式）：
  // 记录上一次的 jump，prop 变化时立即回填表单，不经 effect 编排数据流。
  // 注意：applyJump 内部均为本地 setState，无外部副作用，方可在此执行；
  // App 侧无需清除 jump——prevJump 记忆保证同一信号不会重复应用。
  const [prevJump, setPrevJump] = useState<StudioJump | null>(null);
  if (jump !== prevJump) {
    setPrevJump(jump);
    if (jump) api.applyJump(jump);
  }

  // 详情数据源：当前会话的完成结果（删除整任务；跳转与重新编辑走会话参数快照）。
  // 审计#12：原实现对每条完成结果内层再 filter 全量数组统计同任务张数（O(n²)），
  // 每次进度事件都重算；改为先单遍扫描出 taskId→张数 Map 再 O(1) 查表
  // （与 sessionStore 的 stats 单遍思路一致，审计#9）。
  const doneCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of api.results) {
      if (r.status === "done") m.set(r.taskId, (m.get(r.taskId) ?? 0) + 1);
    }
    return m;
  }, [api.results]);

  const detailSources = useMemo<DetailSource[]>(
    () =>
      api.results
        .filter((r) => r.status === "done")
        .map((r) => {
          const n = doneCounts.get(r.taskId) ?? 1;
          return {
            key: r.id,
            image: true,
            prompt: r.prompt,
            model: r.model,
            createdAt: new Date(r.at).toISOString(),
            paths: r.path ? [r.path] : [],
            historyId: r.historyId,
            ratio: r.ar,
            size: r.size,
            quality: r.quality,
            duration: r.duration,
            format: r.format,
            n,
            params: r.params,
            loras: r.loras,
            onDelete: () => {
              setDetailIdx(null);
              api.removeTask(r.taskId);
            },
            onImageToVideo: (src, prompt) => {
              setDetailIdx(null);
              onImageToVideo?.(src, prompt);
            },
            onImageToImage: (src, prompt) => {
              setDetailIdx(null);
              // 审计#12：src 为详情面板提供的本地产物路径，直接入 refs（通路统一为路径）。
              api.applyJump({ prompt, refs: [src] });
            },
            onReEdit: () => {
              setDetailIdx(null);
              const n = doneCounts.get(r.taskId) ?? 1;
              let j: (StudioJump & { studio: "image" | "video" }) | undefined;
              if (r.paramsJson) {
                try {
                  j = jumpFromParams(
                    { prompt: r.prompt, model: r.modelId ?? r.model },
                    JSON.parse(r.paramsJson) as Record<string, unknown>,
                    true,
                    r.refs,
                  );
                } catch {
                  // paramsJson 损坏回退散装快照
                }
              }
              onReEdit?.(
                j ?? {
                  studio: "image",
                  prompt: r.prompt,
                  modelId: r.modelId,
                  ar: r.ar,
                  quality: r.quality,
                  duration: r.duration,
                  n,
                  refs: r.refs,
                  loras: r.loras,
                },
              );
            },
          };
        }),
    [api.results, doneCounts, api.removeTask, onImageToVideo, onReEdit],
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

  // 打开详情 / 重新编辑：稳定引用，配合 TaskTimeline memo 在折叠动画期间跳过时间线重渲染。
  // 审计#12：原实现依赖 detailSources / api.results——任何结果变化都重建回调引用，
  // 使 TaskTimeline 的 memo 对全部任务卡失效；改用 ref 读取最新数据，回调恒稳定。
  const detailSourcesRef = useRef(detailSources);
  detailSourcesRef.current = detailSources;
  const openDetail = useCallback((item: ResultItem) => {
    const idx = detailSourcesRef.current.findIndex((s) => s.key === item.id);
    if (idx >= 0) setDetailIdx(idx);
  }, []);

  const doneCountsRef = useRef(doneCounts);
  doneCountsRef.current = doneCounts;
  const onReEditRef = useRef(onReEdit);
  onReEditRef.current = onReEdit;
  const reEdit = useCallback((item: ResultItem) => {
    const n = doneCountsRef.current.get(item.taskId) ?? 1;
    let j: (StudioJump & { studio: "image" | "video" }) | undefined;
    if (item.paramsJson) {
      try {
        j = jumpFromParams(
          { prompt: item.prompt, model: item.modelId ?? item.model },
          JSON.parse(item.paramsJson) as Record<string, unknown>,
          true,
          item.refs,
        );
      } catch {
        // paramsJson 损坏回退散装快照
      }
    }
    onReEditRef.current?.(
      j ??
        {
          studio: "image",
          prompt: item.prompt,
          modelId: item.modelId,
          ar: item.ar,
          quality: item.quality,
          duration: item.duration,
          n,
          refs: item.refs,
          loras: item.loras,
        },
    );
  }, []);

  // 审计#12：原实现为内联箭头函数，每次渲染（含输入击键）新建引用，击穿
  // TaskTimeline 的 memo，数百张卡随每次击键整树重渲染；改为稳定引用
  // （api.applyJump 仅随模型选择变化，输入过程恒稳定）。
  const handleImageToImage = useCallback(
    (src: string, prompt: string) => {
      // 审计#12：参考图数据通路统一为本地路径（不再存 base64 data URL），
      // 预览经 asset 协议渲染，后端收编时才读文件。
      api.applyJump({ prompt, refs: [src] });
      // 回填后滚回底部让输入条展开，提示词/参考图立即可见可改
      const el = streamRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    },
    [api.applyJump],
  );

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center bg-background p-4">
      <div className="m-0 flex-1 w-full overflow-y-auto px-2" ref={streamRef}>
        <TaskTimeline
          key={session.activeId}
          results={api.results}
          studio="image"
          emptyModelName={api.model.name}
          scrollRef={streamRef}
          onBottomStateChange={handleBottomChange}
          onImageToVideo={onImageToVideo}
          onImageToImage={handleImageToImage}
          onDeleteTask={api.removeTask}
          onRegenerate={api.regenerate}
          onOpenDetail={openDetail}
          onReEdit={reEdit}
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
});
