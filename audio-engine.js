class AudioEngine {
    constructor() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.originalBuffer = null;
    }

    async extractAudioFromVideo(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const arrayBuffer = e.target.result;
                    this.originalBuffer = await this.ctx.decodeAudioData(arrayBuffer);
                    resolve(this.originalBuffer);
                } catch (err) {
                    reject(err);
                }
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    }

    // Used for the demo mode
    async createSyntheticAudio() {
        const sampleRate = this.ctx.sampleRate;
        const length = sampleRate * 10; // 10 seconds
        const buffer = this.ctx.createBuffer(1, length, sampleRate);
        const data = buffer.getChannelData(0);
        
        // Generate a 10s track with two "dialogue" bursts (noise/sine mix)
        for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            let val = 0;
            // Burst 1: 2s to 4s
            if (t > 2 && t < 4) val = (Math.random() * 2 - 1) * 0.5 * Math.sin(t * 400 * Math.PI);
            // Burst 2: 6s to 8.5s
            if (t > 6 && t < 8.5) val = (Math.random() * 2 - 1) * 0.4 * Math.sin(t * 300 * Math.PI);
            data[i] = val;
        }
        this.originalBuffer = buffer;
        return buffer;
    }
}
window.AppAudioEngine = new AudioEngine();