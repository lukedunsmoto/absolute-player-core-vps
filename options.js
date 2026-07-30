// Advanced settings, stored in chrome.storage.local:
//   directStreaming (default true) — remote file mode: true = Transcode while
//     Download (range streaming when supported), false = Download then
//     Transcode (always pre-download first).
//   cacheResolvedUrls (default true) — fetch chunks from a redirect's resolved
//     destination instead of re-resolving through the redirector every time.
//   chunkSizeMB (default 8) — range-request size for directly streamed remote
//     sources: 8 = Normal, 16 = Fast, 32 = Very Fast.
//   forceOnTop (default false) — give the player frame a maximal z-index so
//     leftover site overlays can't cover it.
//   transcodeQuality (default "normal") — encoder effort for re-encoded
//     streams: normal | high | highest.
//
// Sidebar navigation: add a .nav-item with data-section="x" plus a matching
// <section id="section-x"> in <main> and it registers automatically.
for (const btn of document.querySelectorAll(".nav-item")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".nav-item")) {
      b.classList.toggle("active", b === btn);
    }
    for (const s of document.querySelectorAll("main > section")) {
      s.hidden = s.id !== `section-${btn.dataset.section}`;
    }
  });
}

const radios = document.querySelectorAll('input[name="mode"]');

chrome.storage.local
  .get({ directStreaming: true })
  .then(({ directStreaming }) => {
    for (const r of radios) r.checked = r.value === (directStreaming ? "stream" : "prefetch");
  })
  .catch(() => {
    for (const r of radios) r.checked = r.value === "stream";
  });

for (const r of radios) {
  r.addEventListener("change", () => {
    if (r.checked) chrome.storage.local.set({ directStreaming: r.value === "stream" });
  });
}

const forceOnTopEl = document.getElementById("force-on-top");

chrome.storage.local
  .get({ forceOnTop: false })
  .then(({ forceOnTop }) => {
    forceOnTopEl.checked = forceOnTop;
  })
  .catch(() => {
    forceOnTopEl.checked = false;
  });

forceOnTopEl.addEventListener("change", () => {
  chrome.storage.local.set({ forceOnTop: forceOnTopEl.checked });
});

const cacheResolvedEl = document.getElementById("cache-resolved");

chrome.storage.local
  .get({ cacheResolvedUrls: true })
  .then(({ cacheResolvedUrls }) => {
    cacheResolvedEl.checked = cacheResolvedUrls;
  })
  .catch(() => {
    cacheResolvedEl.checked = true;
  });

cacheResolvedEl.addEventListener("change", () => {
  chrome.storage.local.set({ cacheResolvedUrls: cacheResolvedEl.checked });
});

// Stepped sliders: values[] maps slider index → stored value. Tick labels
// double as click targets. values[0] is the default.
function wireSlider(id, key, values) {
  const el = document.getElementById(id);
  const ticks = el.closest(".range-wrap").querySelectorAll(".ticks span");

  const paint = (idx) => {
    el.value = String(idx);
    for (const t of ticks) t.classList.toggle("on", Number(t.dataset.idx) === idx);
  };
  const commit = (idx) => {
    paint(idx);
    chrome.storage.local.set({ [key]: values[idx] });
  };

  chrome.storage.local
    .get({ [key]: values[0] })
    .then((got) => {
      const idx = values.indexOf(got[key]);
      paint(idx === -1 ? 0 : idx);
    })
    .catch(() => paint(0));

  el.addEventListener("input", () => commit(Number(el.value)));
  for (const t of ticks) t.addEventListener("click", () => commit(Number(t.dataset.idx)));
}

wireSlider("net-speed", "chunkSizeMB", [8, 16, 32]);
wireSlider("transcode-quality", "transcodeQuality", ["normal", "high", "highest"]);
