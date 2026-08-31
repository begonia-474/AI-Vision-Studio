import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 结果卡/任务 id 生成（审计#11：原 sessionStore 与 useStudio 各实现一份，统一收口）。
let _seq = 0;
export const uid = () => `r_${Date.now().toString(36)}_${_seq++}`;

// 复制文本：优先 Clipboard API，失败回退 execCommand（Tauri WebView / 旧环境兼容）。
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* 权限/聚焦异常走回退 */
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}
