// Updated app.js to fetch storage info directly from the Ubuntu server
const SERVER_STORAGE_URL = 'http://192.168.91.133:3000/storage-info';
const UPLOAD_URL = 'http://192.168.91.133:3000/upload';

async function getActualServerStorage() {
    try {
        const response = await fetch(SERVER_STORAGE_URL);
        const data = await response.json();
        
        const totalSizeBytes = parseFloat(data.sizeGB) * 1024 * 1024 * 1024;
        const freeSizeBytes = parseFloat(data.freeGB) * 1024 * 1024 * 1024;
        const usedSizeBytes = parseFloat(data.usedGB) * 1024 * 1024 * 1024;

        return {
            total: totalSizeBytes,
            used: usedSizeBytes,
            free: freeSizeBytes
        };
    } catch (error) {
        console.error("Error fetching storage info:", error);
        return {
            total: 18.53 * 1024 * 1024 * 1024,
            used: 0,
            free: 18.53 * 1024 * 1024 * 1024
        };
    }
}

async function canUploadFile(fileSize) {
    const storage = await getActualServerStorage();
    if (fileSize > storage.free) {
        return {
            allowed: false,
            message: `المساحة المتبقية بالسيرفر (${(storage.free / (1024**3)).toFixed(2)} GB) غير كافية لرفع هذا الملف.`
        };
    }
    return { allowed: true };
}

console.log("Updated app.js loaded successfully.");
