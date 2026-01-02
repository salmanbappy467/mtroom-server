// file: server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Socket Server (Timeout 10 Minutes)
const io = new Server(server, { 
    cors: { origin: "*" },
    pingTimeout: 600000, 
    connectTimeout: 600000
});

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI;

app.use(cors());
app.use(express.json());

// Static Files for OTA Update
const DIST_FOLDER = path.join(__dirname, 'public/worker_dist');
app.use('/files', express.static(DIST_FOLDER));

// --- DATA STORE ---
let workers = new Map();
let workerList = [];
let pendingRequests = 0;

// --- DATABASE MODELS ---
const workerSchema = new mongoose.Schema({
    deviceId: String, socketId: String, lastSeen: Date, isActive: Boolean,
    totalProcessed: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 }
});
const Worker = mongoose.models.Worker || mongoose.model('Worker', workerSchema);

const dailyStatSchema = new mongoose.Schema({
    date: { type: String, unique: true },
    totalRequests: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    breakdown: { login: Number, meter: Number, inventory: Number }
});
const DailyStat = mongoose.models.DailyStat || mongoose.model('DailyStat', dailyStatSchema);

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    socket.on('register_worker', async (data) => {
        const { deviceId } = data;
        console.log(`✅ Worker Connected: ${deviceId}`);
        workers.set(socket.id, { socketId: socket.id, deviceId, processed: 0, success: 0 });
        refreshWorkerList();
        if (MONGO_URI) await Worker.updateOne({ deviceId }, { socketId: socket.id, isActive: true, lastSeen: new Date() }, { upsert: true });
    });

    socket.on('disconnect', async () => {
        const w = workers.get(socket.id);
        if (w) {
            console.log(`❌ Worker Disconnected: ${w.deviceId}`);
            if (MONGO_URI) await Worker.updateOne({ deviceId: w.deviceId }, { isActive: false });
            workers.delete(socket.id);
            refreshWorkerList();
        }
    });
});

function refreshWorkerList() {
    workerList = Array.from(workers.values());
    io.emit('worker_update', { active: workerList.length });
}

async function updateStats(socketId, total, success, type) {
    const w = workers.get(socketId);
    if(w) { w.processed += total; w.success += success; }
    
    if (MONGO_URI && w) {
        await Worker.updateOne({ deviceId: w.deviceId }, { $inc: { totalProcessed: total, successCount: success } });
        const today = new Date().toISOString().split('T')[0];
        const incObj = { totalRequests: total, successCount: success };
        if(type) incObj[`breakdown.${type}`] = total;
        await DailyStat.updateOne({ date: today }, { $inc: incObj }, { upsert: true });
    }
}

// --- PROCESSOR ---
let rrIndex = 0;
function getWorkerSocket() {
    if (workerList.length === 0) return null;
    rrIndex = (rrIndex + 1) % workerList.length;
    return workerList[rrIndex].socketId;
}

const processViaWorker = (eventName, data, res, type) => {
    const socketId = getWorkerSocket();
    if (!socketId) return res.status(503).json({ error: "No active workers available" });

    const count = data.meters ? data.meters.length : 1;
    pendingRequests += count;
    console.log(`🚀 [${type}] Processing ${count} items via ${socketId}...`);

    io.to(socketId).timeout(600000).emit(eventName, data, async (err, response) => {
        pendingRequests = Math.max(0, pendingRequests - count);
        
        if (err) {
            console.error(`⚠️ Worker Timeout: ${err.message}`);
            return res.status(504).json({ error: "Worker Timeout (10m limit)" });
        }
        
        const total = response.count || count;
        const success = response.success || (response.status === 'success' ? 1 : 0);
        await updateStats(socketId, total, success, type);
        res.json(response);
    });
};

// --- API ROUTES ---
app.post('/api/login-check', (req, res) => {
    const socketId = getWorkerSocket();
    if (!socketId) return res.status(503).json({ error: "No Workers" });
    io.to(socketId).emit('login-check', req.body, (resp) => res.json(resp));
});

app.post('/api/meter-post', (req, res) => processViaWorker('meter-post', req.body, res, "meter"));
app.post('/api/fast-post', (req, res) => processViaWorker('meter-post', req.body, res, "meter"));
app.post('/api/single-check', (req, res) => processViaWorker('single-check', req.body, res, "single"));
app.post('/api/all-meter-list', (req, res) => processViaWorker('all-meter-list', req.body, res, "inventory"));

// --- STATS ---
app.get('/stats', async (req, res) => {
    let daily = { totalRequests: 0, successCount: 0, breakdown: { login: 0, meter: 0 } };
    if (MONGO_URI) {
        const today = new Date().toISOString().split('T')[0];
        const dbStat = await DailyStat.findOne({ date: today });
        if (dbStat) daily = dbStat;
    }
    res.json({
        active_workers: workerList.length,
        pending_requests: pendingRequests,
        todays_activity: daily,
        workers: workerList.map(w => ({ deviceId: w.deviceId, lastSeen: new Date(), totalProcessed: w.processed, successCount: w.success }))
    });
});

app.get('/worker/update-check', (req, res) => {
    try {
        const coreFile = path.join(DIST_FOLDER, 'worker_core.js');
        if (fs.existsSync(coreFile)) res.json({ version: fs.statSync(coreFile).mtimeMs });
        else res.json({ version: 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/dashboard', (req, res) => {
    const p = path.join(__dirname, 'dashboard.html');
    if(fs.existsSync(p)) res.sendFile(p);
    else res.send("Dashboard missing");
});

async function start() {
    if (MONGO_URI) try { await mongoose.connect(MONGO_URI); console.log("✅ DB Connected"); } catch (e) {}
    server.listen(PORT, () => console.log(`👑 Manager running on port ${PORT}`));
}
start();