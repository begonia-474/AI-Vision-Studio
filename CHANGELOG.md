# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 魔搭 ModelScope 内置化：接入魔搭 AIGC 专区图像模型（含 LoRA 自由参数），后端协议适配只保留内置厂商
- 用户自添加模型系统：以任意内置模型为模板（继承尺寸机制 / 参数分区 / 默认参数），替换模型 ID 与名称即可注册，可覆盖模板默认参数，无需写代码（存 SQLite `user_models` 表）
- 对话式任务时间线：按会话组织生成任务，多会话切换 / 重命名 / 删除，会话与任务状态持久化到 SQLite（`TaskTimeline.tsx` + `studios/sessionStore.ts`）
- 会话按 ID 恢复，重启后恢复上次会话上下文
- 历史记录保存厂商 HTTP 请求 / 响应（响应体超长文本脱敏），便于排查生成问题
- 作品详情页重做：重新编辑统一从数据库 `params_json` 回填原参数，修复时间线跳底
- 支持通过历史 ID 移除结果卡（不落库）
- 通义万相（百炼）图像模型扩充至 13 个（qwen-image 2.0 / edit / max / plus 系列、wan2.7-image、z-image-turbo、wan2.6），补齐图生图与业务空间专属域名（WorkspaceId）
- 模型选择改哩布风格弹窗，支持厂商分组
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
- 火山方舟 Seedream 官方参数对齐（2026.08 文档）：5.0 Pro / 4.0 新增提示词优化（标准 / 快速），5.0 Pro 新增 1.5K 像素档与透明背景（i2i 单参考图，自动切 PNG），5.0 Lite 新增联网搜索；4.5 / 4.0 移除不支持的图片格式分区；参考图本地选择与 MIME 归一化补齐 bmp / tiff / gif / heic / heif
- Seedream 5.0 Pro 交互编辑 Draw 画板：参考图点选 / 框选，归一化 0–999 坐标并以 `<point>` / `<bbox>` 写入提示词（多参考图按「图 N」标记）
- Seedream 5.0 Pro 图层拆分：单参考图拆为底图 + 图层，按 `z_index` 排序下载；元数据写 sidecar `layers/{history_id}.json`，详情面板展示图层名称 / 描述 / 边界框（不改 tasks 表结构）
- Seedream 组图上限对齐官方：15 张，i2i 组图按「参考图数 + 生成数 ≤ 15」动态收敛；自添加模型提交携带模板 ID，后端按模板识别版本能力

### 变更

- 会话与生成历史全量迁移 SQLite（sessions / tasks 表：提交即落库、终态回写），前端 localStorage 业务数据归零；孤儿任务按归属自动重建会话
- 火山方舟自定义 W/H 尺寸改为前后端共同校验（总像素区间 + 宽高比 [1/16, 16]），非法尺寸显式报错，不再静默回退官方像素表
- 任务结果区由网格卡片重构为对话式时间线（`ResultGrid.tsx` 移除，改为 `TaskTimeline.tsx`）
- 任务时间线重渲染优化（消除会话历史串台与卡顿），i18n 升级为类型安全校验
- 参考图 / 图库跳转带来的本地路径统一归一化为 base64 data URL 后再提交厂商
- 弹窗与弹层统一为 Radix 实现：焦点陷阱、Esc 关闭、外点关闭、aria 标签
- 设置中的分段控件改为 Radix Toggle Group（roving focus + 方向键）
- 生成进度条改为 Radix Progress（语义化进度值）
- 无障碍增强：结果卡片 `role="group"` / 错误 `role="alert"` / 加载 `aria-busy`，按钮补充 aria-label，厂商筛选 tab 支持 `aria-pressed`

### 移除

- 自定义厂商系统（JSON 配置接入 Modelscope / Hugging Face / OpenAI-compatible 协议），由用户自添加模型替代（`src-tauri/src/providers/custom.rs` 与 `CustomProviderModal` 删除）

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
