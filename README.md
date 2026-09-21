<p align="right">
  <a href="README_EN.md">🇬🇧 English</a>
</p>

<h1 align="center">
  <img src="src/chrome-extension/icons/logo.png" width="64" height="64" alt="logo"><br>
  115 离线助手
</h1>

<p align="center">
  <strong>把网页上的资源，变成有来源、有规则、可追踪的 115 离线任务。</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/manifest-v3-blue" alt="Manifest V3">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
  <img src="https://img.shields.io/badge/version-1.17.2-orange" alt="Version">
</p>

---

## 我们的做法

这个扩展不把所有网站都塞进一个巨大的 content script，也不把“JAV 整理”偷偷套到每一个下载上。它把一次下载拆成四个可以追踪的阶段：

```text
网页 / 手工输入
      ↓ 站点 Adapter 识别资源
DownloadIntent（来源、标题、番号、目录、规则）
      ↓ 统一确认窗口编辑与去重
限流任务池（默认并发 2）
      ↓ 115 离线 API
按 processorProfile 执行安全清理或整理
```

因此，站点只负责“看懂页面”，后台只负责“提交和处理”，最终采用哪种整理方式由确认窗口里的规则决定。关闭网页以后，持久化任务和后台监控仍然继续工作。

## 站点扩展是独立的

每个 Adapter 都实现 `matches`、页面元数据提取、下载发现和页面增强，并构造统一的 `DownloadIntent`。站点默认值只是推荐值，提交前随时可以改。

| 网站 | 页面增强 | 默认规则 | 适合的工作方式 |
|------|----------|----------|----------------|
| Generic | 在磁链或 ED2K 附近增加“发送到115” | `generic` | 任意网页、论坛、博客；不猜测媒体类型 |
| JavBus | 读取页面番号和磁链，增加内联按钮 | `jav` | 页面番号优先，下载后按番号整理 |
| South Plus | 线程页集中列出 ED2K、提取文件名番号并提供逐项发送/记录 | `jav` | 文件名番号优先；记录只写本地任务历史，不提交 115 |
| Nyaa | 列表行按钮、行选择框、全选和批量提交 | `anime` | 一次选多条资源，BTIH 去重，失败逐项显示 |
| Sukebei | 复用 Nyaa 的列表核心，但独立站点配置 | `generic` | 默认不把内容当作 JAV，确认时可改为 `jav` |
| Mikan | 番组资源表的单条、选中、全部推送 | `anime` | 以 `/Home/Bangumi/<ID>` 记住番组目标目录 |
| OpenBT | 不建立专用 Adapter，按 Generic 识别标准 Magnet/ED2K | `generic` | 不依赖猜测性的 DOM selector |

Mikan 当前支持 `mikan.congvps.icu`、`mikanani.me`、`mikanime.tv` 和镜像 `mikanani.kas.pub`；`mikanime.tv` 当前跳转至 `mikanani.me`，并保留 `mikan.tangbai.cc` 旧域名兼容。

列表网站的按钮只提交意图，不直接碰 115 API；Nyaa、Sukebei 和 Mikan 共用同一套确认窗口与任务池，South Plus 还可把识别到的 ED2K 和番号写入本地任务历史。动态追加的资源由节流后的 `MutationObserver` 刷新，避免重复注入和全页面高频扫描。

## 后处理规则有明确边界

后台不会再通过 hostname 猜规则，而是查找任务携带的 `processorProfile`：

| Processor | 会做什么 | 明确不会做什么 |
|-----------|----------|----------------|
| `generic` | 执行现有安全垃圾清理：明确的附属文件、满足条件的小广告视频等 | 不按番号重命名，不推断媒体类型 |
| `jav` | 安全清理；页面番号优先；最大主视频改为“番号.ext”；字幕跟随；任务目录改为番号 | 不会被 Mikan、Nyaa 或普通网页自动触发 |
| `anime` | 保留 torrent 的原始文件名和目录语义；批量或 Mikan 归档时，把明确的视频/字幕归到选定目录 | 不套用 JAV 重命名，不猜番名和集数 |

