# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 中英文双语界面（react-i18next），默认中文，可在设置中切换
- 主题切换：暗色 / 浅色 / 跟随系统（设置弹窗中切换，持久化到本地）
- 迁移 [shadcn/ui](https://ui.shadcn.com)（Radix + Tailwind v4）：Dialog / Popover / Command / Button / Badge / Input / Progress / Toggle Group
- 模型选择弹层支持键盘导航（方向键 + Enter）

### 变更

- 弹窗与弹层统一为 Radix 实现：焦点陷阱、Esc 关闭、外点关闭、aria 标签
- 设置中的分段控件改为 Radix Toggle Group（roving focus + 方向键）
- 生成进度条改为 Radix Progress（语义化进度值）
- 无障碍增强：结果卡片 `role="group"` / 错误 `role="alert"` / 加载 `aria-busy`，按钮补充 aria-label，厂商筛选 tab 支持 `aria-pressed`

## [0.1.0] - 2026-08-01

### 新增

- 图像 / 视频双工作室：文生图、图生图、文生视频、图生视频
- 接入 4 家厂商：火山方舟（即梦/豆包）、可灵 Kling、通义万相、MiniMax 海螺
- API Key 经系统凭据管理器（keyring）安全存储，支持连接测试
- 异步视频任务实时进度推送（事件 `gen-progress`）
- 产物自动下载归档至本地，SQLite 持久化生成历史
- 参考图上传，结果卡片一键"图生视频"
- 模型注册表驱动 UI：新增模型无需改界面代码

### 安全

- 生产构建启用严格 CSP（`tauri.conf.json`），`devCsp` 仅限开发模式
- asset 协议访问范围收窄至 `%LOCALAPPDATA%\AIVisionStudio\assets\`

[0.1.0]: https://github.com/begonia-474/ai-vision-studio/releases/tag/v0.1.0
