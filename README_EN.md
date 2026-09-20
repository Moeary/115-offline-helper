<p align="right">
  <a href="README.md">🇨🇳 中文</a>
</p>

<h1 align="center">
  <img src="src/chrome-extension/icons/logo.png" width="64" height="64" alt="logo"><br>
  115 Offline Helper
</h1>

<p align="center">
  <strong>Turn web resources into traceable 115 offline tasks with explicit rules.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/manifest-v3-blue" alt="Manifest V3">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
<img src="https://img.shields.io/badge/version-1.14.0-orange" alt="Version">
</p>

---

## What makes this build different

The extension does not put every website into one giant content script, and it never silently applies JAV renaming to unrelated downloads. Every submission follows the same pipeline:

```text
page / manual input
      ↓ site adapter
DownloadIntent (source, title, code, folder, profile)
      ↓ one confirmation dialog
bounded queue (default concurrency: 2)
      ↓ 115 offline API
processorProfile-driven cleanup or organization
```

Adapters understand pages, the background worker owns API calls and persistent tasks, and the selected `processorProfile` is the only source of post-processing behavior. Closing the source tab does not stop a task.

## Site adapters

| Site | Enhancement | Default profile | Intended use |
|------|-------------|-----------------|--------------|
| Generic | “Send to 115” beside Magnet/ED2K links | `generic` | Any authorized page; no media guessing |
| JavBus | Page-number-aware Magnet buttons | `jav` | Code-first JAV organization |
| South Plus | Thread ED2K discovery in a dedicated list, filename code extraction, per-item send and record actions | `jav` | Filename code first; record writes local history only |
| Nyaa | Row buttons, checkboxes, select-all and batch submission | `anime` | Multi-select torrents with BTIH deduplication |
| Sukebei | Same list core as Nyaa, separate site profile | `generic` | Safe default; change to `jav` only when appropriate |
| Mikan | Per-resource, selected and all-resource actions | `anime` | Remember a destination for `/Home/Bangumi/<ID>` |
| OpenBT | Generic fallback; no special adapter/profile | `generic` | No speculative DOM coupling |

Mikan currently supports `mikan.congvps.icu`, `mikanani.me`, `mikanime.tv` and the mirror `mikanani.kas.pub`; `mikanime.tv` currently redirects to `mikanani.me`, and the legacy `mikan.tangbai.cc` hostname remains compatible.

Nyaa, Sukebei and Mikan share one confirmation dialog and one rate-limited queue; South Plus can additionally save discovered ED2K links and codes to local task history. A throttled `MutationObserver` handles appended rows without repeatedly injecting controls.

## Post-processing profiles

| Profile | Behavior | Guardrail |
|---------|----------|-----------|
| `generic` | Existing conservative junk cleanup | Never renames by code |
| `jav` | Safe cleanup; page code first; largest main video → `CODE.ext`; subtitles follow; task folder → code | Triggered only by this explicit profile |
| `anime` | Keeps torrent names and directory semantics; batch/Mikan archive moves identified video/subtitle files into the chosen destination | No JAV rename and no guessed show/episode names |

Subtitle extensions are protected by default, image/NFO cleanup is opt-in, and every remote move/rename/recycle is verified with explicit CID/FID values. Unknown files, collisions and inconsistent directory responses stay in place for a later retry.

South Plus ED2K tasks persist the original filename, size and hash from the link together with a pre-submit directory snapshot. After the download finishes, the `jav` profile acts on one explicit FID only when exactly one new file matches (`CODE.ext` when that file is the main video); the single-file path never scans or moves other files in the directory. Ambiguous matches, identity mismatches or directory read failures keep the file in place for a later verification instead of scanning the root or other tasks.

