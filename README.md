# Choicer Voicer - Automatic Movie Dubbing 

Choicer Voicer is a 100% local, browser-based web application that turns any movie scene into an interactive voice acting game. It uses advanced Web Audio API engineering to detect speech, mute original dialogue, record your replacement voice, and mix it back together—no AI, backends, or servers required!

## How to Run Locally

Since this app uses microphone access (`getUserMedia`), most modern browsers require a secure context (HTTPS) or localhost to grant permissions. While you *can* try opening `index.html` directly in Firefox, the best way to run this locally without errors is using a simple local server.

### Option 1: VS Code (Recommended)
1. Open this folder in Visual Studio Code.
2. Install the extension **Live Server**.
3. Right-click `index.html` and click **"Open with Live Server"**.

### Option 2: Python
1. Open your terminal in this folder.
2. Run: `python3 -m http.server 8000` (or `python -m SimpleHTTPServer 8000` for Python 2)
3. Go to `http://localhost:8000` in your browser.

## Architecture

- **No Frameworks:** Built in Vanilla JS to maximize audio performance.
- **`audio-engine.js`**: Handles file decoding and global `AudioContext`.
- **`voice-detector.js`**: Replaces AI logic by using mathematical chunking and RMS (Root Mean Square) energy thresholds to detect dialogue boundaries from the audio frequency signal.
- **`recorder.js`**: Interfaces with the `MediaRecorder` API to capture blobs of audio.
- **`scorer.js`**: Compares the original `AudioBuffer` envelope against the user's recorded `AudioBuffer` envelope to grade timing, energy, and pitch. It also renders the dual-canvas visualizer.
- **`mixer.js`**: Uses `OfflineAudioContext` to construct an automated timeline. It dynamically alters a `GainNode` to duck the original audio during speech segments and layers in the user's recordings, applying selectable biquad filters and delays (Robot, Echo, Radio).

## Future Upgrades Ready
The `storage.js` module maps to the internal browser memory but is templated to be swapped out easily with standard IndexedDB or FFmpeg.wasm for final .mp4 rendering in future versions.