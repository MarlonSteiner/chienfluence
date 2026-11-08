# Chienfluence ♡

Cute interval video recorder for iPhone. Set how long to film, how long to pause, and how many clips. Prop up your phone and do your Pilates class. Afterwards, pick your favorite clips and save them one by one or join them into one video.

Live: https://marlonsteiner.github.io/chienfluence/ (open in Safari, then **Share › Add to Home Screen**)

## How it works

- **Plain web app, no build step.** `index.html`, `style.css`, `app.js`. Hosted on GitHub Pages and installable as a home-screen app (`manifest.webmanifest`, `sw.js`).
- **Recording:** one camera stream stays open for the whole session; each clip is its own `MediaRecorder` run. The screen stays on with the Wake Lock API.
- **Storage:** clips are saved to IndexedDB on the phone as soon as each one finishes (`db.js`), so nothing is lost if the app closes.
- **Saving:** the iOS share sheet (`navigator.share` with files) → **Save Video** puts clips straight into Photos. You can select several clips at once.
- **Joining:** `mp4join.js` stitches MP4 clips into one file **without re-encoding**. It rewrites the sample tables and reuses the original video bytes, so it's instant and lossless, even for an hour of clips. It handles both regular and fragmented MP4 (iPhone Safari records fragmented MP4).

## Testing

```bash
node test/server.mjs            # serves the app on http://localhost:5173
```

- `http://localhost:5173/?demo` uses a fake camera, so the whole flow works in a desktop browser or the iOS Simulator.
- `test/ios.html` records 3 clips with Safari's real recorder, joins them, and uploads everything to `test/out/`.
- `node test/join.mjs out.mp4 a.mp4 b.mp4` runs the joiner on files.
- `swift test/check.swift file.mp4` decodes every frame with AVFoundation (what iPhone Photos uses).
