// 工作室共享状态与生成逻辑 Hook。
// 两个 studio 常驻挂载（CSS hidden 切换），各自独立持有状态，切换不丢失。
// 会话状态由 App 层 useSessionStore 持有（侧边栏与工作室共享），这里只负责：
// 模型/参数表单、任务提交（占位卡入列 → invoke generate → 成功替换 / 失败标记）、任务删除。
// 进度事件路由与历史补齐在 sessionStore 内完成。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { aspectToSize, type ModelDef, modelsForStudio, useCustomProviders } from "../models/registry";
import { deleteHistories, generate, toAssetUrl } from "../api";
import type { ResultItem, SessionApi } from "./sessionStore";

let _seq = 0;
const uid = () => `r_${Date.now().toString(36)}_${_seq++}`;

export interface StudioApi {
  studio: "image" | "video";
  model: ModelDef;
  ar: string;
  quality: string;
  duration: string; // 仅视频
  batch: number; // 仅图像
  prompt: string;
  refs: string[];
  results: ResultItem[]; // 当前会话的结果
  running: number; // 进行中任务卡数（loading 卡数）
  finished: number; // 当前会话已完成任务数（成功 + 失败，按任务计）
  sessionTotal: number; // 当前会话新提交任务总数（不把历史恢复任务算进角标）
  setPrompt: (v: string) => void;
  setAr: (v: string) => void;
  setQuality: (v: string) => void;
  setDuration: (v: string) => void;
  setBatch: (n: number) => void;
  selectModel: (m: ModelDef) => void;
  addRef: (url: string) => void;
  removeRef: (i: number) => void;
  removeResult: (id: string) => void;
  removeTask: (taskId: string) => void;
  regenerate: (taskId: string) => void;
  applyVideoJump: (src: string, prompt: string) => void;
  handleGenerate: () => Promise<void>;
}

