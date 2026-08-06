class SpeechLineTranscriber {
    constructor() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.isSupported = Boolean(SpeechRecognition);
        this.recognition = this.isSupported ? new SpeechRecognition() : null;
        this.activeSegment = null;
        this.onUpdate = null;

        if (this.recognition) {
            this.recognition.continuous = true;
            this.recognition.interimResults = true;
            this.recognition.lang = navigator.language || 'en-US';

            this.recognition.onresult = (event) => {
                const parts = [];
                for (let i = 0; i < event.results.length; i++) {
                    const result = event.results[i];
                    if (result[0] && result[0].transcript) {
                        parts.push(result[0].transcript.trim());
                    }
                }

                const text = this.cleanTranscript(parts.join(' '));
                if (this.activeSegment && text) {
                    this.activeSegment.text = text;
                    this.activeSegment.words = this.estimateWordTimings(text, this.activeSegment);
                    if (this.onUpdate) this.onUpdate(this.activeSegment);
                }
            };

            this.recognition.onerror = (event) => {
                console.warn('Speech recognition unavailable for this line:', event.error);
            };
        }
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

    start(segment, onUpdate) {
        this.activeSegment = segment;
        this.onUpdate = onUpdate;
        if (!this.recognition) return false;

        try {
            this.recognition.abort();
            this.recognition.start();
            return true;
        } catch (err) {
            console.warn('Could not start speech recognition:', err);
            return false;
        }
    }

    stop() {
        if (!this.recognition) return;

        try {
            this.recognition.stop();
        } catch (err) {
            console.warn('Could not stop speech recognition:', err);
        }
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
}

window.AppSpeechLineTranscriber = new SpeechLineTranscriber();
