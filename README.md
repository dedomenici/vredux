# VRedux

**Live:** https://dedomenici.github.io/vredux/ · splat demo: https://dedomenici.github.io/vredux/#splat

Stand on the spot where a film was shot, hold up your phone, and the remakes play around you,
turning with the phone (gyro + compass). Part of The Redux Project by Richard DeDomenici.
No build step: plain HTML/JS, three.js from a CDN, hosted on GitHub Pages.

## Scenes (`videos.json`)
| Scene | What it shows |
|---|---|
| `demo-corner` | London street corner (CC0 360 photo) with a **real AI cut-out of Chaplin's Tramp (1915, public domain)** walking off down the street, plus three placeholder characters ("Film A/B/C") overlapping. |
| `walkable-corner` | **Beta.** Gaussian-splat street scene (Tanks & Temples "Truck" sample) you can walk around, with cut-out characters as ground-anchored billboards. Direct link `#splat`. |
| `cubicle-your-fears` | Richard's 360 video *Cubicle Your Fears* (2021), self-hosted (2880 and 1920 versions) with a pre-rendered "ink" matte of the fears written on the walls. Free-play. |

Open a scene directly: `/vredux/#demo-corner`, `/vredux/#cubicle-your-fears`, `/vredux/#splat`.
URL options: `?mode=pass|ghost|360|walk`, `?fmt=alpha` (use native-alpha WebM/HEVC), `?q=low`, `?debug`.

## Modes
* **360**: the scene's 360 background, plus all cut-out layers.
* **Ghost**: the rear camera fills the screen and the 360 sits over it at adjustable opacity, plus the layers.
* **Passthrough**: the rear camera shows the real street. You see **only the cut-outs**: the layers, plus whatever
  the matte allows through from the background 360. The matte can be pre-rendered, a live AI person cut-out, or a live ink key.
* **Walk (beta)**: a Gaussian splat (`.splat` / `.ply` / `.spz`, rendered with Spark) replaces the 360. Look around by dragging or with the gyro, and move with the joystick or WASD.

