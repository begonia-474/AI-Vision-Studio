// 前端 ↔ Rust 共享类型，与 src-tauri/src/models.rs 的 DTO 对齐（serde 默认 snake_case）。

export interface ProviderInfo {
  id: string;
  display_name: string;
  capabilities: string[];
  auth_help: string;
}

export interface GenRequest {
  /** 前端生成的任务 ID，后端进度事件原样回传用于路由 */
  task_id: string;
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
  /** 图像生图模式：single=每张图独立请求（循环 n 次，哩布行为）；group=一次请求组图 auto+max_images */
  mode?: "single" | "group";
  /** 图像输出格式（火山方舟 Seedream 5.0 pro/lite）：png / jpeg，缺省 jpeg */
  output_format?: string;
  references?: string[];
  /** 自定义厂商透传：{ params: 用户按模型配置的自由参数 } */
  extra?: Record<string, unknown>;
}

export type ProtocolType = "modelscope" | "huggingface" | "openai-compatible";

/** 自定义模型参数模块（生成弹层 popover 分区），由用户在配置界面勾选组装。
 *  options 为空时按协议取默认（ratio→size_presets，quality→["默认"]，duration→["5","10"]）；
 *  配置界面勾选时会预填常用值（常用比例/画质档位），可再修改。
 *  param 为自由参数（接口原生字段，如 steps/guidance/seed/negative_prompt），
 *  运行时在 popover 里调整，提交时随请求下发（覆盖 params 同 key 的默认值）。 */
export type CustomParamModule =
  | { type: "ratio"; options: string[] } // 比例/尺寸网格（选项如 1:1 或 1024x1024）
  | { type: "quality"; options: string[] } // 画质分段（如 1K/2K 或 480P/720P）
  | { type: "duration"; options: string[] } // 时长刻度 slider（如 5/10）
  | { type: "batch" } // 图片张数分段（1-4）
  | { type: "size" } // W/H 自定义尺寸输入 + 锁定（提交 size="WxH"）
  | {
      type: "param";
      key: string; // 接口字段名（如 steps / guidance_scale）
      label: string; // popover 分区标题（直接显示）
      kind: "number" | "text"; // 输入形态
      def?: string; // 默认值（写入 params 下发）
    };

export interface CustomModelConfig {
  repo_id: string;
  name: string;
  capabilities: string[];
  size_presets: string[];
  /** 自由参数（协议原生字段名，如 steps/guidance/num_inference_steps/quality 等） */
  params: Record<string, string | number | null>;
  /** 参数模块（popover 分区）；缺省时由 defaultSections 按 studio 推导 */
  param_modules?: CustomParamModule[];
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
  history_id: number;
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
  task_id: string;
  phase: string;
  progress: number;
  message: string;
}

/** 工作室跳转参数（图生视频 / 作为参考图 / 重新编辑共用） */
export interface StudioJump {
  prompt: string;
  modelId?: string;
  ar?: string;
  quality?: string;
  duration?: string;
  n?: number;
  refs?: string[];
}
