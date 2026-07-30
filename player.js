// Player page. Converts the source with ffmpeg.wasm (driven via
// mse-worker.js) and plays it. Two modes:
//
// 1. STREAMING (default): ffmpeg emits fragmented MP4; chunks are appended
//    to a MediaSource SourceBuffer as they are produced, so playback starts
//    almost immediately, while conversion is still running. If the codecs
//    are browser-decodable (H.264, VP9, AV1, hw-HEVC / AAC, Opus, FLAC)
//    they are only remuxed (-c copy); otherwise that stream is transcoded
//    to H.264/AAC.
// 2. LEGACY (fallback): convert the whole file to a Blob, then play it.
//
// Failures escalate through tiers: stream-remux → stream-transcode →
// legacy-transcode.

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const barEl = $("progress-bar");
const logEl = $("log");
const videoEl = $("video");
const fileEl = $("filename");

const MAX_FETCH_BYTES = 4 * 1024 * 1024 * 1024; // cap for the in-memory fallback only
const OPFS_PREFIX = "wvp-src-"; // temp download files in origin-private FS
const SPOOL_PREFIX = "wvp-spool-"; // converted-stream store segments in OPFS
const SPOOL_SEGMENT_BYTES = 16 * 1024 * 1024; // one store file per ~16 MB

let logBuffer = [];
let sourceBlob = null; // Blob or File — worker reads it lazily via WORKERFS
let sourceRemote = null; // {url, size} — worker streams it via HTTP ranges
let netStat = null; // {fetched, size} while streaming directly
let sourceName = "video";
let sourceSafeName = "input.bin";
let sourcePath = null; // mounted path inside the worker FS
let probed = null; // {video, audio, duration}
let converting = false;
let lastSuccessTier = -1;
let lastAttemptPlan = null;
let lastAttemptTier = null;
let attemptGen = 0;
let tiersList = [];
let currentAppender = null;
let lastObjectURL = null;
let phase = ""; // "convert" while ffmpeg runs, used to gate progress updates
let phaseVerb = "";

// ---------- URL parsing ----------
// Two forms: "?enc=1&...&src=<encoded>" (our own links) and "?src=<raw URL>"
// appended un-encoded by the declarativeNetRequest redirect.
function parseSource() {
  const q = location.search;
  const m = q.indexOf("src=");
  if (m === -1) return null;
  const raw = q.slice(m + 4);
  if (q.startsWith("?enc=1")) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

const embedded = location.search.includes("embedded=1");
if (embedded) document.body.classList.add("embedded");

// ---------- UI helpers ----------
function setStatus(text) {
  statusEl.textContent = text;
}

function setProgress(ratio) {
  barEl.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
}

function appendLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > 3000) logBuffer = logBuffer.slice(-1500);
  if (!logEl.hidden) {
    logEl.textContent = logBuffer.join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }
}

$("btn-log-toggle").addEventListener("click", () => {
  logEl.hidden = !logEl.hidden;
  $("btn-log-toggle").textContent = logEl.hidden ? "Show log" : "Hide log";
  if (!logEl.hidden) {
    logEl.textContent = logBuffer.join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }
});

function fail(message) {
  setStatus(`❌ ${message}`);
  setProgress(0);
  document.body.classList.remove("playing");
}

videoEl.addEventListener("playing", () => document.body.classList.add("playing"));

// Decode error after a tier reported success (e.g. remux of a codec the
// device can't actually play) → escalate to the next tier.
videoEl.addEventListener("error", () => {
  if (!converting) escalate();
});

function onFFProgress(data) {
  if (phase !== "convert") return;
  let p = data && typeof data.progress === "number" ? data.progress : 0;
  if ((!p || !isFinite(p)) && data?.time && probed?.duration) {
    p = data.time / 1e6 / probed.duration;
  }
  if (p > 0 && p <= 1.05) {
    setProgress(p);
    const net =
      netStat && netStat.size
        ? ` · fetched ${(netStat.fetched / 1e6).toFixed(0)} / ${(netStat.size / 1e6).toFixed(0)} MB`
        : "";
    setStatus(`${phaseVerb} ${(Math.min(p, 1) * 100).toFixed(0)}%${net}`);
  }
}

// ---------- worker RPC ----------
class FFWorker {
  constructor() {
    this.worker = new Worker(chrome.runtime.getURL("mse-worker.js"), { type: "module" });
    this.pending = new Map();
    this.nextId = 1;
    this.onChunk = null;
    this.worker.onmessage = ({ data: { id, type, data } }) => {
      if (type === "log") return appendLog(data);
      if (type === "progress") return onFFProgress(data);
      if (type === "netstat") return void (netStat = data);
      if (type === "chunk") return this.onChunk?.(new Uint8Array(data));
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (type === "error") p.reject(new Error(data.message));
      else p.resolve(data);
    };
    this.worker.onerror = (e) => this._rejectAll(new Error(e.message || "worker error"));
  }
  _rejectAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
  call(type, data) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, data });
    });
  }
  terminate() {
    this._rejectAll(new Error("worker terminated"));
    this.worker.terminate();
  }
}

let ffw = null;

async function getWorker() {
  if (ffw) return ffw;
  setStatus("Loading FFmpeg core (~32 MB, cached after first load)…");
  const w = new FFWorker();
  await w.call("init", {
    coreURL: chrome.runtime.getURL("vendor/core/ffmpeg-core.js"),
    wasmURL: chrome.runtime.getURL("vendor/core/ffmpeg-core.wasm"),
  });
  ffw = w;
  return w;
}

function resetWorker() {
  ffw?.terminate();
  ffw = null;
  sourcePath = null;
}

