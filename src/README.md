# 源码地图与开发约定

`src/chrome-extension/` 是 Manifest V3 的源码，`dist/extension/` 只是 Pixi 生成给 Chrome 加载的副本。开发时只改 `src`，不要直接修改 `dist`。

## 先理解一条下载的生命线

```text
站点页面 / popup
  → Adapter 发现资源
  → DownloadIntent 记录来源与规则
  → Confirmation UI 校验、去重、让用户覆盖默认值
  → Submission Queue 限制并发
  → background 统一调用 115 API
  → processorRegistry[processorProfile] 后处理
```

Adapter 不得调用 115 API；Processor 不得从 hostname 猜测业务。所有移动、改名和回收都必须使用明确的 CID/FID，并在 API 返回后复核。

## 目录结构

```text
src/
├─ chrome-extension/
│  ├─ shared/                 配置迁移、消息、DownloadIntent、番组身份与规则
│  ├─ content/
│  │  ├─ bootstrap.js         轻量 Adapter 分发与节流刷新
│  │  ├─ sites/               generic、javbus、nyaa-family、mikan
│  │  ├─ intent-factory.js    Adapter 结果 → DownloadIntent
│  │  └─ ui/                  统一确认、番组路由、任务池和反馈
│  ├─ background/
│  │  ├─ api/                 115 Cookie、HTTP、离线和文件 API
│  │  ├─ tasks/               持久任务、目录校验、番组绑定、监控
│  │  ├─ processors/          cleanup、generic、jav、anime
│  │  ├─ router.js            消息与意图提交入口
│  │  └─ service-worker.js    MV3 装配入口
│  ├─ ui/
│  │  ├─ popup/               登录、手工输入和后台任务页
│  │  └─ options/             站点档案、目录规则、日志
│  ├─ popup.html
│  ├─ options.html
│  └─ manifest.json
├─ README.md
└─ ...
scripts/
├─ build.py                   校验入口并复制到 dist/extension
├─ deploy.py                  查找 Chrome 并打开部署页
└─ clean.py                   清理构建产物
```

## 稳定的模块契约

### Adapter

实现 `matches(location)`、`extractPageMetadata()`、`discoverDownloads()`、`enhancePage()` 和 `getDefaultProcessorProfile()`。返回的数据交给 `intent-factory.js`，至少包含：

```js
{
  sourceSite, mediaType, url, title, code, metadata,
  savePathCid, processorProfile
}
```

`nyaa.js` 内部共享 Nyaa/Sukebei 列表核心，但两个站点仍有独立的匹配和配置。OpenBT 不设专用 Adapter，走 Generic。

### Confirmation 与 Queue

所有来源共用一个确认窗口：多行 Magnet/ED2K 会 trim、去空行、按完整链接和 BTIH 去重，并标记非法行。确认窗口可以覆盖站点默认的 `generic`、`jav`、`anime` 规则和保存目录。任务池默认并发 2，单项失败隔离，状态为 `waiting/submitting/success/failed/duplicate`。

### Processor

- `generic`：仅执行通用安全清理。
- `jav`：页面番号优先，最大主视频、字幕、任务目录按番号整理。
- `anime`：不调用 JAV rename；默认保留 torrent 名称。批量或 Mikan 番组归档只移动明确的视频/字幕，完成复核后回收空目录。

Mikan 的 `Home/Bangumi/<ID>` 绑定存储在 `push115_anime_library`，与日志和活动任务分开。移动计划先保存文件 ID，重启后可继续；冲突、未知文件和不一致的目录响应都保留源文件。

## 配置与权限迁移

`push115_site_profiles` 保存各站点的启用状态、默认规则、目录和页面控件；目录由共享的 `SAVE_PATH_LIST` 清单提供，站点卡片通过选择器引用，不再要求逐站手填 CID。旧 `savePathCid`、`processorProfile`、`enhancementMode` 和 Mikan `none` 在读取时迁移。

Generic 的 `<all_urls>` 是可选权限；预定义站点使用各自 host permission。动态注册分别使用 Generic/Site 运行模式，避免专用 Adapter 与通用监听器重复接管页面。

## 本地检查

```powershell
$env:HOME = $env:USERPROFILE
pixi run build
node --test tests/anime-routing.test.cjs
```

构建脚本会检查 Manifest V3、图标、popup/options、service worker 的 `importScripts`、HTML 资源和关键架构入口。版本号唯一来源是 `src/chrome-extension/manifest.json`；版本策略与交付前检查见仓库根目录的 [`AGENTS.md`](../AGENTS.md)。
