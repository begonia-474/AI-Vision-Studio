// 工作室共享状态与生成逻辑 Hook。
// 两个 studio 常驻挂载（CSS hidden 切换），各自独立持有状态，切换不丢失。
// 生成流程：占位卡入列 → invoke generate → 成功替换为本地资源 / 失败标记错误。
// 进度通过 mount 时订阅 "gen-progress" 事件，避免与生成调用竞态。

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { aspectToSize, type ModelDef, modelsForStudio } from "../models/registry";
import { generate, onProgress, toAssetUrl } from "../api";
import type { ProgressPayload } from "../types";

export type Studio = "image" | "video";
export type ResultStatus = "loading" | "done" | "error";

export interface ResultItem {
  id: string;
  status: ResultStatus;
  url?: string; // done 时为本地产物 asset url
  prompt: string;
  model: string;
  ar: string;
  extra: string; // 图像：quality；视频：duration + " · " + quality
  error?: string;
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
  generating: boolean;
  progress: ProgressPayload | null;
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
  const initial = modelsForStudio(studio)[studio === "image" ? 0 : 1];
  const [model, setModel] = useState<ModelDef>(initial);
  const [ar, setAr] = useState(initial.aspectRatios[0]);
  const [quality, setQuality] = useState(initial.qualities[0]);
  const [duration, setDuration] = useState(initial.durations?.[0] ?? "5");
  const [batch, setBatch] = useState(1);
  const [prompt, setPrompt] = useState("");
  const [refs, setRefs] = useState<string[]>([]);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const aliveRef = useRef(true);

  // mount 时订阅一次进度事件，全程更新 progress；展示与否由 generating 决定。
  useEffect(() => {
    aliveRef.current = true;
    let un: (() => void) | undefined;
    onProgress((p) => {
      if (aliveRef.current) setProgress(p);
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

  const handleGenerate = useCallback(async () => {
    if (generating) return;
    const p =
      prompt.trim() ||
      (studio === "video" ? "cinematic dynamic scene, high quality" : "a beautiful scene, highly detailed");
    const n = studio === "image" ? batch : 1;
    const capability = refs.length > 0 ? (studio === "image" ? "i2i" : "i2v") : studio === "image" ? "t2i" : "t2v";
    const size = aspectToSize(model.providerId, ar);
    const extra = studio === "video" ? `${duration}s · ${quality}` : quality;

    const ids = Array.from({ length: n }, () => uid());
    const placeholders: ResultItem[] = ids.map((id) => ({
      id,
      status: "loading",
      prompt: p,
      model: model.name,
      ar,
      extra,
    }));
    setResults((prev) => [...placeholders, ...prev]);
    setGenerating(true);
    setProgress({ phase: "submitting", progress: 10, message: t("prompt.phaseSubmitting") });

    try {
      const res = await generate({
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
      });
      const done: ResultItem[] = res.local_paths.map((lp, i) => ({
        id: ids[i] ?? uid(),
        status: "done",
        url: toAssetUrl(lp),
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
      setProgress({ phase: "failed", progress: 100, message: msg });
    } finally {
      setGenerating(false);
    }
  }, [generating, prompt, studio, batch, refs, model, ar, quality, duration, t]);

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
    generating,
    progress,
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