async function ensureSource(w) {
  if (!sourcePath) {
    const payload = sourceRemote
      ? {
          url: sourceRemote.url,
          resolvedUrl: sourceRemote.resolvedUrl,
          size: sourceRemote.size,
          name: sourceSafeName,
          cacheResolved: await getSetting("cacheResolvedUrls", true),
          chunkSize: (await getSetting("chunkSizeMB", 8)) * 1024 * 1024,
        }
      : { blob: sourceBlob, name: sourceSafeName };
    const { path } = await w.call("setSource", payload);
    sourcePath = path;
  }
  return sourcePath;
}

// Advanced settings (options page). Falls back to the shipped default
// outside extension contexts (e.g. the test harness).
//   directStreaming   — "Transcode while Download" vs "Download then Transcode"
//   cacheResolvedUrls — fetch chunks from a redirect's resolved destination
//   chunkSizeMB       — network speed → range-request size (8/16/32 MB)
async function getSetting(key, fallback) {
  try {
    const got = await chrome.storage.local.get({ [key]: fallback });
    return got[key];
  } catch {
    return fallback;
  }
}

// A server that answers a 1-byte range request with 206 + Content-Range can
// be streamed directly — no pre-download. Content-Encoding rules it out
// (ranges would address compressed bytes).
async function probeRangeSupport(url) {
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-1" } });
    const ok =
      res.status === 206 &&
      !res.headers.get("content-encoding") &&
      /\/(\d+)\s*$/.test(res.headers.get("content-range") || "");
    const size = ok ? Number(/\/(\d+)\s*$/.exec(res.headers.get("content-range"))[1]) : 0;
    res.body?.cancel();
    // res.url is the FINAL location after any redirects — fetching it
    // directly spares the redirector a round-trip per chunk.
    if (ok && size > 0) return { url, resolvedUrl: res.url || url, size };
  } catch {}
  return null;
}

async function probeSource(w, inputPath) {
  if (probed) return probed;
  setStatus("Analyzing streams…");
  const before = logBuffer.length;
  await w.call("exec", { args: ["-hide_banner", "-i", inputPath] }); // non-zero exit expected
  const text = logBuffer.slice(before).join("\n");
  const vm = /Stream #\d+:\d+.*?: Video: (\w+)(?: \(([^)]+)\))?/.exec(text);
  const video = vm?.[1] ?? null;
  const videoProfile = vm?.[2] ?? "";
  const audio = /Stream #\d+:\d+.*?: Audio: (\w+)/.exec(text)?.[1] ?? null;
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);
  const duration = d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : NaN;
  probed = { video, videoProfile, audio, duration };
  appendLog(`>>> detected: video=${video} (${videoProfile}) audio=${audio} duration=${duration}s`);
  return probed;
}

// ---------- conversion planning ----------
const probeVideoEl = document.createElement("video");
const canPlay = (type) => probeVideoEl.canPlayType(type) !== "";

// Transcode quality (Settings → Transcoding). Only applies to streams that
// are re-encoded; copied streams are bit-exact regardless. "normal" is the
// long-standing default. Slower presets compress better but can fall behind
// real-time on large video, which stalls playback at the frontier.
const TRANSCODE_QUALITY = {
  normal: { preset: "ultrafast", crf: "23", audioBitrate: "160k" },
  high: { preset: "veryfast", crf: "21", audioBitrate: "192k" },
  highest: { preset: "faster", crf: "20", audioBitrate: "256k" },
};

const qualityOf = (plan) => TRANSCODE_QUALITY[plan?.quality] || TRANSCODE_QUALITY.normal;

// Streaming (MSE, fragmented MP4) plan.
const MSE_VIDEO_CODEC = {
  h264: "avc1.640033",
  vp9: "vp09.00.10.08",
  av1: "av01.0.04M.08",
};
const MSE_AUDIO_CODEC = { aac: "mp4a.40.2", opus: "opus", flac: "flac" };

function mseVideoTag(codecs) {
  if (codecs.video === "hevc") {
    // Main 10 (HDR) is profile 2; plain Main is profile 1. L153 = level 5.1
    // (covers 4K60); Chrome only gates on codec+profile, not exact level.
    return /main 10/i.test(codecs.videoProfile) ? "hvc1.2.4.L153.B0" : "hvc1.1.6.L123.B0";
  }
  return MSE_VIDEO_CODEC[codecs.video];
}

function planStream(codecs, force) {
  const vTagCopy = mseVideoTag(codecs);
  const videoCopy =
    !force && !!vTagCopy && MediaSource.isTypeSupported(`video/mp4; codecs="${vTagCopy}"`);
  const audioCopy = !force && (codecs.audio === null || !!MSE_AUDIO_CODEC[codecs.audio]);
  const vTag = videoCopy ? vTagCopy : "avc1.640033";
  const aTag =
    codecs.audio === null ? null : audioCopy ? MSE_AUDIO_CODEC[codecs.audio] : "mp4a.40.2";
  const mime = `video/mp4; codecs="${aTag ? `${vTag},${aTag}` : vTag}"`;
  return { videoCopy, audioCopy, mime, vcodec: codecs.video, remuxOnly: videoCopy && audioCopy };
}

