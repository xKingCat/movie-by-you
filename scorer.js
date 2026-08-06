class VoiceScorer {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
    }

    async generateBufferFromBlob(blob, audioCtx) {
        const arrayBuffer = await blob.arrayBuffer();
        return await audioCtx.decodeAudioData(arrayBuffer);
    }

    async compare(origBuffer, userBlob, audioCtx, segment) {
        const userBuffer = await this.generateBufferFromBlob(userBlob, audioCtx);

        // --- 1. Draw Waveforms ---
        this.drawWaveforms(origBuffer, userBuffer, segment.start, segment.end);

        // --- 2. Calculate Scores ---
        // Simple heuristic scoring based on buffer lengths and energy profiles
        const origDuration = segment.end - segment.start;
        const userDuration = userBuffer.duration;

        // Timing: how close is the user's duration to the original duration
        let timingScore = 100 - Math.min(100, Math.abs(origDuration - userDuration) / origDuration * 100);

        // Energy & pitch: compare the original dialogue segment with the user's
        // full recording using lightweight local signal analysis.
        const origData = this.getSegmentData(origBuffer, segment.start, segment.end);
        const userData = userBuffer.getChannelData(0);

        const origRMS = this.calculateRMS(origData);
        const userRMS = this.calculateRMS(userData);
        let energyScore = this.scoreRelativeDifference(origRMS, userRMS);

        // Zero-crossing rate is not full pitch detection, but it provides a
        // deterministic proxy for comparing brightness/pitch-like content.
        const origZCR = this.calculateZeroCrossingRate(origData);
        const userZCR = this.calculateZeroCrossingRate(userData);
        let pitchScore = this.scoreRelativeDifference(origZCR, userZCR);

        let total = Math.round((timingScore + energyScore + pitchScore) / 3);

        return {
            timing: Math.round(timingScore),
            energy: Math.round(energyScore),
            pitch: Math.round(pitchScore),
            total: total
        };
    }

    getSegmentData(buffer, start, end) {
        const data = buffer.getChannelData(0);
        const startIdx = Math.max(0, Math.floor(start * buffer.sampleRate));
        const endIdx = Math.min(data.length, Math.ceil(end * buffer.sampleRate));
        return data.slice(startIdx, endIdx);
    }

    calculateRMS(data) {
        if (!data.length) return 0;

        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            sum += data[i] * data[i];
        }

        return Math.sqrt(sum / data.length);
    }

    calculateZeroCrossingRate(data) {
        if (data.length < 2) return 0;

        let crossings = 0;
        for (let i = 1; i < data.length; i++) {
            if ((data[i - 1] < 0 && data[i] >= 0) || (data[i - 1] >= 0 && data[i] < 0)) {
                crossings++;
            }
        }

        return crossings / (data.length - 1);
    }

    scoreRelativeDifference(referenceValue, candidateValue) {
        if (referenceValue === 0 && candidateValue === 0) return 100;
        if (referenceValue === 0) return 0;

        const difference = Math.abs(referenceValue - candidateValue) / referenceValue;
        return Math.max(0, 100 - Math.min(100, difference * 100));
    }

    drawWaveforms(origBuffer, userBuffer, start, end) {
        const width = this.canvas.width;
        const height = this.canvas.height;
        this.ctx.clearRect(0, 0, width, height);

        const drawBuffer = (buffer, color, yOffset, specificStart, specificEnd, displayDuration) => {
            const data = buffer.getChannelData(0);
            const sRate = buffer.sampleRate;
            let startIdx = specificStart !== undefined ? Math.floor(specificStart * sRate) : 0;
            let endIdx = specificEnd !== undefined ? Math.floor(specificEnd * sRate) : data.length;
            const displaySamples = Math.max(1, Math.floor((displayDuration || ((endIdx - startIdx) / sRate)) * sRate));

            const step = Math.max(1, Math.ceil(displaySamples / width));
            const amp = height / 4;

            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();

            for (let i = 0; i < width; i++) {
                let min = 1.0, max = -1.0;
                for (let j = 0; j < step; j++) {
                    const idx = startIdx + (i * step) + j;
                    if (idx < data.length && idx < endIdx) {
                        const datum = data[idx];
                        if (datum < min) min = datum;
                        if (datum > max) max = datum;
                    }
                }
                if (min === 1.0 && max === -1.0) {
                    min = 0;
                    max = 0;
                }
                this.ctx.moveTo(i, yOffset + min * amp);
                this.ctx.lineTo(i, yOffset + max * amp);
            }
            this.ctx.stroke();
        };

        // Draw original top (blue), user bottom (cyan)
        const segmentDuration = end - start;
        drawBuffer(origBuffer, '#3366ff', height / 4, start, end, segmentDuration);
        drawBuffer(userBuffer, '#00f0ff', (height / 4) * 3, 0, userBuffer.duration, segmentDuration);
    }
}