Mikan also handles a common 115 layout where the wrapper folder has exactly the same name as its video. Instead of relying on a rename that may be rejected, the processor creates a task-specific `__push115_stage_*` folder inside the destination, stages the explicit file IDs there, verifies and recycles the empty wrapper, then moves files back and recycles the staging folder. The plan persists the staging CID and file IDs so retries do not recreate it. A real same-name file already in the destination remains a collision and is never overwritten.

Release-group prefixes such as `[NEST]` are preserved only when they belong to the torrent's original filename; the extension never invents or strips them. If an older run shortened a filename, retry restores the original name recorded in the plan. Version 1.4.7 also recovers the screenshot-era shape where a wrapper directory still has the full `.mkv` name but its only file was shortened to `[NEST]`, using only that explicit file ID and then removing the empty wrapper.

### Mikan series memory

The numeric ID in `/Home/Bangumi/<ID>` is the series identity. On the first Anime submission, the confirmation dialog can create/reuse a series folder, bind the current folder, or perform a one-time plain Anime submission. The binding is stored separately in `push115_anime_library`, so clearing logs does not remove it.

- Finished shows can be selected and archived together.
- For an ongoing show, submit episodes 1–8 first; later episodes such as EP09 reuse the same CID.
- Submitted BTIH values are marked as duplicates by default and can be resubmitted explicitly.
- Only known video/subtitle files are moved; verified-empty wrapper folders are recycled, while unknown or conflicting sources are retained.

## One confirmation flow for every source

Inline buttons, Nyaa/Sukebei/Mikan batches, JavBus, and popup input all open the same dialog:

1. One Magnet or ED2K per line; trim whitespace and ignore blank lines.
2. Deduplicate exact links and BTIH values; mark invalid lines instead of submitting them silently.
3. Show source site, title, save directory and selected profile.
4. Allow `generic`, `jav` or `anime` regardless of the site's recommendation; show a warning when a choice is unusual but do not lock it.
5. Report `waiting`, `submitting`, `success`, `failed` and `duplicate` per item. One failure never aborts the rest of a batch.

## Installation

### Chrome Web Store

