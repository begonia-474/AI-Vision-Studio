// 在系统文件管理器中定位并选中文件。
// 统一走自定义命令 reveal_in_folder（审计#21），不在前端调插件的 revealItemInDir：
//  - Windows 上插件 SHOpenFolderAndSelectItems 偶发失败会兜底成「只打开文件夹不选中文件」；
//  - Linux 上插件无 xdg-open 兜底，且其 portal 降级 service/interface 写反。
// 命令内 Windows=explorer.exe /select、macOS=open -R、Linux=FileManager1→xdg-open 父目录。
// 失败时 toast 可读错误（不再静默吞错）。

import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";
import { toast } from "./toast";

export async function revealInFolder(path: string) {
  try {
    await invoke("reveal_in_folder", { path });
  } catch (e) {
    toast(typeof e === "string" && e ? e : i18n.t("common.revealFailed"));
  }
}