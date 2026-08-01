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

- **前端**：TypeScript strict，组件命名 PascalCase，样式写在 `src/styles/global.css`（CSS 变量驱动主题）
- **Rust**：遵循 `rustfmt` 与 `cargo clippy`（提交前请本地运行）
- **类型对齐**：`src/types.ts` 与 `src-tauri/src/models.rs` 的 DTO 必须保持对齐（serde 默认 snake_case，前端 invoke 参数自动转换）
- **不添加无意义的注释**：注释只解释"为什么"，不解释"是什么"

## 新增一个 AI 厂商

1. 在 `src-tauri/src/providers/` 下新建 `xxx.rs`，实现 `GenerationProvider` trait（`submit` / `poll` / `test_connectivity` / `default_model`）
2. 在 `providers/mod.rs` 的 `get_provider()` 中注册 id
3. 在前端 `src/models/registry.ts` 添加厂商元信息（id、名称、颜色、`wired: true`）与模型定义
4. 在 `storage.rs` 的 `save_key` / `get_key` 中确认密钥存取无需改动（按 providerId 区分，自动支持）

> 同步厂商（立即返回结果）与异步厂商（先提交后轮询）只需遵循 trait 约定，commands 层统一调度。

## 测试

目前项目无自动化测试框架。提交涉及核心逻辑（provider / storage）的改动时，请手动验证以下路径：

- 生成成功：结果卡片展示本地产物
- 生成失败：错误卡片展示可读的错误信息
- 密钥测试：设置页的"测试连接"通过/失败
- 历史记录：重启应用后历史仍在，可删除

## Issue 规范

- Bug 报告：描述复现场景、应用版本、操作系统、期望行为与实际行为
- 功能请求：说明使用场景与期望行为，便于讨论设计

## 行为准则

参与本项目即视为同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 中规定的行为准则。
