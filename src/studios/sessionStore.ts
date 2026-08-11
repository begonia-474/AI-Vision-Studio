// 会话（session）存储：对话式时间线的会话管理与持久化。
// 每个 studio 一个 useSessionStore 实例（App 层持有），工作室与侧边栏共享同一份会话状态。
// 【持久化架构（对齐 Codex 范式）】SQLite 是唯一权威：
//  - sessions 表：会话元数据（id/title/手动标记/时间戳）——权威数据的可重建索引；
//  - tasks 表：任务行（succeeded/running/failed，提交即落库、终态回写）；
//  - 前端状态只是镜像，不再使用 localStorage（清理 WebView 缓存不影响任何会话数据）；
//  - 孤儿 session_id 启动时自动补建会话（历史任务按归属回到时间线）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  deleteSession as deleteSessionApi,
  listHistory,
  listSessions,
  onProgress,
  toAssetUrl,
  upsertSession,
} from "../api";
import type { HistoryTask, LoraEntry, SessionRow, StudioJump } from "../types";

export type Studio = "image" | "video";
export type ResultStatus = "loading" | "done" | "error";

export interface ResultItem {
  id: string;
  taskId: string; // 同一次提交（一次 invoke）的所有卡片共享；进度事件按它路由
  at: number; // 提交时间戳（时间线气泡显示）
  historyId?: number; // SQLite tasks.id，删除时同步移除持久化记录
  status: ResultStatus;
  url?: string; // done 时为本地产物 asset url
  path?: string; // done 时为本地绝对路径（i2v 跳转传原路径，后端转 data URL）
  prompt: string;
  model: string;
  ar: string;
  extra: string; // 图像：quality；视频：duration + " · " + quality
  /** 提交时实际发送的尺寸：像素模型为 "WxH"（volcark/wanxiang/魔搭），非像素厂商为比例原值占位 */
  size?: string;
  /** 魔搭自由参数快照（steps/guidance/seed/negative_prompt；不含 loras——已由 loras 字段承接） */
  params?: Record<string, unknown>;
  /** 数据库 params_json 原样（生成响应返回 / 历史恢复携带）；重新编辑按此拼接回填 */
  paramsJson?: string;
  // 重新生成所需的参数快照（persist 到 localStorage，用于「重新生成」）
  modelId?: string;
  quality?: string;
  format?: string; // 图像输出格式（png/jpeg）
  duration?: string;
  refs?: string[];
  loras?: LoraEntry[]; // 重新生成参数快照：LoRA 列表（魔搭用户自添加模型）
  error?: string;
  // loading 期间实时阶段（由 gen-progress 事件按 taskId 写入；进度数值不展示，
  // 卡片上用装饰性动画代替，避免后端跳变式进度显得卡顿）
  phase?: string;
  msg?: string;
}

export interface Session {
  id: string;
  title: string;
  /** 标题是否用户手动改过（自动命名不得覆盖显式标题，对齐 Codex） */
  nameManuallyEdited?: boolean;
  createdAt: number;
  /** 最近活动时间（提交/完成/进度/删除卡片时刷新），侧边栏按此倒序排列。 */
  updatedAt: number;
  results: ResultItem[];
}

export interface SessionStats {
  running: number; // 进行中任务卡数（loading 卡数）
  finished: number; // 当前会话已完成任务数（成功 + 失败，按任务计）
  sessionTotal: number; // 当前会话新提交任务总数（不把历史恢复任务算进角标）
}

export interface SessionApi {
  sessions: Session[];
  activeId: string;
  results: ResultItem[]; // 当前会话的结果
  stats: SessionStats;
  patchActive: (fn: (prev: ResultItem[]) => ResultItem[]) => void;
  /** 对指定会话的 results 做变换（任务生命周期回写用：提交发生在会话 A、完成时激活会话
   *  可能已是 B，patchActive 会把结果写错会话——必须按提交时捕获的会话 id 定位） */
  patchSession: (id: string, fn: (prev: ResultItem[]) => ResultItem[]) => void;
  /** 从全部会话移除指定 historyId 的结果卡（图库删除产物后同步时间线；
   *  卡片可能位于任意会话——历史按 session_id 归属恢复，用户可能已切换会话） */
  removeByHistoryId: (historyId: number) => void;
  createSession: () => void;
  switchSession: (id: string) => void;
  renameSession: (id: string, title: string, manual?: boolean) => void;
  deleteSession: (id: string) => void;
}

