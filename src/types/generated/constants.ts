// 本文件由 `npm run typegen`（cargo test export_bindings）生成，请勿手动编辑。
// 进度事件 phase 常量的唯一事实源是 Rust 侧 ProgressPhase 枚举（src-tauri/src/models.rs）。
import type { ProgressPhase } from "./ProgressPhase";

/** gen-progress 事件阶段（与 Rust ProgressPhase 枚举一一对应） */
export const PROGRESS_PHASES: readonly ProgressPhase[] = ["submitting", "running", "downloading", "done", "failed"];