function buildStreamArgs(inputPath, plan, outPath) {
  const q = qualityOf(plan);
  const args = ["-hide_banner", "-i", inputPath, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"];
  if (plan.videoCopy) {
    args.push("-c:v", "copy");
    // ffmpeg tags copied HEVC as 'hev1' by default; browsers want 'hvc1'.
    if (plan.vcodec === "hevc") args.push("-tag:v", "hvc1");
  } else {
    // GOP stays fixed across quality levels: frequent keyframes keep
    // fragments small, which is what makes startup fast and seeking precise.
    args.push("-c:v", "libx264", "-preset", q.preset, "-crf", q.crf,
      "-vf", "format=yuv420p", "-g", "48", "-keyint_min", "48");
  }
  if (plan.audioCopy) {
    args.push("-c:a", "copy");
  } else {
    // first_pts=0 normalizes decoder-side start offsets (e.g. MP3's LAME
    // delay), which otherwise can push fragment timestamps negative.
    // aformat pins the layout to standard AAC channel configs — otherwise
    // layouts like 5.1(side) (every AC-3/E-AC-3 decode) make the encoder
    // emit an in-band PCE, which Chrome's MSE parser rejects.
    args.push("-c:a", "aac", "-b:a", q.audioBitrate,
      "-af", "aresample=async=1:first_pts=0,aformat=channel_layouts=5.1|stereo|mono");
  }
  args.push(
    "-avoid_negative_ts", "make_zero",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "-y", outPath
  );
  return args;
}

// Legacy (whole-file Blob) plan — same logic the pre-MSE version used.
function planLegacy(codecs, force) {
  const copyableVideo = new Set(["h264", "vp9", "av1"]);
  if (canPlay('video/mp4; codecs="hvc1.1.6.L93.B0"')) copyableVideo.add("hevc");
  const copyableAudio = new Set(["aac", "mp3", "opus", "flac"]);

  const plan = { container: "mp4", videoCopy: true, audioCopy: true };
  if (codecs.video === "vp8" && !force) {
    plan.container = "webm";
    plan.audioCopy = codecs.audio === null || ["vorbis", "opus"].includes(codecs.audio);
  } else {
    plan.videoCopy = !force && codecs.video !== null && copyableVideo.has(codecs.video);
    plan.audioCopy = !force && (codecs.audio === null || copyableAudio.has(codecs.audio));
    plan.container = "mp4";
  }
  plan.remuxOnly = plan.videoCopy && plan.audioCopy;
  plan.vcodec = codecs.video;
  return plan;
}

function buildLegacyArgs(inputPath, plan, outPath) {
  const q = qualityOf(plan);
  const args = ["-hide_banner", "-i", inputPath, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"];
  if (plan.videoCopy) {
    args.push("-c:v", "copy");
    if (plan.vcodec === "hevc" && plan.container === "mp4") args.push("-tag:v", "hvc1");
  } else if (plan.container === "webm") {
    args.push("-c:v", "copy");
  } else {
    args.push("-c:v", "libx264", "-preset", q.preset, "-crf", q.crf, "-vf", "format=yuv420p");
  }
  if (plan.audioCopy) args.push("-c:a", "copy");
  else if (plan.container === "webm") args.push("-c:a", "libopus", "-b:a", "128k");
  else args.push("-c:a", "aac", "-b:a", q.audioBitrate);
  if (plan.container === "mp4") args.push("-movflags", "+faststart");
  args.push("-y", outPath);
  return args;
}

// ---------- "save converted" ----------
// The download button is backed by the StreamStore: once the producer
// finishes cleanly, the store's segments ARE the complete converted file.
// A Blob built from File parts is reference-based (no copy), so the link
// costs no memory or extra disk at any output size. The link stays valid
// for as long as the store's files live (i.e. this player session).
const saver = {
  reset() {
    $("btn-download").hidden = true;
  },
  async fromStore(store, container) {
    try {
      store._flush(); // seal the tail into a segment file
      await store.flushing;
      if (store.failed || store.disposed || !store.total) return;
      const root = await navigator.storage.getDirectory();
      const parts = [];
      for (const f of store.files) {
        parts.push(await (await root.getFileHandle(f.name)).getFile());
      }
      for (const c of store.buf) parts.push(c); // any unsealed remainder
      const blob = new Blob(parts, { type: container === "webm" ? "video/webm" : "video/mp4" });
      if (blob.size !== store.total) {
        appendLog(">>> save link skipped: store size mismatch");
        return;
      }
      this.setBlob(blob, container);
      appendLog(`>>> converted file complete — download ready (${(blob.size / 1e6).toFixed(1)} MB)`);
    } catch (e) {
      appendLog(`>>> save link unavailable: ${e.message}`);
    }
  },
  setBlob(blob, container) {
    const dl = $("btn-download");
    if (dl.href && dl.href.startsWith("blob:")) URL.revokeObjectURL(dl.href);
    dl.href = URL.createObjectURL(blob);
    dl.download = sourceName.replace(/\.\w+$/, "") + "." + container;
    dl.hidden = false;
  },
};

// ---------- converted-stream store ----------
// Every converted chunk is retained on disk for the whole session (numbered
// OPFS segment files, ~16 MB each) and indexed by fragment (moof) timestamps
// as it flows through. The SourceBuffer stays a small sliding window, but
// any already-converted moment can be re-appended from disk on seek — the
// exact original bytes on the original timeline, so A/V sync cannot drift.
// If the box scanner ever fails on unexpected structure, the store degrades
// to a raw sequential feed (playback preserved, store-seeking disabled).

const be32 = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
const str4 = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);

function* childBoxes(u8, start, end) {
  let p = start;
  while (p + 8 <= end) {
    const sz = be32(u8, p);
    if (sz < 8 || p + sz > end) return;
    yield { type: str4(u8, p + 4), start: p + 8, end: p + sz };
    p += sz;
  }
}

class StreamStore {
  constructor() {
    this.id = `${SPOOL_PREFIX}${Date.now()}-${crypto.randomUUID()}`;
    this.files = []; // flushed segments: {name, start, size}
    this.buf = []; // unflushed tail chunks (also serves reads near the live edge)
    this.bufBytes = 0;
    this.bufStart = 0; // absolute offset of the first tail byte
    this.total = 0; // absolute bytes appended so far
    this.flushing = Promise.resolve();
    this.failed = null;
    this.disposed = false;
    this.rootP = null;
    this.producerDone = false;
    // fragment index
    this.indexBroken = false;
    this.timescales = null; // trackId → timescale (from moov)
    this.initEnd = 0; // init segment = [0, initEnd) — set at the first moof
    this.frags = []; // {offset, seconds}
    // incremental top-level box scanner
    this.pos = 0; // absolute offset of the next unscanned byte
    this.hdr = new Uint8Array(16);
    this.hdrLen = 0;
    this.skip = 0;
    this.collect = null; // {type, offset, need, parts} for moov/moof bodies
  }

  _root() {
    if (!this.rootP) this.rootP = navigator.storage.getDirectory();
    return this.rootP;
  }

  append(chunk) {
    if (this.failed || this.disposed) return false;
    this.buf.push(chunk);
    this.bufBytes += chunk.length;
    this.total += chunk.length;
    if (!this.indexBroken) {
      try {
        this._scan(chunk);
      } catch (e) {
        this.indexBroken = true;
        appendLog(`>>> stream index failed (${e.message}) — store-seeking disabled`);
      }
    }
    if (this.bufBytes >= SPOOL_SEGMENT_BYTES) this._flush();
    return !this.failed;
  }

  _flush() {
    if (!this.bufBytes || this.failed || this.disposed) return;
    const parts = this.buf;
    const name = `${this.id}-${this.files.length}`;
    this.files.push({ name, start: this.bufStart, size: this.bufBytes });
    this.bufStart += this.bufBytes;
    this.buf = [];
    this.bufBytes = 0;
    this.flushing = this.flushing
      .then(async () => {
        const root = await this._root();
        const h = await root.getFileHandle(name, { create: true });
        const w = await h.createWritable();
        for (const p of parts) await w.write(p);
        await w.close();
      })
      .catch((e) => {
        this.failed = e;
      });
  }

  // Incremental top-level box walk; moov/moof bodies are buffered (they're
  // small) for index parsing, everything else is skipped by size.
  _scan(chunk) {
    let i = 0;
    while (i < chunk.length) {
      if (this.skip > 0) {
        const take = Math.min(this.skip, chunk.length - i);
        this.skip -= take;
        i += take;
        this.pos += take;
        continue;
      }
      if (this.collect) {
        const c = this.collect;
        const take = Math.min(c.need, chunk.length - i);
        c.parts.push(chunk.slice(i, i + take));
        c.need -= take;
        i += take;
        this.pos += take;
        if (c.need === 0) {
          this._boxDone(c);
          this.collect = null;
        }
        continue;
      }
      this.hdr[this.hdrLen++] = chunk[i++];
      this.pos++;
      if (this.hdrLen !== 8 && this.hdrLen !== 16) continue;
      let size = be32(this.hdr, 0);
      let hdrBytes = 8;
      if (size === 1) {
        if (this.hdrLen < 16) continue; // wait for the 64-bit largesize
        size = be32(this.hdr, 8) * 4294967296 + be32(this.hdr, 12);
        hdrBytes = 16;
      }
      const type = str4(this.hdr, 4);
      if (size < hdrBytes || !/^[\x20-\x7e]{4}$/.test(type)) throw new Error(`bad box at ${this.pos - this.hdrLen}`);
      const offset = this.pos - this.hdrLen;
      const bodyLen = size - hdrBytes;
      this.hdrLen = 0;
      if (type === "moov" || type === "moof") {
        if (bodyLen > 8 * 1024 * 1024) throw new Error("oversized header box");
        this.collect = { type, offset, need: bodyLen, parts: [] };
        if (bodyLen === 0) {
          this._boxDone(this.collect);
          this.collect = null;
        }
      } else {
        this.skip = bodyLen;
      }
    }
  }

  _boxDone(c) {
    const body = new Uint8Array(c.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of c.parts) {
      body.set(p, o);
      o += p.length;
    }
    if (c.type === "moov") this._parseMoov(body);
    else this._parseMoof(body, c.offset);
  }

  _parseMoov(body) {
    const ts = new Map();
    for (const trak of childBoxes(body, 0, body.length)) {
      if (trak.type !== "trak") continue;
      let trackId = null;
      let scale = null;
      for (const b of childBoxes(body, trak.start, trak.end)) {
        if (b.type === "tkhd") {
          trackId = be32(body, b.start + (body[b.start] === 1 ? 20 : 12));
        } else if (b.type === "mdia") {
          for (const m of childBoxes(body, b.start, b.end)) {
            if (m.type === "mdhd") scale = be32(body, m.start + (body[m.start] === 1 ? 20 : 12));
          }
        }
      }
      if (trackId != null && scale) ts.set(trackId, scale);
    }
    if (!ts.size) throw new Error("no timescales in moov");
    this.timescales = ts;
  }

  _parseMoof(body, offset) {
    if (!this.initEnd) this.initEnd = offset;
    if (!this.timescales) throw new Error("moof before moov");
    let seconds = Infinity;
    for (const traf of childBoxes(body, 0, body.length)) {
      if (traf.type !== "traf") continue;
      let trackId = null;
      let tfdt = null;
      for (const b of childBoxes(body, traf.start, traf.end)) {
        if (b.type === "tfhd") trackId = be32(body, b.start + 4);
        else if (b.type === "tfdt") {
          tfdt =
            body[b.start] === 1
              ? be32(body, b.start + 4) * 4294967296 + be32(body, b.start + 8)
              : be32(body, b.start + 4);
        }
      }
      const scale = trackId != null ? this.timescales.get(trackId) : null;
      if (tfdt != null && scale) seconds = Math.min(seconds, tfdt / scale);
    }
    if (!isFinite(seconds)) throw new Error("moof without tfdt");
    this.frags.push({ offset, seconds });
  }

  // Byte range of fragment i: [frags[i].offset, fragmentEnd(i)). The live
  // (latest) fragment's end is unknown until the next moof arrives or the
  // producer finishes.
  fragmentEnd(i) {
    if (i + 1 < this.frags.length) return this.frags[i + 1].offset;
    return this.producerDone ? this.total : null;
  }

  // Last fragment starting at or before t, or null if t can't be served yet.
  indexForTime(t) {
    if (this.indexBroken || !this.frags.length) return null;
    let lo = 0;
    let hi = this.frags.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.frags[mid].seconds <= t) lo = mid;
      else hi = mid - 1;
    }
    if (this.fragmentEnd(lo) == null) return null; // live edge — end unknown yet
    return lo;
  }

  async readRange(start, end) {
    if (this.failed) throw this.failed;
    await this.flushing; // segment files are only readable once closed
    if (this.failed) throw this.failed;
    const out = new Uint8Array(end - start);
    for (const f of this.files) {
      if (f.start + f.size <= start || f.start >= end) continue;
      const s = Math.max(start, f.start);
      const e = Math.min(end, f.start + f.size);
      const root = await this._root();
      const h = await root.getFileHandle(f.name);
      const file = await h.getFile();
      const ab = await file.slice(s - f.start, e - f.start).arrayBuffer();
      out.set(new Uint8Array(ab), s - start);
    }
    if (end > this.bufStart) {
      let p = this.bufStart;
      for (const c of this.buf) {
        const ce = p + c.length;
        if (ce > start && p < end) {
          const s = Math.max(start, p);
          const e = Math.min(end, ce);
          out.set(c.subarray(s - p, e - p), s - start);
        }
        p = ce;
      }
    }
    return out;
  }

  dispose() {
    this.disposed = true;
    const names = this.files.map((f) => f.name);
    this.files = [];
    this.buf = [];
    this.bufBytes = 0;
    this._root()
      .then((root) => {
        for (const n of names) root.removeEntry(n).catch(() => {});
      })
      .catch(() => {});
  }
}

