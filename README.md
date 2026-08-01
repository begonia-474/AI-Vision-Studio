# AI Vision Studio

> 多供应商 AI 图像 / 视频生成桌面客户端，一站式接入即梦（豆包）、可灵、通义万相、MiniMax 海螺。

![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-purple)
![React](https://img.shields.io/badge/React-19-61dafb)

## 功能特性

- **统一工作台**：图像 / 视频两个工作室，文生图、图生图、文生视频、图生视频全部走同一套界面
- **多供应商**：火山方舟（即梦/豆包）、可灵 Kling、通义万相、MiniMax 海螺，模型参数随厂商动态渲染
- **密钥安全**：API Key 存储在系统凭据管理器（Windows Credential Manager / macOS Keychain / Linux Secret Service），绝不落盘明文
- **任务实时进度**：异步厂商（视频类）通过事件推送展示生成进度与阶段
- **产物本地归档**：生成结果自动下载到本地并按月份归档，历史记录持久化到 SQLite
- **参考图驱动**：图生图 / 图生视频支持多张参考图，双击结果卡片可一键发起"图生视频"
- **BYOK**：自带密钥（Bring Your Own Key），应用本身不持有任何密钥

## 支持的厂商与模型

| 厂商 | 接入状态 | 图像模型 | 视频模型 |
|------|---------|---------|---------|
| 火山方舟（即梦/豆包） | ✅ | Seedream 4.0 / 4.5 / 5.0 | Seedance 1.0 / 1.5 / 2.0 |
| 可灵 Kling | ✅ | — | Kling 2.6 / 3.0 |
| 通义万相 | ✅ | wan2.6-t2i / wan2.6-image | wan2.7-t2v / wan2.7-i2v |
| MiniMax 海螺 | ✅ | image-01 / image-01-live | Hailuo video-01 |

> 模型清单与参数（比例、画质、时长、参考图上限）维护在 `src/models/registry.ts`，新增模型只需改注册表，无需改 UI。

## 架构

```
┌──────────────────── 前端 (React + TS) ────────────────────┐
│  ImageStudio / VideoStudio ── ModelDropdown ── ResultGrid │
│        │                    PromptComposer                │
│        ▼                                                  │
│  api.ts (Tauri invoke + 进度事件订阅 + asset URL 转换)      │
└────────────────────────┬──────────────────────────────────┘
                         │ IPC (camelCase → snake_case)
┌────────────────────────▼──────────────────────────────────┐
│                后端 (Rust / Tauri 2)                       │
│  commands.rs ── GenerationProvider trait                  │
│                  ├─ VolcArkProvider  ──┐                  │
│                  ├─ WanxiangProvider  ├── 统一 submit/    │
│                  ├─ MiniMaxProvider   ├── poll/test_      │
│                  └─ KlingProvider     ──┘ connectivity    │
│  storage.rs: AssetStore(下载落盘) + HistoryDb(SQLite)      │
│              + SecureKeyStore(keyring)                    │
└───────────────────────────────────────────────────────────┘
```

关键设计：

- `providers/mod.rs:19` 的 `GenerationProvider` trait 把同步厂商（图像）与异步厂商（视频）统一成 `submit / poll / test_connectivity` 三个方法，新增厂商只需实现该 trait 并注册
- 产物下载由 `commands` 层调用 `storage` 完成，provider 与本地存储解耦
- API 请求全部由 Rust 后端发出，WebView 不直接接触任何第三方 API

## 技术栈

- **桌面框架**：[Tauri 2](https://tauri.app)（Rust 后端 + 系统 WebView）
- **前端**：React 19 + TypeScript + Vite 7
- **UI 组件**：[shadcn/ui](https://ui.shadcn.com)（Radix 原语 + Tailwind v4，组件源码在 `src/components/ui/`）
- **i18n**：react-i18next（中 / 英双语，默认中文）
- **样式**：CSS 变量设计系统（`src/styles/global.css`），暗色 / 浅色 / 跟随系统三档主题
- **后端**：reqwest / tokio / rusqlite / keyring / chrono

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

## 安全设计

- **API Key**：经 `keyring` 写入系统凭据管理器（`src-tauri/src/storage.rs`），SQLite 只存生成历史，不存任何密钥
- **CSP**：生产环境启用严格 Content-Security-Policy（`tauri.conf.json`），仅允许自身源 + IPC + asset 协议
- **asset 协议**：`convertFileSrc` 的访问范围收窄到 `%LOCALAPPDATA%\AIVisionStudio\assets\`（glob 模式 `**/AppData/Local/AIVisionStudio/assets/**`，兼容 Windows canonicalize 的 `\\?\` 前缀路径），WebView 无法读取任意本地文件
- **零服务端**：应用无自有服务器，所有调用直连你配置的厂商 API

## 数据位置（Windows）

| 数据 | 位置 |
|------|------|
| 生成产物 | `%LOCALAPPDATA%\AIVisionStudio\assets\YYYY\MM\` |
| 历史记录 | `%LOCALAPPDATA%\AIVisionStudio\history.db` |
| API Key | 系统凭据管理器（Service: `AIVisionStudio.ApiKey`） |

## 贡献

欢迎提交 Issue 与 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。报告安全问题请见 [SECURITY.md](SECURITY.md)。

## 许可证

[Apache License 2.0](LICENSE) © 2026 [begonia-474](https://github.com/begonia-474)
