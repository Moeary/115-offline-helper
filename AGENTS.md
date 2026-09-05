# 115 Offline Helper 协作约束

## 版本号规则

项目使用三段式版本号 `MAJOR.MINOR.PATCH`，源码唯一版本来源是 `src/chrome-extension/manifest.json` 的 `version` 字段。

- 日常小更新、兼容性修补和 bug 修复：递增最后一段 `PATCH`，例如 `1.3.0 → 1.3.1`。
- 新增完整功能、改变用户工作流或涉及多个模块的重大更新：递增倒数第二段 `MINOR`，并将最后一段归零，例如 `1.3.1 → 1.4.0`。
- 只有扩展生态不兼容、需要迁移或明确宣布的破坏性变更，才递增第一段 `MAJOR`，例如 `1.4.0 → 2.0.0`。
- 纯文档、注释、测试或构建脚本改动，若没有发布新扩展产物，可以不改版本号。

每次版本变更都必须同步更新 `README.md` 和 `README_EN.md` 的版本徽章；不要直接编辑 `dist/extension/manifest.json`，它由构建生成。

## 提交前检查

涉及扩展代码的改动至少执行：

```powershell
$env:HOME = $env:USERPROFILE
pixi run build
```

若改动后台任务、Processor、站点 Adapter 或统一确认流程，应同时运行相关 Node 测试和 JavaScript 语法检查。构建必须保持 Manifest V3、`importScripts`、popup/options 本地资源及关键架构入口校验通过。

## 兼容性与安全

- 不重写已经稳定的 115 登录、Cookie、离线 API、持久任务和安全清理判断；优先抽取公共模块并保留旧配置迁移。
- `DownloadIntent.processorProfile` 是后处理唯一决策来源；不得通过 hostname 分支调用 JAV 或 Anime 整理。
- 任何文件移动、重命名或回收都必须使用明确的 CID/FID，并在状态返回后复核；不能因目录读取失败而回退到根目录或全库扫描。
- Anime 默认保留 torrent 原文件名和目录语义；只有明确的 Anime Processor 规则才能改变它。JAV 重命名逻辑只能由 `jav` profile 触发。
- 清空日志只能清除历史记录，不能取消 `waiting` / `processing` 任务，也不能清除番组目录绑定或去重回执。
- 站点 Adapter 只负责识别页面和构造意图，不得直接调用 115 API；动态内容脚本要避免重复注入，并保留 optional host permissions 逻辑。

## 工作区与交付

- 修改前先检查 `git status`，保留用户已有改动，不使用 `git reset --hard`、强制覆盖或无关删除。
- 新增入口必须加入 `scripts/build.py` 的架构入口校验，并确认 Manifest、HTML、`importScripts` 引用文件存在。
- 完成后说明改动文件、版本号、运行过的检查及未能验证的外部站点；不要把设计计划当作代码完成结果。
