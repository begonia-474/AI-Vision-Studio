# AGENTS.md

AI Vision Studio 是一个 Tauri 2 桌面应用（React 19 + TypeScript + Vite 7 前端，Rust 后端），聚合火山方舟 / 可灵 / 通义万相 / MiniMax / 魔搭五家厂商的图像与视频生成。本文件是开发约定的**入口**，面向 agent 与协作者；文档体系分层如下，动手改代码前按需阅读：

- [docs/architecture.md](docs/architecture.md) — 架构、关键设计、开发命令、环境怪癖（改架构级行为必须同步）
- [docs/development.md](docs/development.md) — 详细开发约定：错误处理、并发性能、类型与 DTO、防御性模式、依赖、测试
- [docs/glossary.md](docs/glossary.md) — 领域术语表与命名规范（跨文档统一用词）

## 版本与数据兼容立场

项目已有 Release 分发（见 README「下载安装」），**存在真实用户数据**——不做无通告的破坏：

- **数据库向后兼容**：表结构演进用「新表 `CREATE TABLE IF NOT EXISTS` + 新列 `ensure_column` 渐进迁移」（见 `storage.rs::ensure_schema`，含 WAL 持久化）；当前**没有** `PRAGMA user_version`——首次需要结构性迁移（改列/删列/重建）时，先引入版本号机制再动结构，禁止直接改旧表定义。
- **数据文件格式变更**（如 `keys.json` 结构、路径布局）必须：① 启动时对旧格式可观测（报错或说明），② 在 README 数据章节注明影响。先例：keyring → 明文 `keys.json` 不互通，README 已声明「首次使用需重新填入」。
- 移除依赖、换实现、改存储语义时，在提交信息与 README 中写明用户可见影响；「重写正确」优先于「兼容垫片」，但数据不丢是底线。

## 仓库布局

```
src/                      React 前端
  api.ts                  Tauri invoke 封装 + gen-progress 订阅（onProgress）+ toAssetUrl（asset 协议）
  types.ts                前端私有类型（StudioJump 等）+ re-export；跨端 DTO 由 ts-rs 生成（types/generated/，npm run typegen）
  App.tsx                 视图路由（image / video / gallery）+ 全局弹层
  models/registry.ts      模型注册表：内置模型 + 自添加模型 + 默认模型解析
  studios/                useStudio（表单状态机）、sessionStore（会话状态）、ImageStudio / VideoStudio
  components/             ByokModal、SettingsModal、GalleryView、TaskTimeline、ui/（shadcn）等
  shell/                  侧边栏
  i18n/                   locales/zh-CN.ts + en-US.ts（默认中文；key 类型安全由 i18next.d.ts 保证）
  lib/                    utils.ts（uid 等）、classes.ts、icons.tsx
src-tauri/                Rust 后端
  src/commands.rs         IPC 命令层：generate、会话 / 历史 / 密钥 / 自添加模型 CRUD
  src/storage.rs          AssetStore（下载 / 缩略图 / 参考图收编）+ HistoryDb（rusqlite）
                          + KeyStore（keys.json）+ UserModelStore；数据目录解析与 GC
  src/models.rs           领域模型与共享 DTO（serde snake_case；ts-rs 生成前端类型）
  src/registry.rs         内置模型注册表（能力/尺寸/官方像素表/像素区间，领域数据唯一事实源）
  src/params.rs           参数纯函数：LoRA 归一化 + params_json 解析（STRUCTURED_PARAM_KEYS 唯一来源）
  src/providers/          厂商适配器：mod.rs 契约 + dashscope / volcark / kling / minimax / modelscope
  src/lib.rs              启动初始化（storage::init + asset scope 授权）与命令注册
docs/                     架构（architecture.md）、开发约定（development.md）、术语表（glossary.md）
```

## 命令与检查

```sh
npm install                          # 前端依赖（Node ≥ 18；Rust stable）
npm run tauri dev                    # 完整开发（debug 构建，数据在 <项目根>/.data/）
npm run dev                          # 仅 Vite 前端热更（无后端，界面可看不可生成）
npm run build                        # 前端门禁：tsc（strict + noUnusedLocals）&& vite build
npm run tauri build                  # 发布打包 → src-tauri/target/release/bundle/
npm run typegen                      # 跨端 DTO/常量重新生成（ts-rs，改 Rust DTO 后必跑并提交）
cd src-tauri && cargo check --all-targets   # 后端门禁
cd src-tauri && cargo test                  # 后端单测（storage 层）
```

