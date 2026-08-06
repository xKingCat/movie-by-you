class AudioMixer {
    constructor() { }

    applyEffect(audioCtx, node, effectType) {
        if (effectType === 'deep') {
            const filter = audioCtx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 500;
            node.connect(filter);
            return filter;
        } else if (effectType === 'high') {
            const filter = audioCtx.createBiquadFilter();
            filter.type = 'highpass';
            filter.frequency.value = 1000;
            node.connect(filter);
            return filter;
        } else if (effectType === 'robot') {
            const filter = audioCtx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = 1000;
            filter.Q.value = 10;
            node.connect(filter);
            return filter;
        } else if (effectType === 'echo') {
            const delay = audioCtx.createDelay();
            delay.delayTime.value = 0.3;
            const feedback = audioCtx.createGain();
            feedback.gain.value = 0.4;
            node.connect(delay);
            delay.connect(feedback);
            feedback.connect(delay);

            const outGain = audioCtx.createGain();
            node.connect(outGain);
            delay.connect(outGain);
            return outGain;
        } else if (effectType === 'radio') {
            const filter1 = audioCtx.createBiquadFilter();
            filter1.type = 'highpass';
            filter1.frequency.value = 400;
            const filter2 = audioCtx.createBiquadFilter();
            filter2.type = 'lowpass';
            filter2.frequency.value = 2500;
            node.connect(filter1);
            filter1.connect(filter2);
            return filter2;
        }
        return node;
    }

    async mix(origBuffer, segments, userBlobs, effectType) {
        const duration = origBuffer.duration;
        const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 44100 * duration, 44100);

        // 1. Setup Original track with ducking
        const origSource = offlineCtx.createBufferSource();
        origSource.buffer = origBuffer;

        const duckingGain = offlineCtx.createGain();
        duckingGain.gain.setValueAtTime(1, 0);

        // Apply ducking automation during segments
        segments.forEach(seg => {
            duckingGain.gain.setTargetAtTime(0.1, seg.start, 0.1); // Drop volume
            duckingGain.gain.setTargetAtTime(1, seg.end, 0.1);     // Restore volume
        });

        origSource.connect(duckingGain);
        duckingGain.connect(offlineCtx.destination);
        origSource.start(0);

        // 2. Overlay User tracks
        for (let i = 0; i < segments.length; i++) {
            const blob = userBlobs[i];
            if (!blob) continue;

            const arrayBuffer = await blob.arrayBuffer();
            const userBuffer = await offlineCtx.decodeAudioData(arrayBuffer);

            const userSource = offlineCtx.createBufferSource();
            userSource.buffer = userBuffer;

            const segmentDuration = segments[i].end - segments[i].start;
            if (segmentDuration <= 0) continue;
            userSource.playbackRate.value = userBuffer.duration / segmentDuration;

            // Apply specific node effects
            let connectionNode = this.applyEffect(offlineCtx, userSource, effectType);

            connectionNode.connect(offlineCtx.destination);

            // Align the user's take to the original dialogue slot and stop it
            // at the segment boundary to prevent overlap with the next line.
            userSource.start(segments[i].start);
            userSource.stop(segments[i].end);
        }

        // Render final mix
        const renderedBuffer = await offlineCtx.startRendering();
        return renderedBuffer;
    }
}
window.AppMixer = new AudioMixer();