// ---------- MediaSource appender ----------
class MSEAppender {
  constructor(video, mime, duration) {
    this.video = video;
    this.mime = mime;
    this.duration = duration;
    this.store = new StreamStore();
    this.cursor = -1; // -1 → init segment next; else next fragment index
    this.rawCursor = 0; // byte cursor for the raw (index-broken) fallback
    this.seekCursor = null; // fragment to jump to after re-appending init
    this.pending = null; // {bytes, r} — read from store, awaiting append
    this.loading = false;
    this.readGen = 0;
    this.ended = false;
    this.failed = null;
    this.started = false;
    this.sb = null;
    this.onstart = null;
    this.failure = new Promise((res) => (this._failRes = res));
    this._doneRes = null;
    this.ms = new MediaSource();
    this.objectURL = URL.createObjectURL(this.ms);
    this.ready = new Promise((res, rej) => {
      this.ms.addEventListener(
        "sourceopen",
        () => {
          try {
            this.sb = this.ms.addSourceBuffer(this.mime);
            if (isFinite(this.duration) && this.duration > 0) {
              try {
                this.ms.duration = this.duration;
              } catch {}
            }
            this.sb.addEventListener("updateend", () => this._onUpdateEnd());
            this.sb.addEventListener("error", () =>
              this._fail(new Error("SourceBuffer error (bad segment?)"))
            );
            res();
          } catch (e) {
            rej(e);
          }
        },
        { once: true }
      );
    });
    video.src = this.objectURL;
  }

