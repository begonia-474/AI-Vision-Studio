// 本文件由 `npm run typegen`（cargo test export_bindings）生成，请勿手动编辑。
// 进度事件 phase 常量的唯一事实源是 Rust 侧 ProgressPhase 枚举（src-tauri/src/models.rs）；
// params_json 结构化键表的唯一事实源是 Rust 侧 params.rs（commands.rs 写快照与前端 freeParams 消费同一份）。
import type { ProgressPhase } from "./ProgressPhase";

/** gen-progress 事件阶段（与 Rust ProgressPhase 枚举一一对应） */
export const PROGRESS_PHASES: readonly ProgressPhase[] = ["submitting", "running", "downloading", "done", "failed"];

/** params_json 中已结构化消费的键（剩余键为魔搭自由参数，原样透传） */
export const STRUCTURED_PARAM_KEYS: readonly string[] = ["size", "n", "aspect_ratio", "quality", "duration", "mode", "output_format", "optimize_prompt_mode", "background", "web_search", "layer_decomposition", "references", "loras"];
