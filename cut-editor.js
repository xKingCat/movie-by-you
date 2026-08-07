class CutEditor {
    constructor() {
        this.pxPerSec = 90;
        this.minDuration = 0.15;
        this.segments = [];
        this.selectedIndex = -1;
        this.audioBuffer = null;
        this.video = null;
        this.onConfirm = null;
        this.drag = null;
        this.previewRafId = null;
        this.previewEndTime = null;
        this.ready = false;
    }

    init() {
        if (this.ready) return;
        this.ready = true;

        this.container = document.getElementById('cut-editor');
        this.scrollEl = document.getElementById('cut-timeline-scroll');
        this.timelineEl = document.getElementById('cut-timeline');
        this.canvas = document.getElementById('cut-waveform');
        this.blocksEl = document.getElementById('cut-blocks');
        this.playheadEl = document.getElementById('cut-playhead');
        this.hintEl = document.getElementById('cut-editor-hint');

        document.getElementById('cut-preview').addEventListener('click', () => this.previewSelected());
        document.getElementById('cut-split').addEventListener('click', () => this.splitAtPlayhead());
        document.getElementById('cut-merge-next').addEventListener('click', () => this.mergeWithNext());
        document.getElementById('cut-add').addEventListener('click', () => this.addAtPlayhead());
        document.getElementById('cut-delete').addEventListener('click', () => this.deleteSelected());
        document.getElementById('btn-confirm-cuts').addEventListener('click', () => this.confirm());

        this.timelineEl.addEventListener('pointerdown', (e) => {
            if (e.target === this.timelineEl || e.target === this.canvas) {
                this.scrubTo(this.eventToTime(e));
            }
        });
    }

    open(segments, audioBuffer, video, onConfirm) {
        this.init();
        this.segments = segments.map(seg => ({ ...seg }));
        this.audioBuffer = audioBuffer;
        this.video = video;
        this.onConfirm = onConfirm;
        this.selectedIndex = this.segments.length ? 0 : -1;
        this.playheadTime = this.segments.length ? this.segments[0].start : 0;

        if (window.AppLineWaveform) window.AppLineWaveform.setBuffer(audioBuffer);

        const width = Math.max(this.scrollEl.clientWidth, Math.ceil(audioBuffer.duration * this.pxPerSec));
        this.timelineEl.style.width = `${width}px`;
        this.canvas.width = width;
        this.canvas.height = 130;
        this.canvas.style.width = `${width}px`;

        this.renderWaveform();
        this.renderBlocks();
        this.updatePlayhead();
        this.updateHint();

        this.container.classList.remove('hidden');
        this.container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    close() {
        this.init();
        this.stopPreview();
        this.container.classList.add('hidden');
    }

    // ---------- rendering ----------

    renderWaveform() {
        const ctx = this.canvas.getContext('2d');
        const width = this.canvas.width;
        const height = this.canvas.height;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#050508';
        ctx.fillRect(0, 0, width, height);

        const data = this.audioBuffer.getChannelData(0);
        const samplesPerPixel = Math.max(1, Math.floor(data.length / width));
        const mid = height / 2;

        ctx.strokeStyle = 'rgba(0, 240, 255, 0.65)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x < width; x++) {
            const start = x * samplesPerPixel;
            const end = Math.min(data.length, start + samplesPerPixel);
            let min = 0;
            let max = 0;
            for (let i = start; i < end; i++) {
                const v = data[i];
                if (v < min) min = v;
                if (v > max) max = v;
            }
            ctx.moveTo(x + 0.5, mid + min * mid);
            ctx.lineTo(x + 0.5, mid + max * mid);
        }
        ctx.stroke();
    }

    renderBlocks() {
        this.blocksEl.innerHTML = '';
        this.segments.forEach((segment, index) => {
            const block = document.createElement('div');
            block.className = 'cut-block' + (index === this.selectedIndex ? ' selected' : '');
            block.style.left = `${this.timeToPx(segment.start)}px`;
            block.style.width = `${Math.max(6, this.timeToPx(segment.end) - this.timeToPx(segment.start))}px`;

            const label = document.createElement('div');
            label.className = 'cut-label';
            label.innerText = `${index + 1}. ${segment.text || '(new line)'}`;
            block.appendChild(label);

            const leftHandle = document.createElement('div');
            leftHandle.className = 'cut-handle left';
            const rightHandle = document.createElement('div');
            rightHandle.className = 'cut-handle right';
            block.appendChild(leftHandle);
            block.appendChild(rightHandle);

            block.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                this.selectedIndex = index;
                this.renderBlocks();
                this.updateHint();
                this.beginDrag(e, index, 'move');
            });
            leftHandle.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                this.selectedIndex = index;
                this.beginDrag(e, index, 'left');
            });
            rightHandle.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                this.selectedIndex = index;
                this.beginDrag(e, index, 'right');
            });

            this.blocksEl.appendChild(block);
        });
    }

    updatePlayhead() {
        this.playheadEl.style.left = `${this.timeToPx(this.playheadTime)}px`;
    }

    updateHint() {
        if (this.selectedIndex < 0 || !this.segments[this.selectedIndex]) {
            this.hintEl.innerText = 'No line selected.';
            if (window.AppLineWaveform) window.AppLineWaveform.clear();
            return;
        }
        const seg = this.segments[this.selectedIndex];
        this.hintEl.innerText =
            `Line ${this.selectedIndex + 1} selected: ${this.formatTime(seg.start)} - ${this.formatTime(seg.end)} ` +
            `(${(seg.end - seg.start).toFixed(2)}s)`;

        // Keep the shared line-waveform panel in sync with whatever is
        // currently selected in the cut editor, so dragging a handle,
        // splitting, merging, adding, or deleting a line all immediately
        // update the waveform preview to match the new cut.
        if (window.AppLineWaveform) window.AppLineWaveform.showSegment(seg);
    }

    // ---------- dragging ----------

    beginDrag(e, index, mode) {
        const segment = this.segments[index];
        const prev = this.segments[index - 1];
        const next = this.segments[index + 1];

        this.drag = {
            index,
            mode,
            pointerId: e.pointerId,
            startClientX: e.clientX,
            originalStart: segment.start,
            originalEnd: segment.end,
            lowerBound: prev ? prev.end : 0,
            upperBound: next ? next.start : this.audioBuffer.duration
        };

        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        const move = (ev) => this.handleDragMove(ev);
        const up = (ev) => {
            target.releasePointerCapture(ev.pointerId);
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', up);
            this.drag = null;
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
    }

    handleDragMove(e) {
        if (!this.drag) return;
        const { index, mode, startClientX, originalStart, originalEnd, lowerBound, upperBound } = this.drag;
        const deltaTime = (e.clientX - startClientX) / this.pxPerSec;
        const segment = this.segments[index];

        if (mode === 'left') {
            segment.start = this.clamp(originalStart + deltaTime, lowerBound, originalEnd - this.minDuration);
        } else if (mode === 'right') {
            segment.end = this.clamp(originalEnd + deltaTime, originalStart + this.minDuration, upperBound);
        } else if (mode === 'move') {
            const duration = originalEnd - originalStart;
            let newStart = this.clamp(originalStart + deltaTime, lowerBound, upperBound - duration);
            segment.start = newStart;
            segment.end = newStart + duration;
        }

        this.renderBlocks();
        this.updateHint();
    }

    // ---------- toolbar actions ----------

    scrubTo(time) {
        this.playheadTime = this.clamp(time, 0, this.audioBuffer.duration);
        this.updatePlayhead();
        try { this.video.currentTime = this.playheadTime; } catch (err) { /* seeking unsupported in this state */ }
    }

    previewSelected() {
        const segment = this.segments[this.selectedIndex];
        if (!segment) return;
        this.stopPreview();

        this.video.muted = false;
        try { this.video.currentTime = segment.start; } catch (err) { /* ignore */ }
        this.video.play();
        this.previewEndTime = segment.end;

        const step = () => {
            this.playheadTime = this.video.currentTime;
            this.updatePlayhead();
            this.autoScrollTo(this.playheadTime);
            if (this.video.currentTime >= this.previewEndTime || this.video.paused) {
                this.video.pause();
                this.video.muted = true;
                return;
            }
            this.previewRafId = requestAnimationFrame(step);
        };
        this.previewRafId = requestAnimationFrame(step);
    }

    stopPreview() {
        if (this.previewRafId) cancelAnimationFrame(this.previewRafId);
        this.previewRafId = null;
        if (this.video) {
            this.video.pause();
            this.video.muted = true;
        }
    }

    splitAtPlayhead() {
        const index = this.selectedIndex;
        const segment = this.segments[index];
        if (!segment) return;

        const t = this.playheadTime;
        if (t <= segment.start + this.minDuration || t >= segment.end - this.minDuration) {
            this.hintEl.innerText = 'Move the playhead inside the selected line first, then split.';
            return;
        }

        const first = { ...segment, end: t, text: segment.text, words: [] };
        const second = { ...segment, start: t, text: '', words: [] };
        this.segments.splice(index, 1, first, second);
        this.selectedIndex = index + 1;
        this.renderBlocks();
        this.updateHint();
    }

    mergeWithNext() {
        const index = this.selectedIndex;
        const current = this.segments[index];
        const next = this.segments[index + 1];
        if (!current || !next) {
            this.hintEl.innerText = 'Select a line that has another line after it to merge.';
            return;
        }

        current.end = next.end;
        current.text = [current.text, next.text].filter(Boolean).join(' ');
        current.words = [];
        this.segments.splice(index + 1, 1);
        this.renderBlocks();
        this.updateHint();
    }

    deleteSelected() {
        const index = this.selectedIndex;
        if (index < 0 || !this.segments[index]) return;
        this.segments.splice(index, 1);
        this.selectedIndex = Math.min(index, this.segments.length - 1);
        this.renderBlocks();
        this.updateHint();
    }

    addAtPlayhead() {
        const t = this.playheadTime;
        let insertIndex = this.segments.findIndex(seg => seg.start > t);
        if (insertIndex === -1) insertIndex = this.segments.length;

        const prev = this.segments[insertIndex - 1];
        const next = this.segments[insertIndex];
        const lowerBound = prev ? prev.end : 0;
        const upperBound = next ? next.start : this.audioBuffer.duration;

        if (upperBound - lowerBound < this.minDuration * 2) {
            this.hintEl.innerText = "There's no room here — move the playhead to a gap between lines.";
            return;
        }

        const start = this.clamp(t, lowerBound, upperBound - this.minDuration);
        const end = Math.min(upperBound, start + 1.5);

        this.segments.splice(insertIndex, 0, { start, end, text: '', words: [] });
        this.selectedIndex = insertIndex;
        this.renderBlocks();
        this.updateHint();
    }

    confirm() {
        this.stopPreview();
        const cleaned = this.segments.map(seg => ({
            ...seg,
            words: [],
            speechStart: seg.start,
            speechEnd: seg.end
        }));
        const prepared = window.AppSceneTranscriber.prepareSegments(cleaned);
        this.close();
        if (this.onConfirm) this.onConfirm(prepared);
    }

    // ---------- helpers ----------

    eventToTime(e) {
        const rect = this.timelineEl.getBoundingClientRect();
        return this.pxToTime(e.clientX - rect.left);
    }

    autoScrollTo(time) {
        const px = this.timeToPx(time);
        const scrollLeft = this.scrollEl.scrollLeft;
        const width = this.scrollEl.clientWidth;
        if (px < scrollLeft || px > scrollLeft + width - 40) {
            this.scrollEl.scrollLeft = px - width / 2;
        }
    }

    timeToPx(t) { return t * this.pxPerSec; }
    pxToTime(px) { return Math.max(0, px / this.pxPerSec); }
    clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

    formatTime(seconds) {
        const safeSeconds = Math.max(0, seconds || 0);
        const minutes = Math.floor(safeSeconds / 60);
        const remaining = (safeSeconds % 60).toFixed(2).padStart(5, '0');
        return `${String(minutes).padStart(2, '0')}:${remaining}`;
    }
}

window.AppCutEditor = new CutEditor();
