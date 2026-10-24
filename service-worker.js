/**
 * scrolling-screenshot
 *
 * Self-contained Manifest V3 service worker. It coordinates overlapping
 * viewport captures, injects the page-side helpers below, stitches the tiles,
 * and downloads one PNG. There are no imports or generated runtime assets.
 */

// ---------------------------------------------------------------------------
// General helpers
// ---------------------------------------------------------------------------

const MAX_CANVAS_HEIGHT_PX = 32000;
function computeScrollPositions(scrollHeight, viewportHeight, overlap = 0) {
  if (scrollHeight <= viewportHeight) return [0];
  const last = scrollHeight - viewportHeight;
  const safeOverlap = Math.min(
    Math.max(0, overlap),
    Math.max(0, viewportHeight - 1),
  );
  const step = Math.max(1, viewportHeight - safeOverlap);
  const positions = [];
  let y = 0;
  while (y < last) {
    positions.push(y);
    y += step;
  }
  if (positions[positions.length - 1] !== last) positions.push(last);
  return positions;
}
function formatFilename(template, ctx) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const title =
    sanitizeFilename(ctx.title ?? "screenshot").slice(0, 60) || "screenshot";
  return template
    .replaceAll("{date}", date)
    .replaceAll("{time}", time)
    .replaceAll("{title}", title)
    .replaceAll("{w}", String(ctx.width))
    .replaceAll("{h}", String(ctx.height));
}
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}
function isProtectedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("devtools://") ||
    url.startsWith("about:") || // Chrome blocks script injection on both Web Store hosts (old + current).
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://chromewebstore.google.com")
  );
}
// ---------------------------------------------------------------------------
// Page-side capture helpers
//
// Chrome serializes these functions and executes them in the active tab using
// chrome.scripting.executeScript. Keep each function self-contained: it cannot
// refer to helpers or variables outside its own body.
// ---------------------------------------------------------------------------

