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
  <img src="https://img.shields.io/badge/version-1.4.6-orange" alt="Version">
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
| Nyaa | Row buttons, checkboxes, select-all and batch submission | `anime` | Multi-select torrents with BTIH deduplication |
| Sukebei | Same list core as Nyaa, separate site profile | `generic` | Safe default; change to `jav` only when appropriate |
| Mikan | Per-resource, selected and all-resource actions | `anime` | Remember a destination for `/Home/Bangumi/<ID>` |
| OpenBT | Generic fallback; no special adapter/profile | `generic` | No speculative DOM coupling |

Nyaa, Sukebei and Mikan share one confirmation dialog and one rate-limited queue. A throttled `MutationObserver` handles appended rows without repeatedly injecting controls.

## Post-processing profiles

| Profile | Behavior | Guardrail |
|---------|----------|-----------|
| `generic` | Existing conservative junk cleanup | Never renames by code |
| `jav` | Safe cleanup; page code first; largest main video → `CODE.ext`; subtitles follow; task folder → code | Triggered only by this explicit profile |
| `anime` | Keeps torrent names and directory semantics; batch/Mikan archive moves identified video/subtitle files into the chosen destination | No JAV rename and no guessed show/episode names |

Subtitle extensions are protected by default, image/NFO cleanup is opt-in, and every remote move/rename/recycle is verified with explicit CID/FID values. Unknown files, collisions and inconsistent directory responses stay in place for a later retry.

Mikan also handles a common 115 layout where the wrapper folder has exactly the same name as its video. Instead of relying on a rename that may be rejected, the processor creates a task-specific `__push115_stage_*` folder inside the destination, stages the explicit file IDs there, verifies and recycles the empty wrapper, then moves files back and recycles the staging folder. The plan persists the staging CID and file IDs so retries do not recreate it. A real same-name file already in the destination remains a collision and is never overwritten.

Release-group prefixes such as `[NEST]` are preserved only when they belong to the torrent's original filename; the extension never invents or strips them. If an older run shortened a filename, retry restores the original name recorded in the plan. Version 1.4.6 also recovers the screenshot-era shape where a wrapper directory still has the full `.mkv` name but its only file was shortened to `[NEST]`, using only that explicit file ID and then removing the empty wrapper.

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

Set the local Chrome path in `[browser] chrome`. Deploy validates the MV3 entry points, copies the extension to `dist/extension`, and opens the extensions page. If Chrome is already running, enable Developer mode and load `dist/extension` once, then use **Reload** after subsequent builds.

### Manual install

Download the latest archive from [Releases](https://github.com/gangz1o/115-offline-helper/releases/latest), or clone the repository. Open `chrome://extensions/` (or `edge://extensions/`), enable Developer mode, and choose **Load unpacked** after running `pixi run build`.

## First run

1. Scan the QR code with the 115 mobile client.
2. Maintain the shared 115 directory catalog in Settings. Site profiles and the confirmation dialog select from this catalog; legacy `Name:CID` entries are migrated automatically.
3. Enable and configure Generic, JavBus, Nyaa, Sukebei and Mikan separately. Set defaults, inline controls, batch controls and concurrency (default 2, safe maximum 2); 115 file mutations are additionally serialized and rate-limited in the background.
4. Push from a page or paste multiple links in the popup. The dialog can override both the site profile and destination.
5. Inspect, refresh or retry tasks from the background task page. **Clear logs** removes history only; it keeps active tasks, series bindings and deduplication receipts. If stale local state is blocking new submissions, use **Complete task reset**: it clears local tasks, processing plans, series bindings and dedupe receipts, while leaving 115 cloud tasks, login, directories and site settings untouched.

Generic uses optional `<all_urls>` permission. Dedicated site enhancements use their own host permissions. OpenBT has no separate profile and follows Generic when that permission is enabled.

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
- No user data is collected or shared.
- Network access is limited to `*.115.com`.
- [Privacy policy](https://gangz1o.github.io/115-offline-helper/privacy-policy.html)

[MIT License](LICENSE)
