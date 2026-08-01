// 通用 Popover：相对锚点（.popover-wrap）向上弹出，外部点击关闭。
// 注册延迟 document 监听，避免触发打开的同一 click 立即关闭；popover 内部点击 stopPropagation。

import { useEffect, useRef, type ReactNode } from "react";

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}

export function Popover({ open, onClose, wide, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // setTimeout(0) 跳过触发 open 的那次 click
    const id = window.setTimeout(() => document.addEventListener("click", handler), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", handler);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div ref={ref} className={"popover" + (wide ? " wide" : "")} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

// ============ 简单选项列表 popover（比例 / 画质 / 时长）============
interface OptionItem {
  value: string;
  label?: string;
}

interface ParamPopoverProps {
  open: boolean;
  onClose: () => void;
  title: string;
  options: (string | OptionItem)[];
  current: string;
  onSelect: (v: string) => void;
}

export function ParamPopover({ open, onClose, title, options, current, onSelect }: ParamPopoverProps) {
  return (
    <Popover open={open} onClose={onClose}>
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
                onClose();
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
    </Popover>
  );
}
