# 本地 Bridge

`bridge` 是一个只绑定 `127.0.0.1:52115` 的 FastAPI 服务。Telegram 负责查询
JavBus 或 Nyaa RSS 并把用户选择写入 SQLite 队列，Chrome 扩展定期领取任务并使用浏览器中已有
的 115 登录态提交。Bridge 从不接收或保存 115 Cookie。

Bridge Intent 只接受严格的 BTIH Magnet 或 ED2K file 链接。扩展设置中的 Bridge 默认 CID
只在任务没有提供 `savePathCid` 时使用；任务自带的 CID 始终优先。

## Windows 启动

在仓库根目录 PowerShell 中安装 Pixi 环境，并复制 Bridge 配置示例：

```powershell
pixi install
Copy-Item src\fastapi-bridge\.env.example src\fastapi-bridge\.env
```

再按实际环境修改 `src\fastapi-bridge\.env` 中的 `PUSH115_BRIDGE_CORS_ORIGINS`、Telegram token
和 allowlist。启用 Telegram polling 时只要求 Bot token 和非空 chat allowlist；
`PUSH115_TELEGRAM_SAVE_PATHS` 现在是浏览器 Directory Registry 尚未同步时的可选兼容 fallback。
目录表使用 `CID=显示名,...` 格式，例如 `123=影视,456=动漫`；Bridge 不查询 115 目录，也不接收 115 Cookie。服务启动时会读取这个简单的 `KEY=VALUE` 文件；同名环境变量优先，
也可以只在当前 PowerShell 会话中覆盖需要的值，例如：

```powershell
$env:PUSH115_BRIDGE_CORS_ORIGINS = 'chrome-extension://<扩展ID>'
$env:PUSH115_TELEGRAM_BOT_TOKEN = '123456:replace-me'
$env:PUSH115_TELEGRAM_ALLOWED_CHAT_IDS = '123456789'
$env:PUSH115_TELEGRAM_ALLOWED_USER_IDS = '123456789'
$env:PUSH115_TELEGRAM_SAVE_PATHS = '123=影视,456=动漫'
$env:PUSH115_TELEGRAM_POLLING = '1'
```

扩展 ID 可在 `chrome://extensions` 的扩展卡片中查看；只允许写入自己安装的
扩展 origin。`.env` 含有本地凭据，已加入 Git 忽略规则，不要提交；
`.env.example` 仅供复制参考。

首次启动前，用显式命令取得随机 Bearer token，并把输出填入扩展选项页：

```powershell
pixi run bridge-token
pixi run bridge-start
```

Token 会保存到 `src/fastapi-bridge/.state/bearer.token`；正常服务日志不会打印它。
Windows 文件访问权限取决于当前用户和目录 ACL，请将整个 `src/fastapi-bridge/.state` 保留在
本机私有目录，不要提交到仓库。

运行测试使用根 Pixi 环境：

```powershell
pixi run bridge-test
```

## HTTP 契约

所有 `/v1/*` 路由都需要 `Authorization: Bearer <token>`。Intent 的 `url` 必须是严格的
BTIH Magnet 或 ED2K file 链接。主要路由如下：

| 路由 | 用途 |
|------|------|
| `GET /v1/runtime/directories` | 读取当前浏览器同步的目录 registry |
| `PUT /v1/runtime/directories` | 以 revision 幂等更新目录 registry |
| `GET /v1/jobs?status=...&limit=...&cursor=...` | 按状态和游标分页查看任务 |
| `GET /v1/jobs/{jobId}` | 查看单个任务及待处理动作 |
| `POST /v1/jobs/{jobId}/retry` | 对失败任务创建一次幂等重试 |
| `POST /v1/jobs/{jobId}/cancel` | 取消排队任务，或为活动任务创建取消动作 |
| `POST /v1/jobs/claim` | 扩展按 worker 领取任务 |
| `POST /v1/jobs/{jobId}/events` | 扩展回传任务进度和终态 |
| `POST /v1/actions/claim` | 扩展按同一 worker 领取取消动作 |
| `POST /v1/actions/{actionId}/events` | 回传动作结果；`eventId` 幂等 |

