/**
 * SceneTranscriber turns each cut segment into real text by running the
 * MOVIE'S OWN audio for that exact [start, end) window through an in-browser
 * speech-to-text model. This is deliberately not the old approach (having
 * the browser's live SpeechRecognition listen to the mic while the video
 * plays through speakers, hoping it picks up the dialogue) and it is never
 * fed the user's recorded voice - it only ever reads samples pulled directly
 * out of the decoded scene AudioBuffer for that cut.
 *
 * Runs once per set of cuts (right after auto-cut / after the cut editor is
 * confirmed), so every line already has its text before the recording game
 * starts, instead of being guessed live while the person watches.
 */
class SceneTranscriber {
    constructor() {
        this.modelId = 'Xenova/whisper-tiny.en';
        this.pipelinePromise = null;
        this.available = true; // flips false if the model fails to load once
    }

    prepareSegments(segments) {
        return segments.map((segment, index) => {
            const normalized = {
                ...segment,
                id: `line-${index + 1}`,
                startTime: segment.startTime ?? segment.start,
                endTime: segment.endTime ?? segment.end,
                text: segment.text || 'Listen to the scene, then repeat this line.',
                words: segment.words || []
            };

            normalized.words = normalized.words.length
                ? normalized.words
                : this.estimateWordTimings(normalized.text, normalized);

            return normalized;
        });
    }

    /** Called when the person manually corrects a line's text by tapping it. */
    applyManualText(text, segment) {
        const cleaned = this.cleanTranscript(text);
        segment.text = cleaned || segment.text;
        segment.words = this.estimateWordTimings(segment.text, segment);
        return segment;
    }

    cleanTranscript(text) {
        return text.replace(/\s+/g, ' ').trim();
    }

    estimateWordTimings(text, segment) {
        const words = this.cleanTranscript(text).split(' ').filter(Boolean);
        const start = segment.speechStart ?? segment.startTime ?? segment.start;
        const end = segment.speechEnd ?? segment.endTime ?? segment.end;
        const duration = Math.max(0.1, end - start);
        const slot = duration / Math.max(1, words.length);

        return words.map((word, index) => ({
            word,
            start: start + (slot * index),
            end: index === words.length - 1 ? end : start + (slot * (index + 1))
        }));
    }

    async loadPipeline(onStatus) {
        if (this.pipelinePromise) return this.pipelinePromise;

        this.pipelinePromise = (async () => {
            if (onStatus) onStatus('Loading speech-to-text model…');
            // Loaded from CDN at runtime rather than bundled, so the app
            // stays a handful of plain script files. Cached by the browser
            // after the first run.
            const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
            env.allowLocalModels = false;

            return pipeline('automatic-speech-recognition', this.modelId, {
                progress_callback: (data) => {
                    if (onStatus && data && data.status === 'progress' && typeof data.progress === 'number') {
                        onStatus(`Downloading speech-to-text model… ${Math.round(data.progress)}%`);
                    }
                }
            });
        })();

        try {
            // A blocked CDN or a stalled connection can leave a fetch
            // neither resolving nor rejecting for a long time. Without a
            // bound here, the whole app would sit waiting before ever
            // getting to the point of playing the video - which looks
            // exactly like "the video isn't playing" with no way out.
            return await this.withTimeout(this.pipelinePromise, 25000, 'Speech-to-text model took too long to load');
        } catch (err) {
            this.available = false;
            this.pipelinePromise = null;
            throw err;
        }
    }

    withTimeout(promise, ms, message) {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
        ]);
    }

    /** Pulls a mono slice out of the full scene buffer for exactly this
     *  segment's [start, end) window - this is the cut's own audio, not
     *  anything captured live. */
    extractMonoSlice(audioBuffer, start, end) {
        const inRate = audioBuffer.sampleRate;
        const startIdx = Math.max(0, Math.floor(start * inRate));
        const endIdx = Math.min(audioBuffer.length, Math.ceil(end * inRate));
        const length = Math.max(1, endIdx - startIdx);
        const channels = audioBuffer.numberOfChannels;

        const mono = new Float32Array(length);
        for (let c = 0; c < channels; c++) {
            const data = audioBuffer.getChannelData(c);
            for (let i = 0; i < length; i++) {
                mono[i] += data[startIdx + i] / channels;
            }
        }
        return mono;
    }

    /** Whisper models expect 16kHz input; the scene audio is usually 44.1/48kHz. */
    resampleTo16k(mono, inRate) {
        const outRate = 16000;
        if (inRate === outRate) return mono;

        const ratio = inRate / outRate;
        const outLength = Math.max(1, Math.floor(mono.length / ratio));
        const out = new Float32Array(outLength);
        for (let i = 0; i < outLength; i++) {
            const srcPos = i * ratio;
            const idx0 = Math.floor(srcPos);
            const idx1 = Math.min(mono.length - 1, idx0 + 1);
            const frac = srcPos - idx0;
            out[i] = (mono[idx0] * (1 - frac)) + (mono[idx1] * frac);
        }
        return out;
    }

    async transcribeSegment(asr, audioBuffer, segment) {
        const mono = this.extractMonoSlice(audioBuffer, segment.start, segment.end);
        const samples = this.resampleTo16k(mono, audioBuffer.sampleRate);
        if (samples.length < 800) return ''; // shorter than ~50ms - not enough to transcribe

        const result = await this.withTimeout(
            asr(samples, { chunk_length_s: 30 }),
            15000,
            'Line transcription took too long'
        );
        return this.cleanTranscript((result && result.text) || '');
    }

    /** Transcribes every cut's own audio slice from the decoded scene
     *  buffer. Returns { segments, ok } - ok is false if the model itself
     *  couldn't be loaded at all (falls back to placeholder text + manual
     *  correction for every line). onProgress receives { status } while the
     *  model loads and { index, total, status } per line. */
    async transcribeAll(audioBuffer, segments, onProgress) {
        let asr;
        try {
            asr = await this.loadPipeline((status) => {
                if (onProgress) onProgress({ status });
            });
        } catch (err) {
            console.warn('Speech-to-text model could not be loaded; lines will need to be typed in manually:', err);
            return { segments, ok: false };
        }

        const results = [];
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if (onProgress) {
                onProgress({ index: i, total: segments.length, status: `Transcribing line ${i + 1} of ${segments.length}…` });
            }

            try {
                const text = await this.transcribeSegment(asr, audioBuffer, segment);
                results.push({
                    ...segment,
                    text: text || segment.text || 'Listen to the scene, then repeat this line.',
                    words: text ? this.estimateWordTimings(text, segment) : (segment.words || [])
                });
            } catch (err) {
                console.warn(`Could not transcribe line ${i + 1}, keeping placeholder text:`, err);
                results.push({ ...segment });
            }
        }

        if (onProgress) onProgress({ index: segments.length, total: segments.length, status: 'Transcription complete.' });
        return { segments: results, ok: true };
    }
}

window.AppSceneTranscriber = new SceneTranscriber();
