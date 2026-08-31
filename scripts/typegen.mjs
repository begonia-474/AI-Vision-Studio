// 前端类型生成：把 Rust DTO（src-tauri/src/models.rs，ts-rs derive）导出为 TS 类型。
// 用法：npm run typegen。生成文件提交进版本库，CI 校验一致性（git diff --exit-code）。
// 跨平台处理路径，不依赖 shell 环境变量语法。

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repo, "src", "types", "generated");

execSync("cargo test export_bindings", {
  cwd: path.join(repo, "src-tauri"),
  env: { ...process.env, TS_RS_EXPORT_DIR: outDir },
  stdio: "inherit",
});

console.log(`[typegen] 已导出 TS 类型到 ${outDir}`);