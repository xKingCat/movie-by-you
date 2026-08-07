class VoiceDetector {
    constructor() {
        this.segments = [];
        this.options = {
            chunkMs: 50,
            minSpeechSeconds: 0.3,
            // How long a quiet stretch has to last before we decide a line is
            // actually over. Natural speech is full of tiny gaps (breaths,
            // stops between words) - if this is too short, a single sentence
            // gets sliced into several segments and each fragment plays back
            // as if it were "cut off".
            mergeGapSeconds: 0.6,
            silenceHoldSeconds: 0.35,
            prePaddingSeconds: 0.5,
            // Trailing padding is intentionally generous: trimming this too
            // tight is exactly what makes the last word of a line disappear.
            postPaddingSeconds: 1.0,
            speechLowHz: 85,
            speechHighHz: 3400,
            minSpeechBandRatio: 0.16,
            // Frames are smoothed with a short moving average before
            // thresholding so a single quiet syllable in the middle of a
            // word doesn't get treated as silence.
            smoothingFrames: 3,
            fftBins: 24,
            fftWindow: 1024
        };
    }

    analyzeBuffer(audioBuffer) {
        console.log('Analyzing audio for dialogue...');
        const data = audioBuffer.getChannelData(0);
        const sampleRate = audioBuffer.sampleRate;
        const stepSize = Math.max(1, Math.floor(sampleRate * (this.options.chunkMs / 1000)));

        // Precompute the DFT twiddle factors once per analysis instead of
        // once per frame. The previous implementation rebuilt every sin/cos
        // value for every bin on every single frame, which for a full-length
        // movie clip meant tens of millions of trig calls - slow enough that
        // "Analyze Dialogue" could look hung or silently give up on longer
        // videos. The math per frame is identical (same window size, same
        // bin frequencies), so the trig tables only need to be built once.
        this.buildTrigTables(sampleRate);

        const frames = this.buildAnalysisFrames(data, sampleRate, stepSize);

        if (!frames.length || frames.every(frame => frame.rms === 0)) {
            console.warn('No dialogue detected. Audio appears to be silent.');
            this.segments = [];
            return this.segments;
        }

        this.smoothFrames(frames);

        const rmsValues = frames.map(frame => frame.smoothedRms).sort((a, b) => a - b);
        const noiseFloor = rmsValues[Math.floor(rmsValues.length * 0.25)] || 0;
        const avgEnergy = frames.reduce((sum, frame) => sum + frame.smoothedRms, 0) / frames.length;
        // Slightly less aggressive than before (2.8x / 1.2x) so soft
        // consonants and trailing-off words at the edges of a line stay
        // above threshold instead of getting trimmed away.
        const threshold = Math.max(noiseFloor * 2.2, avgEnergy * 0.9, 0.008);

        const rawSegments = [];
        let inSpeech = false;
        let startFrame = 0;
        let trailingQuietFrames = 0;
        const quietFrameAllowance = Math.max(1, Math.ceil(this.options.silenceHoldSeconds / (this.options.chunkMs / 1000)));

        frames.forEach((frame, index) => {
            const active = frame.smoothedRms >= threshold && frame.speechBandRatio >= this.options.minSpeechBandRatio;

            if (active && !inSpeech) {
                inSpeech = true;
                startFrame = index;
                trailingQuietFrames = 0;
            } else if (!active && inSpeech) {
                trailingQuietFrames++;
                if (trailingQuietFrames >= quietFrameAllowance) {
                    this.pushSpeechSegment(rawSegments, audioBuffer, frames, startFrame, index - trailingQuietFrames + 1);
                    inSpeech = false;
                    trailingQuietFrames = 0;
                }
            } else if (active) {
                trailingQuietFrames = 0;
            }
        });

        if (inSpeech) {
            this.pushSpeechSegment(rawSegments, audioBuffer, frames, startFrame, frames.length - 1);
        }

        this.segments = this.mergeSegments(rawSegments).map((segment, index) => ({
            ...segment,
            id: `line-${index + 1}`,
            startTime: segment.start,
            endTime: segment.end,
            text: segment.text || 'Listen to the scene, then repeat this line.',
            words: segment.words || []
        }));

        if (this.segments.length === 0) {
            console.warn('No dialogue detected. Try a file with clearer speech or less background music.');
        }

        console.log('Detected Dialogue Segments:', this.segments);
        return this.segments;
    }

    buildTrigTables(sampleRate) {
        const { fftBins, fftWindow } = this.options;
        const nyquist = sampleRate / 2;
        this.trigSampleRate = sampleRate;
        this.binFrequencies = new Array(fftBins);
        this.cosTable = new Array(fftBins);
        this.sinTable = new Array(fftBins);

        for (let bin = 1; bin <= fftBins; bin++) {
            const frequency = (bin / fftBins) * Math.min(5000, nyquist);
            const cosRow = new Float32Array(fftWindow);
            const sinRow = new Float32Array(fftWindow);
            for (let n = 0; n < fftWindow; n++) {
                const angle = (2 * Math.PI * frequency * n) / sampleRate;
                cosRow[n] = Math.cos(angle);
                sinRow[n] = Math.sin(angle);
            }
            this.binFrequencies[bin - 1] = frequency;
            this.cosTable[bin - 1] = cosRow;
            this.sinTable[bin - 1] = sinRow;
        }
    }

    buildAnalysisFrames(data, sampleRate, stepSize) {
        const frames = [];
        for (let i = 0; i < data.length; i += stepSize) {
            let sum = 0;
            let count = 0;
            const end = Math.min(data.length, i + stepSize);
            for (let j = i; j < end; j++) {
                sum += data[j] * data[j];
                count++;
            }

            const rms = count ? Math.sqrt(sum / count) : 0;
            frames.push({
                start: i / sampleRate,
                end: end / sampleRate,
                rms,
                smoothedRms: rms,
                speechBandRatio: this.estimateSpeechBandRatio(data, i, end)
            });
        }
        return frames;
    }

    smoothFrames(frames) {
        const window = Math.max(1, this.options.smoothingFrames);
        if (window <= 1) return;
        const half = Math.floor(window / 2);
        const raw = frames.map(f => f.rms);
        for (let i = 0; i < frames.length; i++) {
            let sum = 0;
            let count = 0;
            for (let j = Math.max(0, i - half); j <= Math.min(frames.length - 1, i + half); j++) {
                sum += raw[j];
                count++;
            }
            frames[i].smoothedRms = count ? sum / count : raw[i];
        }
    }

    estimateSpeechBandRatio(data, start, end) {
        const { fftBins, fftWindow, speechLowHz, speechHighHz } = this.options;
        const windowSize = Math.min(fftWindow, end - start);
        if (windowSize < 32) return 0;

        let speechMagnitude = 0;
        let broadMagnitude = 0;

        // Uses the trig tables built once per analysis in buildTrigTables()
        // instead of recomputing cos/sin per sample here - this is the hot
        // loop that previously dominated analysis time.
        for (let bin = 0; bin < fftBins; bin++) {
            const frequency = this.binFrequencies[bin];
            const cosRow = this.cosTable[bin];
            const sinRow = this.sinTable[bin];
            let real = 0;
            let imaginary = 0;

            for (let n = 0; n < windowSize; n++) {
                const sample = data[start + n] || 0;
                real += sample * cosRow[n];
                imaginary -= sample * sinRow[n];
            }

            const magnitude = Math.sqrt((real * real) + (imaginary * imaginary));
            if (frequency >= 60 && frequency <= 5000) broadMagnitude += magnitude;
            if (frequency >= speechLowHz && frequency <= speechHighHz) {
                speechMagnitude += magnitude;
            }
        }

        return broadMagnitude === 0 ? 0 : speechMagnitude / broadMagnitude;
    }

    pushSpeechSegment(segments, audioBuffer, frames, startFrame, endFrame) {
        const speechStart = frames[startFrame].start;
        const speechEnd = frames[Math.max(startFrame, endFrame)].end;
        if (speechEnd - speechStart < this.options.minSpeechSeconds) return;

        const start = Math.max(0, speechStart - this.options.prePaddingSeconds);
        const end = Math.min(audioBuffer.duration, speechEnd + this.options.postPaddingSeconds);
        segments.push({ start, end, speechStart, speechEnd });
    }

    mergeSegments(segments) {
        const merged = [];
        segments.forEach(segment => {
            const last = merged[merged.length - 1];
            if (last && segment.start - last.end <= this.options.mergeGapSeconds) {
                last.end = Math.max(last.end, segment.end);
                last.speechEnd = Math.max(last.speechEnd, segment.speechEnd);
            } else {
                merged.push({ ...segment });
            }
        });
        return merged;
    }
}
window.AppVoiceDetector = new VoiceDetector();
