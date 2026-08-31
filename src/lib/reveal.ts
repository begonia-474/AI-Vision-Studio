// 在系统文件管理器中定位并选中文件。
// 优先 tauri-plugin-opener 的 revealItemInDir（Windows/macOS 可靠、Linux 有 FileManager1 时
// 能选中文件）；插件失败时降级到自定义命令 reveal_in_folder（审计#21）——标准 Linux 兜底：
// xdg-open 打开父目录（Electron showItemInFolder 同款，不特判发行版/容器）。
// 最终仍失败才 toast 可读错误（不再静默吞错）。
//
// 注意：不能用 openPath(path, "reveal")——v2 里会被当成「用名为 reveal 的程序打开文件」，
// Windows/Linux 都静默失败；官方正确 API 是 revealItemInDir（见 v2.tauri.app 文档）。

import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";
import { toast } from "./toast";

export async function revealInFolder(path: string) {
  try {
    await revealItemInDir(path);
    return;
  } catch {
    /* 插件失败（Linux 无 FileManager1）：降级到自定义命令 */
  }
  try {
    await invoke("reveal_in_folder", { path });
  } catch (e) {
    toast(typeof e === "string" && e ? e : i18n.t("common.revealFailed"));
  }
}