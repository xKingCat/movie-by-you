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
    const transcriptionWarning = document.getElementById('transcription-warning');
    const transcribeStatus = document.getElementById('transcribe-status');
    const headphoneTip = document.getElementById('headphone-tip');
    const headphoneTipDismiss = document.getElementById('headphone-tip-dismiss');
    const HEADPHONE_TIP_KEY = 'cv_headphone_tip_dismissed';

    const scorer = new VoiceScorer('waveform-canvas');

    let state = GAME_STATES.IDLE;
    let segments = [];
    let currentSegmentIndex = 0;
    let recordings = [];
    let mixedBuffer = null;
    let mixedAudioSource = null;
    let activeRecordingAudio = null;
    // Set while a single line is being re-recorded from the "Your Voice
    // Takes" panel, so finishing that one take resumes wherever the normal
    // game flow was instead of chaining forward through every later line.
    let retakeContext = null;

    headphoneTipDismiss.addEventListener('click', () => {
        headphoneTip.classList.add('hidden');
        try { localStorage.setItem(HEADPHONE_TIP_KEY, '1'); } catch (err) { /* storage may be disabled */ }
    });

    function maybeShowHeadphoneTip() {
        try {
            if (localStorage.getItem(HEADPHONE_TIP_KEY)) return;
        } catch (err) { /* storage may be disabled - just show the tip */ }
        headphoneTip.classList.remove('hidden');
    }

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
        try {
            await video.play();
        } catch (err) {
            console.warn('Could not start demo preview playback:', err);
        }
        await window.AppAudioEngine.createSyntheticAudio();

        btnAnalyze.classList.remove('hidden');
        btnDemo.innerText = 'Load Demo Scene';
        resetGameUi('Demo scene loaded. Analyze dialogue to find your lines.');
    });

    // ---------- Manual line correction (speech-to-text fallback) ----------

    lineText.addEventListener('blur', () => {
        const segment = segments[currentSegmentIndex];
        if (!segment || state === GAME_STATES.RECORDING || state === GAME_STATES.COUNTDOWN) return;

        const corrected = lineText.innerText.trim();
        if (!corrected || corrected === segment.text) return;

        window.AppSceneTranscriber.applyManualText(corrected, segment);
        renderWords(segment, video.currentTime || segment.start);
        transcriptionWarning.classList.add('hidden');
    });

    lineText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            lineText.blur();
        }
    });

    function showTranscriptionWarning(kind) {
        const messages = {
            unsupported: "Automatic line transcription isn't available right now. Tap the line above to type it in yourself.",
            empty: "Couldn't make out this line automatically — tap the line above to type it in yourself."
        };
        transcriptionWarning.innerText = messages[kind] || 'Auto-transcription may be inaccurate — tap the line above to correct it.';
        transcriptionWarning.classList.remove('hidden');
    }

    // ---------- Analyze ----------

    btnAnalyze.addEventListener('click', analyzeDialogue);
    btnPlayDub.addEventListener('click', playFinalDub);
    btnDownloadMix.addEventListener('click', downloadMixedAudio);

    async function analyzeDialogue() {
        // Browsers only allow unmuted programmatic video.play() calls when
        // they're "close enough" to a real user gesture. The steps below
        // (decoding audio, detecting speech, loading the mic, and now
        // transcribing every line, which can take several seconds -
        // longer on a first run while the model downloads) can easily push
        // the eventual first video.play() call in checkPlayback() past
        // that window, so the browser silently blocks it and the video
        // never starts. Playing (then immediately pausing) right here,
        // still synchronously inside this click handler, "activates" the
        // element for the rest of the session so later automatic plays
        // keep working even after a long delay.
        if (video.src || video.srcObject) {
            video.play().then(() => video.pause()).catch(() => { /* nothing to unlock yet - fine */ });
        }

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

        window.AppLineWaveform.setBuffer(window.AppAudioEngine.originalBuffer);

        segments = window.AppVoiceDetector.analyzeBuffer(window.AppAudioEngine.originalBuffer);
        segments = window.AppSceneTranscriber.prepareSegments(segments);

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

        btnAnalyze.disabled = false;
        btnAnalyze.innerText = 'Analyze Dialogue';

        const advancedToggle = document.getElementById('advanced-cuts-toggle');
        if (advancedToggle.checked) {
            btnAnalyze.classList.add('hidden');
            // Transcription runs AFTER cuts are confirmed, against the
            // final edited boundaries - if a cut moves, the words that fall
            // inside it move with it, so the text should always match
            // exactly what ended up in the cut, not the pre-edit guess.
            window.AppCutEditor.open(segments, window.AppAudioEngine.originalBuffer, video, async (editedSegments) => {
                segments = editedSegments;
                await transcribeSceneLines();
                startRecordingGame();
            });
        } else {
            await transcribeSceneLines();
            btnAnalyze.classList.add('hidden');
            startRecordingGame();
        }
    }

    /** Transcribes every cut's own audio slice from the scene (see
     *  scene-transcriber.js) - not a live mic feed, and never the user's
     *  recorded voice. Runs once, up front, against the final cut
     *  boundaries, so every line's text is ready before the game starts. */
    async function transcribeSceneLines() {
        transcribeStatus.classList.remove('hidden');
        transcribeStatus.innerText = 'Transcribing lines from the scene…';

        const { segments: transcribed, ok } = await window.AppSceneTranscriber.transcribeAll(
            window.AppAudioEngine.originalBuffer,
            segments,
            (progress) => {
                transcribeStatus.innerText = progress.status || 'Transcribing…';
            }
        );
        segments = transcribed;
        renderRecordings();

        if (!ok) showTranscriptionWarning('unsupported');
        transcribeStatus.classList.add('hidden');
    }

    // ---------- Game flow ----------

    function startRecordingGame() {
        currentSegmentIndex = 0;
        recordings = [];
        mixedBuffer = null;
        retakeContext = null;
        btnPlayDub.classList.add('hidden');
        btnDownloadMix.classList.add('hidden');
        document.getElementById('award-display').classList.add('hidden');
        renderRecordings();
        maybeShowHeadphoneTip();
        playOriginalLine();
    }

    async function playOriginalLine() {
        checkPlayback();
    }

    async function safePlay() {
        try {
            await video.play();
            return true;
        } catch (err) {
            console.warn('Video playback was blocked by the browser:', err);
            return false;
        }
    }

    /** Makes sure the video is actually playing before the caller proceeds,
     *  instead of leaving an unhandled rejection that silently stalls the
     *  game if the browser blocked autoplay. Tries a normal (audible) play
     *  first; if that's blocked, gives the person a chance to unblock it
     *  with a real tap (always allowed); if nothing works within a few
     *  seconds, falls back to a muted play so the game's timing - which
     *  depends on video.currentTime actually advancing - never gets stuck
     *  waiting on playback that will never start. */
    async function ensurePlaying() {
        if (await safePlay()) return;

        overlay.classList.remove('hidden');
        overlayText.innerText = 'TAP TO CONTINUE';
        countdownEl.classList.add('hidden');
        recIndicator.classList.add('hidden');

        let handler;
        const tapped = await new Promise(resolve => {
            handler = () => resolve(true);
            overlay.addEventListener('click', handler);
            setTimeout(() => resolve(false), 6000);
        });
        overlay.removeEventListener('click', handler);

        if (tapped && await safePlay()) {
            overlay.classList.add('hidden');
            return;
        }

        video.muted = true;
        await safePlay();
        overlay.classList.add('hidden');
    }

    async function checkPlayback() {
        if (currentSegmentIndex >= segments.length) {
            finishGame();
            return;
        }

        const segment = segments[currentSegmentIndex];
        setState(GAME_STATES.PREVIEW_SCENE);
        updateDialoguePanel(segment, 'Listen to the original performance first.');
        window.AppLineWaveform.showSegment(segment);
        overlay.classList.add('hidden');
        video.muted = false;
        video.volume = 1;
        lineText.contentEditable = 'true';

        // Text comes from transcribeSceneLines() up front now, not a live
        // guess while this preview plays - only warn here if that pass
        // genuinely couldn't make out this particular line.
        if (segment.text === 'Listen to the scene, then repeat this line.') {
            showTranscriptionWarning('empty');
        } else {
            transcriptionWarning.classList.add('hidden');
        }

        await safeSeek(Math.max(0, segment.start - 0.6));
        await ensurePlaying();
        setState(GAME_STATES.DIALOGUE_PLAYING);

        monitorLinePreview(segment);
    }

    function monitorLinePreview(segment) {
        const update = () => {
            if (state !== GAME_STATES.DIALOGUE_PLAYING) return;

            updateSpeechProgress(segment, video.currentTime);
            if (video.currentTime >= segment.end) {
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
        lineText.contentEditable = 'false';
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
        // Keep the original line playing as a guide track while recording,
        // just quieter (25% lower) rather than fully muted, so the user has
        // something to perform against instead of dead silence. Note this
        // does mean the mic can pick up a little bleed of the original
        // dialogue - that's the deliberate trade-off for having a reference.
        video.muted = false;
        video.volume = 0.75;

        try {
            await window.AppVoiceRecorder.startRecording();
        } catch (err) {
            console.error('Could not start recording:', err);
            alert(err.message || 'Microphone is unavailable. Please check mic permissions and try again.');
            video.muted = false;
            video.volume = 1;
            recordingStatus.classList.remove('recording');
            overlay.classList.add('hidden');
            setState(GAME_STATES.REVIEW);
            advanceAfterLine();
            return;
        }

        await ensurePlaying();
        // ensurePlaying() only touches the overlay if playback was blocked
        // and it had to fall back through the tap-to-continue prompt; make
        // sure the recording overlay is in the right state either way.
        overlay.classList.remove('hidden');
        overlayText.innerText = 'SPEAK NOW';
        countdownEl.classList.add('hidden');
        recIndicator.classList.remove('hidden');

        // The original dialogue's own timing is only a target, not a hard
        // wall: people often talk a little slower than the actor did, and
        // cutting the mic the instant playback reaches segment.end chops
        // the last word or two off almost every take. Once that point is
        // reached, keep recording for a short grace window and end the take
        // as soon as the mic actually goes quiet (rather than waiting out
        // the full window every time), with a hard cap so a stuck take
        // can't record forever.
        const stopAt = segment.end;
        const MAX_GRACE_MS = 3500;
        const SILENCE_HOLD_MS = 500;
        const QUIET_LEVEL = 0.015;
        const NO_METER_GRACE_MS = 1200; // fallback if live level metering isn't available

        // Layer the user's live waveform on top of the line's original
        // waveform. Give it headroom for the grace period above so the
        // trace doesn't hit the right edge before recording actually stops.
        window.AppLineWaveform.beginLiveOverlay((segment.end - segment.start) + (MAX_GRACE_MS / 1000));

        let linePassed = false;
        let graceStartedAt = null;
        let quietSince = null;
        let finished = false;
        let recChecker = null;

        const finishTake = async () => {
            if (finished) return;
            finished = true;
            if (recChecker) clearInterval(recChecker);
            video.pause();
            window.AppLineWaveform.stopLiveOverlay();

            const blob = await window.AppVoiceRecorder.stopRecording();
            await saveRecording(segment, blob);

            overlay.classList.add('hidden');
            recordingStatus.classList.remove('recording');
            video.muted = false;
            video.volume = 1;
            setState(GAME_STATES.REVIEW);

            advanceAfterLine();
        };

        recChecker = setInterval(() => {
            updateSpeechProgress(segment, Math.min(video.currentTime, stopAt));

            if (!linePassed && video.currentTime >= stopAt) {
                linePassed = true;
                video.pause();
                graceStartedAt = performance.now();
                overlayText.innerText = 'FINISH THE LINE…';
            }

            if (!linePassed) return;

            const elapsedGrace = performance.now() - graceStartedAt;
            const level = window.AppVoiceRecorder.getCurrentLevel();

            if (level === null) {
                if (elapsedGrace >= NO_METER_GRACE_MS) finishTake();
                return;
            }

            if (level < QUIET_LEVEL) {
                if (quietSince === null) quietSince = performance.now();
                if (performance.now() - quietSince >= SILENCE_HOLD_MS) {
                    finishTake();
                    return;
                }
            } else {
                quietSince = null;
            }

            if (elapsedGrace >= MAX_GRACE_MS) {
                finishTake();
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

    /** Moves the game forward after a take is saved. During a normal
     *  playthrough that means advancing to the next line as before; during
     *  a retake (see startRetake) it instead resumes wherever the main game
     *  was, without re-triggering every line after the retaken one. */
    function advanceAfterLine() {
        if (retakeContext) {
            const resumeIndex = retakeContext.resumeIndex;
            retakeContext = null;
            currentSegmentIndex = resumeIndex;
            setState(GAME_STATES.REVIEW);
            // If the scene had already been fully mixed once, refresh the
            // mix so the retaken line is actually reflected in it, instead
            // of leaving a stale "Play Final Mix" around silently.
            if (mixedBuffer) finishGame();
        } else {
            currentSegmentIndex++;
            setState(GAME_STATES.NEXT_LINE);
            playOriginalLine();
        }
    }

    /** Re-records (or records for the first time, if it was skipped/deleted)
     *  a single line without disturbing anything already recorded for the
     *  other lines. Only allowed while nothing else is actively in flight -
     *  the normal game loop chains preview -> countdown -> record -> next
     *  line with essentially no safe interruption point in between, so
     *  starting a retake mid-line would leave two overlapping flows fighting
     *  over the same video element. */
    function startRetake(segmentIndex) {
        const busy = [
            GAME_STATES.PREVIEW_SCENE,
            GAME_STATES.DIALOGUE_PLAYING,
            GAME_STATES.DIALOGUE_FINISHED,
            GAME_STATES.PREPARE_RECORDING,
            GAME_STATES.COUNTDOWN,
            GAME_STATES.RECORDING
        ].includes(state);

        if (retakeContext || busy) {
            alert('Please wait for the current line to finish before retaking another.');
            return;
        }
        if (!segments[segmentIndex]) return;

        retakeContext = { resumeIndex: currentSegmentIndex };
        currentSegmentIndex = segmentIndex;
        checkPlayback();
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
        video.play().catch(err => console.warn('Could not play final dub preview:', err));

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
        recordingsList.classList.toggle('empty', segments.length === 0);

        if (segments.length === 0) {
            recordingsList.innerText = 'No recordings yet.';
            return;
        }

        segments.forEach((segment, index) => {
            const recording = recordings[index];
            const card = document.createElement('div');
            card.className = recording ? 'recording-card' : 'recording-card pending';

            const actions = document.createElement('div');
            actions.className = 'recording-actions';

            if (recording) {
                card.innerHTML = `
                    <strong>Line ${index + 1}: "${escapeHtml(recording.transcript)}"</strong>
                    <div class="recording-meta">${formatTime(recording.sceneTimestamp)} \u2022 ${recording.duration.toFixed(2)}s</div>
                `;
                actions.appendChild(createActionButton('Replay', () => replayRecording(recording)));
                actions.appendChild(createActionButton('Retake', () => startRetake(index)));
                actions.appendChild(createActionButton('Download', () => downloadRecording(recording, index + 1)));
                actions.appendChild(createActionButton('Delete', () => deleteRecording(index)));
            } else {
                card.innerHTML = `
                    <strong>Line ${index + 1}: "${escapeHtml(segment.text)}"</strong>
                    <div class="recording-meta">Not recorded yet</div>
                `;
                actions.appendChild(createActionButton('Record This Line', () => startRetake(index)));
            }

            card.appendChild(actions);
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
        window.AppCutEditor.close();
        window.AppLineWaveform.clear();
        video.volume = 1;
        retakeContext = null;
        transcribeStatus.classList.add('hidden');
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
