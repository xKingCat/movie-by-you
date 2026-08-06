class AppStorage {
    constructor() {
        this.cache = new Map();
    }
    
    // In a full production app, use IndexedDB. 
    // For this local browser runtime, memory Map is used to hold audio blobs during session.
    saveBlob(id, blob) {
        this.cache.set(id, blob);
    }
    
    getBlob(id) {
        return this.cache.get(id);
    }

    saveScore(scoreData) {
        localStorage.setItem('cv_last_score', JSON.stringify(scoreData));
    }

    getScore() {
        const data = localStorage.getItem('cv_last_score');
        return data ? JSON.parse(data) : null;
    }
}
window.AppStorage = new AppStorage();