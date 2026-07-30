// Worker that drives @ffmpeg/core directly (no @ffmpeg/ffmpeg wrapper) so
// output can be streamed to the page WHILE ffmpeg is running.
//
// ffmpeg's exec() blocks this worker thread, so the page can't read results
// mid-run through normal APIs. Instead, before exec we swap the output
// file's Emscripten stream_ops for ops whose write() forwards every byte
// straight to the main thread via postMessage (which delivers even while
// the worker is blocked). With fragmented-MP4 flags the mp4 muxer writes
// (nearly) sequentially — box-size backpatches that land within the
// holdback window are absorbed in memory — so the shipped bytes form a
// valid MSE stream and the output is never stored in wasm memory.
//
// Input is mounted with WORKERFS (local Blobs/Files, read lazily from disk)
// or served as a virtual file backed by HTTP Range requests (remote URLs on
// range-capable servers) — either way the input is never copied into wasm
// memory, and remote conversion starts without any pre-download.

let core = null;
let FS = null;
let mounted = false;
const MOUNT = "/work";

const FLUSH_BYTES = 256 * 1024;

function reply(id, type, data, transfer) {
  self.postMessage({ id, type, data }, transfer || []);
}

async function init({ coreURL, wasmURL }) {
  if (core) return;
  self.createFFmpegCore = (await import(coreURL)).default;
  const workerURL = coreURL.replace(/\.js$/, ".worker.js");
  core = await self.createFFmpegCore({
    // Same locateFile hack the official wrapper uses: the core derives the
    // .wasm URL from the fragment on its own script URL.
    mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL, workerURL }))}`,
  });
  FS = core.FS;
  core.setLogger(({ message }) => self.postMessage({ type: "log", data: message }));
  core.setProgress((data) => self.postMessage({ type: "progress", data }));
}

function setSource({ blob, url, resolvedUrl, size, name, cacheResolved, chunkSize }) {
  if (mounted) {
    try {
      FS.unmount(MOUNT);
    } catch {}
    mounted = false;
  }
  try {
    FS.mkdir(MOUNT);
  } catch {}
  // Clear any previous lazy-input node.
  for (const f of FS.readdir(MOUNT)) {
    if (f !== "." && f !== "..") {
      try {
        FS.unlink(`${MOUNT}/${f}`);
      } catch {}
    }
  }
  const path = `${MOUNT}/${name}`;
  if (url) {
    makeLazyInput(path, url, resolvedUrl, size, cacheResolved !== false, chunkSize);
    return { path };
  }
  FS.mount(FS.filesystems.WORKERFS, { blobs: [{ name, data: blob }] }, MOUNT);
  mounted = true;
  return { path };
}

// Virtual input file backed by HTTP Range requests: ffmpeg's reads block
// this worker on a SYNCHRONOUS XHR (legal in workers) until the bytes
// arrive — which is exactly the backpressure we want. Nothing is
// pre-downloaded; an LRU window keeps memory bounded on huge files.
//
// Redirecting sources (a service 302-ing to the real file) are fetched via
// the RESOLVED location so the redirector is hit once, not once per chunk.
// If the resolved target stops answering (signed URLs expire), the fetch
// falls back to the original URL — which follows the redirect, yields the
// data, and reveals a fresh resolved target to cache for later chunks.
// With cacheResolved=false (Advanced settings) every chunk goes through the
// original URL instead — slower, but required by sources that reject reused
// destinations (single-use nonces, per-request binding).
function makeLazyInput(path, originalUrl, resolvedUrl, size, cacheResolved, chunkSize) {
  // Request size comes from the "Network speed" setting (8/16/32 MB). The
  // LRU is byte-budgeted, not count-budgeted, so resident memory stays put
  // no matter which size is selected.
  const CHUNK = chunkSize > 0 ? chunkSize : 8 * 1024 * 1024;
  const CACHE_BUDGET = 128 * 1024 * 1024;
  const MAX_CACHED = Math.max(2, Math.floor(CACHE_BUDGET / CHUNK));
  self.postMessage({ type: "log", data: `>>> range chunk size ${(CHUNK / 1048576).toFixed(0)} MB` });
  const cache = new Map(); // chunkIndex → Uint8Array, Map order = LRU
  let currentUrl = (cacheResolved && resolvedUrl) || originalUrl;
  let fetched = 0;

  function requestRange(u, start, end) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", u, false);
    xhr.responseType = "arraybuffer";
    xhr.setRequestHeader("Range", `bytes=${start}-${end}`);
    xhr.send(null);
    return xhr;
  }

  function chunkData(idx) {
    let c = cache.get(idx);
    if (c) {
      cache.delete(idx);
      cache.set(idx, c);
      return c;
    }
    const start = idx * CHUNK;
    const end = Math.min(size, start + CHUNK) - 1;
    for (let attempt = 0; ; attempt++) {
      try {
        let xhr = null;
        try {
          xhr = requestRange(currentUrl, start, end);
        } catch (e) {
          if (currentUrl === originalUrl) throw e;
        }
        if ((!xhr || xhr.status !== 206) && currentUrl !== originalUrl) {
          // Resolved target likely rotated/expired — go back through the
          // redirector and pick up its new destination.
          self.postMessage({
            type: "log",
            data: `>>> resolved URL ${xhr ? `returned HTTP ${xhr.status}` : "failed"} — re-resolving via original URL`,
          });
          xhr = requestRange(originalUrl, start, end);
        }
        if (xhr.status !== 206) throw new Error(`HTTP ${xhr.status}`);
        if (cacheResolved && xhr.responseURL && xhr.responseURL !== currentUrl) {
          currentUrl = xhr.responseURL;
        }
        c = new Uint8Array(xhr.response);
        break;
      } catch (e) {
        if (attempt >= 2) {
          self.postMessage({ type: "log", data: `>>> range fetch failed at ${start}: ${e.message}` });
          throw new FS.ErrnoError(29); // EIO
        }
      }
    }
    fetched += c.length;
    self.postMessage({ type: "netstat", data: { fetched, size } });
    cache.set(idx, c);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
    return c;
  }

  FS.writeFile(path, new Uint8Array(0));
  const node = FS.lookupPath(path).node;
  node.usedBytes = size; // stat() must report the real size for demuxers
  node.stream_ops = {
    open() {},
    close() {},
    llseek(stream, offset, whence) {
      let pos = offset;
      if (whence === 1) pos += stream.position;
      else if (whence === 2) pos += size;
      if (pos < 0) throw new FS.ErrnoError(28);
      return pos;
    },
    read(stream, buffer, offset, length, position) {
      if (position >= size) return 0;
      const n = Math.min(length, size - position);
      let copied = 0;
      while (copied < n) {
        const pos = position + copied;
        const idx = Math.floor(pos / CHUNK);
        const c = chunkData(idx);
        const within = pos - idx * CHUNK;
        const take = Math.min(n - copied, c.length - within);
        buffer.set(c.subarray(within, within + take), offset + copied);
        copied += take;
      }
      return n;
    },
    write() {
      throw new FS.ErrnoError(28);
    },
  };
}

function runExec(args) {
  core.setTimeout(-1);
  try {
    core.exec(...args);
  } catch {
    // ffmpeg's exit() can unwind via exception; core.ret still holds the code
  }
  const ret = typeof core.ret === "number" ? core.ret : -1;
  core.reset();
  return ret;
}

// How much of the output tail we keep un-shipped. ffmpeg writes box sizes
// as placeholders and seeks back to patch them when the box closes; the
// patch can land up to (avio buffer = 32 KB) + (box size) behind the write
// head. Holding back 128 KB lets those backpatches land in memory instead
// of in bytes the page has already consumed.
const HOLDBACK_BYTES = 128 * 1024;

// Create a regular MEMFS node at `path`, then replace its stream_ops so
// writes stream out through the holdback window instead of being stored.
// A regular file (not a char device) keeps ffmpeg's O_TRUNC open and
// seekability probing happy. `state.corrupted` is set if a write patches
// bytes that were already shipped — the stream is then invalid.
function makeStreamingOutput(path) {
  try {
    FS.unlink(path);
  } catch {}
  FS.writeFile(path, new Uint8Array(0));
  const node = FS.lookupPath(path).node;

  const state = {
    corrupted: false,
    shippedUpTo: 0, // absolute offset of first un-shipped byte
    buf: new Uint8Array(256 * 1024), // window covering [shippedUpTo, size)
    len: 0, // bytes in window
    size: 0, // max absolute offset written (virtual file size)
  };

  function ensureCapacity(need) {
    if (need <= state.buf.length) return;
    let cap = state.buf.length;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(state.buf.subarray(0, state.len));
    state.buf = next;
  }

  function shipReady(final) {
    const keep = final ? 0 : HOLDBACK_BYTES;
    let ready = state.len - keep;
    if (ready <= 0) return;
    if (!final && ready < FLUSH_BYTES) return; // batch small ships
    const out = state.buf.slice(0, ready);
    state.buf.copyWithin(0, ready, state.len);
    state.len -= ready;
    state.shippedUpTo += ready;
    self.postMessage({ type: "chunk", data: out.buffer }, [out.buffer]);
  }

  state.finish = () => shipReady(true);

  node.stream_ops = {
    open() {},
    close() {},
    read() {
      return 0;
    },
    llseek(stream, offset, whence) {
      let pos = offset;
      if (whence === 1) pos += stream.position;
      else if (whence === 2) pos += state.size;
      if (pos < 0) throw new FS.ErrnoError(28);
      return pos;
    },
    write(stream, buffer, offset, length, position) {
      if (length === 0) return 0;
      if (position < state.shippedUpTo) {
        // Backpatch to bytes the page already has — stream is broken.
        state.corrupted = true;
        return length;
      }
      const rel = position - state.shippedUpTo;
      ensureCapacity(rel + length);
      if (rel > state.len) state.buf.fill(0, state.len, rel); // forward-seek gap
      // buffer is a view on the wasm heap — copy the bytes out.
      state.buf.set(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length), rel);
      state.len = Math.max(state.len, rel + length);
      state.size = Math.max(state.size, position + length);
      shipReady(false);
      return length;
    },
  };
  return state;
}

function stream({ args, outPath }) {
  const state = makeStreamingOutput(outPath);
  const ret = runExec(args);
  state.finish(); // tail bytes; FIFO ordering guarantees arrival before the reply
  try {
    FS.unlink(outPath);
  } catch {}
  return { ret, outOfOrder: state.corrupted };
}

const handlers = {
  init,
  setSource,
  exec: ({ args }) => ({ ret: runExec(args) }),
  stream,
  readFile: ({ path }) => FS.readFile(path),
  deleteFile: ({ path }) => {
    try {
      FS.unlink(path);
    } catch {}
    return true;
  },
};

self.onmessage = async ({ data: { id, type, data } }) => {
  try {
    const result = await handlers[type](data || {});
    const transfer = result instanceof Uint8Array ? [result.buffer] : [];
    reply(id, "ok", result, transfer);
  } catch (e) {
    reply(id, "error", { message: e?.message || String(e) });
  }
};
