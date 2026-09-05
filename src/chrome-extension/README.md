# 扩展源码：页面适配与后台整理

这里是扩展的运行地图，不是打包产物说明。`pixi run build` 会先校验入口，再把本目录复制到 `dist/extension/`；Chrome 永远应该加载后者。

## 运行链路

```text
页面 / popup 手工输入
        ↓
Site Adapter（只理解页面）
        ↓
DownloadIntent（来源 + 目录 + processorProfile）
        ↓
统一 Download Confirmation
        ↓
Submission Queue（默认并发 2）
        ↓
background API / 持久任务
        ↓
processorRegistry[task.processorProfile]
```

Adapter 不调用 115 API，Processor 不从 hostname 推断规则。这样同一个 Magnet 可以在确认时从网站推荐的规则切换到另一种规则，后台仍走同一条安全路径。

## 目录与职责

```text
chrome-extension/
├─ shared/
│  ├─ config.js / messages.js       配置、迁移和消息常量
│  ├─ intent.js                     DownloadIntent 规范
│  ├─ anime-series.js               Mikan 番组 URL 身份与安全目录名
│  └─ ...                           清理、链接、路径等通用规则
├─ content/
│  ├─ bootstrap.js                  轻量分发、节流 MutationObserver
│  ├─ runtime-generic.js            动态注册的 Generic 模式标记
│  ├─ runtime-sites.js              动态注册的专用站点模式标记
│  ├─ intent-factory.js             Adapter 结果 → DownloadIntent[]
│  ├─ sites/
│  │  ├─ generic.js                 Magnet/ED2K 通用增强
│  │  ├─ javbus.js                  番号、磁链和内联按钮
│  │  ├─ nyaa.js                    Nyaa/Sukebei family core
│  │  └─ mikan.js                   番组资源表和批量操作
│  └─ ui/
│     ├─ download-confirmation.js   多行校验、去重、规则/目录覆盖
│     ├─ anime-routing.js            番组目录建立、绑定和复用
│     ├─ submission-queue.js         限流、失败隔离、批次汇总
│     └─ batch-progress.js           waiting/submitting/success/failed/duplicate
├─ background/
│  ├─ api/                           Cookie、HTTP、离线和文件 API
│  ├─ tasks/
│  │  ├─ store.js                    持久任务与日志生命周期
│  │  ├─ folders.js                  目录分页、CID/FID 路径校验
│  │  ├─ anime-library.js            番组 → CID 绑定与重复提交回执
│  │  └─ monitor.js                  下载完成检测与 Processor 调度
│  ├─ processors/
│  │  ├─ cleanup.js                  安全垃圾判断
│  │  ├─ generic.js                  通用 profile
│  │  ├─ jav.js                      既有 JAV 整理
│  │  └─ anime.js                    保留原名的 Anime 归档
│  ├─ content-scripts.js              按权限动态注册内容脚本
│  ├─ router.js                       消息与意图提交入口
│  └─ service-worker.js               MV3 service worker 装配
├─ ui/
│  ├─ popup/                          登录、手工输入、任务页
│  └─ options/                        站点档案、目录、规则和日志
├─ popup.html
├─ options.html
└─ manifest.json
```

## Adapter 矩阵

| Adapter | 稳定识别点 | 默认 profile | 备注 |
|---------|------------|--------------|------|
| Generic | 标准 `magnet:` / `ed2k://` href | `generic` | 不推断媒体类型；OpenBT 也走这里 |
| JavBus | `#magnet-table`、`.magnet-name`、页面 URL 末段番号 | `jav` | URL 番号优先，按钮可重复刷新而不重复注入 |
| Nyaa family | `table.torrent-list > tbody > tr`、行标题和 Magnet 操作区 | Nyaa=`anime`，Sukebei=`generic` | 共用 DOM 核心，站点匹配与配置独立 |
| Mikan | `p.bangumi-title`、`table.table.table-striped.tbl-border`、`.js-episode-select[data-magnet]` | `anime` | 详情页 ID 用于番组记忆 |

页面增强只追加自己的 `data-push115-*` 标记，并通过节流后的 MutationObserver 处理动态行。翻页或 SPA 更新时先判断已有标记，避免按钮和选择框重复出现。

## DownloadIntent 与确认窗口

`intent-factory.js` 统一补齐以下字段：

```js
{
  sourceSite,       // generic / javbus / nyaa / sukebei / mikan
  mediaType,        // generic / jav / anime
  url, title, code,
  metadata,          // 页面、番组、批次等可追踪信息
  savePathCid,
  processorProfile  // generic / jav / anime；最终决策字段
}
```

