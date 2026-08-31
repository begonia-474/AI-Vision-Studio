// 轻量全局 toast：模块级事件订阅 + useSyncExternalStore 渲染。
// 用于"非阻塞、需即时反馈"的操作失败提示（如 reveal 失败），
// 避免为低频提示引入 toast 依赖；替代原生 alert/静默吞错。

import { useSyncExternalStore } from "react";

export interface ToastItem {
  id: number;
  message: string;
}

let seq = 0;
let items: ToastItem[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function toast(message: string, duration = 2600) {
  const id = ++seq;
  items = [...items, { id, message }];
  emit();
  window.setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, duration);
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => items,
  );
}