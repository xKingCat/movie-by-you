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

        // --- Pass 1: decode every user take up front and work out its real
        // timing. A single corrupt/undecodable blob used to throw out of the
        // whole mix() call, which silently dropped EVERY recorded voice from
        // the final render, not just the bad one. Now a failure here just
        // skips that one line (the original dialogue plays through for it)
        // and mixing continues normally for the rest.
        const takes = [];
        for (let i = 0; i < segments.length; i++) {
            const blob = userBlobs[i];
            if (!blob) continue;

            const segmentDuration = segments[i].end - segments[i].start;
            if (segmentDuration <= 0) continue;

            try {
                const arrayBuffer = await blob.arrayBuffer();
                const userBuffer = await offlineCtx.decodeAudioData(arrayBuffer);

                // Recording is allowed to run a little past the original
                // line's timing so a slower take doesn't get chopped off.
                // Rather than always time-stretching to force an exact fit
                // (which pitch-shifts the voice on almost every line), only
                // speed up - and only as much as needed, clamped - when the
                // take would otherwise run into the next line.
                const nextStart = segments[i + 1] ? segments[i + 1].start : duration;
                const room = Math.max(segmentDuration, nextStart - segments[i].start);

                let playbackRate = 1;
                if (userBuffer.duration > room) {
                    playbackRate = Math.min(1.15, userBuffer.duration / room);
                }

                const playedDuration = userBuffer.duration / playbackRate;
                const stopTime = Math.min(duration, nextStart, segments[i].start + playedDuration);

                takes.push({
                    index: i,
                    buffer: userBuffer,
                    playbackRate,
                    startTime: segments[i].start,
                    stopTime: Math.max(segments[i].start, stopTime),
                    duckUntil: Math.max(segments[i].end, stopTime)
                });
            } catch (err) {
                console.warn(`Could not decode recording for line ${i + 1}, keeping the original dialogue there:`, err);
            }
        }

        // --- Pass 2: original track with ducking, held down through
        // however long each take actually runs (not just the original
        // line's timing), so a longer take doesn't get talked over by the
        // original dialogue coming back up early.
        const origSource = offlineCtx.createBufferSource();
        origSource.buffer = origBuffer;

        const duckingGain = offlineCtx.createGain();
        duckingGain.gain.setValueAtTime(1, 0);

        const takeByIndex = new Map(takes.map(take => [take.index, take]));
        segments.forEach((seg, i) => {
            const take = takeByIndex.get(i);
            duckingGain.gain.setTargetAtTime(0.08, seg.start, 0.1);
            duckingGain.gain.setTargetAtTime(1, take ? take.duckUntil : seg.end, 0.1);
        });

        origSource.connect(duckingGain);
        duckingGain.connect(offlineCtx.destination);
        origSource.start(0);

        // --- Pass 3: schedule the user takes.
        takes.forEach(take => {
            const userSource = offlineCtx.createBufferSource();
            userSource.buffer = take.buffer;
            userSource.playbackRate.value = take.playbackRate;

            const connectionNode = this.applyEffect(offlineCtx, userSource, effectType);
            connectionNode.connect(offlineCtx.destination);

            userSource.start(take.startTime);
            userSource.stop(take.stopTime);
        });

        // Render final mix
        const renderedBuffer = await offlineCtx.startRendering();
        return renderedBuffer;
    }
}
window.AppMixer = new AudioMixer();