let _seq = 0;
const uid = () => `r_${Date.now().toString(36)}_${_seq++}`;

// 历史恢复任务的前缀（SQLite 会话恢复的条目，不计入会话 x/y 角标）。
const HISTORY_TASK_PREFIX = "history_";

function historyParams(item: HistoryTask): Record<string, unknown> {
  if (!item.params_json) return {};
  try {
    const parsed: unknown = JSON.parse(item.params_json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/// 已结构化消费的 params_json 键（size/n/aspect_ratio/quality/duration/output_format/
/// references/loras 分别落入 ResultItem 对应字段），剩余键（魔搭自由参数 steps/
/// guidance/seed/negative_prompt 等）原样返回，供详情页展示。
const STRUCTURED_PARAM_KEYS = new Set([
  "size",
  "n",
  "aspect_ratio",
  "quality",
  "duration",
  "output_format",
  "references",
  "loras",
  "mode",
]);

export function freeParams(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const rest = Object.fromEntries(Object.entries(raw).filter(([k]) => !STRUCTURED_PARAM_KEYS.has(k)));
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/// 自由参数快照 → 重新编辑回填值（只保留字符串/数字，供 StudioJump.params / paramValues）。
export function jumpParams(raw: Record<string, unknown> | undefined): Record<string, string | number> | undefined {
  if (!raw) return undefined;
  const f = Object.fromEntries(
    Object.entries(raw).filter(
      (e): e is [string, string | number] => typeof e[1] === "string" || typeof e[1] === "number",
    ),
  );
  return Object.keys(f).length > 0 ? f : undefined;
}

/// 数据库 params_json → 重新编辑跳转（图库 / 时间线共用同一数据源同一拼装，
/// 保证回填与库中记录一致；model/prompt 来自 tasks 行，参数来自 params_json）。
export function jumpFromParams(
  task: { prompt: string; model: string },
  params: Record<string, unknown>,
  image: boolean,
  refs?: string[],
): StudioJump & { studio: "image" | "video" } {
  return {
    studio: image ? "image" : "video",
    prompt: task.prompt,
    modelId: task.model,
    ar: typeof params.aspect_ratio === "string" ? params.aspect_ratio : undefined,
    quality: typeof params.quality === "string" ? params.quality : undefined,
    duration: typeof params.duration === "string" ? params.duration : undefined,
    n: typeof params.n === "number" ? params.n : undefined,
    mode: params.mode === "single" || params.mode === "group" ? params.mode : undefined,
    format: typeof params.output_format === "string" ? params.output_format : undefined,
    size: typeof params.size === "string" ? params.size : undefined,
    params: jumpParams(freeParams(params)),
    refs,
    loras: parseLoras(params.loras),
  };
}

/// 历史 params_json.loras（提交格式：字符串或 {repo: weight}）→ 弹层行（LoraEntry[]）。
/// 字符串（旧数据/单 LoRA 字符串形式）→ 单行 weight "1"；dict → 每项一行，权重转字符串。
export function parseLoras(raw: unknown): LoraEntry[] | undefined {
  if (typeof raw === "string") {
    return raw.trim() ? [{ repo: raw.trim(), weight: "1" }] : undefined;
  }
  if (raw && typeof raw === "object") {
    const entries = Object.entries(raw as Record<string, unknown>)
      .filter(([repo]) => typeof repo === "string" && repo.trim() !== "")
      .map(([repo, w]) => ({ repo: repo.trim(), weight: String(w ?? 1) }));
    return entries.length > 0 ? entries : undefined;
  }
  return undefined;
}

/// SQLite 记录 → 会话时间线条目（taskId 带 history_ 前缀，不计入会话角标）。
/// 完整映射重新生成所需参数：modelId=model 列，n/quality/duration/format/refs 来自 params_json
/// （references 为收编后的路径数组；旧数据存的是数量，非数组时忽略）。
function historyResults(studio: Studio, item: HistoryTask): ResultItem[] {
  let paths: unknown;
  try {
    paths = JSON.parse(item.local_paths_json);
  } catch {
    return [];
  }
  if (!Array.isArray(paths)) return [];
  const localPaths = paths.filter((path): path is string => typeof path === "string" && path.length > 0);
  if (localPaths.length === 0) return [];

  const params = historyParams(item);
  const ar = String(params.aspect_ratio ?? params.size ?? "1:1");
  const quality = String(params.quality ?? "default");
  // duration 仅视频模型有（图像提交时后端写 null）；不要给图像任务兜底 "5"，
  // 否则详情页/重新编辑会拿到不存在的视频参数。
  const duration = studio === "video" ? String(params.duration ?? "5") : undefined;
  const extra = studio === "video" ? `${duration}s · ${quality}` : quality;
  const size = typeof params.size === "string" ? params.size : undefined;
  const at = Date.parse(item.created_at) || Date.now();
  const taskId = `${HISTORY_TASK_PREFIX}${item.id}`;
  const refs = Array.isArray(params.references) ? (params.references as unknown[]) : undefined;
  const refList = refs
    ? refs.filter((r): r is string => typeof r === "string" && r.length > 0)
    : undefined;
  const modelId = item.model;
  const format = typeof params.output_format === "string" ? params.output_format : undefined;
  const n = typeof params.n === "number" ? params.n : undefined;

  return localPaths.map((path, index) => ({
    id: `${taskId}_${index}`,
    taskId,
    historyId: item.id,
    at,
    status: "done",
    url: toAssetUrl(path),
    path,
    prompt: item.prompt,
    model: item.model,
    modelId,
    ar,
    size,
    quality,
    duration,
    format,
    n,
    refs: refList,
    loras: parseLoras(params.loras),
    params: freeParams(params),
    paramsJson: item.params_json ?? undefined,
    extra,
  }));
}

/// SQLite 记录 → 会话时间线条目，按状态映射：
/// succeeded → 完成卡（historyResults）；running（应用关闭时未完成）→「中断」错误卡；
/// failed → 失败卡（带错误信息）。taskId 带 history_ 前缀，不计入会话角标。
function historyCards(studio: Studio, item: HistoryTask, t: TFunction): ResultItem[] {
  if (item.status === "succeeded") {
    return historyResults(studio, item);
  }
  const at = Date.parse(item.created_at) || Date.now();
  const taskId = `${HISTORY_TASK_PREFIX}${item.id}`;
  const params = historyParams(item);
  const error =
    item.status === "failed"
      ? (item.error ?? t("common.generationFailed"))
      : t("prompt.interrupted");
  return [
    {
      id: `${taskId}_0`,
      taskId,
      historyId: item.id,
      at,
      status: "error",
      error,
      prompt: item.prompt,
      model: item.model,
      ar: String(params.aspect_ratio ?? params.size ?? "1:1"),
      extra: "",
    },
  ];
}

/// 会话按最近活动倒序（类 ChatGPT：新对话置顶，旧对话有新消息时上浮）。
function sortByRecent(list: Session[]): Session[] {
  return [...list].sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
}

interface SessionState {
  sessions: Session[];
  activeId: string;
}

function freshSession(title: string): Session {
  const now = Date.now();
  return { id: uid(), title, createdAt: now, updatedAt: now, results: [] };
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    title: r.title,
    nameManuallyEdited: r.name_manually_edited,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    results: [],
  };
}

function toSessionRow(s: Session): SessionRow {
  return {
    id: s.id,
    title: s.title,
    name_manually_edited: s.nameManuallyEdited ?? false,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

export function useSessionStore(studio: Studio): SessionApi {
  const { t } = useTranslation();
  // 占位会话：SQLite 启动加载完成前保证 activeId/results 可用；加载后以库为准整体替换。
  const [state, setState] = useState<SessionState>(() => {
    const s = freshSession(t("sessions.defaultTitle"));
    return { sessions: [s], activeId: s.id };
  });
  const [ready, setReady] = useState(false);
  const aliveRef = useRef(true);

  const activeSession = state.sessions.find((s) => s.id === state.activeId) ?? state.sessions[0];
  const results = activeSession?.results ?? [];

  // 会话级统计（不持久化，每次启动归零）：角标 x/y，x=已完成任务数，y=本会话新提交任务数。
  // SQLite 会话恢复的条目（taskId 前缀 history_）不计入。
  const stats = useMemo<SessionStats>(() => {
    const taskIds = new Set<string>();
    for (const it of results) {
      if (!it.taskId.startsWith(HISTORY_TASK_PREFIX)) taskIds.add(it.taskId);
    }
    let finished = 0;
    for (const id of taskIds) {
      const items = results.filter((it) => it.taskId === id);
      if (items.length > 0 && items.every((it) => it.status !== "loading")) finished += 1;
    }
    return {
      running: results.filter((it) => it.status === "loading").length,
      finished,
      sessionTotal: taskIds.size,
    };
  }, [results]);

  // 启动加载（SQLite 为唯一权威，无 localStorage）：
  // 1) sessions 表 → 会话列表（空库建默认会话）；
  // 2) tasks 表按 session_id 分组回灌，孤儿 id 自动补建会话（历史任务回到时间线）；
  // 3) 卡片按状态映射：succeeded→done / running→中断 / failed→失败（含错误信息）。
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [sessionRows, history] = await Promise.all([
        listSessions(),
        listHistory().catch(() => []),
      ]);
      if (!mounted) return;
      setState((prev) => {
        let sessions = sessionRows.map(toSession);
        if (sessions.length === 0) {
          const s = freshSession(t("sessions.defaultTitle"));
          sessions = [s];
          void upsertSession(toSessionRow(s));
        }
        const bySession = new Map<string, HistoryTask[]>();
        for (const item of history) {
          if (!item.session_id) continue; // 旧记录无会话归属，仅图库可见
          const arr = bySession.get(item.session_id);
          if (arr) arr.push(item);
          else bySession.set(item.session_id, [item]);
        }
        // 孤儿 session_id：按库中归属补建会话（权威数据 → 重建索引）
        const known = new Set(sessions.map((s) => s.id));
        for (const sid of bySession.keys()) {
          if (!known.has(sid)) {
            const s = freshSession(t("sessions.defaultTitle"));
            s.id = sid;
            sessions.push(s);
            void upsertSession(toSessionRow(s));
          }
        }
        sessions = sortByRecent(sessions);
        // 保留加载窗口内已在内存中的实时卡（loading 占位等），再注入库中恢复卡
        sessions = sessions.map((s) => {
          const live = prev.sessions.find((p) => p.id === s.id);
          return live ? { ...s, results: live.results } : s;
        });
        sessions = sessions.map((s) => {
          const rows = bySession.get(s.id);
          if (!rows || rows.length === 0) return s;
          const existingTaskIds = new Set(s.results.map((it) => it.taskId));
          const existingHistoryIds = new Set(
            s.results
              .map((it) => it.historyId)
              .filter((id): id is number => id !== undefined),
          );
          const existingPaths = new Set(
            s.results.map((it) => it.path).filter((p): p is string => Boolean(p)),
          );
          const restored = rows
            .filter((item) => {
              const isImage = item.capability === "t2i" || item.capability === "i2i";
              return studio === "image" ? isImage : !isImage;
            })
            .slice()
            .reverse()
            .flatMap((item) => historyCards(studio, item, t))
            .filter(
              (it) =>
                !existingTaskIds.has(it.taskId) &&
                (it.historyId === undefined || !existingHistoryIds.has(it.historyId)) &&
                (!it.path || !existingPaths.has(it.path)),
            );
          if (restored.length === 0) return s;
          return { ...s, results: [...restored, ...s.results] };
        });
        const active = sessions.some((s) => s.id === prev.activeId) ? prev.activeId : sessions[0].id;
        return { sessions, activeId: active };
      });
      setReady(true);
    })();
    return () => {
      mounted = false;
    };
  }, [studio, t]);

  // 会话行持久化（幂等 upsert）：任何会话变更（新建/重命名/活动时间上浮/回灌）落库。
  // ready 前不写——占位会话不该污染库。SQLite 为权威、状态为镜像。
  useEffect(() => {
    if (!ready) return;
    for (const s of state.sessions) {
      void upsertSession(toSessionRow(s));
    }
  }, [state.sessions, ready]);

  // mount 时订阅一次进度事件；按 task_id 路由（跨会话更新，后台会话的任务同样刷新阶段，
  // 并把会话的最近活动时间上浮，类 ChatGPT 的"有动静的对话置顶"）。
  useEffect(() => {
    aliveRef.current = true;
    let un: (() => void) | undefined;
    onProgress((p) => {
      if (!aliveRef.current || !p.task_id) return;
      setState((prev) => {
        let changed = false;
        const sessions = prev.sessions.map((s) => {
          if (!s.results.some((it) => it.taskId === p.task_id)) return s;
          changed = true;
          return {
            ...s,
            updatedAt: Date.now(),
            results: s.results.map((it) =>
              it.taskId === p.task_id
                ? p.phase === "failed"
                  ? // failed 事件即终态：置 error 并带具体失败原因（invoke catch 之外的第二通道，
                    // 避免卡片停留在 loading 分支只显示"生成失败"文案）。
                    { ...it, status: "error" as const, phase: p.phase, msg: p.message, error: p.message || it.error }
                  : { ...it, phase: p.phase, msg: p.message }
                : it,
            ),
          };
        });
        return changed ? { ...prev, sessions: sortByRecent(sessions) } : prev;
      });
    }).then((u) => {
      // 竞态防护：listen 注册完成前若已卸载，立即注销，避免监听器残留
      if (!aliveRef.current) {
        u();
      } else {
        un = u;
      }
    });
    return () => {
      aliveRef.current = false;
      un?.();
    };
  }, []);

  // 对当前会话的 results 做变换，并刷新其最近活动时间（提交/完成/失败/删除均算活动）。
  const patchActive = useCallback((fn: (prev: ResultItem[]) => ResultItem[]) => {
    setState((prev) => {
      const sessions = prev.sessions.map((s) =>
        s.id === prev.activeId
          ? { ...s, updatedAt: Date.now(), results: fn(s.results) }
          : s,
      );
      return { ...prev, sessions: sortByRecent(sessions) };
    });
  }, []);

  // 对指定会话的 results 做变换（任务生命周期回写：提交/完成/失败必须落在任务所属会话，
  // 而非 patch 时刻的激活会话——用户中途切走会话时结果才不会写错地方）。
  const patchSession = useCallback((id: string, fn: (prev: ResultItem[]) => ResultItem[]) => {
    setState((prev) => {
      const sessions = prev.sessions.map((s) =>
        s.id === id
          ? { ...s, updatedAt: Date.now(), results: fn(s.results) }
          : s,
      );
      return { ...prev, sessions: sortByRecent(sessions) };
    });
  }, []);

  // 从全部会话移除指定 historyId 的结果卡（图库删除产物后同步时间线；不刷新会话
  // 最近活动时间——非本会话主动操作，避免删除导致会话置顶跳动）。
  const removeByHistoryId = useCallback((historyId: number) => {
    setState((prev) => {
      let changed = false;
      const sessions = prev.sessions.map((s) => {
        const results = s.results.filter((it) => it.historyId !== historyId);
        if (results.length === s.results.length) return s;
        changed = true;
        return { ...s, results };
      });
      return changed ? { ...prev, sessions } : prev;
    });
  }, []);

  const createSession = useCallback(() => {
    setState((prev) => {
      const n = prev.sessions.length + 1;
      const s = freshSession(`${t("sessions.defaultTitle")} ${n}`);
      // 新会话即最近活动 → 置顶（类 ChatGPT）
      return { sessions: sortByRecent([...prev.sessions, s]), activeId: s.id };
    });
  }, [t]);

  const switchSession = useCallback((id: string) => {
    setState((prev) => (prev.sessions.some((s) => s.id === id) ? { ...prev, activeId: id } : prev));
  }, []);

  const renameSession = useCallback((id: string, title: string, manual = false) => {
    setState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((s) =>
        s.id === id
          ? { ...s, title, nameManuallyEdited: manual || s.nameManuallyEdited }
          : s,
      ),
    }));
  }, []);

  const deleteSession = useCallback(
    (id: string) => {
      // 删会话行（任务行保留，仅图库可见——会话与任务生命周期分离）
      void deleteSessionApi(id).catch(() => {});
      setState((prev) => {
        const remaining = prev.sessions.filter((s) => s.id !== id);
        if (remaining.length === 0) {
          const s = freshSession(t("sessions.defaultTitle"));
          return { sessions: [s], activeId: s.id };
        }
        return { sessions: remaining, activeId: prev.activeId === id ? remaining[0].id : prev.activeId };
      });
    },
    [t],
  );

  return {
    sessions: state.sessions,
    activeId: state.activeId,
    results,
    stats,
    patchActive,
    patchSession,
    removeByHistoryId,
    createSession,
    switchSession,
    renameSession,
    deleteSession,
  };
}
