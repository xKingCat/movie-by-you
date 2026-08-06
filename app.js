document.addEventListener('DOMContentLoaded', () => {
    const GAME_STATES = {
        IDLE: 'IDLE',
        PREVIEW_SCENE: 'PREVIEW_SCENE',
        DIALOGUE_PLAYING: 'DIALOGUE_PLAYING',
        DIALOGUE_FINISHED: 'DIALOGUE_FINISHED',
        PREPARE_RECORDING: 'PREPARE_RECORDING',
        COUNTDOWN: 'COUNTDOWN',
        RECORDING: 'RECORDING',
        REVIEW: 'REVIEW',
        NEXT_LINE: 'NEXT_LINE'
    };

    const video = document.getElementById('main-video');
    const uploadInput = document.getElementById('video-upload');
    const btnUpload = document.getElementById('btn-upload');
    const btnDemo = document.getElementById('btn-demo');
    const btnAnalyze = document.getElementById('btn-analyze');
    const btnPlayDub = document.getElementById('btn-play-dub');
    const btnDownloadMix = document.getElementById('btn-download-mix');
    const overlay = document.getElementById('overlay-ui');
    const overlayText = document.getElementById('overlay-text');
    const countdownEl = document.getElementById('countdown');
    const recIndicator = document.getElementById('recording-indicator');
    const lineText = document.getElementById('line-text');
    const wordStrip = document.getElementById('word-strip');
    const lineTiming = document.getElementById('line-timing');
    const progressBar = document.getElementById('speech-progress-bar');
    const recordingStatus = document.getElementById('recording-status');
    const recordingsList = document.getElementById('recordings-list');

    const scorer = new VoiceScorer('waveform-canvas');

    let state = GAME_STATES.IDLE;
    let segments = [];
    let currentSegmentIndex = 0;
    let recordings = [];
    let mixedBuffer = null;
    let mixedAudioSource = null;
    let activeRecordingAudio = null;

    // ---------- Upload / demo scene loading ----------

    btnUpload.addEventListener('click', () => uploadInput.click());

    uploadInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        video.srcObject = null;
        video.src = URL.createObjectURL(file);
        window.AppAudioEngine.originalBuffer = null;

        btnAnalyze.classList.remove('hidden');
        btnUpload.innerText = 'Change Video';
        resetGameUi('Scene loaded. Analyze dialogue to find your lines.');
    });

    btnDemo.addEventListener('click', async () => {
        btnDemo.innerText = 'Generating Demo...';

        // Generate a synthetic "video" via a canvas stream so the whole flow
        // can be tried without uploading a real file.
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const ctx = canvas.getContext('2d');

        let frame = 0;
        const draw = () => {
            ctx.fillStyle = '#111';
            ctx.fillRect(0, 0, 640, 360);
            ctx.fillStyle = '#00f0ff';
            ctx.font = '30px Arial';
            ctx.fillText('Demo Scene (Simulated Dialogue)', 60, 180);
            ctx.beginPath();
            ctx.arc(320 + Math.sin(frame * 0.05) * 100, 250, 20, 0, Math.PI * 2);
            ctx.fill();
            frame++;
            requestAnimationFrame(draw);
        };
        draw();

        video.srcObject = canvas.captureStream(30);
        uploadInput.value = '';
        await video.play();
        await window.AppAudioEngine.createSyntheticAudio();

        btnAnalyze.classList.remove('hidden');
        btnDemo.innerText = 'Load Demo Scene';
        resetGameUi('Demo scene loaded. Analyze dialogue to find your lines.');
    });

    // ---------- Analyze ----------

    btnAnalyze.addEventListener('click', analyzeDialogue);
    btnPlayDub.addEventListener('click', playFinalDub);
    btnDownloadMix.addEventListener('click', downloadMixedAudio);

    async function analyzeDialogue() {
        btnAnalyze.innerText = 'Analyzing Audio...';
        btnAnalyze.disabled = true;

        try {
            if (!window.AppAudioEngine.originalBuffer) {
                const file = uploadInput.files[0];
                if (!file) throw new Error('Please choose a video file or load the demo scene first.');
                await window.AppAudioEngine.ctx.resume();
                await window.AppAudioEngine.extractAudioFromVideo(file);
            }
        } catch (err) {
            console.error('Failed to load audio:', err);
            alert(`Failed to load audio: ${err.message}`);
            btnAnalyze.innerText = 'Analyze Dialogue';
            btnAnalyze.disabled = false;
            return;
        }

        segments = window.AppVoiceDetector.analyzeBuffer(window.AppAudioEngine.originalBuffer);
        segments = window.AppSpeechLineTranscriber.prepareSegments(segments);

        if (segments.length === 0) {
            alert('No dialogue detected! Try a scene with clearer talking, or load the demo scene.');
            btnAnalyze.innerText = 'Analyze Dialogue';
            btnAnalyze.disabled = false;
            return;
        }

        try {
            await window.AppVoiceRecorder.init();
        } catch (err) {
            console.error('Microphone access failed:', err);
            alert('Microphone access is required to record your lines. Please allow microphone access and try again.');
            btnAnalyze.innerText = 'Analyze Dialogue';
            btnAnalyze.disabled = false;
            return;
        }

        btnAnalyze.classList.add('hidden');
        btnAnalyze.disabled = false;
        btnAnalyze.innerText = 'Analyze Dialogue';

        startRecordingGame();
    }

    // ---------- Game flow ----------

    function startRecordingGame() {
        currentSegmentIndex = 0;
        recordings = [];
        mixedBuffer = null;
        btnPlayDub.classList.add('hidden');
        btnDownloadMix.classList.add('hidden');
        document.getElementById('award-display').classList.add('hidden');
        renderRecordings();
        playOriginalLine();
    }

    async function playOriginalLine() {
        checkPlayback();
    }

    async function checkPlayback() {
        if (currentSegmentIndex >= segments.length) {
            finishGame();
            return;
        }

        const segment = segments[currentSegmentIndex];
        setState(GAME_STATES.PREVIEW_SCENE);
        updateDialoguePanel(segment, 'Listen to the original performance first.');
        overlay.classList.add('hidden');
        video.muted = false;

        await safeSeek(Math.max(0, segment.start - 0.35));
        await video.play();
        setState(GAME_STATES.DIALOGUE_PLAYING);

        const transcribing = window.AppSpeechLineTranscriber.start(segment, (updatedSegment) => {
            updateDialoguePanel(updatedSegment, 'Transcript updated. Get ready to repeat it.');
        });
        if (!transcribing) {
            updateDialoguePanel(segment, 'Speech recognition is unavailable; listen and repeat the line.');
        }

        monitorLinePreview(segment);
    }

    function monitorLinePreview(segment) {
        const update = () => {
            if (state !== GAME_STATES.DIALOGUE_PLAYING) return;

            updateSpeechProgress(segment, video.currentTime);
            if (video.currentTime >= segment.end) {
                window.AppSpeechLineTranscriber.stop();
                video.pause();
                setState(GAME_STATES.DIALOGUE_FINISHED);
                prepareRecording(segment);
            } else {
                requestAnimationFrame(update);
            }
        };
        requestAnimationFrame(update);
    }

    function prepareRecording(segment) {
        setState(GAME_STATES.PREPARE_RECORDING);
        updateDialoguePanel(segment, 'Get ready...');
        overlay.classList.remove('hidden');
        overlayText.innerText = 'YOUR TURN';
        countdownEl.classList.remove('hidden');
        recIndicator.classList.add('hidden');
        runCountdown(segment);
    }

    function runCountdown(segment) {
        setState(GAME_STATES.COUNTDOWN);
        let count = 3;
        countdownEl.innerText = count;

        const timer = setInterval(() => {
            count--;
            if (count > 0) {
                countdownEl.innerText = count;
            } else {
                clearInterval(timer);
                startSegmentRecording(segment);
            }
        }, 1000);
    }

    async function startSegmentRecording(segment) {
        setState(GAME_STATES.RECORDING);
        countdownEl.classList.add('hidden');
        recIndicator.classList.remove('hidden');
        overlayText.innerText = 'SPEAK NOW';
        recordingStatus.classList.add('recording');
        updateDialoguePanel(segment, '🎤 RECORDING');

        await safeSeek(segment.start);
        video.muted = true;
        window.AppVoiceRecorder.startRecording();
        await video.play();

        const stopAt = segment.end;
        const recChecker = setInterval(async () => {
            updateSpeechProgress(segment, video.currentTime);
            if (video.currentTime >= stopAt) {
                clearInterval(recChecker);
                video.pause();

                const blob = await window.AppVoiceRecorder.stopRecording();
                await saveRecording(segment, blob);

                overlay.classList.add('hidden');
                recordingStatus.classList.remove('recording');
                video.muted = false;
                setState(GAME_STATES.REVIEW);

                currentSegmentIndex++;
                setState(GAME_STATES.NEXT_LINE);
                playOriginalLine();
            }
        }, 50);
    }

    async function saveRecording(segment, blob) {
        let duration = segment.end - segment.start;
        try {
            duration = await getBlobDuration(blob);
        } catch (err) {
            console.warn('Could not read recording duration:', err);
        }

        const segmentIndex = currentSegmentIndex;
        const id = `recording-${Date.now()}-${segmentIndex + 1}`;
        const recording = {
            id,
            sceneTimestamp: segment.startTime ?? segment.start,
            segmentIndex,
            transcript: segment.text,
            audioBlob: blob,
            duration,
            segment
        };

        recordings[segmentIndex] = recording;
        window.AppStorage.saveBlob(id, blob);
        renderRecordings();

        try {
            const score = await scorer.compare(window.AppAudioEngine.originalBuffer, blob, window.AppAudioEngine.ctx, segment);
            updateScoreboard(score);
        } catch (err) {
            console.warn('Could not score recording:', err);
        }

        const expected = segment.end - segment.start;
        if (Math.abs(duration - expected) > 0.5) {
            console.warn('Recording significantly longer/shorter than dialogue', {
                expected,
                recorded: duration
            });
        }
    }

    async function finishGame() {
        video.pause();
        recordingStatus.innerText = '🎤 YOUR RECORDING: Mixing final audio...';

        const effect = document.getElementById('voice-effect').value;
        try {
            mixedBuffer = await window.AppMixer.mix(
                window.AppAudioEngine.originalBuffer,
                segments,
                recordings.map(recording => recording && recording.audioBlob),
                effect
            );
            btnPlayDub.classList.remove('hidden');
            btnDownloadMix.classList.remove('hidden');
            recordingStatus.innerText = '🎤 YOUR RECORDING: Final mix ready!';
        } catch (err) {
            console.error('Mixing failed:', err);
            recordingStatus.innerText = '🎤 YOUR RECORDING: Mixing failed. See console for details.';
        }
    }

    function playFinalDub() {
        if (!mixedBuffer) return;

        safeSeek(0);
        video.muted = true;
        video.play();

        if (mixedAudioSource) mixedAudioSource.disconnect();

        mixedAudioSource = window.AppAudioEngine.ctx.createBufferSource();
        mixedAudioSource.buffer = mixedBuffer;
        mixedAudioSource.connect(window.AppAudioEngine.ctx.destination);
        mixedAudioSource.start();
    }

    function downloadMixedAudio() {
        if (!mixedBuffer) return;
        const wavBlob = audioBufferToWavBlob(mixedBuffer);
        downloadBlob(wavBlob, 'ChoicerVoicer_dubbed_scene.wav');
    }

    // ---------- UI rendering ----------

    function updateDialoguePanel(segment, status) {
        lineText.innerText = `"${segment.text}"`;
        lineTiming.innerText = `Timing: ${formatTime(segment.start)} - ${formatTime(segment.end)}`;
        recordingStatus.innerText = `🎤 YOUR RECORDING: ${status}`;
        renderWords(segment, video.currentTime || segment.start);
    }

    function updateSpeechProgress(segment, currentTime) {
        const pct = Math.max(0, Math.min(1, (currentTime - segment.start) / Math.max(0.1, segment.end - segment.start)));
        progressBar.style.width = `${pct * 100}%`;
        renderWords(segment, currentTime);
    }

    function renderWords(segment, currentTime) {
        wordStrip.innerHTML = '';
        (segment.words || []).forEach((word) => {
            const chip = document.createElement('span');
            chip.className = 'word-chip';
            if (currentTime >= word.start && currentTime <= word.end) chip.classList.add('active');
            chip.innerText = word.word;
            wordStrip.appendChild(chip);
        });
    }

    function renderRecordings() {
        recordingsList.innerHTML = '';
        const existing = recordings.filter(Boolean);
        recordingsList.classList.toggle('empty', existing.length === 0);

        if (existing.length === 0) {
            recordingsList.innerText = 'No recordings yet.';
            return;
        }

        existing.forEach((recording, displayIndex) => {
            const card = document.createElement('div');
            card.className = 'recording-card';
            card.innerHTML = `
                <strong>Line ${recording.segmentIndex + 1}: "${escapeHtml(recording.transcript)}"</strong>
                <div class="recording-meta">${formatTime(recording.sceneTimestamp)} \u2022 ${recording.duration.toFixed(2)}s</div>
                <div class="recording-actions"></div>
            `;

            const actions = card.querySelector('.recording-actions');
            actions.appendChild(createActionButton('Replay', () => replayRecording(recording)));
            actions.appendChild(createActionButton('Download', () => downloadRecording(recording, displayIndex + 1)));
            actions.appendChild(createActionButton('Delete', () => deleteRecording(recording.segmentIndex)));
            recordingsList.appendChild(card);
        });
    }

    function createActionButton(label, onClick) {
        const button = document.createElement('button');
        button.className = 'btn secondary small';
        button.type = 'button';
        button.innerText = label;
        button.addEventListener('click', onClick);
        return button;
    }

    function replayRecording(recording) {
        if (activeRecordingAudio) activeRecordingAudio.pause();
        activeRecordingAudio = new Audio(URL.createObjectURL(recording.audioBlob));
        activeRecordingAudio.play();
    }

    function deleteRecording(index) {
        recordings[index] = null;
        renderRecordings();
    }

    function downloadRecording(recording, number) {
        downloadBlob(recording.audioBlob, `ChoicerVoicer_recording_${String(number).padStart(2, '0')}.webm`);
    }

    function updateScoreboard(score) {
        document.getElementById('score-total').innerText = score.total;
        document.getElementById('score-timing').innerText = score.timing;
        document.getElementById('score-energy').innerText = score.energy;
        document.getElementById('score-pitch').innerText = score.pitch;

        const award = document.getElementById('award-display');
        if (score.total > 85) {
            award.classList.remove('hidden');
            award.innerText = '🏆 Perfect Dub!';
        } else {
            award.classList.add('hidden');
        }
    }

    function resetGameUi(message) {
        setState(GAME_STATES.IDLE);
        lineText.innerText = message;
        wordStrip.innerHTML = '';
        lineTiming.innerText = 'Timing: --:--.--- - --:--.---';
        progressBar.style.width = '0%';
        recordingStatus.innerText = '🎤 YOUR RECORDING: Waiting for analysis.';
        btnPlayDub.classList.add('hidden');
        btnDownloadMix.classList.add('hidden');
        document.getElementById('award-display').classList.add('hidden');
        recordingsList.innerHTML = 'No recordings yet.';
        recordingsList.classList.add('empty');
        document.getElementById('score-total').innerText = '--';
        document.getElementById('score-timing').innerText = '--';
        document.getElementById('score-energy').innerText = '--';
        document.getElementById('score-pitch').innerText = '--';
    }

    // ---------- Helpers ----------

    async function safeSeek(time) {
        if (!Number.isFinite(time)) return;
        try {
            video.currentTime = time;
        } catch (err) {
            console.warn('Video cannot seek in this mode:', err);
        }
    }

    function setState(nextState) {
        state = nextState;
        console.log(`Choicer Voicer state: ${state}`);
    }

    async function getBlobDuration(blob) {
        const arrayBuffer = await blob.arrayBuffer();
        const recordingBuffer = await window.AppAudioEngine.ctx.decodeAudioData(arrayBuffer.slice(0));
        return recordingBuffer.duration;
    }

    function formatTime(seconds) {
        const safeSeconds = Math.max(0, seconds || 0);
        const minutes = Math.floor(safeSeconds / 60);
        const remaining = (safeSeconds % 60).toFixed(3).padStart(6, '0');
        return `${String(minutes).padStart(2, '0')}:${remaining}`;
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>'"]/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[char]));
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    function audioBufferToWavBlob(buffer) {
        const channels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const length = buffer.length * channels * 2;
        const arrayBuffer = new ArrayBuffer(44 + length);
        const view = new DataView(arrayBuffer);
        let offset = 0;

        const writeString = (value) => {
            for (let i = 0; i < value.length; i++) view.setUint8(offset++, value.charCodeAt(i));
        };

        writeString('RIFF');
        view.setUint32(offset, 36 + length, true); offset += 4;
        writeString('WAVE');
        writeString('fmt ');
        view.setUint32(offset, 16, true); offset += 4;
        view.setUint16(offset, 1, true); offset += 2;
        view.setUint16(offset, channels, true); offset += 2;
        view.setUint32(offset, sampleRate, true); offset += 4;
        view.setUint32(offset, sampleRate * channels * 2, true); offset += 4;
        view.setUint16(offset, channels * 2, true); offset += 2;
        view.setUint16(offset, 16, true); offset += 2;
        writeString('data');
        view.setUint32(offset, length, true); offset += 4;

        for (let i = 0; i < buffer.length; i++) {
            for (let channel = 0; channel < channels; channel++) {
                const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i]));
                view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
                offset += 2;
            }
        }

        return new Blob([arrayBuffer], { type: 'audio/wav' });
    }
});