function getMetrics() {
  const de = document.documentElement;
  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const docScrolls = de.scrollHeight > vh + 4;
  // A previous interrupted capture must not leave a stale target behind.
  for (const el of document.querySelectorAll('[data-oss-scroller="1"]')) {
    delete el.dataset.ossScroller;
  }
  let scroller = null;
  if (!docScrolls) {
    let bestOverflow = vh * 0.5;
    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") continue;
      // Resize sensors can have more overflow than the actual record list.
      // They must never become the capture target.
      if (cs.visibility !== "visible" || cs.display === "none") continue;
      let transparent = false;
      for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || Number(style.opacity) === 0) {
          transparent = true;
          break;
        }
      }
      if (transparent) continue;
      const overflow = el.scrollHeight - el.clientHeight;
      if (overflow <= bestOverflow) continue;
      const r = el.getBoundingClientRect();
      const visibleWidth = Math.min(vw, r.right) - Math.max(0, r.left);
      const visibleHeight = Math.min(vh, r.bottom) - Math.max(0, r.top);
      if (visibleWidth < vw * 0.5 || visibleHeight < vh * 0.5) continue;
      // A viewport tile must include the full client area of the scroller.
      // Otherwise a capture would have gaps between tiles.
      if (
        r.left + el.clientLeft < -1 ||
        r.top + el.clientTop < -1 ||
        r.left + el.clientLeft + el.clientWidth > vw + 1 ||
        r.top + el.clientTop + el.clientHeight > vh + 1
      )
        continue;
      bestOverflow = overflow;
      scroller = el;
    }
  }
  if (scroller) {
    scroller.dataset.ossScroller = "1";
    const r = scroller.getBoundingClientRect();
    return {
      scrollHeight: scroller.scrollHeight,
      viewportHeight: scroller.clientHeight,
      viewportWidth: scroller.clientWidth,
      captureViewportHeight: vh,
      captureViewportWidth: vw,
      devicePixelRatio: dpr,
      container: {
        x: r.left + scroller.clientLeft,
        y: r.top + scroller.clientTop,
        width: scroller.clientWidth,
        height: scroller.clientHeight,
      },
    };
  }
  return {
    scrollHeight: de.scrollHeight,
    viewportHeight: vh,
    viewportWidth: vw,
    captureViewportHeight: vh,
    captureViewportWidth: vw,
    devicePixelRatio: dpr,
    container: null,
  };
}
function prepareCapture() {
  const de = document.documentElement;
  const scroller = document.querySelector('[data-oss-scroller="1"]');
  const rememberScrollBehavior = (el) => {
    const value = el.style.getPropertyValue("scroll-behavior");
    el.dataset.ossHadScrollBehavior = value ? "1" : "0";
    el.dataset.ossScrollBehavior = value;
    el.dataset.ossScrollBehaviorPriority =
      el.style.getPropertyPriority("scroll-behavior");
    el.style.setProperty("scroll-behavior", "auto", "important");
  };
  rememberScrollBehavior(de);
  de.dataset.ossOriginalScrollTop = String(window.scrollY);
  if (scroller) {
    rememberScrollBehavior(scroller);
    scroller.dataset.ossOriginalScrollTop = String(scroller.scrollTop);
  }
  const style = document.createElement("style");
  style.dataset.ossCaptureStyle = "1";
  style.textContent = `
    *, *::before, *::after {
      animation-play-state: paused !important;
      caret-color: transparent !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
    }
    html, [data-oss-scroller="1"] {
      scroll-behavior: auto !important;
      scroll-snap-type: none !important;
    }
  `;
  (document.head || de).appendChild(style);
}
function hideFixedElements() {
  const scroller = document.querySelector('[data-oss-scroller="1"]');
  const els = document.querySelectorAll("*");
  for (const el of els) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed") continue;
    // Some applications put their scroll area inside a fixed layout shell.
    if (scroller && (el === scroller || el.contains(scroller))) continue;
    const htmlEl = el;
    const value = htmlEl.style.getPropertyValue("visibility");
    htmlEl.dataset.ossHidden = "1";
    htmlEl.dataset.ossHadVisibility = value ? "1" : "0";
    htmlEl.dataset.ossVisibility = value;
    htmlEl.dataset.ossVisibilityPriority =
      htmlEl.style.getPropertyPriority("visibility");
    htmlEl.style.setProperty("visibility", "hidden", "important");
  }
}
async function waitForCaptureReady(pauseMs = 140, imageWaitMs = 700) {
  const frame = () =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()));
  await frame();
  await frame();
  await new Promise((resolve) => setTimeout(resolve, pauseMs));
  const visiblePendingImages = Array.from(document.images).filter((img) => {
    if (img.complete) return false;
    const r = img.getBoundingClientRect();
    return (
      r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
    );
  });
  if (visiblePendingImages.length) {
    const loaded = Promise.all(
      visiblePendingImages.map(
        (img) =>
          new Promise((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          }),
      ),
    );
    await Promise.race([
      loaded,
      new Promise((resolve) => setTimeout(resolve, imageWaitMs)),
    ]);
  }
  await frame();
  await frame();
}
function scrollToPosition(y) {
  const scroller = document.querySelector('[data-oss-scroller="1"]');
  if (scroller) {
    scroller.scrollTop = y;
    const after2 = scroller.scrollTop;
    const max2 = scroller.scrollHeight - scroller.clientHeight;
    return { scrollY: after2, atBottom: after2 >= max2 - 1 };
  }
  window.scrollTo(0, y);
  const after = window.scrollY;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return { scrollY: after, atBottom: after >= max - 1 };
}
function restoreCapture() {
  const hidden = document.querySelectorAll('[data-oss-hidden="1"]');
  for (const el of hidden) {
    const htmlEl = el;
    if (htmlEl.dataset.ossHadVisibility === "1") {
      htmlEl.style.setProperty(
        "visibility",
        htmlEl.dataset.ossVisibility ?? "",
        htmlEl.dataset.ossVisibilityPriority ?? "",
      );
    } else {
      htmlEl.style.removeProperty("visibility");
    }
    delete htmlEl.dataset.ossHidden;
    delete htmlEl.dataset.ossHadVisibility;
    delete htmlEl.dataset.ossVisibility;
    delete htmlEl.dataset.ossVisibilityPriority;
  }
  const restoreScrollBehavior = (el) => {
    if (el.dataset.ossHadScrollBehavior === "1") {
      el.style.setProperty(
        "scroll-behavior",
        el.dataset.ossScrollBehavior ?? "",
        el.dataset.ossScrollBehaviorPriority ?? "",
      );
    } else {
      el.style.removeProperty("scroll-behavior");
    }
    delete el.dataset.ossHadScrollBehavior;
    delete el.dataset.ossScrollBehavior;
    delete el.dataset.ossScrollBehaviorPriority;
  };
  document.querySelector('[data-oss-capture-style="1"]')?.remove();
  const de = document.documentElement;
  const scroller = document.querySelector('[data-oss-scroller="1"]');
  if (scroller) {
    const original = Number(scroller.dataset.ossOriginalScrollTop ?? "0");
    restoreScrollBehavior(scroller);
    scroller.scrollTop = Number.isFinite(original) ? original : 0;
    delete scroller.dataset.ossOriginalScrollTop;
    delete scroller.dataset.ossScroller;
  } else {
    const original = Number(de.dataset.ossOriginalScrollTop ?? "0");
    window.scrollTo(0, Number.isFinite(original) ? original : 0);
  }
  restoreScrollBehavior(de);
  delete de.dataset.ossOriginalScrollTop;
}
async function stitchTiles(tiles, metrics) {
  const load = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("tile load failed"));
      img.src = src;
    });
  if (!tiles.length) throw new Error("no capture tiles");
  const images = await Promise.all(tiles.map((tile) => load(tile.dataUrl)));
  const first = images[0];
  const scaleX = first.naturalWidth / Math.max(1, metrics.captureViewportWidth);
  const scaleY =
    first.naturalHeight / Math.max(1, metrics.captureViewportHeight);
  const crop = metrics.container
    ? {
        x: Math.round(metrics.container.x * scaleX),
        y: Math.round(metrics.container.y * scaleY),
        w: Math.round(metrics.container.width * scaleX),
        h: Math.round(metrics.container.height * scaleY),
      }
    : null;
  const width = crop?.w ?? first.naturalWidth;
  const height = Math.round(metrics.scrollHeight * scaleY);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  const scratch = document.createElement("canvas");
  scratch.width = canvas.width;
  scratch.height = Math.max(1, crop?.h ?? first.naturalHeight);
  const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  if (!scratchCtx) throw new Error("scratch canvas 2d context unavailable");
  let coveredUntil = 0;
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const img = images[i];
    scratchCtx.clearRect(0, 0, scratch.width, scratch.height);
    if (crop) {
      scratchCtx.drawImage(
        img,
        crop.x,
        crop.y,
        crop.w,
        crop.h,
        0,
        0,
        scratch.width,
        scratch.height,
      );
    } else {
      scratchCtx.drawImage(img, 0, 0);
    }
    const destY = Math.max(0, Math.round(tile.scrollY * scaleY));
    const overlap = Math.max(
      0,
      Math.min(scratch.height - 1, coveredUntil - destY, canvas.height - destY),
    );
    let seam = 0;
    if (i > 0 && overlap > 4) {
      const existing = ctx.getImageData(0, destY, canvas.width, overlap).data;
      const incoming = scratchCtx.getImageData(
        0,
        0,
        scratch.width,
        overlap,
      ).data;
      const firstRow = Math.max(1, Math.round(overlap * 0.6));
      const lastRow = Math.max(
        firstRow,
        Math.min(overlap - 1, Math.round(overlap * 0.95)),
      );
      const sampleStep = Math.max(1, Math.floor(canvas.width / 96));
      let bestError = Number.POSITIVE_INFINITY;
      seam = lastRow;
      for (let row = firstRow; row <= lastRow; row += 1) {
        let error = 0;
        let samples = 0;
        for (let x = 0; x < canvas.width; x += sampleStep) {
          const p = (row * canvas.width + x) * 4;
          error +=
            Math.abs(existing[p] - incoming[p]) +
            Math.abs(existing[p + 1] - incoming[p + 1]) +
            Math.abs(existing[p + 2] - incoming[p + 2]);
          samples += 1;
        }
        const average = samples ? error / samples : error;
        if (average <= bestError) {
          bestError = average;
          seam = row;
        }
      }
    } else if (i > 0) {
      seam = overlap;
    }
    const drawY = destY + seam;
    const drawHeight = Math.min(scratch.height - seam, canvas.height - drawY);
    if (drawHeight > 0) {
      ctx.drawImage(
        scratch,
        0,
        seam,
        scratch.width,
        drawHeight,
        0,
        drawY,
        scratch.width,
        drawHeight,
      );
    }
    coveredUntil = Math.max(coveredUntil, destY + scratch.height);
  }
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  };
}
// ---------------------------------------------------------------------------
// Service-worker capture coordinator
// ---------------------------------------------------------------------------

