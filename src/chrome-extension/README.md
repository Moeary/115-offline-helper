# 115 Offline Helper - Chrome Extension

此目录是 Manifest V3 扩展源码；`pixi run build` 会校验所有入口后复制到 `dist/extension/`。

## 架构

```text
chrome-extension/
├─ shared/                         配置迁移、DownloadIntent、番组身份、消息、目录与文件规则
│  └─ anime-series.js              Mikan 番组 URL 身份与安全目录名
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
│     ├─ anime-routing.js          Mikan 番组目录绑定、复用与断点提示
│     ├─ submission-queue.js      统一限流提交与失败隔离
│     ├─ batch-progress.js        waiting/submitting/success/failed/duplicate
│     └─ styles.js / feedback.js
├─ background/
│  ├─ api/                        Cookie、HTTP、115 离线与文件 API
│  ├─ tasks/                      持久任务记录与 alarm 监控
│  │  ├─ folders.js                115 目录分页读取与路径校验
│  │  └─ anime-library.js          番组 → 115 CID 持久绑定与重复提交回执
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

所有页面单发、Nyaa/Sukebei/Mikan 批量和 popup 手工输入都会进入同一个确认 UI。确认层会 trim、去空行、按 BTIH 或完整链接去重并标记非法行；用户可把网站默认规则改为 `generic`、`jav` 或 `anime`。提交层默认并发 2，逐项失败不会终止批次。

- `generic`：通用安全清理，不按番号重命名。
- `jav`：安全清理后，页面番号优先，最大主视频、字幕和任务文件夹按番号整理。
- `anime`：单条任务通用安全清理并保留 torrent 原始文件名与目录结构；同一确认窗口的批量任务，或绑定到 Mikan 番组的单条/批量任务，会在完成后将视频/字幕移到同一个目标目录，确认源目录为空后再删除任务文件夹，不做番号或番名强制改名。移动计划会先保存文件 ID，失败或 service worker 重启后从计划继续，不会扩大扫描范围。

### Mikan 番组归档

Mikan 详情页的 `/Home/Bangumi/<数字 ID>` 是稳定的番组身份。第一次使用 Anime 规则时，确认窗口可选择：在当前目录建立或复用一层番组目录、直接绑定当前目录，或仅本次普通 Anime。绑定保存于 `chrome.storage.local` 的 `push115_anime_library`，与任务日志分开；因此“完结番”可一次选择多个资源整合，“连载番”先提交前 8 集，后续在同一详情页提交 EP09 时会自动复用相同 CID。已提交 BTIH 默认跳过，可取消跳过以强制重下。

下载完成后，Anime 处理器只移动明确识别的 `视频/字幕`，保留 torrent 原始名称和未知文件；每次移动、目标目录可见性和空目录回收均会复核。同名文件、目录位置改变或 115 返回不一致时会保留源文件并等待重试，避免误删其他番组。清空后台日志不会清除番组绑定或重复提交回执。

## 页面结构校验记录（2026-09-05）

- Nyaa/Sukebei：两站由同一套 Nyaa 模板生成。当前官方模板确认列表为 `table.torrent-list > tbody > tr`；标题链接位于第二个 `td` 的 `/view/` 链接；Magnet 位于链接操作单元格，Adapter 先使用 `td:nth-child(3) a[href^="magnet:"]`，再以行内 Magnet 兜底。页面为服务端渲染，翻页会重新加载文档。
- Mikan：通过 Chrome 实际打开 `https://mikan.tangbai.cc/Home/Bangumi/2087` 核对到 `p.bangumi-title`（番组名）、`table.table.table-striped.tbl-border > tbody > tr`（资源行）、行内 `.js-episode-select[data-magnet]`（磁链）和 `.magnet-link-wrap`（资源名），复制磁链链接为 `.js-magnet`。页面服务端渲染，底部“显示更多”可能追加行；Adapter 继续从这些属性兜底读取，节流 `MutationObserver` 处理动态追加且不重复注入。
- JavBus：保留现有 `#magnet-table`、`.magnet-name` 与 Magnet href 读取；番号先取 URL 最后一个路径段，再退回标题和信息区。
- OpenBT：没有专用 Adapter 或 Site Profile；无论页面结构如何，都只由 Generic 查找标准 Magnet/ED2K href。

本轮已通过 Chrome 实际读取 Mikan 番组详情页的 DOM，并确认增强工具栏、15 个按 BTIH 去重的资源行与逐行按钮均可见；Nyaa/Sukebei、JavBus 的 selector 仍沿用上一轮已核对并记录的结构。OpenBT 不建立专用 Adapter，按 Generic 处理；若站点被 Cloudflare 拦截，不会臆造专用 selector。

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
