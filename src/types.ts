// 前端 ↔ Rust 共享类型，与 src-tauri/src/models.rs 的 DTO 对齐（serde 默认 snake_case）。

export interface ProviderInfo {
  id: string;
  display_name: string;
  capabilities: string[];
  auth_help: string;
}

export interface GenRequest {
  provider_id: string;
  capability: string;
  prompt: string;
  negative_prompt?: string;
  model?: string;
  size: string;
  n: number;
  aspect_ratio?: string;
  quality?: string;
  duration?: string;
  references?: string[];
  /** 自定义厂商透传：{ params: 用户按模型配置的自由参数 } */
  extra?: Record<string, unknown>;
}

export type ProtocolType = "modelscope" | "huggingface" | "openai-compatible";

export interface CustomModelConfig {
  repo_id: string;
  name: string;
  capabilities: string[];
  size_presets: string[];
  /** 自由参数（协议原生字段名，如 steps/guidance/num_inference_steps/quality 等） */
  params: Record<string, string | number | null>;
}

export interface CustomProviderConfig {
  id: string;
  name: string;
  protocol: ProtocolType;
  base_url: string;
  models: CustomModelConfig[];
}

export interface CustomProviderRow {
  id: string;
  config_json: string;
  created_at: string;
}

export interface GenerationResult {
  provider_id: string;
  model: string;
  local_paths: string[];
  remote_urls: string[];
}

export interface HistoryTask {
  id: number;
  provider: string;
  model: string;
  capability: string;
  prompt: string;
  params_json: string | null;
  status: string;
  created_at: string;
  local_paths_json: string;
  remote_urls_json: string | null;
  starred: boolean;
  thumbnail_path: string | null;
}

export interface ProgressPayload {
  phase: string;
  progress: number;
  message: string;
}
