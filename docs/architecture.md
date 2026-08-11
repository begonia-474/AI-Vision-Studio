# 架构与开发

> 面向维护者：架构速记、关键设计决策、开发环境要求。日常开发流程与代码规范见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 架构

```
┌────────────────────── 前端 (React + TS) ──────────────────────┐
│  App ── Sidebar（会话列表 / BYOK / 设置）           │
│   ├─ ImageStudio / VideoStudio ── TaskTimeline（对话式时间线）  │
│   │        └─ useStudio ─ sessionStore（多会话 + SQLite 持久化） │
│   └─ GalleryView（图库）── DetailPanel（作品详情）        │
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

## 关键设计

- `providers/mod.rs` 的 `GenerationProvider` trait 把同步厂商（图像）与异步厂商（视频）统一成 `submit / poll / test_connectivity / default_model` 四个方法，新增内置厂商只需实现该 trait 并注册
- 自添加模型存 SQLite `user_models` 表，前端注册表（`src/models/registry.ts`）是模型声明的单一数据源（尺寸机制 / 参数分区 / 默认参数），启动/增删时拉取合并进模型列表
- 产物下载、缩略图生成由 `commands` 层调用 `storage` 完成，provider 与本地存储解耦
- 任务进度由后端 `gen-progress` 事件推送，前端 `TaskTimeline` 按 taskId 写入对应卡片
- 会话与生成历史全部以 SQLite 为唯一权威（sessions 表 + tasks 表，提交即落库、终态回写），前端无 localStorage 业务数据——清理 WebView 缓存不影响任何会话；孤儿任务按归属自动重建会话

## 开发环境要求

- [Node.js](https://nodejs.org) ≥ 18
- [Rust](https://rustup.rs)（stable）
- 平台依赖见 [Tauri 官方文档](https://tauri.app/start/prerequisites/)

## 开发命令

```bash
npm install          # 安装前端依赖
npm run tauri dev    # 完整开发循环（Vite + Rust 后端自动编译）
npm run tauri build  # 产出安装包到 src-tauri/target/release/bundle/
cargo test           # Rust 单元测试（src-tauri/src/storage.rs 等）
```

> `npm run tauri dev` 会同时启动 Vite 与 Rust 后端。生产构建的 CSP 已启用；开发模式使用 `devCsp: null` 以兼容 React Fast Refresh。

## 开发环境怪癖

- Vite 固定端口 53217（HMR 53218）+ `strictPort`，与 `tauri.conf.json` 的 `devUrl` 对齐。默认的 1420/1421 落在 Windows Hyper-V/WSL2 排除端口段（1367-1466）会 EACCES，5180 也在本机排除段（5121-5220）——不要改回标准端口
- 应用图标（窗口/任务栏）在编译期由 tauri-build 嵌入 exe；`src-tauri/build.rs` 已显式声明 `rerun-if-changed`，更换 `icons/icon.ico` 后重编译会自动生效。重生成全套图标：`npm run tauri icon <1024px源图>`（源图在 `assets/AI_Vision_Studio_logo_1024.png`）
