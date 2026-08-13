# 开发约定（Development Conventions）

本文是 [AGENTS.md](../AGENTS.md) 的详细约定层：类型与 DTO、错误处理、并发与性能、安全实现细节、依赖纪律、测试纪律、防御性模式与文档规范。AGENTS.md 只保留高层不变量与入口，本文提供可操作的细则。架构与开发环境见 [architecture.md](architecture.md)，术语见 [glossary.md](glossary.md)。

## 错误与失败

- **错误一律 `Result<_, String>` 中文可读消息**：可失败 IO/解析全部向上传播或转 `Err`，消息面向用户可读，不抛原始 panic。
- **`unwrap`/`panic` 仅两处例外**：`KEYS_LOCK.lock().unwrap()`（Mutex 中毒不可恢复）与启动期 `expect`（必须带消息，如 `lib.rs` 的 http client 构建）。其余生产路径一律禁止。
- **失败路径统一收尾**：`commands.rs::fail_generation` 是唯一出口（清理已产生文件 + 写库终态 + 推 failed 事件）。新失败分支不得自写 cleanup / update / emit 序列。
- **空 catch 必须命名所吞之物**：`let _ = ...` 与 `.catch(() => {})` 要注释为什么可以吞（先例：删除历史的 fire-and-forget）；保持 try 块只包一个语句。
- **前端错误三态**：结果卡 `loading / done / error`（`ResultStatus`）；生成失败文案展示在卡片上，不用 `alert()`；异步操作失败必须落卡片或设置页内联提示，不得静默。

## 并发与性能

- **阻塞 IO 一律出 tokio worker**：SQLite、文件、`keys.json` 的同步 IO 全部 `spawn_blocking`（厂商内读 WorkspaceId 也一样）。
- **流式落盘**：产物下载用 `resp.bytes_stream()` 边收边写，数百 MB 视频不得整块进内存（`resp.bytes()` 禁止用于大文件）。
- **零拷贝优先**：参考图是可达数 MB 的 base64 串，跨线程传递用 `mem::take` 移出请求体（先例：`generate` 的 `req_refs`），禁止整份克隆。
- **统计与扫描单遍**：会话角标/统计不得在循环里嵌套 `filter`（审计#9 的 O(n²) 教训）；单遍 Map/Set 扫描。
- **引用稳定性**：进度事件高频（每任务 3-5s），时间线重渲染路径的 `useCallback`/`useMemo` 依赖必须正确，避免无谓重渲染（历史教训：任务线重渲染卡顿）。
- **行为参数集中声明**：轮询间隔/超时、重试退避、GC 保留期、写入冷却窗口等参数以具名常量集中定义并注释依据；用户可调项走设置，不散落魔法数字。

## 类型与 DTO

- **共享 DTO 单一事实源**：`src/types.ts` ↔ `src-tauri/src/models.rs`（serde snake_case；Tauri invoke 自动 camelCase→snake_case）。新增/改名字段两边同步，前端不得发明后端没有的字段。
- **前端零 `any`**（当前全库无 `any`，保持）：tsconfig `strict` + `noUnusedLocals` + `noUnusedParameters` 全开；`@/` 路径别名指向 `src/`。
- **边界信任类型**：前端 ↔ Rust 边界由 serde DTO 保证，不在两端重复校验同一规则；校验只做在解析边界（命令入口的输入校验、模型声明的参数区）。
- **默认值显式化**：工作室默认模型用 `defaultModelForStudio`（显式 id，删除/改名时回退列表首个），禁止消费方魔法下标；后端默认模型由 provider 的 `default_model()` 唯一提供；业务默认值在唯一实现处解析，不散落在调用点。

## 前端状态与 UI

