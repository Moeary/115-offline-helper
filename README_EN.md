<p align="right">
  <a href="README.md">🇨🇳 中文</a>
</p>

<h1 align="center">
  <img src="src/chrome-extension/icons/logo.png" width="64" height="64" alt="logo"><br>
  115 Offline Helper
</h1>

<p align="center">
  <strong>Detect magnet/ed2k links and push them to your 115.com cloud offline download with one click.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/manifest-v3-blue" alt="Manifest V3">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
  <img src="https://img.shields.io/badge/version-1.2.0-orange" alt="Version">
</p>

---

## ✨ Features

- 🔍 **Auto-detect links** — Detect magnet and ed2k links on any web page (opt-in)
- 🧩 **Site adapters** — Profiles for Generic, JavBus, Nyaa/Sukebei, and Mikan; OpenBT uses Generic
- 📺 **List batch submission** — Nyaa, Sukebei, and Mikan support selected/all submission, BTIH deduplication, bounded concurrency, and per-item progress
- 📥 **Unified confirmation** — Page buttons, batches, and manual multi-line input share editable links, save directory, and processor selection
- 📁 **Custom save directory** — Choose which 115 folder to save downloads to
- 🗑️ **Safe junk cleanup** — Remove obvious HTML/TXT attachments and small ad videos; subtitles are protected and image/NFO cleanup is off by default
- 📂 **Auto-organize videos** — Move video files into folders based on filename
- 🧰 **Full settings and logs page** — Manage extension rules, cleanup switches, directories, and background logs
- 🔄 **In-popup task manager** — Open background task status, logs, refresh, and retry directly from the Home tab
- 📱 **QR code login** — Log into 115.com directly from the extension popup
- 🌐 **Bilingual UI** — Supports both Chinese and English

## 📦 Installation

### Chrome Web Store (Recommended)

Install directly from the Chrome Web Store:

[<img src="https://storage.googleapis.com/web-dev-uploads/image/WlD8wC6g8khYWPJUsQceQkhXSlv1/iNEddTyWiMfLSwFD6qGq.png" height="58" alt="Available in the Chrome Web Store">](https://chromewebstore.google.com/detail/115-offline-helper/blgnjjjbmjgilkiimglodjdebcdaidgl?hl=zh-CN&authuser=0)

### Build and deploy from source with Pixi

On Windows, install [pixi](https://pixi.sh/) and Chrome. From the repository root:

```powershell
Copy-Item config.example.toml config.toml
```

Set the local `chrome.exe` path in `[browser] chrome`, then run:

```powershell
pixi install
pixi run deploy
```

The deploy task validates the extension, copies it to `dist/extension`, opens `chrome://extensions/`, and asks Chrome to load the compiled directory. If an already-running Chrome ignores the launch argument, enable **Developer mode**, click **Load unpacked**, and choose `dist/extension` once.

After source changes, run `pixi run deploy` again and click **Reload** on the extension card.

### Manual Install

1. **Download the extension**

   Go to the [Releases](https://github.com/gangz1o/115-offline-helper/releases/latest) page and download `115-offline-helper_v*.zip`, then unzip.

   Or clone the repo:

   ```bash
   git clone https://github.com/gangz1o/115-offline-helper.git
   ```

2. **Open Extensions page**

   | Browser | URL |
   |---------|-----|
   | Chrome | `chrome://extensions/` |
   | Edge | `edge://extensions/` |

3. **Enable Developer Mode**

   Toggle the **Developer mode** switch — bottom-left on Edge, top-right on Chrome.

4. **Load the extension**

   Click **Load unpacked**. For a source checkout, run `pixi run build` first and select `dist/extension`; for a release archive, select the extracted extension directory.

5. **Done!**

   The extension icon will appear in your toolbar. Pin it for easy access.

> **💡 Tip:** To update, run `git pull` and click the ↻ refresh button on the extension card.

> **💡 Compatibility:** This extension is built on Manifest V3 and works with all Chromium-based browsers (Chrome, Edge, Brave, Arc, etc.).

## 🚀 Usage

1. **Login** — Click the extension icon → **Scan to Login** → scan QR code with the 115 mobile app.
2. **Set save directory** — Choose a folder from the dropdown on the Home tab, or add custom paths in Settings (`FolderName:CID` format).
3. **Push links** — Generic adds buttons beside magnet/ed2k links; JavBus uses its page code; Nyaa, Sukebei, and Mikan support single and batch submission. OpenBT uses Generic.

### Settings

| Setting | Description |
|---------|-------------|
| Save directory list | Add folders in `Name:CID` format, one per line |
| Auto-detect links | Detect links on all pages via content script |
| Site enhancements | Configure enabled state, default save directory (selected from the directory list), processor profile, and page controls for Generic, JavBus, Nyaa, Sukebei, and Mikan |
| List batches | Nyaa, Sukebei, and Mikan default to concurrency 2; failures are isolated and every batch uses unified confirmation |
| Log cleanup | Clear completed, failed, and recorded history from Settings; active tasks are retained |
| Background task manager | Open the Task manager tab from Home to inspect logs and retry failures |
| Junk extension rules | Edit junk, protected, and optional cleanup extensions in the full settings page |
| Image/NFO cleanup | Off by default; enable it explicitly in the full settings page |
| Safe junk cleanup | Explicit junk extensions are removed; small videos still pass safety checks |
| Auto-organize videos | Move video files into named folders |

> By default, `.url/.html/.htm/.txt/.exe/.bat/.cmd/.torrent` are treated as explicit junk, while `.srt/.ass/.ssa/.sup/.vtt` are protected. Image/poster and `.nfo` cleanup is disabled by default. If an extension appears in both lists, the protected list wins.

> Each task carries an explicit `processorProfile`: `generic` performs safe cleanup only, `jav` may apply code-based renaming, and `anime` preserves torrent names by default. Anime tasks submitted together from one confirmation dialog move video/subtitle files into the selected save directory after completion and delete only verified-empty task folders; no forced series renaming or extra folder is created. The confirmation dialog can override every site's default.

## ❓ FAQ

**Q: How to find a folder's CID?**
> Open the folder in [115.com](https://115.com), look at the URL: `https://115.com/?cid=1234567` — the number after `cid=` is the CID.

**Q: "Not logged in" error?**
> Click extension icon → **Scan to Login**, scan with 115 mobile app.

**Q: Auto-detect not working?**
> Enable "Auto detect links" in Settings. The browser will ask for additional permissions — click Allow.

## 🛠️ Development commands

```powershell
pixi install
pixi run build    # Validate and generate dist/extension
pixi run deploy   # Build and open the Chrome extensions page
pixi run clean    # Remove build output
```

See [`src/README.md`](src/README.md) for the source layout. The local `config.toml` only stores the Chrome path and is ignored by Git.

## 🔒 Privacy

- All data is stored locally via `chrome.storage.local`
- No user data is collected, transmitted, or shared with third parties
- Only communicates with `*.115.com` domains
- [Full Privacy Policy](https://gangz1o.github.io/115-offline-helper/privacy-policy.html)

## 📄 License

[MIT License](LICENSE)
