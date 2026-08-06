// 工作室共享状态与生成逻辑 Hook。
// 两个 studio 常驻挂载（CSS hidden 切换），各自独立持有状态，切换不丢失。
// 会话状态由 App 层 useSessionStore 持有（侧边栏与工作室共享），这里只负责：
// 模型/参数表单、任务提交（占位卡入列 → invoke generate → 成功替换 / 失败标记）、任务删除。
// 进度事件路由与历史补齐在 sessionStore 内完成。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { aspectToSize, batchCap, parseSizePx, type ModelDef, modelsForStudio, useCustomProviders } from "../models/registry";
import { deleteHistories, generate, toAssetUrl } from "../api";
import type { ResultItem, SessionApi } from "./sessionStore";
import type { StudioJump } from "../types";

let _seq = 0;
const uid = () => `r_${Date.now().toString(36)}_${_seq++}`;

export interface StudioApi {
  studio: "image" | "video";
  model: ModelDef;
  ar: string;
  quality: string;
  format: string; // 仅图像；输出格式（png/jpeg，缺省 jpeg）
  duration: string; // 仅视频
  batch: number; // 仅图像；组图模式下为组图张数（max_images）
  mode: "single" | "group"; // 生图模式：单图固定 1 张（API 无 n），组图 = sequential auto
  size: { w: number; h: number } | null; // 自定义像素尺寸（仅声明 size 区的模型，选中比例时同步）
  sizeLocked: boolean; // W/H 锁定比例联动
  paramValues: Record<string, string | number>; // 自定义厂商自由参数（popover 运行时值，提交时覆盖 params 默认）
  prompt: string;
  refs: string[];
  results: ResultItem[]; // 当前会话的结果
  running: number; // 进行中任务卡数（loading 卡数）
  finished: number; // 当前会话已完成任务数（成功 + 失败，按任务计）
  sessionTotal: number; // 当前会话新提交任务总数（不把历史恢复任务算进角标）
  setPrompt: (v: string) => void;
  setAr: (v: string) => void;
  setQuality: (v: string) => void;
  setFormat: (v: string) => void;
  setDuration: (v: string) => void;
  setBatch: (n: number) => void;
  setMode: (v: "single" | "group") => void;
  setSize: (w: number, h: number) => void;
  setSizeLocked: (v: boolean) => void;
  setParamValue: (key: string, v: string | number) => void;
  selectModel: (m: ModelDef) => void;
  addRef: (url: string) => void;
  removeRef: (i: number) => void;
  removeResult: (id: string) => void;
  removeTask: (taskId: string) => void;
  regenerate: (taskId: string) => void;
  applyJump: (j: StudioJump) => void;
  handleGenerate: () => Promise<void>;
}