const CAPTURE_THROTTLE_MS = 500;
const CAPTURE_OVERLAP_CSS_PX = 160;
const STATUS_CLEAR_MS = 2500;
let captureInProgress = false;
let statusClearTimer;
chrome.action.onClicked.addListener((tab) => {
  void startCapture(tab);
});
async function startCapture(tab) {
  if (captureInProgress || !tab || tab.id == null) return;
  captureInProgress = true;
  const tabId = tab.id;
  clearScheduledStatus();
  try {
    await setStatus(tabId, "…", "#2563eb", "Capturing full page…");
    if (isProtectedUrl(tab.url)) {
      throw new Error("Chrome doesn't allow extensions to capture this page.");
    }
    const result = await captureFullPage(tab);
    const filename = `${formatFilename("scrolling-screenshot_{title}_{date}_{time}", {
      title: tab.title,
      width: result.width,
      height: result.height,
    })}.png`;
    await chrome.downloads.download({
      url: result.dataUrl,
      filename,
      saveAs: false,
    });
    await setStatus(tabId, "✓", "#15803d", `Saved ${filename}`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Capture failed unexpectedly.";
    console.error("[scrolling-screenshot] capture failed", error);
    await setStatus(tabId, "!", "#b91c1c", message).catch(() => {});
  } finally {
    captureInProgress = false;
    scheduleStatusClear(tabId);
  }
}
async function execInTab(tabId, func, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  const result = results?.[0]?.result;
  if (result === void 0)
    throw new Error("Could not run the capture code on this page.");
  return result;
}
async function runInTab(tabId, func, args) {
  await chrome.scripting.executeScript({ target: { tabId }, func, args });
}
async function captureFullPage(tab) {
  const tabId = tab.id;
  const metrics = await execInTab(tabId, getMetrics, []);
  if (metrics.viewportHeight <= 0 || metrics.scrollHeight <= 0) {
    throw new Error("This page has no scrollable content.");
  }
  const canvasHeight = Math.round(
    metrics.scrollHeight * metrics.devicePixelRatio,
  );
  if (canvasHeight > MAX_CANVAS_HEIGHT_PX) {
    throw new Error(`This page is too tall for one PNG (${canvasHeight}px).`);
  }
  const overlap = Math.min(
    CAPTURE_OVERLAP_CSS_PX,
    Math.floor(metrics.viewportHeight * 0.3),
  );
  const positions = computeScrollPositions(
    metrics.scrollHeight,
    metrics.viewportHeight,
    overlap,
  );
  const windowId = tab.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
  const tiles = [];
  await runInTab(tabId, prepareCapture, []);
  try {
    for (let index = 0; index < positions.length; index += 1) {
      if (index > 0) {
        if (index === 1) await runInTab(tabId, hideFixedElements, []);
        await delay(CAPTURE_THROTTLE_MS);
      }
      const { scrollY } = await execInTab(tabId, scrollToPosition, [
        positions[index],
      ]);
      await runInTab(tabId, waitForCaptureReady, []);
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: "png",
      });
      tiles.push({ dataUrl, scrollY });
      const percent = Math.round(((index + 1) / positions.length) * 100);
      await setStatus(
        tabId,
        String(percent),
        "#2563eb",
        `Capturing full page… ${percent}%`,
      );
    }
  } finally {
    await runInTab(tabId, restoreCapture, []);
  }
  return execInTab(tabId, stitchTiles, [tiles, metrics]);
}
async function setStatus(tabId, text, color, title) {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
    chrome.action.setTitle({ tabId, title }),
  ]);
}
function scheduleStatusClear(tabId) {
  statusClearTimer = setTimeout(() => {
    void Promise.all([
      chrome.action.setBadgeText({ tabId, text: "" }),
      chrome.action.setTitle({
        tabId,
        title: "scrolling-screenshot — Capture full page",
      }),
    ]).catch(() => {});
  }, STATUS_CLEAR_MS);
}
function clearScheduledStatus() {
  if (statusClearTimer !== void 0) clearTimeout(statusClearTimer);
  statusClearTimer = void 0;
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