扩展使用的领取请求为：

```http
POST /v1/jobs/claim
Content-Type: application/json

{"schema":1,"workerId":"extension-runtime-id","leaseSeconds":120}
```

响应为 `{"schema":1,"job":null}`，或带有 `jobId`、`leaseId`、`status`、`recovered`、
`attemptCount`、`taskId`、`remoteId` 和固定下载意图的任务。`recovered=true` 表示
这是过期租约的同一 worker 恢复；扩展在本地任务无法核对时必须标记 `uncertain`，
不得再次提交 115。
任务事件使用：

```http
POST /v1/jobs/{jobId}/events
Content-Type: application/json

{"schema":1,"leaseId":"...","eventId":"...","state":"accepted",
 "taskId":"...","remoteId":"..."}
```

任务事件按 `eventId` 幂等，租约绑定 worker，`completed`、`failed`、`uncertain` 为终态。
`uncertain` 不会重新入队；过期任务也不会交给另一个 worker 自动重投，以免重复提交
115。取消动作也使用 worker 租约，只有原 worker 可以领取或恢复，动作事件按 `eventId`
幂等。排队任务的取消会直接终止；进行中任务的取消只让扩展停止本地任务和监控，不会取消
115 云端离线任务。`GET /healthz` 只报告本地进程是否可响应。

## Telegram

启用 `PUSH115_TELEGRAM_POLLING=1` 时必须设置 Bot token 和非空 chat allowlist；静态目录表
`PUSH115_TELEGRAM_SAVE_PATHS=CID=显示名,...` 仅作为浏览器尚未同步 registry 时的兼容 fallback。
可选的 user allowlist 会进一步限制发送者。Bridge 不查询 115 目录，也不接收或保存 115 Cookie。
Chrome 扩展扫描目录后，会把非敏感的路径、CID 和 revision 通过 `PUT /v1/runtime/directories`
保存到 SQLite；Telegram 每次 `/dir`、`/add` 或候选确认都会读取最新快照，无需重启 Bridge。
没有快照且没有静态 fallback 时，`/dir` 会提示打开扩展并同步目录。目录选择按
chat 和 user 记忆；候选按钮点击时使用该用户最新选择的目录。`/add <Magnet|ED2K>`
直接加入队列，`/jobs` 查看自己的任务列表，进入详情后可重试失败任务或取消活动任务。

查询结果使用 JavBus 页面封面（若可用）和每个候选的一次性 opaque token 按钮；token 绑定
chat、user、消息和 TTL，重复点击、转发到其他聊天或未授权用户都不会入队。任务状态通过
编辑同一条状态消息反馈。

`/anime 关键词` 使用 Nyaa RSS 搜索，返回每个 Magnet 的一次性按钮；入队意图固定为
`sourceSite=nyaa`、`mediaType=anime`、`processorProfile=anime`，`code` 为空，元数据包含
原始标题、provider、BTIH 和 Nyaa detail URL。Nyaa 只读取配置的 HTTPS RSS 来源，按 BTIH 去重，
并限制响应大小和结果数量；不做 HTML fallback、Torznab、翻页或订阅。Telegram polling 关闭或
Bot token 未配置时，不会发起 Nyaa 请求。本版本保留现有 Nyaa RSS 能力，没有新增 RSS、订阅
或自动搜索功能。

JavBus 仅允许配置的 HTTPS 主机，最多跟随两次同源重定向，并限制响应大小。页面中
由 `gid`/`uc` 脚本参数加载的 `ajax/uncledatoolsbyajax.php` 磁链也会按同源规则解析；
不会绕过验证码、挑战页或其他反爬措施。

Nyaa RSS 的 `PUSH115_NYAA_BASE_URL`、`PUSH115_NYAA_ALLOWED_HOSTS`、超时、响应大小和结果上限
见 `.env.example`；allowlist 必须包含实际使用的 HTTPS 主机。

测试请注入 mock Telegram transport 和 provider；部署说明不代表已使用真实 Bot、
JavBus 或 115 账号联调。
