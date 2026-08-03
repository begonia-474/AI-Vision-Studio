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
- **不添加无意义的注释**：注释只解释"为什么"，不解释"是什么"

## 新增一个内置 AI 厂商

1. 在 `src-tauri/src/providers/` 下新建 `xxx.rs`，实现 `GenerationProvider` trait（`submit` / `poll` / `test_connectivity` / `default_model`）
2. 在 `providers/mod.rs` 的 `all_providers()` 与 `get_provider()` 中注册 id
3. 在前端 `src/models/registry.ts` 添加厂商元信息（id、名称、颜色、`wired: true`）与模型定义
4. 在 `src/i18n/locales/` 中补充厂商名与密钥帮助文案
5. 在 `storage.rs` 的 `save_key` / `get_key` 中确认密钥存取无需改动（按 providerId 区分，自动支持）

> 同步厂商（立即返回结果）与异步厂商（先提交后轮询）只需遵循 trait 约定，commands 层统一调度。

## 接入自定义厂商（无需改代码）

普通用户可在设置弹窗中用 JSON 配置接入任何兼容 Modelscope / Hugging Face / OpenAI 协议的服务（见 [README.md](README.md#自定义厂商系统)）。只有新增协议类型时才需要动代码：

1. 在 `src-tauri/src/providers/custom.rs` 中新增协议分支（提交 / 轮询 / 参数透传）
2. 在 `src/types.ts` 的 `ProtocolType` 与 `src/models/registry.ts` 的 `PROTOCOL_COLORS` 中登记新协议
3. 在 `CustomProviderModal.tsx` 中补充协议的帮助文案（双语）

## 测试

Rust 侧运行 `cargo test`（现有 `storage.rs` 单元测试）。项目暂无可运行的前端自动化测试。

提交涉及核心逻辑（provider / storage / sessionStore / 图库）的改动时，请手动验证以下路径：

- 生成成功：时间线内结果卡片展示本地产物，缩略图正常
- 多任务并行：同一会话同时发起多个任务，各自进度独立、互不阻塞
- 重新生成：失败/完成卡片一键重试，提示词与参数（含参考图）正确回填
- 会话持久化：重启应用后会话与任务仍在；切换 / 重命名 / 删除会话正常
- 图库：历史作品正常展示，收藏 / 批量删除 / 筛选可用；删除时本地产物文件一并清理
- 跨工作室跳转：图库与结果卡片发起"图生视频" / "作为参考图" / "重新编辑"均正确回填
- 自定义厂商：JSON 配置可保存、模型出现在工作室列表、生成与密钥测试通过
- 密钥测试：设置页的"测试连接"通过/失败

## Issue 规范

- Bug 报告：描述复现场景、应用版本、操作系统、期望行为与实际行为
- 功能请求：说明使用场景与期望行为，便于讨论设计

## 行为准则

参与本项目即视为同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 中规定的行为准则。
