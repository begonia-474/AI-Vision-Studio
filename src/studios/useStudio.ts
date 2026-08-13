// 工作室共享状态与生成逻辑 Hook。
// 两个 studio 常驻挂载（CSS hidden 切换），各自独立持有状态，切换不丢失。
// 会话状态由 App 层 useSessionStore 持有（侧边栏与工作室共享），这里只负责：
// 模型/参数表单、任务提交（占位卡入列 → invoke generate → 成功替换 / 失败标记）、任务删除。
// 进度事件路由与历史补齐在 sessionStore 内完成。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { aspectToSize, batchCap, defaultModelForStudio, parseSizePx, type ModelDef, modelsForStudio, useUserModels } from "../models/registry";
import { deleteHistories, generate, toAssetUrl } from "../api";
import { freeParams, jumpParams, type ResultItem, type SessionApi } from "./sessionStore";
import { uid } from "../lib/utils";
import type { LoraEntry, StudioJump } from "../types";

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
  paramValues: Record<string, string | number>; // 用户自添加模型的自由参数（popover 运行时值，提交时覆盖 params 默认）
  loras: LoraEntry[]; // LoRA 列表（魔搭 loras 字段；1 个→字符串，多个→{repo: weight}）
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
  setLoras: (v: LoraEntry[]) => void;
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
  const userModels = useUserModels();
  const allModels = useMemo(() => modelsForStudio(studio), [studio, userModels]);
  const [model, setModel] = useState<ModelDef>(() => defaultModelForStudio(studio));
  const [ar, setAr] = useState(() => defaultModelForStudio(studio).aspectRatios[0]);
  const [quality, setQuality] = useState(() => defaultModelForStudio(studio).qualities[0]);
  const [format, setFormat] = useState("jpeg"); // 输出格式（仅声明 formats 的模型生效）
  const [duration, setDuration] = useState(() => defaultModelForStudio(studio).durations?.[0] ?? "5");
  const [batch, setBatch] = useState(1);
  const [mode, setModeState] = useState<"single" | "group">("single");
  const [size, setSizeState] = useState<{ w: number; h: number } | null>(null);
  const [sizeLocked, setSizeLocked] = useState(false);
  const [paramValues, setParamValues] = useState<Record<string, string | number>>({});
  const [loras, setLoras] = useState<LoraEntry[]>([]);
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
      if (m.providerId === "volcark" || m.providerId === "wanxiang" || m.providerId === "modelscope") {
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
   *  volcark 查官方表；wanxiang 按档位长边换算；自定义模型识别 K 档（1K/2K/3K/4K → 长边 1024×档位，保持比例），其余档位不联动。
   *  审计#10：支持显式传入 model/ar——applyJump 在 selectModel 之后调用时闭包里的
   *  model/ar 还是旧值，会导致换算用旧模型并覆盖 selectModel 已算好的尺寸。 */
  const setQualityCb = useCallback(
    (v: string, m?: ModelDef, arOverride?: string) => {
      const target = m ?? model;
      const targetAr = arOverride ?? ar;
      setQuality(v);
      if (!supportsCustomSize(target)) return;
      if (target.providerId === "volcark" || target.providerId === "wanxiang" || target.providerId === "modelscope") {
        const { w, h } = parseSizePx(aspectToSize(target.providerId, target.id, targetAr, v));
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
    setModel((prev) => allModels.find((m) => m.id === prev.id) ?? defaultModelForStudio(studio));
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
      // LoRA 列表按模型独立，切换时清空（popover 里重新添加）。
      setLoras([]);
    },
    [applyAr, ar, quality, studio],
  );

  const addRef = useCallback((url: string) => setRefs((r) => [...r, url]), []);
  const removeRef = useCallback((i: number) => setRefs((r) => r.filter((_, idx) => idx !== i)), []);

  const removeResult = useCallback(
    (id: string) => {
      // 审计#11：卡片可能位于任意会话（历史按 session_id 归属恢复），
      // 用全部会话快照定位而非激活会话，找到才同步删 DB 记录。
      const target = session.sessions
        .flatMap((s) => s.results)
        .find((it) => it.id === id);
      session.removeByResultId(id);
      if (target?.historyId != null) void deleteHistories([target.historyId]).catch(() => {});
    },
    [session],
  );

  // 按任务整条删除（时间线的任务级删除：一次提交的全部产物一起移除）。
  const removeTask = useCallback(
    (taskId: string) => {
      const target = session.sessions
        .flatMap((s) => s.results)
        .find((it) => it.taskId === taskId);
      session.removeByTaskId(taskId);
      if (target?.historyId != null) void deleteHistories([target.historyId]).catch(() => {});
    },
    [session],
  );

  // 工作室跳转（图生视频/作为参考图/重新编辑）：按参数快照回填表单。
  // 模型按 id 匹配，匹配失败保持当前模型；ar/quality/duration 仅在该模型支持时生效。
  const applyJump = useCallback(
    (j: StudioJump) => {
      const m = allModels.find((x) => x.id === j.modelId);
      if (m) selectModel(m);
      const target = m ?? model;
      setPrompt(j.prompt);
      if (j.ar && (!m || m.aspectRatios.includes(j.ar))) applyAr(target, j.ar, j.quality ?? quality);
      // 审计#10：selectModel/applyAr 之后闭包 model/ar 仍是旧值，画质换算必须显式
      // 传入目标模型与已收敛的比例（否则用旧模型换算像素并覆盖已算好的尺寸）。
      if (j.quality && (!m || m.qualities.includes(j.quality))) {
        const arForQuality =
          j.ar && (!m || m.aspectRatios.includes(j.ar))
            ? j.ar
            : m
              ? (m.aspectRatios.includes(ar) ? ar : m.aspectRatios[0])
              : ar;
        setQualityCb(j.quality, target, arForQuality);
      }
      if (j.duration && (!m || !m.durations || m.durations.includes(j.duration))) setDuration(j.duration);
      // 生图模式：快照带 mode 时按该模式上限收敛张数（组图任务恢复后仍是组图，
      // 而非退化为单图模式带超量 n 并行请求）；无 mode 的旧数据按原逻辑取两模式上限。
      if (j.mode === "single" || j.mode === "group") {
        setModeState(j.mode);
        if (j.n != null) setBatch(Math.min(Math.max(1, j.n), m ? batchCap(m, j.mode) : 4));
      } else if (j.n != null) {
        setBatch(Math.min(Math.max(1, j.n), m ? Math.max(batchCap(m, "single"), batchCap(m, "group")) : 4));
      }
      // 自定义像素尺寸（size 区模型）：原任务手动 W/H 优先于 ar 换算
      if (j.size && supportsCustomSize(target)) {
        const px = parseSizePx(j.size);
        if (px) {
          setSizeState(px);
          setSizeLocked(false);
        }
      }
      if (j.format && target.formats?.includes(j.format)) setFormat(j.format);
      // 魔搭自由参数快照：selectModel 已重置为模型默认，此处覆盖回原任务值
      if (j.params) setParamValues(j.params);
      if (j.refs) setRefs(j.refs);
      // LoRA：selectModel 已清空（模型切换重置），跳转快照在此恢复。
      if (j.loras) setLoras(j.loras);
    },
    [allModels, model, selectModel, applyAr, setQualityCb, quality, supportsCustomSize],
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
      loras: LoraEntry[];
      isVideo: boolean;
      /** 魔搭自由参数覆盖（重新生成时从原任务 params_json 还原，优先于弹层当前值） */
      paramsOverride?: Record<string, string | number>;
    }) => {
      const { taskId, prompt: p, model: m, ar: ar0, quality: q, format: fmt, duration: d, n, mode, refs: refs0, loras: loras0, isVideo, paramsOverride } = params;
      const capability = refs0.length > 0 ? (isVideo ? "i2v" : "i2i") : isVideo ? "t2v" : "t2i";
      // 声明 size 区的模型（volcark）用自定义像素尺寸直传 size；其余仍走 aspect_ratio。
      const useCustomSize = size !== null && supportsCustomSize(m);
      const sizeField = useCustomSize ? `${size.w}x${size.h}` : aspectToSize(m.providerId, m.id, ar0, q);
      const extra = isVideo ? `${d}s · ${q}` : q;
      // 用户自添加模型：透传按模型配置的自由参数（协议原生字段名，如
      // steps/guidance/seed/negative_prompt（魔搭）或 num_inference_steps/guidance_scale（HF））。
      // popover 里调整过的参数（paramValues）覆盖配置默认值；数值参数转 number，空值跳过。
      let customExtra: { params: Record<string, unknown> } | undefined;
      if (m.custom) {
        const merged: Record<string, unknown> = { ...m.custom.params };
        for (const s of m.sections ?? []) {
          if (s.type === "param" && paramValues[s.key] !== undefined) {
            const ov = paramsOverride?.[s.key];
            if (ov !== undefined) {
              merged[s.key] = s.kind === "number" ? Number(ov) : ov;
              continue;
            }
            const raw = paramValues[s.key];
            if (raw === "") continue;
            merged[s.key] = s.kind === "number" ? Number(raw) : raw;
          }
        }
        // LoRA：魔搭 loras 字段。实测网关规则：
        // - 单 LoRA：dict 形式 {repo: weight} 权重透传（任意数值生效）；字符串形式不带权重，
        //   调权重无效（网关按默认权重处理）→ 单 LoRA 也发 dict 保留用户权重。
        // - 多 LoRA：权重和必须恰为 1.0（大于/小于整体被忽略），只认 2 位小数 →
        //   提交时等比归一（w/sum）四舍五入到 2 位，最后一项补余数保证和恰为 1.00。
        // 空 repo 行忽略。Rust merge_params 原样并入请求顶层。
        const lorasClean = loras0.filter((l) => l.repo.trim() !== "");
        if (lorasClean.length === 1) {
          const w = Number(lorasClean[0].weight);
          const wv = Number.isFinite(w) && w > 0 ? w : 1;
          merged["loras"] = { [lorasClean[0].repo.trim()]: wv };
        } else if (lorasClean.length > 1) {
          const raw = lorasClean.map((l) => Math.max(0, Number(l.weight) || 0));
          const sum = raw.reduce((a, b) => a + b, 0);
          let normed: number[];
          if (sum <= 0) {
            // 全 0/空权重：均分 1/n（末项补余数）。
            const base = Math.round((1 / raw.length) * 100) / 100;
            normed = raw.map(() => base);
            normed[raw.length - 1] = Math.round((1 - base * (raw.length - 1)) * 100) / 100;
          } else {
            normed = raw.map((w) => Math.round((w / sum) * 100) / 100);
            normed[raw.length - 1] =
              Math.round((1 - normed.slice(0, -1).reduce((a, b) => a + b, 0)) * 100) / 100;
          }
          merged["loras"] = Object.fromEntries(lorasClean.map((l, i) => [l.repo.trim(), normed[i]]));
        }
        customExtra = { params: merged };
      }

      const ids = Array.from({ length: n }, () => uid());
      const submittedAt = Date.now();
      // 魔搭自由参数快照（loras 由 loras 字段承接，此处排除避免双份）
      const paramSnapshot =
        customExtra && Object.keys(customExtra.params).some((k) => k !== "loras")
          ? Object.fromEntries(Object.entries(customExtra.params).filter(([k]) => k !== "loras"))
          : undefined;
      // 任务所属会话在提交时刻捕获：完成/失败回写必须落在它上面——
      // 若中途切换会话，patchActive 会把结果写进新激活会话，原会话占位卡永远停留在 loading。
      const sessionId = session.activeId;
      const placeholders: ResultItem[] = ids.map((id) => ({
        id,
        taskId,
        at: submittedAt,
        status: "loading",
        prompt: p,
        model: m.name,
        modelId: m.id,
        ar: ar0,
        size: sizeField,
        params: paramSnapshot,
        extra,
        quality: q,
        format: m.formats ? fmt : undefined,
        duration: d,
        refs: refs0,
        loras: loras0,
        phase: "submitting",
      }));
      // 对话式队列：新任务追加到时间线底部，而非头部。
      session.patchSession(sessionId, (prev) => [...prev, ...placeholders]);

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
          size: sizeField,
          params: paramSnapshot,
          paramsJson: res.params_json,
          extra,
          quality: q,
          format: m.formats ? fmt : undefined,
          duration: d,
          refs: refs0,
          loras: loras0,
        }));
        // 厂商实际返回张数可能少于请求（wan2.7 组图"实际张数由模型决定 ≤n"、
        // 并行请求部分失败等）：未匹配的占位卡直接移除，时间线只展示实际产物
        // （与数据库/图库一致），否则多余占位卡永远停留在 loading 动画。
        // 完全没产出的极端情况（理论上后端会先报错）按失败标记，不留 loading。
        if (done.length === 0) {
          session.patchSession(sessionId, (prev) =>
            prev.map((it) =>
              ids.includes(it.id) ? { ...it, status: "error", error: t("common.generationFailed") } : it,
            ),
          );
          return;
        }
        session.patchSession(sessionId, (prev) => {
          const map = new Map(done.map((d) => [d.id, d]));
          return prev
            .filter((it) => !ids.includes(it.id) || map.has(it.id))
            .map((it) => map.get(it.id) ?? it);
        });
      } catch (e) {
        const msg = typeof e === "string" ? e : (e as Error)?.message ?? t("common.generationFailed");
        session.patchSession(sessionId, (prev) =>
          prev.map((it) => (ids.includes(it.id) ? { ...it, status: "error", error: msg } : it)),
        );
      }
    },
    // 会话切换时重建 submitTask：内部捕获 session.activeId，陈旧闭包会把新提交
    // 写到旧会话（占位卡隐形 + 数据库 session_id 错归属）。activeId 必须入 deps。
    [session.patchSession, session.activeId, t, size, supportsCustomSize, paramValues, format, loras],
  );

  const handleGenerate = useCallback(async () => {
    const p =
      prompt.trim() ||
      (studio === "video" ? "cinematic dynamic scene, high quality" : "a beautiful scene, highly detailed");

    // 会话内首条消息时用提示词自动命名（类 ChatGPT）。
    // 用户手动改过标题的会话不自动覆盖（对齐 Codex：显式标题优先）。
    const activeS = session.sessions.find((s) => s.id === session.activeId);
    if (results.length === 0 && p.trim() && !activeS?.nameManuallyEdited) {
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
      loras,
      isVideo: studio === "video",
    });
  }, [prompt, studio, batch, mode, refs, loras, model, ar, quality, format, duration, results, session.activeId, session.renameSession, submitTask]);

  // 重新生成：按原任务的参数快照再提交一次（模型/提示词/比例/画质/时长/参考图/批量数）。
  // mode 与魔搭自由参数优先从数据库 params_json 还原（与「重新编辑」同源），
  // 避免组图任务退化为单图模式带超量 n 并行请求、自由参数回退弹层默认值。
  const regenerate = useCallback(
    (taskId: string) => {
      const task = results.find((it) => it.taskId === taskId);
      if (!task || task.status !== "done") return;
      const m = allModels.find((x) => x.id === task.modelId) ?? model;
      const n = results.filter((it) => it.taskId === taskId).length;
      let regenMode: "single" | "group" = mode;
      let paramsOverride: Record<string, string | number> | undefined;
      if (task.paramsJson) {
        try {
          const p = JSON.parse(task.paramsJson) as Record<string, unknown>;
          if (p.mode === "single" || p.mode === "group") regenMode = p.mode;
          const fp = jumpParams(freeParams(p));
          if (fp) paramsOverride = fp;
        } catch {
          // paramsJson 损坏回退散装快照
        }
      }
      void submitTask({
        taskId: uid(),
        prompt: task.prompt,
        model: m,
        ar: task.ar,
        quality: task.quality ?? quality,
        format: task.format ?? format,
        duration: task.duration ?? duration,
        n,
        mode: regenMode,
        refs: task.refs ?? [],
        loras: task.loras ?? [],
        paramsOverride,
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
    loras,
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
    setLoras,
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
