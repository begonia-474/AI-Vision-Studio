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
│              + KeyStore(明文 keys.json) + UserModelStore        │
└───────────────────────────────────────────────────────────────┘
```

## 关键设计

- `providers/mod.rs` 的 `GenerationProvider` trait 把同步厂商（图像）与异步厂商（视频）统一成 `submit / poll / test_connectivity / default_model` 四个方法，新增内置厂商只需实现该 trait 并注册；厂商特化副作用经带默认实现的方法下沉到 trait（审计#19：`on_workspace_changed`、`parse_layer_metas`），`commands.rs` 不依赖具体厂商模块，只做编排
- 跨端 DTO 由 ts-rs 从 `models.rs` 自动生成（`npm run typegen` → `src/types/generated/`，CI 校验一致性）；进度阶段由 `ProgressPhase` 枚举唯一声明并生成前端 union 与常量，`commands.rs` 不拼阶段裸字符串
- 自添加模型存 SQLite `user_models` 表；内置模型领域数据（能力/尺寸/官方像素表/像素区间）的单一事实源在 Rust `registry.rs`（`list_builtin_models` 命令启动时一次性拉取，前端 `src/models/registry.ts` 只留缓存与渲染期同步薄函数），自添加模型以内置模型为模板（尺寸机制 / 参数分区 / 默认参数），启动/增删时合并进模型列表；提交时携带 `template_model_id`，volcark 后端按模板 ID 判断 Seedream 版本能力，避免自定义模型 ID 破坏版本识别
- volcark（Seedream，对照 2026.08 官方文档）：5.0 pro 支持 1K/1.5K/2K 像素档、`optimize_prompt_options`（standard/fast）与 `background`（仅 i2i 单参考图，透明模式强制 PNG）；4.0 同样支持 standard/fast 优化；5.0 lite 支持 `web_search` 与 png/jpeg 输出；4.5/4.0 仅 jpeg、不渲染格式分区；组图上限 15 且 i2i 按 `15 - 参考图数` 收敛；自定义 W/H 必须同时满足总像素区间与宽高比 [1/16, 16]，前后端共同校验、非法尺寸显式报错不静默回退
- Seedream 5.0 Pro 交互编辑（`DrawDialog.tsx`）：纯前端实现，按参考图显示矩形把点选 / 框选换算为 0–999 归一化坐标，以 `<point>` / `<bbox>` token 写回 prompt；多参考图按「图 N」标记，后端复用现有 refs 提交通路
- Seedream 5.0 Pro 图层拆分：volcark 解析 `data[].z_index/name/description/bounding_box` 并按 z_index 排序；commands 层写入 sidecar `layers/{history_id}.json`（不迁移 tasks 表），删除任务与失败路径同步清理；详情面板经 `get_layer_meta` 按需读取
- 图层重组画布（`LayerCanvasDialog.tsx`）：前端 Canvas2D 按 `bounding_box.absolute` 叠放图层，支持显隐 / 拖拽排序；导出走后端 `export_layer_composition`（image crate 合成 PNG 到 outputs），避免 WebView canvas 跨域污染
- 产物下载、缩略图生成由 `commands` 层调用 `storage` 完成，provider 与本地存储解耦
- 任务进度由后端 `gen-progress` 事件推送，前端 `TaskTimeline` 按 taskId 写入对应卡片
- 会话与生成历史全部以 SQLite 为唯一权威（sessions 表 + tasks 表，提交即落库、终态回写），前端无 localStorage 业务数据——清理 WebView 缓存不影响任何会话；孤儿任务按归属自动重建会话
- 性能（审计#12）：时间线任务卡组级 memo + items 引用复用（进度事件只重渲染受影响任务，重渲染风暴由此消除；曾引入窗口化渲染，因切会话定位/卡片重叠/空会话 hooks 顺序三处回归已回退）；图库条目一次标准化解析缓存、详情源按需懒计算、历史经 `list_history_page` 分页拉取；后端任务级并发不设全局上限（轮询为 3~5s 一次的轻量请求，视频任务轮询最长 60 分钟，全局限流会造成队头阻塞——曾引入已回退），单任务内扇出受控并发（volcark 单图提交 `buffer_unordered(4)`、缩略图/下载 `buffer_unordered(3)`）；`KEYS_LOCK` 为读写锁 + 内存缓存（读命中零磁盘 IO），dashscope 业务空间 base_url 进程内缓存并随 workspace 变更失效；启动 inputs GC 在后台线程执行

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

### 持续集成（CI/CD）

- **CI**（`.github/workflows/ci.yml`）：每次 push / PR 自动跑前端 `npm run build` 与后端 `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` + `cargo check --all-targets` + `cargo test`（Ubuntu runner，含 Tauri Linux 系统依赖）。
- **发布**（`.github/workflows/release.yml`）：打 `v*` 标签触发 `tauri-action` 在 Windows / macOS（aarch64 + x86_64）/ Linux 构建安装包，创建 Release 草稿供人工确认后发布。

### 应用图标

应用图标（窗口/任务栏）在编译期由 tauri-build 嵌入可执行文件；`src-tauri/build.rs` 已显式声明 `rerun-if-changed`，更换 `icons/icon.ico` 后重编译会自动生效。重生成全套图标：`npm run tauri icon <1024px源图>`（源图在 `assets/AI_Vision_Studio_logo_1024.png`）。

## 环境适配说明

- **Vite 端口固定为 53217（HMR 53218）+ `strictPort`**：不用 Tauri 默认的 1420/1421，是因为部分 Windows 机器上 Hyper-V/WSL2 会占用排除端口段（1367-1466、5121-5220），默认端口会报 EACCES。端口与 `tauri.conf.json` 的 `devUrl` 对齐，改动需两处同步；你的机器若无此冲突，改回标准端口亦可。
