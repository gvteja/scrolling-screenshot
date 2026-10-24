# scrolling-screenshot

A Chrome extension that captures a scrolling page and saves one PNG image.
Version: 0.4.2.

## Install

1. Clone this repository or download and extract its ZIP file.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the repository folder.
5. Pin **scrolling-screenshot** to the toolbar.

## Use

1. Open the page that you want to capture.
2. Expand any groups that you want in the image.
3. Click the extension icon.
4. Keep the tab active until capture ends.

The extension saves the PNG in the Chrome download folder. The toolbar badge
shows progress. A check mark means the download has started.

Capture and image assembly run locally in Chrome. No build step is required.

## Files

- `manifest.json`: extension name, permissions, and icon references.
- `service-worker.js`: capture, scrolling, image assembly, and download code.
- `icons/`: PNG icons and the source image.
- `LICENSE`: the MIT license and original copyright notice.

## License

MIT. Based on OpenScreenShot. The original copyright notice is preserved in
`LICENSE`.
