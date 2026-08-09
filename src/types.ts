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
  /** 所属会话 ID，写库后启动时按会话恢复时间线 */
  session_id?: string;
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

export interface GenerationResult {
  history_id: number;
  provider_id: string;
  model: string;
  local_paths: string[];
  remote_urls: string[];
  /** 写入数据库 params_json 的完整参数快照（重新编辑时按此拼接回填） */
  params_json: string;
}

/** 模型参数模块（生成弹层 popover 分区）。内置魔搭模型的参数区声明。
 *  param 为自由参数（接口原生字段，如 steps/guidance/seed/negative_prompt），
 *  运行时在 popover 里调整，提交时随请求下发（覆盖 params 同 key 的默认值）。 */
export type CustomParamModule =
  | { type: "ratio"; options: string[] } // 比例/尺寸网格（选项如 1:1 或 1024x1024）
  | { type: "quality"; options: string[] } // 画质分段（如 1K/2K 或 480P/720P）
  | { type: "duration"; options: string[] } // 时长刻度 slider（如 5/10）
  | { type: "batch" } // 图片张数分段（1-4）
  | { type: "size" } // W/H 自定义尺寸输入 + 锁定（提交 size="WxH"）
  | { type: "loras" } // LoRA 列表（魔搭 loras 字段：1 个 → 字符串 repo-id；多个 → {repo: weight}）
  | {
      type: "param";
      key: string; // 接口字段名（如 steps / guidance_scale）
      label: string; // popover 分区标题（直接显示）
      kind: "number" | "text"; // 输入形态
      def?: string; // 默认值（写入 params 下发）
    };

/** LoRA 条目（生成弹层内编辑；repo=模型仓库 ID，weight=权重，原样下发不做限制）。 */
export interface LoraEntry {
  repo: string;
  weight: string;
}

/** 内置魔搭模型的参数配置载体（ModelDef.custom）：默认参数 + 弹层分区声明。 */
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

/** 用户为内置厂商自添加的模型行（SQLite user_models）。 */
export interface UserModelRow {
  id: number;
  provider_id: string;
  model_id: string;
  name: string;
  /** 模板模型 id：继承其尺寸机制/参数分区/默认参数（如内置模型 id） */
  template_model_id: string;
  params_json: string | null;
  created_at: string;
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
  /** 所属会话 ID（旧记录为 null，仅出现在图库） */
  session_id: string | null;
  /** 任务级错误信息（failed/running 状态行的原因） */
  error: string | null;
}

/** 会话行（SQLite sessions 表；会话元数据是权威数据的可重建索引） */
export interface SessionRow {
  id: string;
  title: string;
  /** 标题是否用户手动改过（自动命名不得覆盖显式标题） */
  name_manually_edited: boolean;
  /** 创建时间（Unix 毫秒） */
  created_at: number;
  /** 最近活动时间（Unix 毫秒，排序键） */
  updated_at: number;
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
  /** 生图模式（single/group；volcark 组图任务快照恢复用，缺省保持当前模式） */
  mode?: "single" | "group";
  /** 图像输出格式（png/jpeg，仅图像） */
  format?: string;
  /** 提交时实际像素尺寸 "WxH"（size 区模型回填，优先于 ar 换算） */
  size?: string;
  /** 魔搭自由参数快照（steps/guidance/seed/negative_prompt 等） */
  params?: Record<string, string | number>;
  refs?: string[];
  /** LoRA 列表（自定义魔搭厂商；重新编辑/跳转时回填弹层） */
  loras?: LoraEntry[];
}
