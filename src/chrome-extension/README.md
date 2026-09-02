# 115 Offline Helper - Browser Extension

This directory contains the source code for the Chrome Extension version of the 115 Offline Helper. The Chrome-loadable build is generated at `dist/extension` by Pixi.

## Installation

1.  Open Chrome/Edge and navigate to `chrome://extensions`.
2.  Enable **Developer mode** (toggle in the top right).
3.  Click **Load unpacked**.
4.  Select the `dist/extension` folder in this project. Run `pixi run build` first if it does not exist.

## Development

-   **background.js**: Service worker, handles 115 requests, alarms, and persistent task processing.
-   **content.js**: Detects links and captures page metadata such as the JAV code.
-   **file-rules.js**: Conservative junk-file classification shared by the background processor.
-   **popup.css**: Styles for the popup UI.
-   **options.html / options.css / options.js**: Full settings page with configurable extension rules and background task logs.
-   **manifest.json**: Extension configuration.

## Features

-   Automatic detection of Magnet/ED2K links.
-   "Push to 115" functionality.
-   Settings panel (Theme, Language, safe cleanup/organize).
-   In-popup background task manager plus full options page for extension rules, image/NFO cleanup switches, and task logs.
-   Background monitoring of offline tasks.

## Processing model

After a magnet is submitted, `content.js` sends the page title, source host, detected code, and the 115 task identifier to `background.js`. The service worker stores the task in `chrome.storage.local` and uses a Chrome alarm to resume polling after the source page is closed.

Cleanup is intentionally conservative: explicit junk extensions are sent to the 115 recycle bin; subtitle extensions are protected by default. Image/poster and NFO cleanup is disabled by default and can be enabled from `options.html`; if a type appears in both lists, the protected list wins. Multipart videos and the largest video are protected. A video is only a candidate when it is below the configured threshold and also has a short-duration or strong advertisement-name signal. Unknown files are kept. The popup's `后台管理` tab exposes the persisted task timeline without requiring the separate options page.
