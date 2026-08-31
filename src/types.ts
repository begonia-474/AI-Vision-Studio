// 前端 ↔ Rust 共享类型：与 src-tauri/src/models.rs 的 DTO 对齐（serde 默认 snake_case）。
// 审计#19：跨端 DTO 已改由 ts-rs 从 Rust 自动生成（src/types/generated/，`npm run typegen`），
// 本文件仅保留前端私有类型并 re-export 生成产物。改 DTO 字段在 Rust 侧改，勿在此手写。
export * from "./types/generated/index";

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

/** LoRA 条目（生成弹层内编辑；repo=模型仓库 ID，weight=权重，原样下发不做限制）。
 *  由 ts-rs 从 Rust 侧 LoraEntryDto 生成（src/types/generated/LoraEntry.ts）。
 *  export * 不建立模块内绑定，StudioJump 需引用故显式 import 后 re-export。 */
import type { LoraEntry } from "./types/generated/LoraEntry";
export type { LoraEntry };

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
  /** 提示词优化模式（Seedream 5.0 pro：standard / fast） */
  optimizePromptMode?: string;
  /** 透明通道（Seedream 5.0 pro：transparent / opaque） */
  background?: string;
  /** 联网搜索（Seedream 5.0 lite） */
  webSearch?: boolean;
  /** 图层拆分（Seedream 5.0 pro） */
  layerDecomposition?: boolean;
  /** 提交时实际像素尺寸 "WxH"（size 区模型回填，优先于 ar 换算） */
  size?: string;
  /** 魔搭自由参数快照（steps/guidance/seed/negative_prompt 等） */
  params?: Record<string, string | number>;
  refs?: string[];
  /** LoRA 列表（魔搭用户自添加模型；重新编辑/跳转时回填弹层） */
  loras?: LoraEntry[];
}
