// 简单选项列表 popover（比例 / 画质 / 时长）
// 基于 shadcn/Radix Popover：焦点管理、外点关闭、Esc 均由 Radix 处理。
// trigger 由调用方传入（asChild 包裹），打开状态由调用方受控管理。

import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "../lib/utils";

interface OptionItem {
  value: string;
  label?: string;
}

interface ParamPopoverProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  trigger: ReactNode;
  title: string;
  options: (string | OptionItem)[];
  current: string;
  onSelect: (v: string) => void;
}

export function ParamPopover({ open, onOpenChange, trigger, title, options, current, onSelect }: ParamPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="top" align="start" className="max-h-[40vh] min-w-[180px] overflow-y-auto rounded-lg border border-border-3 bg-overlay p-3.5 shadow-[0_10px_40px_var(--shadow-lg)] backdrop-blur-[24px] animate-[fadeInUp_.2s]">
        <div className="mb-2 border-b border-border-1 px-1 pb-2 text-[11px] font-semibold uppercase tracking-[.08em] text-faint">{title}</div>
        <div className="flex flex-col gap-1">
          {options.map((o) => {
            const v = typeof o === "string" ? o : o.value;
            const label = typeof o === "string" ? o : o.label ?? o.value;
            const sel = String(current) === String(v);
            return (
              <button
                key={v}
                className={cn(
                  "flex min-h-10 w-full cursor-pointer items-center justify-between gap-3 rounded-xl border-0 bg-transparent px-3 py-2.5 text-left text-xs font-semibold text-text-2 transition-all duration-[120ms] hover:bg-accent hover:text-primary",
                  sel && "text-primary",
                )}
                onClick={() => {
                  onSelect(v);
                  onOpenChange(false);
                }}
              >
                <span className="flex min-w-0 flex-col">
                  <span>{label}</span>
                </span>
                {sel && (
                  <svg className="size-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={4.5}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