  push(chunk) {
    if (this.failed) return;
    if (!this.store.append(chunk)) {
      this._fail(this.store.failed || new Error("disk store write failed"));
      return;
    }
    this._pump();
  }

  // Seek into already-converted content: re-append the stored init segment,
  // then replay fragments from the one covering t. Returns false when t is
  // beyond the converted frontier (playback then waits for the converter,
  // as before).
  seekTo(t) {
    if (this.failed || this.store.indexBroken) return false;
    const idx = this.store.indexForTime(t);
    if (idx == null) return false;
    this.readGen++; // cancel any in-flight store read
    this.loading = false;
    this.pending = null;
    try {
      if (this.ms.readyState === "open" && this.sb.updating) this.sb.abort();
    } catch {}
    this.seekCursor = idx;
    this.cursor = -1; // re-append init first: cheap, and resets cleanly
    appendLog(
      `>>> seek to ${Math.round(t)}s — replaying stored stream from ${Math.round(this.store.frags[idx].seconds)}s`
    );
    this._pump();
    return true;
  }

  async finish() {
    this.ended = true;
    this.store.producerDone = true;
    await new Promise((res) => {
      this._doneRes = res;
      this._pump();
    });
    if (this.failed) throw this.failed;
  }

  _onUpdateEnd() {
    if (!this.started && this.sb.buffered.length) {
      this.started = true;
      // Streams that don't start at t=0 (e.g. MPEG-TS offsets) need a nudge.
      const start = this.sb.buffered.start(0);
      if (start > 0.1 && this.video.currentTime < start) {
        this.video.currentTime = start + 0.01;
      }
      this.onstart?.();
    }
    this._pump();
  }

