// 会话（session）存储：对话式时间线的会话管理与持久化。
// 每个 studio 一个 useSessionStore 实例（App 层持有），工作室与侧边栏共享同一份会话状态。
// 会话及时间线快照持久化到 localStorage（保留失败卡/删除状态，关闭时未完成任务转为 interrupted）；
// 完成结果以 SQLite 历史为权威来源（tasks.session_id 关联会话），启动时按会话 ID 各归各补回；
// 会话按最近活动时间倒序（类 ChatGPT），活动 = 提交/完成/进度/删除卡片。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listHistory, onProgress, toAssetUrl } from "../api";
import type { HistoryTask, LoraEntry } from "../types";

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
  // 重新生成所需的参数快照（persist 到 localStorage，用于「重新生成」）
  modelId?: string;
  quality?: string;
  format?: string; // 图像输出格式（png/jpeg）
  duration?: string;
  refs?: string[];
  loras?: LoraEntry[]; // 重新生成参数快照：LoRA 列表（自定义魔搭厂商）
  error?: string;
  // loading 期间实时阶段（由 gen-progress 事件按 taskId 写入；进度数值不展示，
  // 卡片上用装饰性动画代替，避免后端跳变式进度显得卡顿）
  phase?: string;
  msg?: string;
}

export interface Session {
  id: string;
  title: string;
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
  createSession: () => void;
  switchSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  deleteSession: (id: string) => void;
}

let _seq = 0;
const uid = () => `r_${Date.now().toString(36)}_${_seq++}`;

const sessionsKey = (studio: Studio) => `aivision-studio.sessions.v2.${studio}`;

// 历史恢复任务的前缀（SQLite 会话恢复的条目，不计入会话 x/y 角标）。
const HISTORY_TASK_PREFIX = "history_";

function normalizeStoredResults(raw: unknown, interruptedMessage: string): ResultItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Partial<ResultItem> => Boolean(item && typeof item === "object"))
    .map((item) => {
      const path = typeof item.path === "string" ? item.path : undefined;
      const wasLoading = item.status === "loading";
      return {
        ...(item as ResultItem),
        id: String(item.id ?? uid()),
        taskId: String(item.taskId ?? item.id ?? uid()),
        at: Number(item.at) || Date.now(),
        status: wasLoading ? "error" : item.status === "done" ? "done" : "error",
        path,
        url: path ? toAssetUrl(path) : item.url,
        error: wasLoading ? interruptedMessage : item.error,
      };
    });
}

function historyParams(item: HistoryTask): Record<string, unknown> {
  if (!item.params_json) return {};
  try {
    const parsed: unknown = JSON.parse(item.params_json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
  const duration = String(params.duration ?? "5");
  const extra = studio === "video" ? `${duration}s · ${quality}` : quality;
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
    quality,
    duration,
    format,
    n,
    refs: refList,
    loras: parseLoras(params.loras),
    extra,
  }));
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

function loadSessions(studio: Studio, defaultTitle: string, interruptedMessage: string): SessionState {
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(sessionsKey(studio));
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          const rawSessions = (parsed as { sessions?: unknown }).sessions;
          const rawActive = (parsed as { activeId?: unknown }).activeId;
          if (Array.isArray(rawSessions) && rawSessions.length > 0) {
            const sessions = sortByRecent(
              rawSessions
                .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === "object"))
                .map((s) => {
                  const createdAt = Number(s.createdAt) || Date.now();
                  return {
                    id: String(s.id ?? uid()),
                    title: String(s.title ?? defaultTitle),
                    createdAt,
                    updatedAt: Number(s.updatedAt) || createdAt,
                    results: normalizeStoredResults(s.results, interruptedMessage),
                  };
                }),
            );
            return {
              sessions,
              activeId: sessions.some((s) => s.id === rawActive) ? String(rawActive) : sessions[0].id,
            };
          }
        }
      }
    } catch {
      // 存储损坏时走默认会话。
    }
  }
  const s = freshSession(defaultTitle);
  return { sessions: [s], activeId: s.id };
}

export function useSessionStore(studio: Studio): SessionApi {
  const { t } = useTranslation();
  const [state, setState] = useState<SessionState>(() =>
    loadSessions(studio, t("sessions.defaultTitle"), t("prompt.interrupted")),
  );
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

  // 会话持久化：会话列表、当前会话、各会话时间线（含失败卡与删除状态）。
  // loading 任务在下次启动时转为 interrupted，当前 provider 层还不能跨进程续轮询。
  useEffect(() => {
    try {
      window.localStorage.setItem(sessionsKey(studio), JSON.stringify(state));
    } catch {
      // 存储不可用时不影响正常生成。
    }
  }, [state, studio]);

  // SQLite 是完成结果的权威来源：启动时按 tasks.session_id 把各会话自己的记录补回对应会话
  // （重启后 localStorage 可能丢失，库中的会话归属保证时间线仍可恢复）。
  // 按会话 ID 各归各，不做任何"整库注入当前会话"。
  useEffect(() => {
    let mounted = true;
    listHistory()
      .then((history) => {
        if (!mounted) return;
        const bySession = new Map<string, HistoryTask[]>();
        for (const item of history) {
          if (!item.session_id) continue; // 旧记录无会话归属，仅图库可见
          const arr = bySession.get(item.session_id);
          if (arr) arr.push(item);
          else bySession.set(item.session_id, [item]);
        }
        setState((prev) => {
          const sessions = prev.sessions.map((s) => {
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
              .flatMap((item) => historyResults(studio, item))
              .filter(
                (it) =>
                  !existingTaskIds.has(it.taskId) &&
                  (it.historyId === undefined || !existingHistoryIds.has(it.historyId)) &&
                  (!it.path || !existingPaths.has(it.path)),
              );
            if (restored.length === 0) return s;
            return { ...s, results: [...restored, ...s.results] };
          });
          return { ...prev, sessions };
        });
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [studio]);

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

  const renameSession = useCallback((id: string, title: string) => {
    setState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
    }));
  }, []);

  const deleteSession = useCallback(
    (id: string) => {
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
    createSession,
    switchSession,
    renameSession,
    deleteSession,
  };
}
