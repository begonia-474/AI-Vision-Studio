# 领域术语表（Glossary）

全仓库统一用词：代码、注释、README、docs、提交信息必须与下表一致。术语冲突时以本表为准，新增术语先补本表再使用。

| 术语 | 含义 |
|------|------|
| 会话 session | 时间线容器，`sessions` 表权威；前端为镜像 |
| 结果卡 result card | 会话时间线上的单个产物卡片（`loading/done/error` 三态） |
| 任务 task | 一次 `generate` 提交（`task_id` 唯一）；组图任务一任务多卡 |
| 工作室 studio | image / video 两个生成入口（App 视图） |
| 图库 gallery | 历史瀑布流视图（`list_history` + 详情面板） |
| 收编 save_reference | 参考图复制进受管 `inputs` 目录 |
| 归一化 normalize_reference | 收编路径/URL 转 data URL 供厂商提交 |
| 重新编辑 / 重新生成 | 按 `params_json` 回填表单（`applyJump`）重跑 |
| 组图 mode=group | 一次请求组图（auto + max_images）；`single` = 每张独立请求循环 n 次 |
| 掩码 mask | 密钥回显形式：首尾 4 位，≤8 字符 `****` |
| 自添加模型 user model | 以内置模型为模板、换 id/名称/默认参数的自建模型 |
| 跳转 studio jump | 图库/卡片发起的"图生视频 / 作为参考图 / 重新编辑" |
| BYOK | 自带密钥（Bring Your Own Key），应用不持有密钥、无自有服务器 |

## 命名规范

- **i18n key**：`模块.名词`（`common.save`、`settings.assetsPath`、`providers.volcark.name`），zh-CN 为类型事实源。
- **id 前缀**：历史恢复任务 `history_` 前缀（不计入会话 x/y 角标）；结果卡 `r_` 前缀（`uid()` 生成，不透明）。
- **事件阶段**：submitting / running / downloading / completed / failed，与 `ProgressPayload.phase` 一一对应。
- **Rust**：DTO 字段 snake_case（serde 默认）；函数/变量 snake_case；类型 CamelCase；错误消息中文。
- **TS**：变量/函数 camelCase；组件 PascalCase；DTO 字段 snake_case（与 Rust 对齐，前端不转换）。