  // Next byte range to append: init segment, then fragments from the cursor,
  // skipping any already fully present in the SourceBuffer.
  _nextRange() {
    const st = this.store;
    if (st.indexBroken) {
      if (this.rawCursor >= st.total) return null;
      return { start: this.rawCursor, end: Math.min(this.rawCursor + 8 * 1024 * 1024, st.total), raw: true };
    }
    if (this.cursor === -1) {
      if (!st.initEnd) return null;
      return { start: 0, end: st.initEnd, init: true };
    }
    for (;;) {
      if (this.cursor >= st.frags.length) return null;
      const end = st.fragmentEnd(this.cursor);
      if (end == null) return null; // live edge — wait for the next moof
      const s = st.frags[this.cursor].seconds;
      const s2 = this.cursor + 1 < st.frags.length ? st.frags[this.cursor + 1].seconds : null;
      if (s2 != null && this._rangeBuffered(s + 0.1, Math.max(s + 0.1, s2 - 0.1))) {
        this.cursor++; // already in the SourceBuffer — no need to re-append
        continue;
      }
      return { start: st.frags[this.cursor].offset, end };
    }
  }

  _rangeBuffered(s, e) {
    const b = this.video.buffered;
    for (let i = 0; i < b.length; i++) {
      if (s >= b.start(i) && e <= b.end(i)) return true;
    }
    return false;
  }

  _caughtUp() {
    const st = this.store;
    if (!st.producerDone) return false;
    if (st.indexBroken) return this.rawCursor >= st.total;
    return this.cursor >= st.frags.length;
  }

  _pump() {
    if (!this.sb || this.sb.updating || this.failed) return;
    if (this.pending) {
      this._tryAppend();
      return;
    }
    if (this.loading) return;
    const r = this._nextRange();
    if (!r) {
      if (this.ended && this._caughtUp() && this.ms.readyState === "open" && this._doneRes) {
        try {
          this.ms.endOfStream();
        } catch {}
        this._doneRes();
      }
      return;
    }
    const gen = ++this.readGen;
    this.loading = true;
    this.store
      .readRange(r.start, r.end)
      .then((bytes) => {
        if (gen !== this.readGen) return; // superseded by a seek
        this.loading = false;
        this.pending = { bytes, r };
        this._tryAppend();
      })
      .catch((e) => {
        if (gen !== this.readGen) return;
        this.loading = false;
        this._fail(e);
      });
  }

  _tryAppend() {
    if (!this.sb || this.sb.updating || this.failed || !this.pending) return;
    try {
      this.sb.appendBuffer(this.pending.bytes);
      const r = this.pending.r;
      this.pending = null;
      if (r.raw) {
        this.rawCursor = r.end;
      } else if (r.init) {
        this.cursor = this.seekCursor ?? 0;
        this.seekCursor = null;
      } else {
        this.cursor++;
      }
    } catch (e) {
      if (e.name === "QuotaExceededError") this._evict();
      else this._fail(e);
    }
  }

  _evict() {
    // Free already-played media, then retry; if there's nothing to free yet,
    // wait for playback to advance.
    const ct = this.video.currentTime;
    try {
      if (this.sb.buffered.length && ct - this.sb.buffered.start(0) > 30) {
        this.sb.remove(0, ct - 15); // updateend re-pumps
        return;
      }
    } catch {}
    setTimeout(() => this._pump(), 2000);
  }

  _fail(err) {
    if (this.failed) return;
    this.failed = err;
    this._failRes(err);
    this._doneRes?.();
  }

  destroy() {
    this._fail(new Error("appender destroyed"));
    this.readGen++; // discard any in-flight store read
    this.pending = null;
    this.store.dispose();
    try {
      if (this.ms.readyState === "open") this.ms.endOfStream();
    } catch {}
    URL.revokeObjectURL(this.objectURL);
  }
}

// ---------- pipelines ----------
async function streamPipeline(force) {
  const w = await getWorker();
  const inputPath = await ensureSource(w);
  const codecs = await probeSource(w, inputPath);
  if (!codecs.video) throw new Error("No video stream found");

  const plan = planStream(codecs, force);
  plan.quality = await getSetting("transcodeQuality", "normal");
  lastAttemptPlan = plan;
  lastAttemptTier = force ? "stream-force" : "stream-auto";
  if (!MediaSource.isTypeSupported(plan.mime)) {
    throw new Error(`MSE rejects ${plan.mime}`);
  }

  const appender = new MSEAppender(videoEl, plan.mime, codecs.duration);
  currentAppender = appender;
  videoEl.hidden = false;
  await appender.ready;

  saver.reset();
  appender.onstart = () => videoEl.play().catch(() => {});
  w.onChunk = (bytes) => appender.push(bytes);

  phase = "convert";
  const vDesc = plan.videoCopy ? "copying video" : `converting ${codecs.video ?? "video"} → H.264`;
  const aDesc =
    codecs.audio === null
      ? "no audio"
      : plan.audioCopy
        ? "copying audio"
        : `converting ${codecs.audio} audio → AAC`;
  phaseVerb = `Streaming: ${vDesc}, ${aDesc} —`;
  setStatus(phaseVerb.replace(" —", "…"));
  setProgress(0);

  const args = buildStreamArgs(inputPath, plan, "/output.mp4");
  appendLog(`>>> ffmpeg ${args.join(" ")}`);

  const streamCall = w.call("stream", { args, outPath: "/output.mp4" });
  streamCall.catch(() => {}); // raced below; may lose after a failure
  const failed = appender.failure.then((e) => Promise.reject(e));
  failed.catch(() => {});

  try {
    const { ret, outOfOrder } = await Promise.race([streamCall, failed]);
    if (outOfOrder) throw new Error("muxer wrote non-sequentially — stream invalid");
    if (ret !== 0) throw new Error(`FFmpeg exited with code ${ret}`);
    // Producer done cleanly → the store now holds the complete file; the
    // download can go live immediately, long before playback finishes.
    await saver.fromStore(appender.store, "mp4");
    await appender.finish();
  } finally {
    w.onChunk = null;
    phase = "";
  }

  setStatus(plan.remuxOnly ? "✅ Remuxed — playing (streamed)." : "✅ Transcoded — playing (streamed).");
  setProgress(1);
  if (plan.remuxOnly) $("btn-transcode").hidden = false;
  videoEl.play().catch(() => {});
}

