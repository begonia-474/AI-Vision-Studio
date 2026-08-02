// 工作室共享状态与生成逻辑 Hook。
// 两个 studio 常驻挂载（CSS hidden 切换），各自独立持有状态，切换不丢失。
// 生成流程：占位卡入列 → invoke generate → 成功替换为本地资源 / 失败标记错误。
// 进度通过 mount 时订阅 "gen-progress" 事件，避免与生成调用竞态。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { aspectToSize, type ModelDef, modelsForStudio, useCustomProviders } from "../models/registry";
import { generate, onProgress, toAssetUrl } from "../api";

export type Studio = "image" | "video";
export type ResultStatus = "loading" | "done" | "error";

export interface ResultItem {
  id: string;
  taskId: string; // 同一次提交（一次 invoke）的所有卡片共享；进度事件按它路由
  status: ResultStatus;
  url?: string; // done 时为本地产物 asset url
  path?: string; // done 时为本地绝对路径（i2v 跳转传原路径，后端转 data URL）
  prompt: string;
  model: string;
  ar: string;
  extra: string; // 图像：quality；视频：duration + " · " + quality
  error?: string;
  // loading 期间实时阶段（由 gen-progress 事件按 taskId 写入；进度数值不展示，
  // 卡片上用装饰性动画代替，避免后端跳变式进度显得卡顿）
  phase?: string;
  msg?: string;
}

let _seq = 0;
const uid = () => `r_${Date.now().toString(36)}_${_seq++}`;

export interface StudioApi {
  studio: Studio;
  model: ModelDef;
  ar: string;
  quality: string;
  duration: string; // 仅视频
  batch: number; // 仅图像
  prompt: string;
  refs: string[];
  results: ResultItem[];
  running: number; // 进行中任务数（loading 卡数）
  finished: number; // 已完成任务数（done + error 卡数）
  setPrompt: (v: string) => void;
  setAr: (v: string) => void;
  setQuality: (v: string) => void;
  setDuration: (v: string) => void;
  setBatch: (n: number) => void;
  selectModel: (m: ModelDef) => void;
  addRef: (url: string) => void;
  removeRef: (i: number) => void;
  removeResult: (id: string) => void;
  applyVideoJump: (src: string, prompt: string) => void;
  handleGenerate: () => Promise<void>;
}

export function useStudio(studio: Studio): StudioApi {
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
  const [results, setResults] = useState<ResultItem[]>([]);
  const aliveRef = useRef(true);

  // 会话级统计（不持久化，每次启动归零）：
  // running = 进行中任务数；finished = 已完成任务数（成功 + 失败）。
  // 角标格式 "x/y 正在生成中"：x=finished，y=本次会话提交的任务总数（results 全长）。
  const running = useMemo(() => results.filter((it) => it.status === "loading").length, [results]);
  const finished = useMemo(
    () => results.filter((it) => it.status === "done" || it.status === "error").length,
    [results],
  );

  // 自定义模型（魔搭）列表变化时，保持当前选中模型；若已被删除则回退默认。
  useEffect(() => {
    setModel((prev) => allModels.find((m) => m.id === prev.id) ?? allModels[studio === "image" ? 0 : 1]);
  }, [allModels, studio]);

  // mount 时订阅一次进度事件；按 task_id 路由到对应任务卡，
  // 多任务并发时各卡进度互不串台（task_id 为空则忽略）。
  useEffect(() => {
    aliveRef.current = true;
    let un: (() => void) | undefined;
    onProgress((p) => {
      if (!aliveRef.current || !p.task_id) return;
      setResults((prev) =>
        prev.map((it) =>
          it.taskId === p.task_id ? { ...it, phase: p.phase, msg: p.message } : it,
        ),
      );
    }).then((u) => {
      un = u;
    });
    return () => {
      aliveRef.current = false;
      un?.();
    };
  }, []);

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
    (id: string) => setResults((prev) => prev.filter((it) => it.id !== id)),
    [],
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
  const handleGenerate = useCallback(async () => {
    const taskId = uid();
    const p =
      prompt.trim() ||
      (studio === "video" ? "cinematic dynamic scene, high quality" : "a beautiful scene, highly detailed");
    const n = studio === "image" ? batch : 1;
    const capability = refs.length > 0 ? (studio === "image" ? "i2i" : "i2v") : studio === "image" ? "t2i" : "t2v";
    const size = aspectToSize(model.providerId, ar);
    const extra = studio === "video" ? `${duration}s · ${quality}` : quality;
    // 自定义厂商：透传用户按模型配置的自由参数（协议原生字段名，如
    // steps/guidance/seed/negative_prompt（魔搭）或 num_inference_steps/guidance_scale（HF））
    const customExtra = model.custom ? { params: model.custom.params } : undefined;

    const ids = Array.from({ length: n }, () => uid());
    const placeholders: ResultItem[] = ids.map((id) => ({
      id,
      taskId,
      status: "loading",
      prompt: p,
      model: model.name,
      ar,
      extra,
      phase: "submitting",
    }));
    setResults((prev) => [...placeholders, ...prev]);

    try {
      const res = await generate({
        task_id: taskId,
        provider_id: model.providerId,
        capability,
        prompt: p,
        model: model.id,
        size,
        n,
        aspect_ratio: ar,
        quality,
        duration: studio === "video" ? duration : undefined,
        references: refs,
        extra: customExtra,
      });
      const done: ResultItem[] = res.local_paths.map((lp, i) => ({
        id: ids[i] ?? uid(),
        taskId,
        status: "done",
        url: toAssetUrl(lp),
        path: lp,
        prompt: p,
        model: res.model,
        ar,
        extra,
      }));
      setResults((prev) => {
        const map = new Map(done.map((d) => [d.id, d]));
        return prev.map((it) => map.get(it.id) ?? it);
      });
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error)?.message ?? t("common.generationFailed");
      setResults((prev) =>
        prev.map((it) => (ids.includes(it.id) ? { ...it, status: "error", error: msg } : it)),
      );
    }
  }, [prompt, studio, batch, refs, model, ar, quality, duration, t]);

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
    setPrompt,
    setAr,
    setQuality,
    setDuration,
    setBatch,
    selectModel,
    addRef,
    removeRef,
    removeResult,
    applyVideoJump,
    handleGenerate,
  };
}
