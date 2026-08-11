# AI Vision Studio

> 多供应商 AI 图像 / 视频生成桌面客户端，一站式接入即梦（豆包）、可灵、通义万相、MiniMax 海螺、魔搭，并支持以内置模型为模板自添加模型。

![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-purple)
![React](https://img.shields.io/badge/React-19-61dafb)

## 功能特性

- **统一工作台**：图像 / 视频两个工作室 + 哩布风格图库，文生图、图生图、文生视频、图生视频走同一套界面
- **对话式任务时间线**：每个工作室按会话（Session）组织生成任务，多会话切换、重命名、删除；会话状态持久化，重启后任务仍在
- **多任务并行**：同一会话内可同时发起多个生成任务，独立进度跟踪，互不阻塞
- **实时进度**：异步厂商（视频类）通过事件推送展示生成阶段（提交 → 生成中 → 下载 → 完成）
- **重新生成**：失败或不满意的结果可一键重试，自动回填原提示词与全部参数（含参考图）
- **多供应商**：内置火山方舟（即梦/豆包）、可灵 Kling、通义万相、MiniMax 海螺、魔搭，模型参数随厂商动态渲染
- **自添加模型**：以任意内置模型为模板（继承其尺寸机制与参数分区），替换模型 ID / 名称并覆盖默认参数，即可接入同厂商新模型（魔搭模型支持自由参数与 LoRA）
- **密钥安全**：API Key 存储在系统凭据管理器（Windows Credential Manager / macOS Keychain / Linux Secret Service），绝不落盘明文
- **产物本地归档**：生成结果自动下载到本地并按月份归档，历史记录持久化到 SQLite，图像产物自动生成缩略图
- **图库**：历史作品瀑布流展示，支持收藏、批量操作（删除 / 下载 / 收藏）、按类型 / 比例 / 画质筛选、作品详情面板
- **跨工作室跳转**：图库与结果卡片一键发起"图生视频"、"作为参考图"（图生图）、"重新编辑"（回填原参数）
- **参考图驱动**：图生图 / 图生视频支持多张参考图，本地文件自动转 base64 后交给厂商
- **i18n 与主题**：中 / 英双语（默认中文），暗色 / 浅色 / 跟随系统三档主题
- **BYOK**：自带密钥（Bring Your Own Key），应用本身不持有任何密钥，无自有服务器

## 支持的厂商与模型

| 厂商 | 接入状态 | 图像模型 | 视频模型 |
|------|---------|---------|---------|
| 火山方舟（即梦/豆包） | ✅ | Seedream 5.0 Pro / 5.0 Lite / 4.5 / 4.0 | Seedance 2.0 / 2.0 Fast / 2.0 Mini / 1.5 Pro / 1.0 Pro / 1.0 Pro Fast |
| 可灵 Kling | ✅ | — | Kling 3.0 / 2.6 |
| 通义万相 | ✅ | qwen-image 2.0 / edit / max / plus 系列、wan2.7-image、wan2.6-t2i / wan2.6-image、z-image-turbo（共 13 个） | wan2.7-t2v / wan2.7-i2v |
| MiniMax 海螺 | ✅ | image-01 / image-01-live | Hailuo video-01 |
| 魔搭 ModelScope | ✅ | 魔搭 AIGC 专区模型（含 LoRA） | — |

> 内置模型的清单与参数（比例、画质、时长、参考图上限）维护在 `src/models/registry.ts`；新增内置模型只需改注册表，无需改 UI。

## 自添加模型系统

无需编写代码即可把内置厂商的新模型接入两个工作室（`AddModelDialog`，数据存 SQLite `user_models` 表）：

- 以任意内置模型为模板：继承其尺寸机制（像素/比例）、参数分区（popover 分段）、采样参数默认值
- 填写模型 ID 与显示名称即可注册；模板的默认参数（steps / guidance / seed / negative_prompt / loras 等）可逐项覆盖
- 自添加模型与内置模型同列表展示（标注「自定义」），提交时 model 字段原样下发；API Key 仍走 keyring 按厂商独立存储
- 前端注册表（`src/models/registry.ts`）是模型声明的所有者，后端只做原样存取与协议适配

## 架构

```
┌────────────────────── 前端 (React + TS) ──────────────────────┐
│  App ── Sidebar（会话列表 / BYOK / 设置）           │
│   ├─ ImageStudio / VideoStudio ── TaskTimeline（对话式时间线）  │
│   │        └─ useStudio ─ sessionStore（多会话 + SQLite 持久化） │
│   └─ GalleryView（哩布风格图库）── DetailPanel（作品详情）        │
│   api.ts (Tauri invoke + gen-progress 事件订阅 + asset URL)    │
└──────────────────────────┬────────────────────────────────────┘
                           │ IPC (camelCase → snake_case)
┌──────────────────────────▼────────────────────────────────────┐
│                   后端 (Rust / Tauri 2)                        │
│  commands.rs ── GenerationProvider trait                      │
│                   ├─ VolcArkProvider ─┐                       │
│                   ├─ WanxiangProvider ├── 统一 submit /       │
│                   ├─ MiniMaxProvider  ├── poll / test_connectivity │
│                   ├─ KlingProvider    ─┘                      │
│                   └─ ModelScopeProvider（魔搭，含 LoRA）        │
│  storage.rs: AssetStore(下载落盘+缩略图) + HistoryDb(SQLite)   │
│              + SecureKeyStore(keyring) + UserModelStore        │
└───────────────────────────────────────────────────────────────┘
```

关键设计：

- `providers/mod.rs` 的 `GenerationProvider` trait 把同步厂商（图像）与异步厂商（视频）统一成 `submit / poll / test_connectivity / default_model` 四个方法，新增内置厂商只需实现该 trait 并注册
- 自添加模型存 SQLite `user_models` 表，前端注册表（`registry.ts`）启动/增删时拉取合并进模型列表
- 产物下载、缩略图生成由 `commands` 层调用 `storage` 完成，provider 与本地存储解耦
- 任务进度由后端 `gen-progress` 事件推送，前端 `TaskTimeline` 按 taskId 写入对应卡片
- 会话与生成历史全部以 SQLite 为唯一权威（sessions 表 + tasks 表，提交即落库、终态回写），
  前端无 localStorage 业务数据——清理 WebView 缓存不影响任何会话；孤儿任务按归属自动重建会话

## 技术栈

- **桌面框架**：[Tauri 2](https://tauri.app)（Rust 后端 + 系统 WebView）
- **前端**：React 19 + TypeScript + Vite 7
- **UI 组件**：[shadcn/ui](https://ui.shadcn.com)（Radix 原语 + Tailwind v4，组件源码在 `src/components/ui/`）
- **i18n**：react-i18next（中 / 英双语，默认中文）
- **样式**：CSS 变量设计系统（`src/styles/global.css`），暗色 / 浅色 / 跟随系统三档主题
- **后端**：reqwest / tokio / rusqlite / keyring / chrono / image（缩略图）

## 开发环境要求

- [Node.js](https://nodejs.org) ≥ 18
- [Rust](https://rustup.rs)（stable）
- 平台依赖见 [Tauri 官方文档](https://tauri.app/start/prerequisites/)

## 开发

```bash
npm install          # 安装前端依赖
npm run tauri dev    # 启动开发模式（自动编译 Rust 后端）
```

> `npm run tauri dev` 会同时启动 Vite 与 Rust 后端。生产构建的 CSP 已启用；开发模式使用 `devCsp: null` 以兼容 React Fast Refresh。

## 构建

```bash
npm run tauri build  # 产出安装包到 src-tauri/target/release/bundle/
```

## 测试

```bash
cargo test           # Rust 单元测试（src-tauri/src/storage.rs 等）
```

项目暂无前端自动化测试。涉及核心逻辑的改动请按 [CONTRIBUTING.md](CONTRIBUTING.md) 中的手动验证清单走一遍。

## 安全设计

- **API Key**：经 `keyring` 写入系统凭据管理器（`src-tauri/src/storage.rs`），SQLite 只存生成历史与用户自添加模型配置，不存任何密钥
- **CSP**：生产环境启用严格 Content-Security-Policy（`tauri.conf.json`），仅允许自身源 + IPC + asset 协议
- **asset 协议**：`convertFileSrc` 的访问范围收窄到 `%LOCALAPPDATA%\AIVisionStudio\`（glob 模式 `**/AppData/Local/AIVisionStudio/**`，兼容 Windows canonicalize 的 `\\?\` 前缀路径），WebView 无法读取任意本地文件
- **零服务端**：应用无自有服务器，所有调用直连你配置的厂商 API

## 数据位置（Windows）

| 数据 | 位置 |
|------|------|
| 生成产物 | `%LOCALAPPDATA%\AIVisionStudio\outputs\YYYY\MM\DD\`（按生成日期归档，文件名 `{时间戳}_{模型}_{uuid}`） |
| 缩略图 | `%LOCALAPPDATA%\AIVisionStudio\thumbs\`（镜像产物日期子路径，可再生的预览文件） |
| 参考图收编 | `%LOCALAPPDATA%\AIVisionStudio\inputs\` |
| 历史记录 / 用户自添加模型 | `%LOCALAPPDATA%\AIVisionStudio\history.db` |
| API Key | 系统凭据管理器（Service: `AIVisionStudio.ApiKey`） |

## 贡献

欢迎提交 Issue 与 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。报告安全问题请见 [SECURITY.md](SECURITY.md)。

## 许可证

[Apache License 2.0](LICENSE) © 2026 [begonia-474](https://github.com/begonia-474)