async function legacyPipeline(force) {
  const w = await getWorker();
  const inputPath = await ensureSource(w);
  const codecs = await probeSource(w, inputPath);

  const plan = planLegacy(codecs, force);
  plan.quality = await getSetting("transcodeQuality", "normal");
  lastAttemptPlan = plan;
  lastAttemptTier = force ? "legacy-force" : "legacy-auto";
  const outPath = "/legacy-out." + plan.container;
  const args = buildLegacyArgs(inputPath, plan, outPath);

  phase = "convert";
  phaseVerb = plan.remuxOnly ? "Remuxing —" : "Transcoding (whole file) —";
  setStatus(
    plan.remuxOnly
      ? `Remuxing to ${plan.container} (no re-encode)…`
      : "Transcoding whole file (slow, plays when done)…"
  );
  setProgress(0);
  appendLog(`>>> ffmpeg ${args.join(" ")}`);

  let data;
  try {
    const { ret } = await w.call("exec", { args });
    if (ret !== 0) throw new Error(`FFmpeg exited with code ${ret}`);
    data = await w.call("readFile", { path: outPath });
    await w.call("deleteFile", { path: outPath });
  } finally {
    phase = "";
  }
  if (!data || data.length === 0) throw new Error("conversion produced an empty file");

  const mime = plan.container === "webm" ? "video/webm" : "video/mp4";
  if (lastObjectURL) URL.revokeObjectURL(lastObjectURL);
  const blob = new Blob([data], { type: mime });
  lastObjectURL = URL.createObjectURL(blob);
  saver.reset();
  saver.setBlob(blob, plan.container);

  videoEl.hidden = false;
  videoEl.src = lastObjectURL;

  // Resolve success/failure so the tier loop can escalate on a bad file.
  await new Promise((res, rej) => {
    const ok = () => {
      cleanupListeners();
      res();
    };
    const bad = () => {
      cleanupListeners();
      rej(new Error(`playback failed (code ${videoEl.error?.code})`));
    };
    const cleanupListeners = () => {
      videoEl.removeEventListener("loadeddata", ok);
      videoEl.removeEventListener("error", bad);
    };
    videoEl.addEventListener("loadeddata", ok);
    videoEl.addEventListener("error", bad);
  });

  setStatus(plan.remuxOnly ? "✅ Remuxed — playing." : "✅ Transcoded — playing.");
  setProgress(1);
  if (plan.remuxOnly) $("btn-transcode").hidden = false;
  videoEl.play().catch(() => {});
}

// ---------- tier orchestration ----------
function cleanupAttempt() {
  currentAppender?.destroy();
  currentAppender = null;
  resetWorker();
  videoEl.removeAttribute("src");
  videoEl.load();
}

async function convertSource(startIdx = 0) {
  converting = true;
  $("btn-transcode").hidden = true;
  try {
    for (let i = startIdx; i < tiersList.length; i++) {
      const tier = tiersList[i];
      // Skip a forced tier only when the SAME pipeline already transcoded
      // BOTH streams (an identical retry). A partial-copy attempt (e.g.
      // copy video + convert audio) is NOT identical to a full transcode.
      const identicalRetry =
        (tier === "stream-force" && lastAttemptTier === "stream-auto") ||
        (tier === "legacy-force" && lastAttemptTier === "legacy-auto");
      if (identicalRetry && lastAttemptPlan && !lastAttemptPlan.videoCopy && !lastAttemptPlan.audioCopy) {
        continue;
      }
      const gen = ++attemptGen;
      try {
        if (tier === "stream-auto") await streamPipeline(false);
        else if (tier === "stream-force") await streamPipeline(true);
        else if (tier === "legacy-auto") await legacyPipeline(false);
        else await legacyPipeline(true);
        lastSuccessTier = i;
        return true;
      } catch (e) {
        if (gen !== attemptGen) return null; // superseded by a newer attempt
        console.error(e);
        appendLog(`>>> tier "${tier}" failed: ${e.message}`);
        cleanupAttempt();
      }
    }
    fail("All conversion strategies failed. Open the log for details.");
    return false;
  } finally {
    converting = false;
  }
}

function escalate() {
  if (converting) return;
  const next = lastSuccessTier + 1;
  if (next > 0 && next < tiersList.length) {
    appendLog(">>> escalating to next conversion tier");
    convertSource(next);
  }
}

$("btn-transcode").addEventListener("click", escalate);

// ---------- seeking into converted history ----------
// Seeks into buffered content are native and instant. Seeks into evicted
// (or skipped-over) but already-converted ranges replay the stored stream.
// Seeks beyond the converted frontier keep the old behavior: playback waits
// for the converter to reach them.
let seekTimer = null;

function bufferedContains(t) {
  const b = videoEl.buffered;
  for (let i = 0; i < b.length; i++) {
    if (t >= b.start(i) - 0.3 && t <= b.end(i) + 0.3) return true;
  }
  return false;
}

videoEl.addEventListener("seeking", () => {
  const app = currentAppender;
  if (!app || app.failed || !app.started) return;
  if (bufferedContains(videoEl.currentTime)) return;
  clearTimeout(seekTimer);
  seekTimer = setTimeout(() => {
    const a = currentAppender;
    if (!a || a.failed) return;
    const t = videoEl.currentTime;
    if (!bufferedContains(t)) a.seekTo(t);
  }, 250); // debounce scrubbing
});

