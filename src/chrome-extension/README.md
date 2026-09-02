# 115 Offline Helper - Browser Extension

This directory contains the source code for the Chrome Extension version of the 115 Offline Helper. The Chrome-loadable build is generated at `dist/extension` by Pixi.

## Installation

1.  Open Chrome/Edge and navigate to `chrome://extensions`.
2.  Enable **Developer mode** (toggle in the top right).
3.  Click **Load unpacked**.
4.  Select the `dist/extension` folder in this project. Run `pixi run build` first if it does not exist.

## Development

-   **background.js**: Service worker, handles cross-origin requests to 115.com and notifications.
-   **content.js**: Main logic, injects the UI panel into pages.
-   **popup.css**: Styles for the popup UI.
-   **manifest.json**: Extension configuration.

## Features

-   Automatic detection of Magnet/ED2K links.
-   "Push to 115" functionality.
-   Settings panel (Theme, Language, Auto-delete/organize).
-   Background monitoring of offline tasks.
