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
<img src="https://img.shields.io/badge/version-1.9.0-orange" alt="Version">
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
2. Maintain the shared 115 directory catalog in Settings. Site profiles and the confirmation dialog select from this catalog; legacy `Name:CID` entries are migrated automatically.
3. Enable and configure Generic, JavBus, Nyaa, Sukebei, Mikan and South Plus separately. Set defaults, inline controls, batch controls and concurrency (default 2, safe maximum 2); all 115 file reads and mutations share a 500ms serial limiter (about 2 QPS maximum), while the background monitor polls at most two tasks per alarm in round-robin order.
4. Push from a page or paste multiple links in the popup. The dialog can override both the site profile and destination. If South Plus has not been granted persistent page access yet, opening the popup temporarily enhances the current page; save the South Plus profile in Settings and approve its permission for automatic enhancement on new pages. After reloading the extension, already-open authorized South Plus threads are repaired automatically; refresh once if a page is still showing its old document.
5. Inspect, refresh or retry tasks from the background task page. South Plus’s **Record** action stores the link, source, filename and code locally without creating a 115 cloud task. **Clear logs** removes history only; it keeps active tasks, series bindings and deduplication receipts. If stale local state is blocking new submissions, use **Complete task reset**: it clears local tasks, processing plans, series bindings and dedupe receipts, while leaving 115 cloud tasks, login, directories and site settings untouched. Bridge claims, lease receipts and its event outbox are retained so a reset cannot submit the same job again.

### Local automation Bridge

The extension can optionally connect to a local FastAPI service at `http://127.0.0.1:52115`, claim Telegram `/av` and JavBus candidates, and submit them through the existing background `Router.submitIntent` path. Bridge is off by default. Enabling it requests only the optional `http://127.0.0.1/*` permission; the transport origin and port remain fixed. The Bearer token stays in local extension storage, is used only by the service worker, and is never injected into pages or sent as a cookie. Bridge Intents accept strict BTIH Magnet or ED2K file links.

The Settings page accepts the token and a Bridge default CID. That CID is used only when a claimed job has no `savePathCid`; an explicit job CID is preserved. The worker claims one job every 30 seconds, persists its `jobId`, lease and submission state before submitting an intent with an explicit `processorProfile` (`jav` for `/av`, `anime` for `/anime`) and `metadata.monitorDownload: true`, then reports progress and terminal states with stable event IDs. If a network failure, worker restart or local persistence error leaves the submission result unclear, the job becomes `uncertain` and is never submitted again automatically. A local `recorded` history entry is never reported as completed. Telegram supports `/dir` for a static directory picker, `/add <Magnet|ED2K>` for direct enqueueing and `/jobs` for the user's task list; task details offer retry for failed jobs and cancel for active jobs. Cancelling an active job stops the local extension task and monitoring only; it does not cancel the 115 cloud offline task. A queued job can be terminated directly. Bridge Telegram `/av` searches JavBus, while the existing `/anime keyword` Nyaa RSS search remains available; this release adds no RSS, subscription or automatic-search feature. Windows startup, token, Telegram allowlist, static directories, Nyaa source and CORS configuration are described in [`src/fastapi-bridge/README.md`](src/fastapi-bridge/README.md).

Start the Bridge from the repository root with Pixi:

```powershell
pixi install
Copy-Item src\fastapi-bridge\.env.example src\fastapi-bridge\.env
pixi run bridge-token
pixi run bridge-start
```

State, the database and the token are stored under `src/fastapi-bridge/.state` by default; run tests with `pixi run bridge-test`.

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
- No telemetry, advertising or profiling is performed, and 115 cookies are never uploaded to the Bridge or Telegram. If Telegram is enabled, selected resources and task status are sent to the configured allowlisted chats.
- By default the extension contacts only `*.115.com`; when Local Bridge is enabled it also contacts the fixed `127.0.0.1:52115` loopback service.
- [Privacy policy](https://gangz1o.github.io/115-offline-helper/privacy-policy.html)

[MIT License](LICENSE)
