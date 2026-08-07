class LineWaveformView {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
        this.audioBuffer = null;
        this.segment = null;
        this.liveRafId = null;
        this.liveColumns = null; // interleaved [min, max] per pixel column
        this.liveStartedAt = 0;
        this.liveTotalDuration = 1;

        // The original-line waveform doesn't change while a take is being
        // recorded, but without caching it, drawing it directly onto the
        // live canvas means re-scanning every raw audio sample in the
        // segment on every single animation frame (~60x/sec) for the whole
        // recording. Instead it's rendered once per showSegment() call into
        // this offscreen canvas, and the live loop just blits that image.
        this.staticLayer = document.createElement('canvas');
        this.staticCtx = this.staticLayer.getContext('2d');

        if (this.canvas) {
            this.resize();
            window.addEventListener('resize', () => this.resize());
        }
    }

    resize() {
        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round((rect.width || 600) * dpr));
        const height = Math.max(1, Math.round((rect.height || 110) * dpr));
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
            this.staticLayer.width = width;
            this.staticLayer.height = height;
            if (this.segment) this.renderStaticLayer();
        }
        this.redraw();
    }

    /** The full original scene audio, decoded once after a video is analyzed. */
    setBuffer(audioBuffer) {
        this.audioBuffer = audioBuffer;
        if (this.segment) this.renderStaticLayer();
        this.redraw();
    }

    /** Called whenever the active line changes, OR its cut boundaries are
     *  edited in the cut editor - always re-renders the static original-audio
     *  waveform to match exactly this segment's current start/end window. */
    showSegment(segment) {
        this.segment = segment;
        this.stopLiveOverlay();
        this.liveColumns = null;
        this.renderStaticLayer();
        this.redraw();
    }

    clear() {
        this.segment = null;
        this.stopLiveOverlay();
        this.liveColumns = null;
        this.redraw();
    }

    /** Starts layering the user's live mic waveform on top of the current
     *  line's original waveform. expectedDurationSeconds should include any
     *  grace-period headroom so the live trace doesn't hit the right edge
     *  before recording actually stops. */
    beginLiveOverlay(expectedDurationSeconds) {
        if (!this.canvas) return;
        this.stopLiveOverlay();
        const width = this.canvas.width;
        this.liveColumns = new Float32Array(width * 2);
        this.liveStartedAt = performance.now();
        this.liveTotalDuration = Math.max(0.5, expectedDurationSeconds || 1);

        const step = () => {
            const recorder = window.AppVoiceRecorder;
            const sample = recorder && recorder.getWaveformSample ? recorder.getWaveformSample() : null;

            if (sample && this.liveColumns) {
                const width = this.canvas.width;
                const elapsed = (performance.now() - this.liveStartedAt) / 1000;
                const frac = Math.min(1, elapsed / this.liveTotalDuration);
                const col = Math.min(width - 1, Math.floor(frac * width));
                const idx = col * 2;
                this.liveColumns[idx] = Math.min(this.liveColumns[idx], sample.min);
                this.liveColumns[idx + 1] = Math.max(this.liveColumns[idx + 1], sample.max);
            }

            this.redraw();
            this.liveRafId = requestAnimationFrame(step);
        };
        this.liveRafId = requestAnimationFrame(step);
    }

    /** Stops updating the live overlay but leaves the last drawn take
     *  visible until the next showSegment()/clear() call. */
    stopLiveOverlay() {
        if (this.liveRafId) cancelAnimationFrame(this.liveRafId);
        this.liveRafId = null;
    }

    redraw() {
        if (!this.ctx) return;
        const ctx = this.ctx;
        const width = this.canvas.width;
        const height = this.canvas.height;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#050508';
        ctx.fillRect(0, 0, width, height);

        if (!this.segment) {
            this.drawPlaceholder();
            return;
        }

        // Cheap blit of the pre-rendered waveform instead of re-scanning
        // raw audio samples every frame.
        ctx.drawImage(this.staticLayer, 0, 0);

        if (this.liveColumns) {
            this.drawLiveWaveform();
        }
    }

    drawPlaceholder() {
        const ctx = this.ctx;
        const width = this.canvas.width;
        const height = this.canvas.height;
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
    }

    /** Renders the current segment's original waveform into the offscreen
     *  cache layer. Only called when the segment/buffer actually changes,
     *  not on every animation frame. */
    renderStaticLayer() {
        const ctx = this.staticCtx;
        const width = this.staticLayer.width;
        const height = this.staticLayer.height;
        ctx.clearRect(0, 0, width, height);

        if (!this.audioBuffer || !this.segment) return;

        const mid = height / 2;
        const data = this.audioBuffer.getChannelData(0);
        const sampleRate = this.audioBuffer.sampleRate;
        const startIdx = Math.max(0, Math.floor(this.segment.start * sampleRate));
        const endIdx = Math.min(data.length, Math.ceil(this.segment.end * sampleRate));
        const span = Math.max(1, endIdx - startIdx);
        const samplesPerPixel = Math.max(1, Math.floor(span / width));

        ctx.strokeStyle = 'rgba(0, 240, 255, 0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x < width; x++) {
            const s = startIdx + x * samplesPerPixel;
            const e = Math.min(endIdx, s + samplesPerPixel);
            let min = 0;
            let max = 0;
            for (let i = s; i < e; i++) {
                const v = data[i];
                if (v < min) min = v;
                if (v > max) max = v;
            }
            ctx.moveTo(x + 0.5, mid + min * mid * 0.9);
            ctx.lineTo(x + 0.5, mid + max * mid * 0.9);
        }
        ctx.stroke();
    }

    drawLiveWaveform() {
        const ctx = this.ctx;
        const width = this.canvas.width;
        const height = this.canvas.height;
        const mid = height / 2;

        ctx.strokeStyle = 'rgba(255, 59, 107, 0.9)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x < width; x++) {
            const min = this.liveColumns[x * 2];
            const max = this.liveColumns[x * 2 + 1];
            if (min === 0 && max === 0) continue;
            ctx.moveTo(x + 0.5, mid + min * mid * 0.9);
            ctx.lineTo(x + 0.5, mid + max * mid * 0.9);
        }
        ctx.stroke();
    }
}
window.AppLineWaveform = new LineWaveformView('line-waveform-canvas');