Controls: Enable motion (iOS asks once), Tap to recentre (turns the scene so its `front` faces where you're pointing),
◀ 5° / 5° ▶ nudges, drag to fine-align while the gyro is on, pinch or scroll to zoom, mute, fullscreen (on iPhone it hides the controls instead),
layer chips to switch each character on or off, ⟲ All to restart every layer in sync. Settings has a layer editor
(bearing, distance, height, elevation) with **Copy layer JSON**, so you can line things up on site and paste the values back into `videos.json`.

## Data model
```jsonc
{
  "id": "some-corner", "title": "…", "subtitle": "…",
  "lat": 22.62, "lng": 120.27,          // filming spot (null = free-play). "You're here" unlocks within unlockRadius (default 20 m)
  "heading": 0,                          // compass bearing (0 = N, 90 = E) that the CENTRE of the background 360 faces
  "front": 0,                            // bearing that "Tap to recentre" turns to face you
  "eyeHeight": 1.6,
  "background": {                        // optional; either a 360 video…
    "sources": [{"src": "videos/x-2880.mp4", "width": 2880}, {"src": "videos/x-1920.mp4", "width": 1920}],
    "matte": {"src": "videos/x-matte.mp4"},   // optional grey equirect matte, same timing (white = keep)
    "loop": true, "audio": true
  },                                     // …or a still: {"image": "…4096.jpg", "imageLow": "…2048.jpg"}
  "splatSrc": "https://…/scene.splat",   // optional; enables Walk (beta). Fine-tune with "splat": {src, rotation, scale, position, spawn, groundY}
  "layers": [{
    "id": "tramp", "title": "The Tramp", "film": "The Tramp", "year": 1915,
    "projection": "flat",                // "flat" = upright billboard; "equirect" = full 360 matte layer
    "sources": {"stacked": "layers/tramp-stacked.mp4", "webm": "layers/tramp.webm", "hevc": "layers/tramp-hevc.mov"},
    "aspect": 0.6565,                    // width/height of the colour frame (filled in automatically on load)
    "bearing": -62,                      // compass bearing from the filming spot
    "distance": 6,                       // metres
    "frameHeight": 4.4,                  // metres the whole video frame covers (NOT the person's height)
    "elevation": -2.05,                  // metres the frame's bottom edge sits above (+) or below (-) the ground
    "start": 0, "loop": true, "enabled": true, "audio": false
  }]
}
```
Tip for flat layers: line up the **horizon** of the original shot with eye level, and perspective takes care of itself.
For example, the Tramp walks away and shrinks towards the London vanishing point.

## Making cut-outs in Final Cut Pro X → VRedux
1. In FCPX, isolate the character with the automatic matte/isolation tool. The background must be transparent.
2. **Share → Export File → Apple ProRes 4444** (keeps alpha). Trim to the moment you want and export at its native fps.
3. Convert (on any machine with ffmpeg, e.g. this box):
   ```bash
   scripts/convert-matte.sh ~/Exports/Character.mov layers/character
   ```
   This makes:
   * `layers/character-stacked.mp4`: H.264 with colour on top and matte below. **The universal default**: plays on iOS, Android and desktop, decoded by a shader.
   * `layers/character.webm`: VP9 with real alpha (Chrome / Android / Firefox).
   * `layers/character-hevc.mov`: HEVC with alpha (Safari / iOS), **only when the script runs on a Mac** (it needs Apple's VideoToolbox).
     On Linux it's skipped. You can also export "HEVC 8-bit with alpha" directly from FCPX or Compressor.

   The script prints a ready-made JSON layer to paste into `videos.json`. Options: `MAXH=1080` (colour height; the stacked file is twice as tall),
   `TRIM_START`, `TRIM_DUR`, `FPS`, `CRF`, and `EQUIRECT=1` for full-360 matte layers (stacked 2048×2048 recommended).
4. Keep every file under 100 MB (GitHub's limit). A 10 s 1080p stacked clip is usually 3–10 MB.

Why stacked by default: ProRes 4444 doesn't play in browsers, and alpha video support is split (WebM alpha on Chrome, HEVC alpha on Safari).
A normal H.264 file with the matte stored as picture plays everywhere. `?fmt=alpha` switches to the native-alpha files where available.

## How the demo assets were made (on the box)
* **Cubicle Your Fears**: downloaded from YouTube with yt-dlp (3840×1920 VP9 equirect, 30 s), re-encoded to H.264 2880×1440 (13.8 MB) and 1920×960 (3.5 MB) with faststart.
  The clip has no people in it (it's a static view inside the cubicle), so a person matte would be empty. Instead, `cubicle-matte-2048.mp4`
  is an OpenCV adaptive "ink" matte of the handwritten fears, so in Passthrough the fears float over your real street.
* **Tramp cut-out**: *The Tramp* (Chaplin, 1915, public domain, Wikimedia Commons), from the final walk-off shot. MediaPipe DeepLab v3 (person class)
  plus selfie-multiclass on a tracked crop, fused, refined with a guided filter and temporally smoothed, then written as ProRes 4444 and run through `convert-matte.sh`.
* **Placeholder characters**: procedurally drawn and exported as ProRes 4444 to test the FCPX pipeline end to end.
* **London corner 360**: "Urban Street 01" by Poly Haven (CC0). **Splat**: Tanks & Temples "Truck", via antimatter15/splat sample data (loaded from Hugging Face, not stored in the repo).

## Live AI cut-out (quick mode)
Passthrough → Settings → Cut-out source → *AI person cut-out (live)* runs MediaPipe Image Segmenter in the browser on the visible part of the
360 view (256×256, about 14 fps) and uses it as the alpha. *Fast* = selfie segmenter, *Accurate* = DeepLab v3. Limits: models are trained on
undistorted, upright, close-ish people, so small or distorted figures in a 360 give soft, blotchy edges. It costs battery and frame rate on phones.
Pre-rendered mattes (FCPX or offline) look far better and are the intended path.

## Alignment notes
* Android Chrome uses `deviceorientationabsolute` (true compass). iOS uses `webkitCompassHeading`, smoothed into a correction.
  Magnetometers are easily thrown by nearby metal and cars, so expect ±10–20°. Use Tap to recentre or drag to fine-tune.
* Without a gyro (desktop), drag to look and scroll to zoom.
* Camera field of view isn't matched exactly to the phone camera. Pinch until the cut-outs sit at the right size.

## Files
`index.html`, `app.js`, `style.css`, `videos.json`, `videos/` (360s + mattes + stills), `layers/` (cut-outs), `scripts/convert-matte.sh`.

Vibecoded by [DeDomenici](https://dedomenici.com).
