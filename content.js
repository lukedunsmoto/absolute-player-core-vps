// Content script: finds <video> elements whose sources the browser can't
// play (unsupported containers like MKV, or sources that fire a decode
// error) and swaps them for the extension's ffmpeg.wasm player in an iframe.

(() => {
  // Containers Chrome never plays natively — intercept on sight.
  const ALWAYS_INTERCEPT =
    /\.(mkv|avi|flv|wmv|ts|m2ts|mts|vob|mpg|mpeg|3gp2?|f4v|ogm|rm|rmvb|asf|divx)(\?|#|$)/i;

  // Normally-fine containers that may still hold unplayable codecs — only
  // intercept these after the element actually errors out.
  const ON_ERROR_INTERCEPT =
    /\.(mp4|m4v|mov|webm|ogv|mp2t)(\?|#|$)/i;

  const handled = new WeakSet();

  // Enable/disable toggle (popup). Off = stop intercepting; already-swapped
  // players stay until the page is refreshed.
  let enabled = false;
  let started = false;

  // "Force player above other page content" (Settings → Player).
  const ON_TOP_CLASS = "wvp-on-top";
  let forceOnTop = false;

  function applyOnTop() {
    for (const f of document.querySelectorAll(".wasm-video-player-frame")) {
      f.classList.toggle(ON_TOP_CLASS, forceOnTop);
    }
  }

  function sourceURL(video) {
    const direct = video.currentSrc || video.src;
    if (direct && !direct.startsWith("blob:") && !direct.startsWith("mediasource:")) {
      return direct;
    }
    for (const s of video.querySelectorAll("source")) {
      if (s.src && !s.src.startsWith("blob:")) return s.src;
    }
    return null;
  }

  function absolute(url) {
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return null;
    }
  }

  function replaceWithPlayer(video, url) {
    if (handled.has(video)) return;
    handled.add(video);

    const rect = video.getBoundingClientRect();
    const width = Math.max(Math.round(rect.width) || video.width || 0, 320);
    const height = Math.max(Math.round(rect.height) || video.height || 0, 180);

    const frame = document.createElement("iframe");
    frame.className = "wasm-video-player-frame" + (forceOnTop ? ` ${ON_TOP_CLASS}` : "");
    frame.allow = "fullscreen; autoplay";
    frame.allowFullscreen = true;
    frame.style.width = width + "px";
    frame.style.height = height + "px";
    frame.src =
      chrome.runtime.getURL("player.html") +
      `?enc=1&embedded=1&src=${encodeURIComponent(url)}`;

    video.pause?.();
    video.replaceWith(frame);
  }

  function check(video) {
    if (!enabled || handled.has(video)) return;
    const url = sourceURL(video);
    if (!url) return;
    const abs = absolute(url);
    if (!abs || !/^(https?|file):/i.test(abs)) return;
    if (ALWAYS_INTERCEPT.test(abs)) replaceWithPlayer(video, abs);
  }

  // Catch decode/format failures on containers the browser normally accepts.
  document.addEventListener(
    "error",
    (e) => {
      if (!enabled) return;
      const el = e.target;
      if (!(el instanceof HTMLVideoElement) && !(el instanceof HTMLSourceElement)) return;
      const video = el instanceof HTMLSourceElement ? el.closest("video") : el;
      if (!video || handled.has(video)) return;
      const err = video.error;
      if (err && err.code !== MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED && err.code !== MediaError.MEDIA_ERR_DECODE) {
        return;
      }
      const url = sourceURL(video);
      const abs = url && absolute(url);
      if (!abs || !/^(https?|file):/i.test(abs)) return;
      if (ALWAYS_INTERCEPT.test(abs) || ON_ERROR_INTERCEPT.test(abs)) {
        replaceWithPlayer(video, abs);
      }
    },
    true
  );

  function scan(root) {
    if (root instanceof HTMLVideoElement) {
      check(root);
      return;
    }
    if (root.querySelectorAll) {
      for (const v of root.querySelectorAll("video")) check(v);
    }
  }

  function start() {
    if (started) return;
    started = true;
    scan(document);
    new MutationObserver((mutations) => {
      if (!enabled) return;
      for (const m of mutations) {
        if (m.type === "attributes") {
          const t = m.target;
          const video = t instanceof HTMLSourceElement ? t.closest("video") : t;
          if (video instanceof HTMLVideoElement) check(video);
        } else {
          for (const node of m.addedNodes) {
            if (node instanceof Element) scan(node);
          }
        }
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  }

  chrome.storage.local.get({ enabled: true, forceOnTop: false }).then((v) => {
    enabled = v.enabled;
    forceOnTop = v.forceOnTop;
    if (enabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.forceOnTop) {
      forceOnTop = changes.forceOnTop.newValue;
      applyOnTop(); // takes effect on players already swapped in
    }
    if (!changes.enabled) return;
    enabled = changes.enabled.newValue;
    if (enabled) {
      started ? scan(document) : start();
    }
  });
})();