- **提交前跑最小相关检查，并报告实际运行的命令**：前端改动 `npm run build`，后端改动 `cargo check --all-targets` + `cargo test`；不要为每次提交重跑已通过的检查。仓库没有 ESLint / Prettier / Biome——tsc 与 cargo 就是全部门禁，Rust 保持 `cargo fmt` 默认格式。
- **CI 门禁（`.github/workflows/ci.yml`）**：每次 push / PR 自动跑前端 `npm run build` 与后端 `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` + `cargo check --all-targets` + `cargo test`。推送前务必本地先过一遍，避免红叉；CI 是最终裁决，本地检查是前置自查。
- **CD 发布（`.github/workflows/release.yml`）**：打 `v*` 标签（如 `v0.2.0`）触发 Windows / macOS（双架构）/ Linux 三平台构建并创建 Release 草稿，人工确认后发布；发布前同步更新 `src-tauri/tauri.conf.json` 的 version。
- 证据匹配表面：行为改动看测试与构建，文档改动核对 README / docs 一致，纯类型改动 `tsc` / `cargo check` 即可。
- 环境适配说明（Vite 固定端口 53217/53218 的决策理由、图标重生成）见 [docs/architecture.md](docs/architecture.md#环境适配说明)；端口是刻意决策，不要"顺手修正"为默认值。

## 密钥与环境

- **密钥存储**：`keys.json`（数据根目录内）明文 JSON `{ api_keys, workspaces }`；Unix 0600、原子写（tmp + rename）、`KEYS_LOCK` 读写锁（写互斥、读并发）+ 内存缓存（审计#12，读命中零磁盘 IO，写后刷新缓存）；读写走 `spawn_blocking`。不要把 Key 写进 SQLite、日志或任何诊断输出。
- **密钥不出后端**：`get_api_key` 只回显掩码（首尾 4 位；≤8 字符统一 `****`，见 `mask_key`）；前端按"是否已设置"消费，不得设计"查看完整密钥"功能。
- **输入校验在命令入口**：WorkspaceId 仅允许字母/数字/连字符（构成专属域名 `https://{ws}.cn-beijing.maas.aliyuncs.com`），非法输入直接 `Err` 拒绝，不静默清洗。
- **绝不提交凭据**：`.env`、`config/`、`.data/` 已 ignore；`keys.json` 位于数据目录、不入库不进版本库。本仓库无环境变量依赖，新增 `.env` 用法必须同时写文档。

## 架构不变量（最高优先级，违反前先读 docs/architecture.md）

- **SQLite 是唯一权威，前端是镜像。** 会话与历史完全以 `history.db` 为准：生成"提交即落库"（先写 running 行，成功/失败终态回写，失败也留行），启动时按行恢复时间线、孤儿会话重建；前端不再有 localStorage 业务数据。任何"本地状态改了但没落库"的路径都是 bug。
- **`params_json` 是"重新编辑 / 重新生成"的回填权威。** 结构化字段以命令层 `json!` 快照为准，用户自建模型声明的同名 key 跳过。键表与解析的唯一事实源在 `params.rs`（`STRUCTURED_PARAM_KEYS` 常量 + `parse_history_params` 命令，typegen 生成前端常量），前端 `sessionStore::freeParams` 与图库/时间线的「重新编辑」「重新生成」均消费它——**改键表只动 `params.rs`，勿两端手写**。
- **`gen-progress` 是唯一实时通道**：后端 `app.emit("gen-progress", ProgressPayload)`，前端 `api.ts::onProgress` 按 `task_id` 路由写入 loading 卡；阶段由 `ProgressPhase` 枚举唯一声明（submitting → running → downloading → done/failed，`npm run typegen` 生成前端类型与常量），禁止两端拼裸字符串。新增阶段要同步枚举、卡片渲染与双语文案；订阅必须可注销（`UnlistenFn`）并处理卸载竞态。
- **阻塞 IO 一律出 tokio worker**：SQLite、文件、`keys.json` 的同步 IO 全部 `spawn_blocking`；产物下载流式落盘，数百 MB 视频不得整块进内存。
- **失败路径统一收尾**：`commands.rs::fail_generation` 是唯一出口：清理已产生文件 + 写库终态 + 推 failed 事件。新失败分支不得自写 cleanup / update / emit 序列。
- **密钥不出后端**：前端只能拿到掩码；完整 Key 只存在于 `keys.json` 与厂商请求中，不得设计"查看完整密钥"类功能。
- **默认模型按显式 id 声明**（`defaultModelForStudio`），禁止列表魔法下标——列表重排会静默换默认。
- **错误一律 `Result<_, String>` 中文可读消息**；生产路径禁止 `unwrap` 与 `panic`（仅锁中毒（KEYS_LOCK/KEYS_CACHE，中毒即不可恢复）与启动期带消息 `expect` 例外）。

## 详细约定

- 错误处理、并发与性能、类型与 DTO、前端状态与 UI、安全实现细节、依赖、测试、防御性模式、文档规范 → [docs/development.md](docs/development.md)
- 领域术语与命名规范 → [docs/glossary.md](docs/glossary.md)

## 文案与提交

- 代码注释、README、docs 用中文；提交信息用 conventional commits 前缀 + 中文主题（`feat:` / `fix:` / `perf:` / `docs:` / `refactor:`）。
- **独立改动独立提交**；修复性改动在注释中标注 `审计#N` 编号并说明动机（既有审查遗留编号，新审计顺延）。
- TODO 标注：`TODO`（待办）、`FIXME`（已知缺陷）、`XXX`（危险点/需立刻注意），一律带一句意图说明。
- 文件以单个换行结尾；提交前 `git diff --cached --check` 无空白错误；不提交生成物与本地数据（`.data/`、`target/`、`dist/`）。

## 编辑这些文档

- 规则分层：高层不变量留在本文件，可操作的细则进 [docs/development.md](docs/development.md)，共享词汇进 [docs/glossary.md](docs/glossary.md)，架构事实进 [docs/architecture.md](docs/architecture.md)——不重复存放同一事实。
- 新增约定必须能指到仓库中的真实先例或明确新增的行为要求，禁止空泛口号；规则保持自包含、可单条引用。
