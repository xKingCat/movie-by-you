class VoiceRecorder {
    constructor() {
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.stream = null;
        this.mimeType = this.getSupportedMimeType();
    }

    async init() {
        if (!this.stream) {
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        }
    }

    startRecording() {
        this.audioChunks = [];
        const options = this.mimeType ? { mimeType: this.mimeType } : undefined;
        this.mediaRecorder = new MediaRecorder(this.stream, options);

        this.mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                this.audioChunks.push(event.data);
            }
        };

        this.mediaRecorder.start();
    }

    stopRecording() {
        return new Promise((resolve) => {
            this.mediaRecorder.onstop = () => {
                const audioBlob = new Blob(this.audioChunks, { type: this.mimeType || 'audio/webm' });
                resolve(audioBlob);
            };
            this.mediaRecorder.stop();
        });
    }

    getSupportedMimeType() {
        if (!window.MediaRecorder) return '';
        const candidates = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg'
        ];
        return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
    }
}
window.AppVoiceRecorder = new VoiceRecorder();
