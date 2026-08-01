// 简单选项列表 popover（比例 / 画质 / 时长）
// 基于 shadcn/Radix Popover：焦点管理、外点关闭、Esc 均由 Radix 处理。
// trigger 由调用方传入（asChild 包裹），打开状态由调用方受控管理。

import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

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
      <PopoverContent side="top" align="start" className="popover">
        <div className="pop-header">{title}</div>
        <div className="pop-menu">
          {options.map((o) => {
            const v = typeof o === "string" ? o : o.value;
            const label = typeof o === "string" ? o : o.label ?? o.value;
            const sel = String(current) === String(v);
            return (
              <button
                key={v}
                className={"pop-item" + (sel ? " selected" : "")}
                onClick={() => {
                  onSelect(v);
                  onOpenChange(false);
                }}
              >
                <span className="pi-name">
                  <span>{label}</span>
                </span>
                {sel && (
                  <svg className="pi-check" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={4.5}>
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
