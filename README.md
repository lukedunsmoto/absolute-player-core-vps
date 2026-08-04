# <img src="logo.svg" width="38" alt=""> AbsolutePlayer

**Play the video formats your browser gave up on.**

An extension for Chromium-based browsers (Manifest V3) that plays video
formats they can't handle natively (MKV, AVI, FLV, WMV, TS/M2TS, VOB, MPG,
HEVC video, AC-3 / E-AC-3 / DTS audio and more) by converting them **on the
fly** with FFmpeg compiled to WebAssembly (bundled locally, no network
dependency).

Playback starts immediately on a modern machine, and everything happens locally in your browser. Video is never uploaded, and the extension has no servers, analytics or telemetry of any kind.

## Install

[Get AbsolutePlayer on the Chrome Web Store](https://chromewebstore.google.com/detail/absoluteplayer/ffpklomeappfmkkaipcjgkdpgbbfpdaf)

## Install from source

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder

Optional: to handle `file://` links to local videos, also enable **"Allow
access to file URLs"** on the extension's details page. The browser blocks
programmatic reads of `file://` URLs in any case, so local videos are opened
through the file picker (toolbar popup → *Open player*); picked files are
read lazily from disk, so there is no size limit.


## Demo

Four videos formats a browser can't play.
With the extension installed, each plays perfectly.

**[Try the live demo →](https://hiburn8.github.io/AbsolutePlayer/demo/)**


## How it works

### Interception
- A content script monitors for `<video>` elements it knows the browser can't play or where a video element has hit a decode error in real-time.
- It swaps those elements with the extension's player. 
- If the server supports it, the video source is fetched over HTTP byte ranges, so conversion starts on the first megabyte and play is immediate. Otherwise the source is downloaded first.
- For locally opened files, the extension redirects to its player page – where the source can be opened as a file handle (doesn’t need to be copied elsewhere or held in memory).

### The engine
- A complete FFmpeg build, compiled to WebAssembly, running in a Web Worker – takes the download parts available and begins on-the-fly transcoding.
- Single-threaded by choice: the multi-threaded build needs SharedArrayBuffer
  and cross-origin isolation, which would rule out streaming from arbitrary
  servers.
- The segments of the transcoded stream are stored in the browser's origin-private file system (OPFS) as they are produced, and appended to a MediaSource so playback can begin while conversion is still running.


### Converting as little as possible
- The media’s container is usually the problem: the streams inside are often
  ones the browser decodes natively. Those are copied bit-for-bit and lossless, and many times faster than real
  time.
- Only unsupported streams are re-encoded. A Blu-ray-sourced MKV typically
  keeps its H.264 or HEVC video and converts just the AC-3 or DTS audio; where
  a codec can't be played at all, it is transcoded to H.264/AAC.

### Avoid re-transcodes and transcode downloads
- Every converted byte is also written to an origin-private (OPFS) store the
  player reads back on demand. Memory stays flat at any file size; seeking
  works anywhere already converted, replaying the original bytes on their
  original timeline so audio and video cannot drift; and the finished file is
  offered as a download at no additional cost.

## Limitations

- **Seeking past the conversion frontier** waits for the converter to reach
  that point. Conversion runs as a single uninterrupted pass. Experiments found that, while it was possible to abort and restart transcoding at specific seek times, splicing the restarted output into the existing stream led to imperfect frame stitching; creating desync and hitching.

- **Disk use**: the browser holds the converted output for the duration of the
  Session in the background – which is typically of similar size to the original file. If the original file must be downloaded before transcoding (server does not support byte-range downloads) then a full copy of the file is first downloaded also.

- **Single-threaded** ffmpeg core (avoids the SharedArrayBuffer / COOP-COEP
  requirements that would break arbitrary-server streaming), so full
  transcodes run around real-time or slower for high-resolution content;
  remuxes are far faster than real-time.
- The **whole-file fallback tier** builds its output in wasm memory, so it
  tops out around 1.5 GB of output. The streaming tiers have no such limit.
- Sites that stream via MSE/DRM (YouTube, Netflix, …) are untouched — they
  don't expose file URLs, and they already work.
- Subtitle tracks are dropped; only the first video + audio stream is kept.

## Layout

```
manifest.json        MV3 manifest (CSP includes 'wasm-unsafe-eval')
background.js        DNR redirect rule, context menu, on/off state
content.js/.css      <video> interception + iframe swap
player.html/.js/.css player page: source loading, planning, tier fallback,
                     MSE appender, converted-stream store, seeking, saving
mse-worker.js        drives @ffmpeg/core; lazy range/WORKERFS input,
                     streams output bytes mid-exec
popup.html/.js       toolbar popup (on/off, URL, local file)
options.html/.js     settings page (Player / Transcoding / Network)
demo/                self-contained demo page + sample problem files
icons/               toolbar icons
vendor/core/         @ffmpeg/core 0.12.10 (ffmpeg-core.js + .wasm, ~32 MB)
```

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) for the full text.

The extension bundles `@ffmpeg/core`, a GPL build of FFmpeg configured with
`--enable-gpl` and including libx264 and libx265. Those components are
GPL-2.0-or-later, and this project exercises the "or later" option to
distribute the combined work under GPL-3.0.
