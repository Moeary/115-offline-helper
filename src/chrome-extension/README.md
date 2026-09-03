# 115 Offline Helper - Chrome Extension

此目录是 Manifest V3 扩展源码；`pixi run build` 会校验所有入口后复制到 `dist/extension/`。

## 架构

```text
chrome-extension/
├─ shared/                         配置迁移、DownloadIntent、消息、目录与文件规则
├─ content/
│  ├─ bootstrap.js                轻量 Adapter 分发与节流后的动态页面刷新
│  ├─ runtime-generic.js / runtime-sites.js  动态注册脚本的运行模式标记
│  ├─ intent-factory.js           Adapter 结果 → DownloadIntent[]
│  ├─ sites/
│  │  ├─ generic.js               任意网页 Magnet/ED2K
│  │  ├─ javbus.js                番号与磁链
│  │  ├─ nyaa.js                  Nyaa/Sukebei 共用 family core
│  │  └─ mikan.js                 番组资源表
│  └─ ui/
│     ├─ download-confirmation.js 多行校验、规则与目录覆盖
│     ├─ submission-queue.js      统一限流提交与失败隔离
│     ├─ batch-progress.js        waiting/submitting/success/failed/duplicate
│     └─ styles.js / feedback.js
├─ background/
│  ├─ api/                        Cookie、HTTP、115 离线与文件 API
│  ├─ tasks/                      持久任务记录与 alarm 监控
│  ├─ processors/                 cleanup、generic、jav、anime
│  ├─ content-scripts.js          按权限和站点 profile 动态注册
│  ├─ router.js                   消息与 DownloadIntent 提交入口
│  └─ service-worker.js           MV3 service worker 装配入口
├─ ui/
│  ├─ popup/                      手工多行输入、登录与任务管理
│  └─ options/                    站点 profile、规则与日志
├─ popup.html
├─ options.html
└─ manifest.json
```

## 处理模型

Adapter 只提供 `matches(location)`、`extractPageMetadata()`、`discoverDownloads()`、`enhancePage()` 与 `getDefaultProcessorProfile()`。`intent-factory.js` 统一生成包含 `sourceSite`、`mediaType`、`url`、`title`、`code`、`metadata`、`savePathCid`、`processorProfile` 的 DownloadIntent；Adapter 不调用 115 API。

所有页面单发、Nyaa/Sukebei/Mikan 批量和 popup 手工输入都会进入同一个确认 UI。确认层会 trim、去空行、按 BTIH 或完整链接去重并标记非法行；用户可把网站默认规则改为 `generic`、`jav` 或 `anime`。提交层默认并发 2，逐项失败不会终止批次；一次确认窗口内的多条任务会携带同一个 `metadata.batchId`，供 anime 后处理识别批量扁平化范围。

- `generic`：通用安全清理，不按番号重命名。
- `jav`：安全清理后，页面番号优先，最大主视频、字幕和任务文件夹按番号整理。
- `anime`：单条任务通用安全清理并保留 torrent 原始文件名与目录结构；同一确认窗口的批量任务会在完成后将视频/字幕移到所选保存目录，确认源目录为空后再删除任务文件夹，不做番号或番名强制改名。

## 页面结构校验记录（2026-09-02）

- Nyaa/Sukebei：两站由同一套 Nyaa 模板生成。当前官方模板确认列表为 `table.torrent-list > tbody > tr`；标题链接位于第二个 `td` 的 `/view/` 链接；Magnet 位于链接操作单元格，Adapter 先使用 `td:nth-child(3) a[href^="magnet:"]`，再以行内 Magnet 兜底。页面为服务端渲染，翻页会重新加载文档。
- Mikan：当前番组详情页可见“番组名 / 大小 / 更新时间 / 下载 / 播放”资源表和逐行“复制磁连”。既有稳定实现继续读取 `.js-magnet` 及其 `href`、`data-clipboard-text`、`data-magnet`、`data-url`，并从最近的 `tr`/资源项取得标题；异步展开的新增行由节流 `MutationObserver` 补强。
- JavBus：保留现有 `#magnet-table`、`.magnet-name` 与 Magnet href 读取；番号先取 URL 最后一个路径段，再退回标题和信息区。
- OpenBT：没有专用 Adapter 或 Site Profile；无论页面结构如何，都只由 Generic 查找标准 Magnet/ED2K href。

本次尝试通过 Browser/Chrome 直接打开上述站点时，本机 Browser service 因插件运行目录权限无法启动；Nyaa/Sukebei 选择器额外以当前官方模板源码核对，Mikan 以当前番组详情页网络读取核对。JavBus/OpenBT 的实时 DOM 未据此臆造新 selector。待浏览器连接恢复后，应再做一次加载扩展后的交互冒烟验证。

## 权限与配置迁移

`push115_site_profiles` 为 Generic、JavBus、Nyaa、Sukebei、Mikan 分别保存 `enabled`、`defaultProcessorProfile`、`defaultSavePathCid`；设置页的 `defaultSavePathCid` 由上方 `SAVE_PATH_LIST`（目录名:CID）下拉选择，不再要求逐站手填 CID。列表站还保存 `inlineSendButton`、`batchSelection`、`batchConcurrency`。旧 `savePathCid`、`processorProfile`、`enhancementMode` 和 Mikan `none` 会在读取时迁移；升级时若旧 CID 不在目录列表中，会暂时保留为兼容选项，其他登录、Cookie、清理和任务配置保持原键。

设置页的“清空日志”只移除已完成、失败和已记录的历史任务；仍处于 `waiting` / `processing` 的持久任务会保留，不会中断后台下载。

Generic 使用 `<all_urls>` 可选权限；预定义站点可只授权自己的 host permission。OpenBT 不单独请求权限，启用 Generic 后随 `<all_urls>` 生效。

动态注册分别注入 `runtime-generic.js` 或 `runtime-sites.js` 模式标记；这样在站点 profile 切换或已有标签页补注入时，Generic 的兼容点击监听不会与专用 Adapter 重复接管页面。

## 开发

```powershell
pixi run build
pixi run deploy
```

构建会校验 Manifest V3、popup/options、service worker 的 `importScripts`、HTML 本地资源以及关键架构入口。
