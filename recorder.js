class VoiceRecorder {
    constructor() {
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.stream = null;
        this.mimeType = this.getSupportedMimeType();

        // A lightweight AnalyserNode tap on the live mic signal, used to
        // detect when the user has actually stopped talking so a take can
        // be given extra time to finish instead of being hard-cut at the
        // original line's timestamp. Built lazily once we have a stream.
        this.audioCtx = null;
        this.analyser = null;
        this.silenceBuffer = null;
    }

    async init() {
        if (!this.stream || !this.hasLiveAudioTrack()) {
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints(), video: false });
            this.setupAnalyser();
        }
    }

    /** Now that the original line plays audibly (at reduced volume) as a
     *  guide track during recording instead of being muted, the mic is more
     *  exposed to speaker bleed. Being explicit about these constraints
     *  (rather than relying on `audio: true` defaults, which vary by
     *  browser) gets more consistent echo/noise suppression. */
    audioConstraints() {
        return {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        };
    }

    hasLiveAudioTrack() {
        if (!this.stream) return false;
        const tracks = this.stream.getAudioTracks();
        return tracks.length > 0 && tracks.some(track => track.readyState === 'live');
    }

    /** Re-checks the mic before every take - devices can get unplugged or
     *  permission can lapse mid-session, and recording against a dead track
     *  silently produces an empty/corrupt blob (the "my voice is missing"
     *  symptom) instead of a clear error. */
    async ensureLiveStream() {
        if (!this.hasLiveAudioTrack()) {
            try {
                this.stream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints(), video: false });
                this.setupAnalyser();
            } catch (err) {
                throw new Error('Microphone is unavailable. Please check mic permissions and try again.');
            }
        }
    }

    setupAnalyser() {
        try {
            if (!this.audioCtx) {
                this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            const source = this.audioCtx.createMediaStreamSource(this.stream);
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 1024;
            this.silenceBuffer = new Float32Array(this.analyser.fftSize);
            source.connect(this.analyser);
        } catch (err) {
            console.warn('Could not set up live level meter:', err);
            this.analyser = null;
        }
    }

    /** Returns the current mic RMS level (0-ish to ~1), or null if unavailable. */
    getCurrentLevel() {
        const range = this.readLevelRange();
        if (!range) return null;
        let sum = 0;
        for (let i = 0; i < this.silenceBuffer.length; i++) {
            sum += this.silenceBuffer[i] * this.silenceBuffer[i];
        }
        return Math.sqrt(sum / this.silenceBuffer.length);
    }

    /** Returns the current mic waveform's peak-to-peak range for this
     *  instant ({min, max}, roughly within [-1, 1]), or null if the live
     *  meter isn't available. Used to draw the live recording waveform. */
    getWaveformSample() {
        const range = this.readLevelRange();
        if (!range) return null;

        let min = 0;
        let max = 0;
        for (let i = 0; i < this.silenceBuffer.length; i++) {
            const v = this.silenceBuffer[i];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        return { min, max };
    }

    readLevelRange() {
        if (!this.analyser || !this.silenceBuffer) return null;
        this.analyser.getFloatTimeDomainData(this.silenceBuffer);
        return true;
    }

    async startRecording() {
        await this.ensureLiveStream();

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            try { this.mediaRecorder.stop(); } catch (err) { /* ignore */ }
        }

        this.audioChunks = [];
        const options = this.mimeType ? { mimeType: this.mimeType } : undefined;
        this.mediaRecorder = new MediaRecorder(this.stream, options);

        this.mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                this.audioChunks.push(event.data);
            }
        };

        this.mediaRecorder.start();
    }

    stopRecording() {
        return new Promise((resolve) => {
            if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
                resolve(new Blob(this.audioChunks, { type: this.mimeType || 'audio/webm' }));
                return;
            }

            this.mediaRecorder.onstop = () => {
                const audioBlob = new Blob(this.audioChunks, { type: this.mimeType || 'audio/webm' });
                resolve(audioBlob);
            };
            this.mediaRecorder.stop();
        });
    }

    getSupportedMimeType() {
        if (!window.MediaRecorder) return '';
        const candidates = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg'
        ];
        return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
    }
}
window.AppVoiceRecorder = new VoiceRecorder();
