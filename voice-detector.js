class VoiceDetector {
    constructor() {
        this.segments = [];
        this.options = {
            chunkMs: 50,
            minSpeechSeconds: 0.35,
            mergeGapSeconds: 0.45,
            prePaddingSeconds: 0.5,
            postPaddingSeconds: 0.8,
            speechLowHz: 85,
            speechHighHz: 3400,
            minSpeechBandRatio: 0.22
        };
    }

    analyzeBuffer(audioBuffer) {
        console.log('Analyzing audio for dialogue...');
        const data = audioBuffer.getChannelData(0);
        const sampleRate = audioBuffer.sampleRate;
        const stepSize = Math.max(1, Math.floor(sampleRate * (this.options.chunkMs / 1000)));
        const frames = this.buildAnalysisFrames(data, sampleRate, stepSize);

        if (!frames.length || frames.every(frame => frame.rms === 0)) {
            console.warn('No dialogue detected. Audio appears to be silent.');
            this.segments = [];
            return this.segments;
        }

        const rmsValues = frames.map(frame => frame.rms).sort((a, b) => a - b);
        const noiseFloor = rmsValues[Math.floor(rmsValues.length * 0.25)] || 0;
        const avgEnergy = frames.reduce((sum, frame) => sum + frame.rms, 0) / frames.length;
        const threshold = Math.max(noiseFloor * 2.8, avgEnergy * 1.2, 0.01);

        const rawSegments = [];
        let inSpeech = false;
        let startFrame = 0;
        let trailingQuietFrames = 0;
        const quietFrameAllowance = Math.ceil(0.18 / (this.options.chunkMs / 1000));

        frames.forEach((frame, index) => {
            const active = frame.rms >= threshold && frame.speechBandRatio >= this.options.minSpeechBandRatio;

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
                speechBandRatio: this.estimateSpeechBandRatio(data, sampleRate, i, end)
            });
        }
        return frames;
    }

    estimateSpeechBandRatio(data, sampleRate, start, end) {
        const windowSize = Math.min(1024, end - start);
        if (windowSize < 32) return 0;

        let speechMagnitude = 0;
        let broadMagnitude = 0;
        const binCount = 32;
        const nyquist = sampleRate / 2;

        // Lightweight FFT-style frequency sampling. A full FFT library would be
        // overkill here, so this computes selected DFT bins and compares speech
        // band energy against broader audible energy.
        for (let bin = 1; bin <= binCount; bin++) {
            const frequency = (bin / binCount) * Math.min(5000, nyquist);
            let real = 0;
            let imaginary = 0;

            for (let n = 0; n < windowSize; n++) {
                const sample = data[start + n] || 0;
                const angle = (2 * Math.PI * frequency * n) / sampleRate;
                real += sample * Math.cos(angle);
                imaginary -= sample * Math.sin(angle);
            }

            const magnitude = Math.sqrt((real * real) + (imaginary * imaginary));
            if (frequency >= 60 && frequency <= 5000) broadMagnitude += magnitude;
            if (frequency >= this.options.speechLowHz && frequency <= this.options.speechHighHz) {
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
