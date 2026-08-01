// Tauri invoke 封装。注意：Tauri 会把 camelCase 形参键自动转为 Rust 的 snake_case。
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { GenRequest, GenerationResult, HistoryTask, ProgressPayload, ProviderInfo } from "./types";

export const listProviders = () => invoke<ProviderInfo[]>("list_providers");

export const getApiKey = (providerId: string) =>
  invoke<string | null>("get_api_key", { providerId });

export const saveApiKey = (providerId: string, apiKey: string) =>
  invoke<void>("save_api_key", { providerId, apiKey });

export const deleteApiKey = (providerId: string) =>
  invoke<void>("delete_api_key", { providerId });

export const testApiKey = (providerId: string) =>
  invoke<string>("test_api_key", { providerId });

// generate 的 Rust 形参为 req（AppHandle/State 由 Tauri 注入，前端不传）。
export const generate = (req: GenRequest) =>
  invoke<GenerationResult>("generate", { req });

export const listHistory = () => invoke<HistoryTask[]>("list_history");

export const setStar = (id: number, starred: boolean) =>
  invoke<void>("set_star", { id, starred });

export const deleteHistories = (ids: number[]) =>
  invoke<void>("delete_histories", { ids });

// ============ 进度事件订阅 ============
// 后端 commands::generate 通过 app.emit("gen-progress", ProgressPayload) 推送。
export function onProgress(cb: (p: ProgressPayload) => void): Promise<UnlistenFn> {
  return listen<ProgressPayload>("gen-progress", (e) => cb(e.payload));
}

// ============ 本地资源 URL ============
// 后端返回的 local_paths 是文件系统绝对路径，webview 需经 asset 协议转换才能显示。
// Cargo.toml 已启用 tauri feature "protocol-asset"。
export function toAssetUrl(localPath: string): string {
  return convertFileSrc(localPath);
}