[<img src="https://storage.googleapis.com/web-dev-uploads/image/WlD8wC6g8khYWPJUsQceQkhXSlv1/iNEddTyWiMfLSwFD6qGq.png" height="58" alt="Available in the Chrome Web Store">](https://chromewebstore.google.com/detail/115-offline-helper/blgnjjjbmjgilkiimglodjdebcdaidgl?hl=zh-CN&authuser=0)

### Build from source with Pixi

Install [pixi](https://pixi.sh/) and Chrome on Windows:

```powershell
Copy-Item config.example.toml config.toml
pixi install
pixi run deploy
```

Set the local Chrome path in `[browser] chrome`. Deploy validates the MV3 entry points, copies the extension to `dist/extension`, and opens the extensions page. If Chrome is already running, enable Developer mode and load `dist/extension` once, then use **Reload** after subsequent builds; authorized South Plus threads already open are repaired automatically, with a manual refresh as a fallback.

### Manual install

Download the latest archive from [Releases](https://github.com/gangz1o/115-offline-helper/releases/latest), or clone the repository. Open `chrome://extensions/` (or `edge://extensions/`), enable Developer mode, and choose **Load unpacked** after running `pixi run build`.

## First run

1. Scan the QR code with the 115 mobile client.
2. Click **Scan directories** in Settings to build the shared 115 Directory Registry. The default scan only reads the root level; selected management roots can then be scanned recursively. Scans enforce directory, request and duration safety budgets and mark a result as potentially incomplete when a budget is reached, so the selected subtree can be scanned again explicitly. Site profiles and the confirmation dialog select from this index; legacy `Name:CID` entries remain available as an advanced fallback.
3. Enable and configure Generic, JavBus, Nyaa, Sukebei, Mikan and South Plus separately. Set defaults, inline controls, batch controls and concurrency (default 2, safe maximum 2); all 115 file reads and mutations share a 500ms serial limiter (about 2 QPS maximum), while the background monitor polls at most two tasks per alarm in round-robin order.
4. Push from a page or paste multiple links in the popup. The dialog can override both the site profile and destination. If South Plus has not been granted persistent page access yet, opening the popup temporarily enhances the current page; save the South Plus profile in Settings and approve its permission for automatic enhancement on new pages. After reloading the extension, already-open authorized South Plus threads are repaired automatically; refresh once if a page is still showing its old document.
5. Inspect, refresh or retry tasks from the background task page. South Plus’s **Record** action stores the link, source, filename and code locally without creating a 115 cloud task. **Clear logs** removes history only; it keeps active tasks, series bindings and deduplication receipts. If stale local state is blocking new submissions, use **Complete task reset**: it clears local tasks, processing plans, series bindings and dedupe receipts, while leaving 115 cloud tasks, login, directories and site settings untouched. Bridge claims, lease receipts and its event outbox are retained so a reset cannot submit the same job again.

### Local automation Bridge

The extension can optionally connect to a local FastAPI service at `http://127.0.0.1:52115`, claim Telegram `/av` and JavBus candidates, and submit them through the existing background `Router.submitIntent` path. Version 1.14.0 adds active Bridge port discovery: once enabled, the service worker keeps probing the fixed loopback port, connects automatically if the local service starts later, and resynchronizes the directory registry after recovery. Concurrent registry revisions are serialized and reconciled, while 115 directory reads accept the supported breadcrumb and pagination variants without dropping explicit CID validation. The popup now uses a fixed-width two-column workspace layout, and the options page reports the synced directory count and revision. JavBus AJAX enrichment failures no longer discard magnets already present on the page, and attribute-style page parameters are supported. Normal users no longer need to find the extension ID, enter chat/user IDs, or edit `.env`. Enabling it requests only the fixed loopback permission; the token is used only by the service worker and is never injected into pages or sent as a cookie. Bridge Intents accept strict BTIH Magnet or ED2K file links.

The Settings page accepts the Telegram Bot Token and keeps the old manual token/CID controls under Advanced settings. Bridge validates the token with `getMe` and starts polling dynamically. After setup, the first user to send `/start` in a private chat is bound as the owner automatically; there is no nonce or claim link. Only that owner can use `/av`, `/anime`, `/add`, `/jobs`, and `/dir`; changing the Bot Token clears the old owner and the first `/start` for the new bot binds again. Directory scans are uploaded as a non-sensitive `schema/revision/path/CID` snapshot plus site defaults to Bridge SQLite. Configure JavBus with the AV CID and Anime sites with the 番剧 CID; Telegram candidates use the matching CID and processor, while `/dir` “use current directory” takes precedence for that user. The directory index “Add” action only adds a scanned folder to the extension’s local save-path list; it does not create a folder or start a download. Before the browser has synced a snapshot, the Bridge asks the user to sync directories; the legacy `PUSH115_TELEGRAM_SAVE_PATHS` setting remains an optional compatibility fallback. The worker claims one job every 30 seconds, persists its `jobId`, lease and submission state before submitting an intent with the explicit site processor and `metadata.monitorDownload: true`, then reports progress and terminal states with stable event IDs. If a network failure, worker restart or local persistence error leaves the submission result unclear, the job becomes `uncertain` and is never submitted again automatically. A local `recorded` history entry is never reported as completed. Telegram supports `/dir`, `/add <Magnet|ED2K>`, and `/jobs`; task details offer retry for failed jobs and cancel for active jobs. Cancelling an active job stops the extension's local task and monitoring only; it does not cancel the 115 cloud offline task. Bridge Telegram `/av` searches JavBus, while `/anime keyword` remains available through Nyaa RSS. If JavBus’s AJAX enrichment is rejected but the page already contains a magnet, the candidate is kept. Advanced environment variables are described in [`src/fastapi-bridge/README.md`](src/fastapi-bridge/README.md).

Start the Bridge from the repository root with Pixi:

```powershell
pixi install
pixi run start
```

#### First-time Telegram bot setup

1. In a private chat with `@BotFather`, send `/newbot`, follow the prompts for the bot name and username, and copy the HTTP API Token. Treat it as a secret: do not post it in a group, screenshot it, or commit it to Git.
2. Open extension settings and click **Connect local Bridge** in **Local automation Bridge**; approve the optional `http://127.0.0.1/*` permission when Chrome asks. The durable local credential is stored and reused automatically; no pairing code is required.
3. In the **Telegram Bot** section of the same settings page, paste the Bot Token and click **Connect Telegram**. Bridge validates it with `getMe`, starts polling dynamically, and shows the bot username.
4. Open the bot in a private chat and send **/start**. The first sender is bound as the owner automatically; wait for **已绑定为管理员** before using commands.
5. Keep 115 logged in, the Chrome extension enabled, and the Bridge terminal running. In extension settings click **Scan directories**, wait for the snapshot to sync, then send `/dir` to the bot and choose the default save directory.

If the browser extension is reinstalled or loses its local credential, keep the existing Bridge running and click **Connect local Bridge** again in extension settings; do not run two Bridge instances at once. Replacing the Bot Token clears the old owner; send `/start` in a private chat with the new bot to bind again. Advanced users can still use `.env.example` for provider, database, and timeout overrides.

#### Telegram bot commands

| Command | Purpose |
|---------|---------|
| `/av ABC-123` | Search JavBus and queue a selected candidate |
| `/anime One Piece` | Search the configured Nyaa RSS source and queue a selected Magnet |
| `/dir` or `/path` | Browse the directory tree and choose the current save directory |
| `/add <Magnet or ED2K>` | Queue an explicit Magnet or ED2K link |
| `/jobs` | List jobs created by the current Telegram account; retry failed jobs or cancel active ones from details |

Choose a directory with `/dir` before using `/av`, `/anime`, or `/add`. Result buttons are bound to the original account and message for a limited time; forwarding or clicking them again cannot enqueue a duplicate. Telegram only searches and queues work; the Chrome extension performs the actual 115 submission. Cancelling an active job stops local monitoring but does not cancel an offline task already submitted to 115.

If the bot does not respond, refresh Telegram status in Settings and confirm that the Bot is configured, polling is running, and the owner has claimed it. If `/dir` reports that no directories are available, keep 115 logged in and scan directories again. If the extension cannot reach Bridge, confirm that `pixi run start` is still running and that local port `52115` is not occupied by another process. If the Bot Token is exposed, revoke and replace it through `@BotFather`, then connect the new token in Settings.

State, the database and the token are stored under `src/fastapi-bridge/.state` by default; run tests with `pixi run test`.

Generic uses optional `<all_urls>` permission. Dedicated site enhancements use optional host permissions, with a one-time `activeTab` fallback for the current HTTP(S) page when the popup is opened. OpenBT has no separate profile and follows Generic when that permission is enabled.

## Development

```powershell
pixi install
pixi run build
pixi run deploy
pixi run clean
node --test tests/anime-routing.test.cjs
```

See [`src/README.md`](src/README.md), [`src/chrome-extension/README.md`](src/chrome-extension/README.md), and [`AGENTS.md`](AGENTS.md) for module contracts, verification rules and versioning.

## Privacy and license

- Data is kept locally in `chrome.storage.local`.
- No telemetry, advertising or profiling is performed, and 115 cookies are never uploaded to the Bridge or Telegram. If Telegram is enabled, selected resources and task status are sent only to the claimed Telegram owner.
- By default the extension contacts only `*.115.com`; when Local Bridge is enabled it also contacts the fixed `127.0.0.1:52115` loopback service.
- [Privacy policy](https://gangz1o.github.io/115-offline-helper/privacy-policy.html)

[MIT License](LICENSE)