// ---------- source loading ----------
// Remove leftover OPFS temp files (downloads + store segments) from crashed
// or abandoned sessions. Generous 12 h age: store segments now live for the
// whole viewing session, and another player instance booting mid-movie must
// never sweep files that still back an active session.
async function cleanStaleDownloads() {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      const m = /^wvp-(?:src|spool)-(\d+)/.exec(name);
      if (!m) continue;
      const ts = parseInt(m[1], 10);
      if (!isFinite(ts) || Date.now() - ts > 12 * 60 * 60 * 1000) {
        await root.removeEntry(name).catch(() => {});
      }
    }
  } catch {}
}

async function fetchSource(url) {
  setStatus("Downloading source file…");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

  const total = Number(res.headers.get("content-length")) || 0;

  // Preferred path: stream the download to disk (origin-private file system).
  // No RAM usage, no practical size cap (browser disk quota applies).
  let opfs = null;
  try {
    const root = await navigator.storage.getDirectory();
    // Name must be collision-proof: several players can boot in the same
    // millisecond (a page with multiple intercepted videos), and OPFS is
    // shared across all of them — a timestamp alone made them clobber
    // each other's downloads.
    const tmpName = `${OPFS_PREFIX}${Date.now()}-${crypto.randomUUID()}`;
    const handle = await root.getFileHandle(tmpName, { create: true });
    const writable = await handle.createWritable();
    opfs = { handle, writable };
    appendLog(">>> downloading to disk (OPFS)");
  } catch (e) {
    appendLog(`>>> OPFS unavailable (${e?.message}) — downloading to memory (4 GB cap)`);
    if (total > MAX_FETCH_BYTES) {
      throw new Error(`File is ${(total / 1e9).toFixed(1)} GB — over the in-memory 4 GB cap.`);
    }
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (opfs) {
      await opfs.writable.write(value);
    } else {
      chunks.push(value);
      if (received > MAX_FETCH_BYTES) {
        throw new Error("File exceeds the in-memory 4 GB cap (disk storage unavailable).");
      }
    }
    if (total) {
      setProgress(received / total);
      setStatus(`Downloading… ${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
    } else {
      setStatus(`Downloading… ${(received / 1e6).toFixed(1)} MB`);
    }
  }

  if (opfs) {
    await opfs.writable.close();
    return await opfs.handle.getFile(); // disk-backed File; WORKERFS reads it lazily
  }
  return new Blob(chunks);
}

function makeSafeName(name) {
  const safe = name.replace(/[^\w.-]+/g, "_") || "video";
  return /\.\w+$/.test(safe) ? safe : safe + ".bin";
}

function beginSession(name) {
  sourceName = name;
  sourceSafeName = makeSafeName(name);
  probed = null;
  sourcePath = null;
  sourceRemote = null;
  netStat = null;
  lastSuccessTier = -1;
  lastAttemptPlan = null;
  fileEl.textContent = name;
  document.title = `${name} — AbsolutePlayer`;
  tiersList = self.MediaSource
    ? ["stream-auto", "stream-force", "legacy-force"]
    : ["legacy-auto", "legacy-force"];
}

async function playFromURL(url) {
  let abs = url;
  let name;
  try {
    const u = new URL(url, location.href);
    abs = u.href;
    name = decodeURIComponent(u.pathname.split("/").pop() || "video");
  } catch {
    name = "video";
  }
  beginSession(name);

  const orig = $("btn-original");
  orig.href = abs;
  orig.download = name;
  orig.hidden = false;

  try {
    // Servers with Range support are streamed directly: download, conversion
    // and playback all run concurrently, nothing is pre-downloaded — unless
    // the Advanced setting forces "Download then Transcode".
    if (await getSetting("directStreaming", true)) {
      sourceRemote = await probeRangeSupport(abs);
    } else {
      sourceRemote = null;
      appendLog(">>> direct streaming disabled in Advanced settings — downloading first");
    }
    if (sourceRemote) {
      appendLog(
        `>>> server supports byte ranges — streaming directly (${(sourceRemote.size / 1e6).toFixed(1)} MB)`
      );
      if (sourceRemote.resolvedUrl !== sourceRemote.url) {
        appendLog(
          (await getSetting("cacheResolvedUrls", true))
            ? ">>> URL redirects — chunks will fetch the resolved location (re-resolves on expiry)"
            : ">>> URL redirects — resolved-source caching is off, every chunk re-resolves"
        );
      }
      await getWorker();
      const ok = await convertSource(0);
      if (ok !== false) return; // true = success, null = superseded
      // Direct streaming failed all tiers — retry once via full download.
      appendLog(">>> direct streaming failed — retrying with full pre-download");
      sourceRemote = null;
      sourcePath = null;
      probed = null;
      netStat = null;
      resetWorker();
    }
    // Fetch the file and warm up the ffmpeg core in parallel.
    const [blob] = await Promise.all([fetchSource(abs), getWorker()]);
    sourceBlob = blob;
    await convertSource(0);
  } catch (e) {
    console.error(e);
    if (/^file:/i.test(url) && !sourceBlob) {
      // Chromium blocks fetch() of file:// URLs — hand the user a picker.
      fail("The browser blocks direct access to local files.");
      setStatus(`❌ Can't read local files directly — use the picker below to open "${sourceName}".`);
      $("picker").hidden = false;
      return;
    }
    fail(e.message);
  }
}

async function playFromFile(file) {
  beginSession(file.name);
  sourceBlob = file; // WORKERFS reads straight from disk — no size cap
  try {
    await convertSource(0);
  } catch (e) {
    console.error(e);
    fail(e.message);
  }
}

$("file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    $("picker").hidden = true;
    playFromFile(file);
  }
});

// Read-only debug handle (used by the test harness to exercise seek paths).
self.__wvpDebug = { getAppender: () => currentAppender };

// ---------- boot ----------
cleanStaleDownloads();
const src = parseSource();
if (src) {
  playFromURL(src);
} else {
  setStatus("Ready.");
  $("picker").hidden = false;
}