清理仍遵循保守原则：字幕扩展名默认保护，图片/NFO 清理默认关闭；移动、改名、回收目录前都以明确的 CID/FID 复核。遇到同名冲突、未知文件或目录状态不一致时保留源文件，等待后续重试。

South Plus 的 ED2K 任务会把链接中的原始文件名、大小和哈希连同提交前目录快照保存下来。下载完成后，只有在目标目录中找到唯一匹配的新文件时，`jav` profile 才会按明确的 FID 移动并整理这一文件（主视频目标名为 `番号.ext`）；单文件路径只处理这个 FID，不连带扫描或移动目录内其他文件。匹配不唯一、校验不符或目录读取失败时保留文件并等待后续复核，不扫描根目录或其他任务。

Mikan 还专门处理 115 常见的“包装目录名与里面的视频文件同名”情况：不依赖容易失败的远程改名，而是在番组目录下创建本任务专用的 `__push115_stage_*` 临时目录，先按明确 FID 暂存视频/字幕，确认原包装目录为空后回收，再把文件移回目标目录并回收临时目录。移动计划会记录临时 CID 和文件 ID，重试不会重复创建；目标目录里真正存在的同名文件仍视为冲突，不会覆盖。

`[NEST]` 等发布组前缀若来自 torrent 原始文件名，扩展不会自行添加或剥离；若旧版处理中曾把文件名改短，重试时会依据计划恢复原始文件名。对于“目录名仍是完整 `.mkv`、目录内文件却只剩 `[NEST]`”的旧状态，1.4.7 会把目录名作为待恢复的原名，仅处理这一明确文件，完成后清理空目录。

### Mikan 番组记忆

Mikan 的详情 URL 是稳定身份。例如打开 `/Home/Bangumi/2087`，第一次以 Anime 规则提交时，可以在确认窗口选择建立/复用番组目录、直接绑定当前目录，或只做一次普通 Anime 任务。绑定保存在独立的 `push115_anime_library` 中，不会因为清空日志而消失。

- 完结番：勾选多个资源后一次提交，完成后归档到同一个目标目录。
- 连载番：先提交前 8 集，之后在同一番组页提交新一集，会沿用相同 CID，不需要重新整理旧集。
- 已提交的 BTIH 默认标记为重复；需要时可在确认窗口取消跳过。
- 归档只移动明确识别的视频/字幕，保留原文件名；仅在确认源目录为空后回收多余文件夹，不做全库扫描。

## 一次确认，所有入口一致

网页内联按钮、Nyaa/Sukebei/Mikan 批量按钮、JavBus 和弹窗里的手工输入，都会进入同一个“下载任务”窗口：

1. 每行一个 Magnet 或 ED2K，自动 `trim`、去空行。
2. 完全相同链接和相同 BTIH 自动去重，非法行会单独标记，不会悄悄提交。
3. 显示来源网站、标题、保存目录和应用规则。
4. `generic`、`jav`、`anime` 都可选择；不合适的规则只给出提示，不锁死用户选择。
5. 批量提交显示 `waiting / submitting / success / failed / duplicate`，单项失败不会中断其他任务，并在结束时给出汇总。

## 安装与更新

### Chrome 应用商店（推荐）

直接从 Chrome 应用商店安装：

