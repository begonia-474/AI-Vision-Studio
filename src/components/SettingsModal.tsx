// 应用偏好 Modal
// 默认模型 / 并发 / 主题 / 资产路径 / 历史保留 / 关于。
// 多数为只读展示（后端尚未持久化偏好），并发数可在前端切换（预留）。

import { useState } from "react";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  defaultImage: string;
  defaultVideo: string;
}

const CONCURRENCY = [2, 4, 6, 8];

export function SettingsModal({ open, onClose, defaultImage, defaultVideo }: SettingsModalProps) {
  const [conc, setConc] = useState(4);
  if (!open) return null;

  return (
    <div className="modal-mask show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>Settings</h2>
        <p className="mdesc">应用偏好与生成行为配置。厂商 Key 管理请走侧栏「BYOK」入口。</p>

        <div className="set-row">
          <div>
            <div className="sk">默认图像模型</div>
            <div className="sd">打开 Image Studio 时预选的模型</div>
          </div>
          <div className="sv">{defaultImage}</div>
        </div>
        <div className="set-row">
          <div>
            <div className="sk">默认视频模型</div>
            <div className="sd">打开 Video Studio 时预选的模型</div>
          </div>
          <div className="sv">{defaultVideo}</div>
        </div>
        <div className="set-row">
          <div>
            <div className="sk">并发任务数</div>
            <div className="sd">同时进行的生成任务上限</div>
          </div>
          <div className="seg">
            {CONCURRENCY.map((n) => (
              <button
                key={n}
                className={conc === n ? "active" : ""}
                onClick={() => setConc(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="sk">主题</div>
            <div className="sd">暗色为基准风格，暂仅此一档</div>
          </div>
          <div className="seg">
            <button className="active">暗色</button>
            <button disabled>跟随系统</button>
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="sk">资产保存路径</div>
            <div className="sd">生成结果按日期归档，永久保留</div>
          </div>
          <div className="sv">%LOCALAPPDATA%\assets\YYYY\MM\</div>
        </div>
        <div className="set-row">
          <div>
            <div className="sk">历史保留</div>
            <div className="sd">用户资产不自动清理</div>
          </div>
          <div className="sv">永久</div>
        </div>
        <div className="set-row">
          <div>
            <div className="sk">关于</div>
            <div className="sd">Tauri 2.x · Rust + React + TS · BYOK 直连</div>
          </div>
          <div className="sv">v0.1.0</div>
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <button className="btn" style={{ flex: 1 }} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
