# 贡献指南

感谢你对 AI Vision Studio 的兴趣！以下是参与贡献的规范。

## 工作流程

1. Fork 本仓库并克隆到本地
2. 创建功能分支：`git checkout -b feat/xxx`
3. 提交改动，Commit 信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)（`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`）
4. 推送分支并创建 Pull Request，在描述中说明改动动机与验证方式

## 本地开发

```bash
npm install
npm run tauri dev
```

Rust 侧修改只需重新编译后端，无需重启 Vite。

## 代码规范

- **前端**：TypeScript strict，组件命名 PascalCase。样式分层：设计 token（色板 / 圆角）定义在 `src/styles/global.css` 的 CSS 变量（`:root` / `[data-theme]`），经 `@theme inline` 桥接为 Tailwind 工具类；组件内直接用 Tailwind 工具类，出现 2 次以上的重复样式抽到 `src/lib/classes.ts` 常量类（`BTN` / `MODAL` / `SEG` 等），不把组件样式写进 global.css
- **Rust**：遵循 `rustfmt` 与 `cargo clippy`（提交前请本地运行）
- **类型对齐**：`src/types.ts` 与 `src-tauri/src/models.rs` 的 DTO 必须保持对齐（serde 默认 snake_case，前端 invoke 参数自动转换）
- **i18n**：新增任何用户可见文案必须同时添加 `src/i18n/locales/zh-CN.ts` 与 `en-US.ts` 两个语言条目
- **持久化**：会话 / 生成历史以 SQLite 为唯一权威（提交即落库、终态回写），前端不要新增 localStorage 业务数据
- **不添加无意义的注释**：注释只解释"为什么"，不解释"是什么"

## 新增一个内置 AI 厂商

1. 在 `src-tauri/src/providers/` 下新建 `xxx.rs`，实现 `GenerationProvider` trait（`submit` / `poll` / `test_connectivity` / `default_model`）
2. 在 `providers/mod.rs` 的 `all_providers()` 与 `get_provider()` 中注册 id
3. 在前端 `src/models/registry.ts` 添加厂商元信息（id、名称、颜色、`wired: true`）与模型定义（尺寸机制 / 参数分区 / 默认参数全在此文件内）
4. 在 `src/i18n/locales/` 中补充厂商名与密钥帮助文案
5. 在 `storage.rs` 的 `save_key` / `get_key` 中确认密钥存取无需改动（按 providerId 区分，自动支持）

> 同步厂商（立即返回结果）与异步厂商（先提交后轮询）只需遵循 trait 约定，commands 层统一调度；下载落盘由 commands 层调用 storage 完成，provider 与本地存储解耦。

## 用户自添加模型（无需改代码）

普通用户可在 `AddModelDialog` 中以任意内置模型为模板（继承其尺寸机制 / 参数分区 / 默认参数），替换模型 ID 与显示名称并覆盖默认参数，注册到 SQLite `user_models` 表后即可在工作室列表中使用（提交时 model 字段原样下发）。只有新增**厂商协议类型**时才需要动代码。

## 测试

Rust 侧运行 `cargo test`（现有 `storage.rs` 单元测试）。项目暂无可运行的前端自动化测试。

提交涉及核心逻辑（provider / storage / sessionStore / 图库）的改动时，请手动验证以下路径：

- 生成成功：时间线内结果卡片展示本地产物，缩略图正常
- 多任务并行：同一会话同时发起多个任务，各自进度独立、互不阻塞
- 重新生成：失败/完成卡片一键重试，提示词与参数（含参考图）正确回填
- 会话持久化：重启应用后会话与任务仍在；切换 / 重命名 / 删除会话正常
- 图库：历史作品正常展示，收藏 / 批量删除 / 筛选可用；删除时本地产物文件一并清理
- 跨工作室跳转：图库与结果卡片发起"图生视频" / "作为参考图" / "重新编辑"均正确回填
- 自添加模型：以模板创建、模型出现在工作室列表、生成与密钥测试通过
- 密钥测试：设置页的"测试连接"通过/失败

## Issue 规范

- Bug 报告：描述复现场景、应用版本、操作系统、期望行为与实际行为
- 功能请求：说明使用场景与期望行为，便于讨论设计

## 行为准则

参与本项目即视为同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 中规定的行为准则。