[<img src="https://fonts.gstatic.com/s/i/productlogos/chrome_store/v7/192px.svg" height="58" alt="前往 Chrome 应用商店">](https://chromewebstore.google.com/detail/115-offline-helper/blgnjjjbmjgilkiimglodjdebcdaidgl?hl=zh-CN&authuser=0)

### 从源码用 Pixi 构建与部署

需要 Windows、Chrome 和 [pixi](https://pixi.sh/)。在仓库根目录执行：

```powershell
Copy-Item config.example.toml config.toml
```

在 `config.toml` 的 `[browser] chrome` 中填写本机 `chrome.exe` 路径，然后执行：

```powershell
pixi install
pixi run deploy
```

`pixi run deploy` 会校验 Manifest V3、入口文件和本地资源，将源码复制到 `dist/extension`，随后打开扩展管理页。若 Chrome 已经运行而忽略启动参数，首次安装时在扩展页开启“开发者模式”，点击“加载已解压的扩展”，选择 `dist/extension`。

以后修改源码后再次执行 `pixi run deploy`，再点击扩展卡片上的“重新加载”；已打开且已获授权的 South Plus 线程会自动补注入，仍显示旧页面时再手动刷新。

### 手动安装

1. 前往 [Releases](https://github.com/gangz1o/115-offline-helper/releases/latest) 下载 `115-offline-helper_v*.zip` 并解压，或克隆仓库：

   ```bash
   git clone https://github.com/gangz1o/115-offline-helper.git
   ```

2. 打开 `chrome://extensions/`（Edge 使用 `edge://extensions/`），开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，源码方式先运行 `pixi run build`，选择 `dist/extension`。

## 第一次使用

1. 点击扩展图标，使用 115 手机客户端扫码登录。
2. 在设置页点击“扫描目录”建立 115 Directory Registry；默认只扫描根目录一级，选中管理根目录后可继续递归扫描。扫描有目录数、请求数和时长安全预算，达到预算时页面会明确标记结果可能不完整，可继续按子目录扫描。站点档案和确认窗口从索引选择目录；旧版的 `目录名:CID` 文本仍可作为高级 fallback，不需要为每个站点重复填写 CID。
3. 在“站点增强”中分别启用 Generic、JavBus、Nyaa、Sukebei、Mikan、South Plus，设置各自默认目录、默认规则、内联按钮和列表并发数。默认并发为 2，安全上限也是 2；115 文件读写共用 500ms 串行节流（不超过约 2 QPS），后台任务监控每轮最多轮询 2 项并按游标轮转。
4. 回到网页点击按钮或打开弹窗手工粘贴链接。确认窗口里的规则和目录可以覆盖网站默认值。若 South Plus 尚未授予持久网页权限，打开扩展弹窗会临时增强当前网页；要让新页面自动出现按钮，请在设置页保存并允许 South Plus 权限。重新加载扩展后，已打开且已获授权的 South Plus 线程也会自动补注入；若页面仍停留在旧文档，可手动刷新一次。
5. 在主页的后台任务页查看处理日志、刷新状态或重试失败项；South Plus 的“记录”按钮只保存本地链接、来源、文件名和番号，不会创建 115 云端任务。设置页提供“清空日志”，只清除历史记录，不取消进行中的任务，也不清除番组绑定和去重回执。若本地任务状态因目录失效而卡住，可使用“完全重置任务”：它会清除扩展本地任务、处理计划、番组绑定和去重回执，但不会取消 115 云端任务，也不会修改登录、目录或站点设置；Bridge 已领取任务、租约回执和事件 outbox 会保留，避免重置后重复提交。

### 本地自动任务 Bridge

扩展可选地连接本机 FastAPI 服务 `http://127.0.0.1:52115`，领取 Telegram `/av` 或 API 入队的资源候选，再通过现有后台 `Router.submitIntent` 提交到 115。1.16.0 新增受 Bearer 保护的 `GET /v1/av/search` 与 `POST /v1/av/enqueue`，后者默认选择第一个有效 Magnet 并复用活动任务；`/av` 的资源主搜索仍使用 Sukebei RSS，JavBus 负责元数据与磁力备用源；任一来源暂时不可用时，仍尽量返回另一来源的结果。目录 registry 即使超过 15 分钟仍会先显示缓存，同时静默排队后台刷新；115 `files` 读取失败时扩展会输出不含 Cookie 和文件名的结构诊断。此前版本的 Bridge 端口自动探测、目录 registry 并发修订、115 breadcrumb/分页兼容、Popup 双栏工作台、JavBus AJAX 兼容及固定 loopback 权限仍保持。Bridge 的 Intent 只接受严格的 BTIH Magnet 或 ED2K file 链接。

设置页现在只需在高级配置之外填写 Telegram Bot Token；Bridge 会用 `getMe` 校验并动态启动 polling。首次配置后，用户在机器人私聊中发送 `/start` 即自动成为 owner，无需 nonce 或认领链接；之后只允许该 owner 使用 `/av`、`/anime`、`/add`、`/jobs`、`/dir`，更换 token 会清除旧 owner 并要求新 token 的首次 `/start`。目录扫描结果会以非敏感的 `schema/revision/path/CID` 快照及站点默认规则自动同步到 Bridge SQLite：JavBus 默认应选择 AV CID，Anime 站点默认应选择番剧 CID；Telegram 候选会使用对应站点的 CID 与 processor，而 `/dir` 中“使用当前目录”优先覆盖它。目录索引中的“加入”只加入扩展本地保存目录列表，不会创建目录或立即下载。Telegram `/dir` 动态读取最新快照并按目录树分页浏览；已有缓存过期时会先显示缓存并在后台刷新，Bridge 尚未收到任何快照时才提示先同步目录，旧版 `PUSH115_TELEGRAM_SAVE_PATHS` 仍可作为兼容 fallback。后台每 30 秒领取一次任务，先持久化 `jobId`、租约和提交状态，再提交带有明确 `processorProfile` 和 `metadata.monitorDownload: true` 的意图；任务进度与完成/失败状态通过稳定的事件 ID 回传。网络中断、扩展重启或本地保存失败后无法确认提交结果时会标记为 `uncertain` 并停止自动重投，需人工处理；本地 `recorded` 历史记录不会被当作完成。Telegram 支持 `/dir` 选择动态目录、`/add <Magnet|ED2K>` 直接入队和 `/jobs` 查看任务；详情页可对失败任务重试、对进行中任务取消。取消进行中任务只停止扩展本地任务和监控，不取消 115 云端离线任务；排队中的任务可以直接终止。Bridge 的 `/av` 使用 Sukebei RSS 搜索番号资源，并以 JavBus 作为元数据与磁力备用源；现有 `/anime 关键词` 保持 Nyaa RSS 搜索。高级环境变量见 [`src/fastapi-bridge/README.md`](src/fastapi-bridge/README.md)。

在仓库根目录使用 Pixi 启动 Bridge：

```powershell
pixi install
pixi run start
```

#### Telegram 机器人首次配置

1. 在 Telegram 私聊 `@BotFather`，发送 `/newbot`，按提示填写机器人名称和用户名，复制返回的 HTTP API Token。Token 是秘密凭据，不要发到群组、截图或提交到 Git。
2. 打开扩展设置页，在“本地自动任务 Bridge”中点击“连接本机 Bridge”；首次操作时允许 `http://127.0.0.1/*` 可选权限。连接凭据会由 Bridge 持久保存并自动复用，不需要输入配对码。
3. 在同一设置页的“Telegram Bot”区域粘贴 Bot Token，点击“连接 Telegram”。Bridge 会调用 `getMe` 校验 Token，成功后动态启动 polling，并显示机器人用户名。
4. 在机器人私聊中发送 **/start**；首次发送者会自动绑定为管理员，看到“已绑定为管理员”后再使用机器人命令。
5. 保持 115 登录、Chrome 扩展启用和 Bridge 终端运行。在扩展设置页点击“扫描目录”，等待目录同步完成，再在机器人中发送 `/dir` 选择默认保存目录。

浏览器扩展重新安装或丢失本地凭据时，保持已有 Bridge 运行并回到设置页再次点击“连接本机 Bridge”即可恢复；不要同时启动两个 Bridge 实例。更换 Bot Token 会清除旧管理员，使用新 Bot 私聊发送 `/start` 即可重新绑定。高级用户仍可使用 `.env.example` 覆盖 provider、数据库和超时配置。

#### Telegram 机器人命令

| 命令 | 用途 |
|------|------|
| `/av ABC-123` | 使用 Sukebei RSS 搜索番号资源，JavBus 提供元数据/备用磁力，点击候选按钮后入队 |
| `/anime One Piece` | 使用 Nyaa RSS 查询关键词，点击 Magnet 候选按钮后入队 |
| `/dir` 或 `/path` | 浏览目录树并选择当前保存目录 |
| `/add <Magnet 或 ED2K>` | 将明确的 Magnet/ED2K 链接直接入队 |
| `/jobs` | 查看当前 Telegram 账号创建的任务；详情可重试失败任务或取消活动任务 |

本机自动化可使用带 Bearer token 的 `GET /v1/av/search?code=ABF-386` 查询候选，或以
`{"schema":1,"code":"ABF-386","candidateIndex":0}` 调用 `POST /v1/av/enqueue`；入队后由已连接的扩展自动领取。

先用 `/dir` 选择目录，再使用 `/av`、`/anime` 或 `/add`。查询结果中的按钮只对原账号、原消息在有效期内有效，转发或重复点击不会重复入队。Telegram 只负责查询和入队，实际提交 115 由 Chrome 扩展完成；取消进行中的任务只停止本地监控，不会取消已经提交到 115 的云端离线任务。

若机器人无响应，请在设置页点击“刷新状态”，确认 Bot 已配置、polling 已启动且管理员已认领；若 `/dir` 提示没有目录，请保持 115 登录并重新扫描目录。若扩展提示 Bridge 不可达，确认 `pixi run start` 的终端仍在运行且本机 `52115` 端口未被其他程序占用。若 Bot Token 泄露，请在 `@BotFather` 撤销并换发，再回设置页重新连接。

状态、数据库和 token 默认保存在 `src/fastapi-bridge/.state`；测试使用 `pixi run test`。

### 权限说明

预定义站点使用对应的可选 host permission；Generic 的全网页识别为可选的 `<all_urls>` 权限。打开扩展弹窗时，`activeTab` 只对当前 HTTP(S) 页面提供一次性增强作为兜底。权限关闭时，扩展仍可使用已授权的站点增强和手工输入。OpenBT 没有独立权限和 profile，启用 Generic 后按普通网页处理。

## 常见问题

**为什么 Anime 下载后文件名没有改成番名？**

这是有意的安全边界。Anime 默认保留 torrent 名称，批量/Mikan 归档只负责把视频和字幕放到同一目标目录；这样不会因猜错番名或集数破坏 STRM/刮削结构。

**为什么 JavBus 会自动整理，而 Sukebei 不会？**

JavBus 的默认 profile 是 `jav`，并且页面番号优先；Sukebei 默认是 `generic`，因为它的内容并不必然是 JAV。两者都能在确认窗口改成其他规则。

**如何获取目录 CID？**

优先在设置页保持 115 登录状态并点击“扫描目录”，再从索引中加入目标目录或扫描子目录。只有扫描不可用时，才从网页版 115 的目录地址或目录列表取得 CID，按 `目录名:CID` 手工加入；站点卡片只从共享清单选择，不再逐站手填。

**提示未登录或自动检测不生效？**

重新扫码登录；若要在任意网页显示按钮，请在设置中启用 Generic 并允许浏览器请求的可选网页权限。

## 开发命令

```powershell
pixi install
pixi run build    # 校验并生成 dist/extension
pixi run deploy   # 构建并打开 Chrome 扩展管理页
pixi run clean    # 清理构建产物
node --test tests/*.test.cjs
```

源码结构和模块契约见 [`src/README.md`](src/README.md) 与 [`src/chrome-extension/README.md`](src/chrome-extension/README.md)。版本规则和协作约束见 [`AGENTS.md`](AGENTS.md)。

## 隐私与许可

- 数据通过 `chrome.storage.local` 保存在本地。
- 不做遥测、广告或用户画像，也不会把 115 Cookie 上传给 Bridge 或 Telegram；若主动启用 Telegram，所选资源和任务状态只会发送给完成认领的 Telegram owner。
- 默认仅与 `*.115.com` 通信；启用本地 Bridge 后，另与固定的 `127.0.0.1:52115` 通信。
- [完整隐私政策](https://gangz1o.github.io/115-offline-helper/privacy-policy.html)

[MIT License](LICENSE)
