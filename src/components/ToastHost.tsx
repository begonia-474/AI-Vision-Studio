// 全局 toast 宿主：App 层挂载一次，lib/toast.ts 的 toast() 驱动渲染。
// 低频提示，不用动画库；固定底部居中浮层。

import { useToasts } from "../lib/toast";

export function ToastHost() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="rounded-lg border border-border-3 bg-overlay px-4 py-2 text-xs text-foreground shadow-[0_10px_30px_var(--shadow-lg)] backdrop-blur-xl animate-[fadeInUp_.2s]"
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}