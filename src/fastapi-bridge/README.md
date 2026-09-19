# 本地 Bridge

`bridge` 是一个只绑定 `127.0.0.1:52115` 的 FastAPI 服务。Telegram 负责查询
JavBus 或 Nyaa RSS 并把用户选择写入 SQLite 队列，Chrome 扩展定期领取任务并使用浏览器中已有
的 115 登录态提交。Bridge 从不接收或保存 115 Cookie。

Bridge Intent 只接受严格的 BTIH Magnet 或 ED2K file 链接。扩展设置中的 Bridge 默认 CID
只在任务没有提供 `savePathCid` 时使用；任务自带的 CID 始终优先。

## Windows 启动

在仓库根目录 PowerShell 中安装 Pixi 环境。普通用户不需要复制 `.env`：

```powershell
pixi install
pixi run bridge-start
```

Bridge 首次启动会在终端打印 5 分钟内有效的一次性 Crockford 配对码。打开扩展设置页，检查本地 Bridge 并输入配对码；Bearer token 会自动保存到扩展本地。浏览器重装后可用 `pixi run bridge-pair` 显式打开新的配对窗口。Telegram Bot Token 在扩展设置页填写，Bridge 会用 `getMe` 校验并动态启动 polling。

`.env.example` 仅供高级配置使用。环境变量仍可覆盖 provider、数据库、超时、静态目录 fallback 等选项，例如：

```powershell
$env:PUSH115_JAVBUS_TIMEOUT_SECONDS = '20'
$env:PUSH115_TELEGRAM_TOKEN_FILE = '.state/telegram_bot.token'
$env:PUSH115_TELEGRAM_SAVE_PATHS = '123=影视,456=动漫'
```

`chrome-extension://[a-p]{32}` origin 会由 Bridge 自动允许，Bearer 仍是唯一的 `/v1` 鉴权。`.env` 含有本地凭据时请保留在本机私有目录，不要提交；`.env.example` 不需要在普通安装流程中复制。

Bearer token 会保存到 `src/fastapi-bridge/.state/bearer.token`；Telegram Bot Token 会保存到同目录的 `telegram_bot.token`。正常服务日志和运行时状态接口不会打印或返回这些 token。
Windows 文件访问权限取决于当前用户和目录 ACL，请将整个 `src/fastapi-bridge/.state` 保留在
本机私有目录，不要提交到仓库。

运行测试使用根 Pixi 环境：

```powershell
pixi run bridge-test
```

## HTTP 契约

无需 Bearer 的引导接口：

```text
GET  /bootstrap/status
POST /bootstrap/pair  {"schema":1,"pairingCode":"K7MP-4Q2D","clientId":"..."}
```

配对码单次使用，有效期 5 分钟，最多允许 5 次失败。成功响应包含一次性的
`bearerToken`；之后所有 `/v1/*` 请求仍必须使用 `Authorization: Bearer ...`。
配对完成后，只有显式运行 `pixi run bridge-pair` 才会重新打开配对窗口。
`GET /v1/runtime/telegram` 返回 `enabled`、`configured`、`botUsername`、`ownerBound`
和管理员认领链接（不返回 token）；`PUT /v1/runtime/telegram` 接收 `enabled` 与可选
`botToken`，会校验 `getMe` 后动态停止、启动或重启 polling。

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

Bridge 默认没有 Telegram 配置。扩展设置页填写 Bot Token 后，Bridge 会校验并动态启动 polling；
不再要求普通用户填写 chat/user allowlist。配置成功后，设置页会显示
`https://t.me/<bot>?start=claim_<nonce>` 管理员认领链接；Telegram `/start` 成功后只允许该
chat/user 使用命令。更换 Bot Token 会清除旧 owner 并要求重新认领。旧的
`PUSH115_TELEGRAM_POLLING`、allowlist 和静态目录变量仍作为高级/兼容 fallback 保留。
静态目录表 `PUSH115_TELEGRAM_SAVE_PATHS=CID=显示名,...` 仅作为浏览器尚未同步 registry 时的兼容 fallback。
Bridge 不查询 115 目录，也不接收或保存 115 Cookie。
Chrome 扩展扫描目录后，会把非敏感的路径、CID 和 revision 通过 `PUT /v1/runtime/directories`
保存到 SQLite；Telegram 每次 `/dir`、`/add` 或候选确认都会读取最新快照，无需重启 Bridge。
`/dir` 使用 CID/parentCid 构成的分页目录树，每页最多展示少量子目录按钮，避免把整个 registry 一次性展开成超大的 Telegram keyboard。
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
