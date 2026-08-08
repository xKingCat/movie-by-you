class VoiceDetector {
    constructor() {
        this.segments = [];
        this.options = {
            chunkMs: 50,
            // Short interjections ("No!", "Wait.") are real lines too - a
            // 0.3s floor was silently dropping them entirely.
            minSpeechSeconds: 0.18,
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
            minSpeechBandRatio: 0.12,
            // A frame whose energy is clearly, unambiguously above its local
            // threshold is trusted as speech even if the spectral band-ratio
            // heuristic doesn't love its timbre (deep voices, sibilants,
            // clipping, etc). The band-ratio check only gets to veto frames
            // that are merely borderline-loud, where it's actually useful
            // for telling a quiet word apart from a quiet hum or rumble.
            strongEnergyMultiplier: 1.8,
            // Frames are smoothed with a short moving average before
            // thresholding so a single quiet syllable in the middle of a
            // word doesn't get treated as silence.
            smoothingFrames: 3,
            fftBins: 24,
            fftWindow: 1024,
            // Instead of one energy threshold for the whole clip - which a
            // single loud section (music, action, a shout) drags high
            // enough to bury every quieter line elsewhere in the same
            // scene - the threshold is recomputed from a local window
            // around each frame, so a hushed line in an otherwise quiet
            // stretch and a hushed line right after a loud stretch are both
            // judged against their own surroundings.
            localWindowSeconds: 5,
            localNoisePercentile: 0.15,
            localThresholdMultiplier: 1.6,
            localThresholdRecomputeSeconds: 0.5,
            absoluteFloor: 0.004,
            // Safety net for the local-threshold approach: if a loud
            // passage runs long enough with little enough amplitude
            // variance, its own local "noise floor" can sit too close to
            // its own loud level and start suppressing itself. Any frame
            // clearly above the whole clip's own typical loudness is
            // treated as active no matter what the local threshold says.
            globalBypassPercentile: 0.6
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
        const thresholds = this.computeLocalThresholds(frames);
        const globalBypassFloor = this.computeGlobalBypassFloor(frames);

        const rawSegments = [];
        let inSpeech = false;
        let startFrame = 0;
        let trailingQuietFrames = 0;
        let droppedShortSpans = 0;
        const quietFrameAllowance = Math.max(1, Math.ceil(this.options.silenceHoldSeconds / (this.options.chunkMs / 1000)));

        frames.forEach((frame, index) => {
            const localThreshold = thresholds[index];
            const strongEnergy = frame.smoothedRms >= localThreshold * this.options.strongEnergyMultiplier;
            const passesLocal = frame.smoothedRms >= localThreshold &&
                (strongEnergy || frame.speechBandRatio >= this.options.minSpeechBandRatio);
            const active = passesLocal || frame.smoothedRms >= globalBypassFloor;

            if (active && !inSpeech) {
                inSpeech = true;
                startFrame = index;
                trailingQuietFrames = 0;
            } else if (!active && inSpeech) {
                trailingQuietFrames++;
                if (trailingQuietFrames >= quietFrameAllowance) {
                    if (!this.pushSpeechSegment(rawSegments, audioBuffer, frames, startFrame, index - trailingQuietFrames + 1)) {
                        droppedShortSpans++;
                    }
                    inSpeech = false;
                    trailingQuietFrames = 0;
                }
            } else if (active) {
                trailingQuietFrames = 0;
            }
        });

        if (inSpeech) {
            if (!this.pushSpeechSegment(rawSegments, audioBuffer, frames, startFrame, frames.length - 1)) {
                droppedShortSpans++;
            }
        }

        this.segments = this.mergeSegments(rawSegments).map((segment, index) => ({
            ...segment,
            id: `line-${index + 1}`,
            startTime: segment.start,
            endTime: segment.end,
            text: segment.text || 'Listen to the scene, then repeat this line.',
            words: segment.words || []
        }));

        if (droppedShortSpans > 0) {
            console.log(`Skipped ${droppedShortSpans} sound(s) shorter than ${this.options.minSpeechSeconds}s (likely noise, not dropped dialogue).`);
        }
        if (this.segments.length === 0) {
            console.warn('No dialogue detected. Try a file with clearer speech or less background music.');
        }

        console.log('Detected Dialogue Segments:', this.segments);
        return this.segments;
    }

    /** Recomputes a local noise floor every ~0.5s from a several-second
     *  window around it (20th percentile RMS, which is robust to a couple
     *  of loud transients inside the window) rather than using one number
     *  for the whole clip. Strided rather than per-frame since the noise
     *  floor doesn't meaningfully change faster than this. */
    computeLocalThresholds(frames) {
        const { chunkMs, localWindowSeconds, localNoisePercentile, localThresholdMultiplier, localThresholdRecomputeSeconds, absoluteFloor } = this.options;
        const framesPerSecond = 1 / (chunkMs / 1000);
        const windowFrames = Math.max(10, Math.round(localWindowSeconds * framesPerSecond));
        const half = Math.floor(windowFrames / 2);
        const stride = Math.max(1, Math.round(localThresholdRecomputeSeconds * framesPerSecond));

        const rms = frames.map(f => f.smoothedRms);
        const thresholds = new Array(frames.length);
        let lastValue = absoluteFloor;

        for (let i = 0; i < frames.length; i += stride) {
            const lo = Math.max(0, i - half);
            const hi = Math.min(frames.length - 1, i + half);
            const windowVals = rms.slice(lo, hi + 1).sort((a, b) => a - b);
            const noiseFloor = windowVals[Math.floor(windowVals.length * localNoisePercentile)] || 0;
            lastValue = Math.max(noiseFloor * localThresholdMultiplier, absoluteFloor);

            for (let j = i; j < Math.min(frames.length, i + stride); j++) {
                thresholds[j] = lastValue;
            }
        }
        return thresholds;
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
        if (speechEnd - speechStart < this.options.minSpeechSeconds) return false;

        const start = Math.max(0, speechStart - this.options.prePaddingSeconds);
        const end = Math.min(audioBuffer.duration, speechEnd + this.options.postPaddingSeconds);
        segments.push({ start, end, speechStart, speechEnd });
        return true;
    }

    /** A robust (percentile-based) global loudness reference for the whole
     *  clip, used purely as a safety-net bypass so a sustained, low-variance
     *  loud passage can never fully suppress itself under the local
     *  adaptive threshold above. */
    computeGlobalBypassFloor(frames) {
        const sorted = frames.map(f => f.smoothedRms).sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * this.options.globalBypassPercentile));
        return Math.max(sorted[idx] || 0, this.options.absoluteFloor);
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