页面单发、列表批量、Mikan 番组提交和 popup 手工输入全部进入同一个确认窗口。窗口会 trim、去空行、按 BTIH 与完整链接去重，显示非法行，并允许用户覆盖站点默认 profile 与目录。Queue 默认并发 2（安全上限也是 2），每项独立显示 `waiting`、`submitting`、`success`、`failed` 或 `duplicate`；后台 115 文件变更再由 FilesApi 串行限速。

## Processor 边界

### `generic`

只执行现有通用安全清理：明确垃圾扩展名、小广告视频等仍需通过主视频、分片、时长和关键词判断。字幕默认保护，图片/NFO 清理必须显式开启。

### `jav`

`background/processors/jav.js` 保留原有算法：页面番号优先，选择最大主视频改为 `番号.ext`，字幕跟随，任务目录改为番号；所有移动和回收都用明确文件 ID/CID 并复核。只有任务的 `processorProfile === 'jav'` 才能进入这里。

### `anime`

普通 Anime 任务保留 torrent 原始名称和目录，不调用 JAV rename。批量确认或 Mikan 番组绑定时，处理器只收集明确的视频/字幕文件，把它们移到同一个目标 CID；若 115 包装目录与视频文件同名，会在目标目录创建可恢复的 `__push115_stage_*` 临时目录，按明确 FID 暂存文件、回收确认为空的包装目录，再把文件移回并回收临时目录。计划同时保存临时 CID、FID 和原始文件名；旧版本若留下短文件名，会在临时目录内恢复计划中的原名。`[NEST]` 等发布组前缀只有在原始 torrent 名中存在时才会保留，扩展不会自行添加。service worker 重启后可续跑，目标可见性和源目录为空均会复核。未知文件、同名冲突或 115 返回不一致时保留源文件，不做全库扫描和强制番名/集数猜测。

Mikan 绑定使用 `push115_anime_library`：`mikan:<BangumiID>` 对应目标 CID 与模式。完结番可以一次整合，连载番先提交前 8 集、之后补集仍会复用同一目录；清空日志只清历史记录，不清绑定和 BTIH 去重回执。设置页的“完全重置任务”是单独的本地运行时清理：会清空任务、处理计划、番组绑定和去重回执，并使重置前的监控/提交对象无法重新写回；不会调用 115 删除接口。

## 页面结构核对记录（2026-09-05）

- **Mikan**：Chrome 实际打开 `https://mikan.tangbai.cc/Home/Bangumi/2087`。番组名为 `p.bangumi-title`，资源表为 `table.table.table-striped.tbl-border`；每行的原生勾选框为 `.js-episode-select[data-magnet]`，资源名在 `.magnet-link-wrap`，复制磁链使用 `.js-magnet`。页面服务端渲染，“显示更多”追加行时由观察器节流刷新。
- **Nyaa/Sukebei**：两站采用同一列表模板，Adapter 以 `table.torrent-list > tbody > tr` 为行边界，第二个单元格的 `/view/` 链接为标题，Magnet 优先读取操作单元格的 `a[href^="magnet:"]` 并保留行内兜底。翻页通常重新加载文档。
- **JavBus**：保留现有 `#magnet-table`、`.magnet-name` 和 Magnet href；番号先取 URL 最后一个路径段，再退回标题/信息区。
- **OpenBT**：无专用 Adapter 和 Site Profile；只按 Generic 查找标准 Magnet/ED2K，不针对被 Cloudflare 拦截的页面臆造 selector。

## 配置、权限与兼容

`push115_site_profiles` 为 Generic、JavBus、Nyaa、Sukebei、Mikan 保存 `enabled`、默认目录、默认 profile 和页面控件；目录从设置页共享的离线目录清单选择。旧版 `savePathCid`、`processorProfile`、`enhancementMode` 以及 Mikan `none` 会在读取时迁移。动态注册将 Generic 与专用站点分成两种 runtime，保留 optional `<all_urls>` 与已有 host permission 逻辑。

稳定的登录、Cookie、115 离线 API、持久任务、日志清理判断均保持原实现；新增逻辑通过消息和 profile 接入。

## 开发与验证

```powershell
$env:HOME = $env:USERPROFILE
pixi run build
node --test tests/*.test.cjs
```

`scripts/build.py` 会校验 Manifest V3、图标、HTML、本地资源、service worker 的 `importScripts` 和关键入口文件。不要直接编辑 `dist/extension/`。