- 结果卡/任务 id 统一用 `src/lib/utils.ts` 的 `uid()`，禁止各处自实现。
- 删除结果卡/任务必须**跨全部会话**（`removeByHistoryId` / `removeByResultId` / `removeByTaskId`），禁止只在激活会话里 find——历史按 session_id 归属恢复，卡片可能落在任意会话。
- 启动加载 effect 不得依赖 `t`（切语言会重跑整库加载，用 `tRef` 固定）。
- `applyJump` 跳转回填的画质换算必须**显式传目标模型与收敛后的比例**——闭包中的 model/ar 是旧值，会换算错误并覆盖已算好的尺寸（审计#10）。
- i18n key 命名 `模块.名词`（如 `settings.assetsPath`），支持 `{{n}}` 插值；key 拼写由 i18next 类型声明兜底（zh-CN 为类型事实源）。

## 安全实现细节

- **响应体写库前 `sanitize_body` 脱敏**：超长字符串截断为长度标记（阈值 2048 字符），保证单行体积有界；诊断日志/注释同理不得打印 base64 图像块或密钥。
- **资产展示走 asset 协议**：webview 经 `convertFileSrc` 读本地文件；scope = 配置 `$APPLOCALDATA/**` + 运行时 `allow_directory`（debug 的 `.data` 靠后者授权）。新增需前端展示的数据子目录，必须确保在 scope 内。
- **前端输入默认不可信**：生成参数的上限（n、参考图数量）以模型声明的 `maxBatch`/`maxRef` 为准，后端不盲信前端数值。
- **密钥掩码规则**：`mask_key` 首尾各 4 位、≤8 字符统一 `****`；完整 Key 只存在于 `keys.json` 与厂商请求中。

## 依赖纪律

- 新增 npm / cargo 依赖必须带理由（体积、维护状态、平台覆盖）。
- 优先维护良好的依赖而非手写，但**手写替代品若换来跨平台一致与可审计性，可接受**——先例：移除 keyring（凭据管理器依赖、平台行为不一）换手写 `keys.json`，代价（明文、不互通）已文档化。
- 不引入重量级依赖解决小问题（缩略图用 `image` crate 而非系统工具；UI 用 shadcn/radix 而非 UI 框架）。

## 测试

- 后端：`cargo test`，当前覆盖 storage 层（数据目录规范化、缩略图往返）。**测试断言行为而非实现**；修改行为必须连带改测试并说明原因。
- 前端暂无测试框架：行为级改动至少保证 `tsc` 通过；新增关键纯函数（参数换算、掩码等）优先抽到可测位置。

## 防御性模式

- **路径必须规范化**：`CARGO_MANIFEST_DIR/../.data` 这类派生路径在落库/落盘前 `canonicalize`（去掉 `src-tauri/..` 段），否则产物路径串与真实位置不一致（有单测锁定）。
- **启动期固定全局状态**：数据根目录用 `OnceLock` 在 `storage::init` 一次性解析并授权 asset scope；不要在运行时重新推导"当前该用哪个目录"。
- **文件写入原子化**：先写临时文件、再 `rename`；Unix 权限在 rename 前设置（`keys.json` 0600 先例）。
- **时间与排序**：时间戳统一 ISO 8601 文本（created_at）与整数 epoch（sessions 的 updated_at）；排序以库内时间为准，不依赖前端时钟。
- **可再生数据靠 GC 兜底**：收编副本按 mtime 年龄回收（30 天），不追踪引用计数；不可再生数据（产物）不自动删。

## 文档规范

- Rust：`///` 文档注释写契约（参数语义、返回约定、调用前提）；可失败函数一律 `Result<_, String>`。
- TS：非显然的导出写 JSDoc（`@param` / `@returns`），共享类型字段注释说明来源与消费方（先例：`types.ts` 的 `task_id`、`params_json`）。
- **注释写"为什么"与契约，不叙述代码事实**；保留行为、失败、时序、所有权与安全使用的事实，链接理由而非复述过程。不要用隐喻；术语用 [glossary.md](glossary.md)。
- 行为变更时同步更新受影响的注释、[architecture.md](architecture.md) 与 README；README 与 docs 用中文。
- 修复性改动在注释中标注 `审计#N` 编号并说明动机（既有审查遗留编号，新审计顺延）。