export function useStudio(studio: "image" | "video", session: SessionApi): StudioApi {
  const { t } = useTranslation();
  const customProviders = useCustomProviders();
  const allModels = useMemo(() => modelsForStudio(studio), [studio, customProviders]);
  const [model, setModel] = useState<ModelDef>(() => allModels[studio === "image" ? 0 : 1]);
  const [ar, setAr] = useState(() => allModels[studio === "image" ? 0 : 1].aspectRatios[0]);
  const [quality, setQuality] = useState(() => allModels[studio === "image" ? 0 : 1].qualities[0]);
  const [duration, setDuration] = useState(() => allModels[studio === "image" ? 0 : 1].durations?.[0] ?? "5");
  const [batch, setBatch] = useState(1);
  const [prompt, setPrompt] = useState("");
  const [refs, setRefs] = useState<string[]>([]);

  const { results, stats } = session;
  const { running, finished, sessionTotal } = stats;

  // 自定义模型（魔搭）列表变化时，保持当前选中模型；若已被删除则回退默认。
  useEffect(() => {
    setModel((prev) => allModels.find((m) => m.id === prev.id) ?? allModels[studio === "image" ? 0 : 1]);
  }, [allModels, studio]);

  const selectModel = useCallback(
    (m: ModelDef) => {
      setModel(m);
      setAr((prev) => (m.aspectRatios.includes(prev) ? prev : m.aspectRatios[0]));
      setQuality((prev) => (m.qualities.includes(prev) ? prev : m.qualities[0]));
      if (m.durations) setDuration((prev) => (m.durations!.includes(prev) ? prev : m.durations![0]));
      if (studio === "image") setBatch((prev) => Math.min(prev, m.maxRef ?? 4));
    },
    [studio],
  );

  const addRef = useCallback((url: string) => setRefs((r) => [...r, url]), []);
  const removeRef = useCallback((i: number) => setRefs((r) => r.filter((_, idx) => idx !== i)), []);

  const removeResult = useCallback(
    (id: string) => {
      const target = results.find((it) => it.id === id);
      session.patchActive((prev) => prev.filter((it) => it.id !== id));
      if (target?.historyId != null) void deleteHistories([target.historyId]).catch(() => {});
    },
    [results, session.patchActive],
  );

  // 按任务整条删除（时间线的任务级删除：一次提交的全部产物一起移除）。
  const removeTask = useCallback(
    (taskId: string) => {
      const target = results.find((it) => it.taskId === taskId);
      session.patchActive((prev) => prev.filter((it) => it.taskId !== taskId));
      if (target?.historyId != null) void deleteHistories([target.historyId]).catch(() => {});
    },
    [results, session.patchActive],
  );

  // 图生视频跳转：把源图作为首帧参考 + 回填 prompt（仅视频 studio 使用）。
  const applyVideoJump = useCallback(
    (src: string, p: string) => {
      if (studio !== "video") return;
      setRefs([src]);
      setPrompt(p);
    },
    [studio],
  );

  // 一次提交 = 一个任务（taskId），与占位卡一一对应；无并发守卫，
  // 提交后立即返回，可随时再次提交新任务（多任务并行执行，各自独立进度）。
  // handleGenerate 与 regenerate 共用此提交流程。
  const submitTask = useCallback(
    async (params: {
      taskId: string;
      prompt: string;
      model: ModelDef;
      ar: string;
      quality: string;
      duration: string;
      n: number;
      refs: string[];
      isVideo: boolean;
    }) => {
      const { taskId, prompt: p, model: m, ar: ar0, quality: q, duration: d, n, refs: refs0, isVideo } = params;
      const capability = refs0.length > 0 ? (isVideo ? "i2v" : "i2i") : isVideo ? "t2v" : "t2i";
      const size = aspectToSize(m.providerId, ar0);
      const extra = isVideo ? `${d}s · ${q}` : q;
      // 自定义厂商：透传用户按模型配置的自由参数（协议原生字段名，如
      // steps/guidance/seed/negative_prompt（魔搭）或 num_inference_steps/guidance_scale（HF））
      const customExtra = m.custom ? { params: m.custom.params } : undefined;

      const ids = Array.from({ length: n }, () => uid());
      const now = Date.now();
      const placeholders: ResultItem[] = ids.map((id) => ({
        id,
        taskId,
        at: now,
        status: "loading",
        prompt: p,
        model: m.name,
        modelId: m.id,
        ar: ar0,
        extra,
        quality: q,
        duration: d,
        refs: refs0,
        phase: "submitting",
      }));
      // 对话式队列：新任务追加到时间线底部，而非头部。
      session.patchActive((prev) => [...prev, ...placeholders]);

      try {
        const res = await generate({
          task_id: taskId,
          provider_id: m.providerId,
          capability,
          prompt: p,
          model: m.id,
          size,
          n,
          aspect_ratio: ar0,
          quality: q,
          duration: isVideo ? d : undefined,
          references: refs0,
          extra: customExtra,
        });
        const done: ResultItem[] = res.local_paths.map((lp, i) => ({
          id: ids[i] ?? uid(),
          taskId,
          historyId: res.history_id,
          at: 0, // 占位 → done 替换时由下方映射从旧条目带过来
          status: "done",
          url: toAssetUrl(lp),
          path: lp,
          prompt: p,
          model: res.model,
          modelId: m.id,
          ar: ar0,
          extra,
          quality: q,
          duration: d,
          refs: refs0,
        }));
        session.patchActive((prev) => {
          const map = new Map(done.map((d) => [d.id, d]));
          return prev.map((it) => {
            const d = map.get(it.id);
            return d ? { ...d, at: it.at } : it;
          });
        });
      } catch (e) {
        const msg = typeof e === "string" ? e : (e as Error)?.message ?? t("common.generationFailed");
        session.patchActive((prev) =>
          prev.map((it) => (ids.includes(it.id) ? { ...it, status: "error", error: msg } : it)),
        );
      }
    },
    [session.patchActive, t],
  );

  const handleGenerate = useCallback(async () => {
    const p =
      prompt.trim() ||
      (studio === "video" ? "cinematic dynamic scene, high quality" : "a beautiful scene, highly detailed");

    // 会话内首条消息时用提示词自动命名（类 ChatGPT）。
    if (results.length === 0 && p.trim()) {
      session.renameSession(session.activeId, p.trim().slice(0, 12));
    }

    await submitTask({
      taskId: uid(),
      prompt: p,
      model,
      ar,
      quality,
      duration,
      n: studio === "image" ? batch : 1,
      refs,
      isVideo: studio === "video",
    });
  }, [prompt, studio, batch, refs, model, ar, quality, duration, results, session.activeId, session.renameSession, submitTask]);

  // 重新生成：按原任务的参数快照再提交一次（模型/提示词/比例/画质/时长/参考图/批量数）。
  const regenerate = useCallback(
    (taskId: string) => {
      const task = results.find((it) => it.taskId === taskId);
      if (!task || task.status !== "done") return;
      const m = allModels.find((x) => x.id === task.modelId) ?? model;
      const n = results.filter((it) => it.taskId === taskId).length;
      void submitTask({
        taskId: uid(),
        prompt: task.prompt,
        model: m,
        ar: task.ar,
        quality: task.quality ?? quality,
        duration: task.duration ?? duration,
        n,
        refs: task.refs ?? [],
        isVideo: studio === "video",
      });
    },
    [results, allModels, model, quality, duration, studio, submitTask],
  );

  return {
    studio,
    model,
    ar,
    quality,
    duration,
    batch,
    prompt,
    refs,
    results,
    running,
    finished,
    sessionTotal,
    setPrompt,
    setAr,
    setQuality,
    setDuration,
    setBatch,
    selectModel,
    addRef,
    removeRef,
    removeResult,
    removeTask,
    regenerate,
    applyVideoJump,
    handleGenerate,
  };
}
