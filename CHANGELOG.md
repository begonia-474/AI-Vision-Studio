# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 自定义厂商系统：JSON 配置接入 Modelscope / Hugging Face / OpenAI-compatible 协议的服务，模型动态注册到工作室（`src-tauri/src/providers/custom.rs` + `src/models/registry.ts` 动态注册表）
- 对话式任务时间线：按会话组织生成任务，多会话切换 / 重命名 / 删除，会话与任务状态持久化到 localStorage（`TaskTimeline.tsx` + `studios/sessionStore.ts`）
- 多任务并行：同一会话可同时发起多个生成任务，独立进度追踪互不阻塞
- 生成失败可一键"重新生成"，自动回填提示词与全部参数（含参考图）
- 图库改版（哩布风格）：作品详情面板、收藏 / 取消收藏、批量操作（删除 / 下载 / 收藏）、按类型 / 比例 / 画质筛选、鼠标框选
- 跨工作室跳转：图生视频、作为参考图（图生图）、重新编辑（回填原参数）
- 图像产物自动生成缩略图（`storage::make_thumbnail`，WEBP 优先，回退 PNG）
- 共享 UI 常量类（`src/lib/classes.ts`），统一样式 token 复用
- 中英文双语界面（react-i18next），默认中文，可在设置中切换
- 主题切换：暗色 / 浅色 / 跟随系统（设置弹窗中切换，持久化到本地）
- 迁移 [shadcn/ui](https://ui.shadcn.com)（Radix + Tailwind v4）：Dialog / Popover / Command / Button / Badge / Input / Progress / Toggle Group
- 模型选择弹层支持键盘导航（方向键 + Enter）

### 变更

- 任务结果区由网格卡片重构为对话式时间线（`ResultGrid.tsx` 移除，改为 `TaskTimeline.tsx`）
- 参考图 / 图库跳转带来的本地路径统一归一化为 base64 data URL 后再提交厂商
- 弹窗与弹层统一为 Radix 实现：焦点陷阱、Esc 关闭、外点关闭、aria 标签
- 设置中的分段控件改为 Radix Toggle Group（roving focus + 方向键）
- 生成进度条改为 Radix Progress（语义化进度值）
- 无障碍增强：结果卡片 `role="group"` / 错误 `role="alert"` / 加载 `aria-busy`，按钮补充 aria-label，厂商筛选 tab 支持 `aria-pressed`

### 移除

- 过时的 `docs/` 研究文档目录（已并入代码与本文档）

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
