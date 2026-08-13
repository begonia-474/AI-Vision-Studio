import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 结果卡/任务 id 生成（审计#11：原 sessionStore 与 useStudio 各实现一份，统一收口）。
let _seq = 0;
export const uid = () => `r_${Date.now().toString(36)}_${_seq++}`;