export function useStudio(studio: "image" | "video", session: SessionApi): StudioApi {
  const { t } = useTranslation();
  const customProviders = useCustomProviders();
  const allModels = useMemo(() => modelsForStudio(studio), [studio, customProviders]);
  const [model, setModel] = useState<ModelDef>(() => allModels[studio === "image" ? 0 : 1]);
  const [ar, setAr] = useState(() => allModels[studio === "image" ? 0 : 1].aspectRatios[0]);
  const [quality, setQuality] = useState(() => allModels[studio === "image" ? 0 : 1].qualities[0]);
  const [format, setFormat] = useState("jpeg"); // 输出格式（仅声明 formats 的模型生效）
  const [duration, setDuration] = useState(() => allModels[studio === "image" ? 0 : 1].durations?.[0] ?? "5");
  const [batch, setBatch] = useState(1);
  const [mode, setModeState] = useState<"single" | "group">("single");
  const [size, setSizeState] = useState<{ w: number; h: number } | null>(null);
  const [sizeLocked, setSizeLocked] = useState(false);
  const [paramValues, setParamValues] = useState<Record<string, string | number>>({});
  const [prompt, setPrompt] = useState("");
  const [refs, setRefs] = useState<string[]>([]);

  const { results, stats } = session;
  const { running, finished, sessionTotal } = stats;

  // 模型是否声明了 W/H 自定义尺寸区（volcark 像素尺寸厂商）。
  const supportsCustomSize = useCallback(
    (m: ModelDef) =>
      m.sections?.some((s) => (s.type === "ratio" && s.size) || s.type === "size") ?? false,
    [],
  );

  /** 选中比例：声明 size 区的模型同步出像素尺寸并解除锁定。
   *  volcark 查官方表（按画质档位）；wanxiang 按档位长边换算（16 倍数）；
   *  自定义模型无官方表——选项为像素串直取，
   *  比例选项按当前 W/H 长边换算（默认 2048 系）。 */
  const applyAr = useCallback(
    (m: ModelDef, v: string, q?: string) => {
      setAr(v);
      if (!supportsCustomSize(m)) {
        setSizeState(null);
        return;
      }
      if (m.providerId === "volcark" || m.providerId === "wanxiang") {
        const { w, h } = parseSizePx(aspectToSize(m.providerId, m.id, v, q));
        setSizeState({ w, h });
        setSizeLocked(false);
        return;
      }
      const px = /^(\d+)x(\d+)$/.exec(v);
      if (px) {
        setSizeState({ w: Number(px[1]), h: Number(px[2]) });
        setSizeLocked(false);
        return;
      }
      const rb = /^(\d+):(\d+)$/.exec(v);
      if (rb) {
        const a = Number(rb[1]);
        const b = Number(rb[2]);
        const cur = size;
        const longSide = cur ? Math.max(cur.w, cur.h) : 2048;
        const m2 = Math.max(a, b);
        setSizeState({ w: Math.round((longSide * a) / m2), h: Math.round((longSide * b) / m2) });
        setSizeLocked(false);
      } else {
        setSizeState(null);
      }
    },
    [supportsCustomSize, size],
  );

  /** 面板/跳转共用入口：按当前模型解析比例。 */
  const setArCb = useCallback((v: string) => applyAr(model, v, quality), [applyAr, model, quality]);

  /** 画质切换：声明 size 区的模型按新档位换算当前比例的像素尺寸（比例不变）。
   *  volcark 查官方表；wanxiang 按档位长边换算；自定义模型识别 K 档（1K/2K/3K/4K → 长边 1024×档位，保持比例），其余档位不联动。 */
  const setQualityCb = useCallback(
    (v: string) => {
      setQuality(v);
      if (!supportsCustomSize(model)) return;
      if (model.providerId === "volcark" || model.providerId === "wanxiang") {
        const { w, h } = parseSizePx(aspectToSize(model.providerId, model.id, ar, v));
        setSizeState({ w, h });
        return;
      }
      if (!size) return;
      const km = /^(\d+(?:\.\d+)?)K$/i.exec(v);
      if (!km) return;
      const longSide = Math.round(Number(km[1]) * 1024);
      const M = Math.max(size.w, size.h);
      setSizeState({
        w: Math.round((longSide * size.w) / M),
        h: Math.round((longSide * size.h) / M),
      });
    },
    [model, ar, size, supportsCustomSize],
  );

  const setSize = useCallback((w: number, h: number) => setSizeState({ w, h }), []);

  /** 模式切换：组图/单图的张数上限不同（wan2.7 组图 1-12），切换时收敛当前张数。 */
  const setMode = useCallback(
    (v: "single" | "group") => {
      setModeState(v);
      setBatch((prev) => Math.min(prev, batchCap(model, v)));
    },
    [model],
  );

  const setParamValue = useCallback(
    (key: string, v: string | number) => setParamValues((p) => ({ ...p, [key]: v })),
    [],
  );

  // 自定义模型（魔搭）列表变化时，保持当前选中模型；若已被删除则回退默认。
  useEffect(() => {
    setModel((prev) => allModels.find((m) => m.id === prev.id) ?? allModels[studio === "image" ? 0 : 1]);
  }, [allModels, studio]);

  const selectModel = useCallback(
    (m: ModelDef) => {
      setModel(m);
      // 先定画质再换算尺寸：保证比例 → 像素换算使用新模型的档位。
      const nextQ = m.qualities.includes(quality) ? quality : m.qualities[0];
      setQuality(nextQ);
      applyAr(m, m.aspectRatios.includes(ar) ? ar : m.aspectRatios[0], nextQ);
      if (m.durations) setDuration((prev) => (m.durations!.includes(prev) ? prev : m.durations![0]));
      if (m.formats) setFormat((prev) => (m.formats!.includes(prev) ? prev : "jpeg"));
      if (studio === "image") setBatch((prev) => Math.min(prev, batchCap(m, "single")));
      // 直接置 single（batch 已按新模型收缩；setMode 的 clamp 会用旧模型上限，不适用）
      setModeState("single");
      // 自由参数：按新模型 param 分区初始化（默认取模块 def，兼容旧 params 配置）。
      const nextParams: Record<string, string | number> = {};
      for (const s of m.sections ?? []) {
        if (s.type === "param") {
          const d = s.def ?? m.custom?.params?.[s.key];
          if (d != null && d !== "") nextParams[s.key] = s.kind === "number" ? Number(d) : d;
        }
      }
      setParamValues(nextParams);
    },
    [applyAr, ar, quality, studio],
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

  // 工作室跳转（图生视频/作为参考图/重新编辑）：按参数快照回填表单。
  // 模型按 id 匹配，匹配失败保持当前模型；ar/quality/duration 仅在该模型支持时生效。
  const applyJump = useCallback(
    (j: StudioJump) => {
      const m = allModels.find((x) => x.id === j.modelId);
      if (m) selectModel(m);
      setPrompt(j.prompt);
      if (j.ar && (!m || m.aspectRatios.includes(j.ar))) applyAr(m ?? model, j.ar, j.quality ?? quality);
      if (j.quality && (!m || m.qualities.includes(j.quality))) setQualityCb(j.quality);
      if (j.duration && (!m || !m.durations || m.durations.includes(j.duration))) setDuration(j.duration);
      if (j.n != null) setBatch(Math.min(Math.max(1, j.n), m ? Math.max(batchCap(m, "single"), batchCap(m, "group")) : 4));
      if (j.refs) setRefs(j.refs);
    },
    [allModels, model, selectModel, applyAr, setQualityCb, quality],
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
      format: string;
      duration: string;
      n: number;
      mode: "single" | "group";
      refs: string[];
      isVideo: boolean;
    }) => {
      const { taskId, prompt: p, model: m, ar: ar0, quality: q, format: fmt, duration: d, n, mode, refs: refs0, isVideo } = params;
      const capability = refs0.length > 0 ? (isVideo ? "i2v" : "i2i") : isVideo ? "t2v" : "t2i";
      // 声明 size 区的模型（volcark）用自定义像素尺寸直传 size；其余仍走 aspect_ratio。
      const useCustomSize = size !== null && supportsCustomSize(m);
      const sizeField = useCustomSize ? `${size.w}x${size.h}` : aspectToSize(m.providerId, m.id, ar0, q);
      const extra = isVideo ? `${d}s · ${q}` : q;
      // 自定义厂商：透传用户按模型配置的自由参数（协议原生字段名，如
      // steps/guidance/seed/negative_prompt（魔搭）或 num_inference_steps/guidance_scale（HF））。
      // popover 里调整过的参数（paramValues）覆盖配置默认值；数值参数转 number，空值跳过。
      let customExtra: { params: Record<string, string | number | null> } | undefined;
      if (m.custom) {
        const merged: Record<string, string | number | null> = { ...m.custom.params };
        for (const s of m.sections ?? []) {
          if (s.type === "param" && paramValues[s.key] !== undefined) {
            const raw = paramValues[s.key];
            if (raw === "") continue;
            merged[s.key] = s.kind === "number" ? Number(raw) : raw;
          }
        }
        customExtra = { params: merged };
      }

      const ids = Array.from({ length: n }, () => uid());
      const submittedAt = Date.now();
      const placeholders: ResultItem[] = ids.map((id) => ({
        id,
        taskId,
        at: submittedAt,
        status: "loading",
        prompt: p,
        model: m.name,
        modelId: m.id,
        ar: ar0,
        extra,
        quality: q,
        format: m.formats ? fmt : undefined,
        duration: d,
        refs: refs0,
        phase: "submitting",
      }));
      // 对话式队列：新任务追加到时间线底部，而非头部。
      session.patchActive((prev) => [...prev, ...placeholders]);

      try {
        const res = await generate({
          task_id: taskId,
          session_id: session.activeId,
          provider_id: m.providerId,
          capability,
          prompt: p,
          model: m.id,
          size: sizeField,
          n,
          aspect_ratio: ar0,
          quality: q,
          duration: isVideo ? d : undefined,
          mode: isVideo ? undefined : mode,
          output_format: m.formats ? fmt : undefined,
          references: refs0,
          extra: customExtra,
        });
        const done: ResultItem[] = res.local_paths.map((lp, i) => ({
          id: ids[i] ?? uid(),
          taskId,
          historyId: res.history_id,
          at: submittedAt, // 占位卡创建时刻即任务提交时间，直接沿用
          status: "done",
          url: toAssetUrl(lp),
          path: lp,
          prompt: p,
          model: res.model,
          modelId: m.id,
          ar: ar0,
          extra,
          quality: q,
          format: m.formats ? fmt : undefined,
          duration: d,
          refs: refs0,
        }));
        session.patchActive((prev) => {
          const map = new Map(done.map((d) => [d.id, d]));
          return prev.map((it) => map.get(it.id) ?? it);
        });
      } catch (e) {
        const msg = typeof e === "string" ? e : (e as Error)?.message ?? t("common.generationFailed");
        session.patchActive((prev) =>
          prev.map((it) => (ids.includes(it.id) ? { ...it, status: "error", error: msg } : it)),
        );
      }
    },
    [session.patchActive, t, size, supportsCustomSize, paramValues, format],
  );

  const handleGenerate = useCallback(async () => {
    const p =
      prompt.trim() ||
      (studio === "video" ? "cinematic dynamic scene, high quality" : "a beautiful scene, highly detailed");

    // 会话内首条消息时用提示词自动命名（类 ChatGPT）。
    if (results.length === 0 && p.trim()) {
      session.renameSession(session.activeId, p.trim().slice(0, 12));
    }

    // 张数：单图模式 = 后端并行 N 次独立请求（哩布计费行为）；组图模式 = 一次请求
    // sequential auto + max_images=N。mode 语义由后端 volcark 适配器实现。
    const n = studio === "video" ? 1 : batch;

    await submitTask({
      taskId: uid(),
      prompt: p,
      model,
      ar,
      quality,
      format,
      duration,
      n,
      mode,
      refs,
      isVideo: studio === "video",
    });
  }, [prompt, studio, batch, mode, refs, model, ar, quality, format, duration, results, session.activeId, session.renameSession, submitTask]);

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
        format: task.format ?? format,
        duration: task.duration ?? duration,
        n,
        mode,
        refs: task.refs ?? [],
        isVideo: studio === "video",
      });
    },
    [results, allModels, model, mode, quality, format, duration, studio, submitTask],
  );

  return {
    studio,
    model,
    ar,
    quality,
    format,
    duration,
    batch,
    mode,
    size,
    sizeLocked,
    paramValues,
    prompt,
    refs,
    results,
    running,
    finished,
    sessionTotal,
    setPrompt,
    setAr: setArCb,
    setQuality: setQualityCb,
    setFormat,
    setDuration,
    setBatch,
    setMode,
    setSize,
    setSizeLocked,
    setParamValue,
    selectModel,
    addRef,
    removeRef,
    removeResult,
    removeTask,
    regenerate,
    applyJump,
    handleGenerate,
  };
}
