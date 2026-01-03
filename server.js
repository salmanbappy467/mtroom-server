require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

// Models (আপনার models ফোল্ডারে Job.js এবং Node.js থাকতে হবে)
const Job = require('./models/Job');
const Node = require('./models/Node');

// --- Configuration ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect DB
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/meternet";
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Error:", err));

// Logic File Management
const LOGIC_FILE_PATH = path.join(__dirname, 'logic.js');
function getLogicFileHash() {
    try {
        const fileBuffer = fs.readFileSync(LOGIC_FILE_PATH);
        const hashSum = crypto.createHash('md5');
        hashSum.update(fileBuffer);
        return { hash: hashSum.digest('hex'), content: fileBuffer.toString() };
    } catch (e) { return { hash: null, content: null }; }
}
let currentLogic = getLogicFileHash();

// Watch for logic file changes
fs.watchFile(LOGIC_FILE_PATH, () => {
    console.log("⚡ Logic file updated on server!");
    currentLogic = getLogicFileHash();
    io.emit('force_update_logic', { hash: currentLogic.hash, content: currentLogic.content });
});

// --- Memory Stores ---
let workers = {}; 

// ==================================================
// 1. AUTH MIDDLEWARE (With Auto-Registration)
// ==================================================
io.use(async (socket, next) => {
    const type = socket.handshake.query.type;
    
    // ড্যাশবোর্ডের জন্য পাসওয়ার্ড লাগে না
    if (type === 'dashboard') return next(); 

    const { machineId, secretKey } = socket.handshake.auth;

    // ক্রেডেনশিয়াল না থাকলে রিজেক্ট
    if (!machineId || !secretKey) {
        return next(new Error("Authentication failed: Missing credentials"));
    }

    try {
        // ১. ডাটাবেসে চেক করা হচ্ছে এই মেশিন আছে কিনা
        let node = await Node.findOne({ machineId: machineId });

        if (node) {
            // যদি নোড আগে থেকেই থাকে, পাসওয়ার্ড চেক করুন
            if (node.secretKey === secretKey) {
                socket.nodeInfo = node;
                return next(); // লগইন সফল
            } else {
                return next(new Error("Authentication failed: Wrong Secret Key")); // পাসওয়ার্ড ভুল
            }
        } else {
            // ২. নতুন নোড: সার্ভার অটোমেটিক রেজিস্টার করে নিবে
            console.log(`🆕 New Node Detected: ${machineId}. Auto-registering...`);
            
            const newNode = new Node({
                machineId: machineId,
                secretKey: secretKey,
                name: machineId, // শুরুতে নাম হিসেবে আইডিই থাকবে
                status: 'online',
                ipAddress: socket.handshake.address
            });
            
            await newNode.save(); // ডাটাবেসে সেভ করা হলো
            socket.nodeInfo = newNode;
            return next(); // লগইন সফল
        }

    } catch (e) {
        console.error("Auth Error:", e);
        return next(new Error("Server Error during Auth"));
    }
});

// ==================================================
// 2. SOCKET CONNECTION LOGIC
// ==================================================
io.on('connection', async (socket) => {
    const type = socket.handshake.query.type;

    // Worker Connected
    if (type === 'worker' && socket.nodeInfo) {
        const node = socket.nodeInfo;
        workers[socket.id] = { id: socket.id, machineId: node.machineId, name: node.name, status: 'idle', lastHeartbeat: Date.now() };
        
        console.log(`✅ Worker Online: ${node.name}`);
        
        await Node.updateOne({ machineId: node.machineId }, { 
            status: 'online', lastSeen: Date.now(), ipAddress: socket.handshake.address 
        });

        // Logic Check
        socket.on('check_version', (clientHash) => {
            if (currentLogic.hash && clientHash !== currentLogic.hash) {
                socket.emit('update_logic_file', currentLogic);
            } else {
                socket.emit('logic_uptodate');
            }
        });

        // Heartbeat
        socket.on('heartbeat', async () => {
            if (workers[socket.id]) {
                workers[socket.id].lastHeartbeat = Date.now();
                await Node.updateOne({ machineId: node.machineId }, { lastSeen: Date.now(), status: 'online' });
            }
        });

        // Progress Update
        socket.on('task_progress', async ({ requestId, progress }) => {
            await Job.findOneAndUpdate({ requestId }, { status: 'processing', progress });
            io.emit('job_progress_update', { requestId, progress });
        });

        // Task Completed
        socket.on('task_completed', async ({ requestId, result }) => {
            if (workers[socket.id]) workers[socket.id].status = 'idle';
            
            const status = (result.error || result.failed > 0) ? 'failed' : 'completed';
            const updateStat = status === 'completed' ? { $inc: { totalSuccess: 1 } } : { $inc: { totalFailed: 1 } };
            
            await Node.updateOne({ machineId: node.machineId }, updateStat);
            await Job.findOneAndUpdate({ requestId }, { status, result, completedAt: new Date() });

            io.emit('job_completed_update', { requestId, status });
            
            // Check for more work
            assignJobToWorker(socket.id);
        });

        // Initial check for work
        assignJobToWorker(socket.id);
    }

    // Disconnect
    socket.on('disconnect', async () => {
        if (workers[socket.id]) {
            const mId = workers[socket.id].machineId;
            delete workers[socket.id];
            await Node.updateOne({ machineId: mId }, { status: 'offline' });
            console.log(`❌ Worker Offline: ${mId}`);
        }
    });
});

// ==================================================
// 3. TASK MANAGEMENT (Queuing)
// ==================================================
async function assignJobToWorker(socketId) {
    if (!workers[socketId] || workers[socketId].status !== 'idle') return;

    const job = await Job.findOne({ status: 'queued' }).sort({ createdAt: 1 });
    if (job) {
        workers[socketId].status = 'busy';
        
        job.status = 'processing';
        job.workerName = workers[socketId].name;
        await job.save();

        io.to(socketId).emit('execute_task', {
            requestId: job.requestId,
            taskType: job.taskType,
            payload: job.payload
        });
        
        io.emit('dashboard_update', {}); 
    }
}

async function createAndDispatch(res, taskType, payload) {
    const requestId = uuidv4();
    try {
        const newJob = new Job({ 
            requestId, 
            taskType, 
            payload,
            progress: { current: 0, total: payload.meters ? payload.meters.length : 0 }
        });
        await newJob.save();
        
        res.json({ 
            status: "queued", 
            trackingId: requestId, 
            message: "Job added to queue." 
        });

        // Try to assign immediately
        const freeWorkerId = Object.keys(workers).find(id => workers[id].status === 'idle');
        if (freeWorkerId) assignJobToWorker(freeWorkerId);

    } catch (e) { res.status(500).json({ error: "DB Error" }); }
}

// ==================================================
// 4. API ENDPOINTS
// ==================================================

// Dashboard Data (Updated for Lifetime Stats)
app.get('/api/dashboard-data', async (req, res) => {
    try {
        const now = new Date();
        const startOfDay = new Date(now.setHours(0, 0, 0, 0));

        // 1. Online Nodes
        const onlineNodeCount = Object.keys(workers).length;

        // 2. Endpoint Stats (LIFETIME - No Date Filter)
        const endpointStatsRaw = await Job.aggregate([
            { $group: { _id: "$taskType", count: { $sum: 1 } } } 
        ]);
        let endpointStats = { 'LOGIN_CHECK': 0, 'METER_POST': 0, 'FAST_POST': 0, 'SINGLE_CHECK': 0, 'INVENTORY': 0 };
        endpointStatsRaw.forEach(item => { if (endpointStats.hasOwnProperty(item._id)) endpointStats[item._id] = item.count; });

        // 3. Graph Data (Last 24h - Keep Date Filter here)
        const graphDataRaw = await Job.aggregate([
            { $match: { createdAt: { $gte: startOfDay } } },
            { $group: { _id: { $hour: "$createdAt" }, count: { $sum: 1 } } },
            { $sort: { "_id": 1 } }
        ]);
        let graphLabels = [], graphCounts = [];
        for(let i=0; i<=now.getHours(); i++) {
            let hourLabel = i.toString().padStart(2, '0') + ":00";
            graphLabels.push(hourLabel);
            const found = graphDataRaw.find(g => g._id === i);
            graphCounts.push(found ? found.count : 0);
        }

        // 4. General Stats (LIFETIME + Today)
        const stats = {
            queued: await Job.countDocuments({ status: 'queued' }),
            
            // Lifetime Stats for Cards
            totalLifetime: await Job.countDocuments({}),
            completedLifetime: await Job.countDocuments({ status: 'completed' }),
            failedLifetime: await Job.countDocuments({ status: 'failed' }),
            
            // Today Stats (Optional if needed)
            totalToday: await Job.countDocuments({ createdAt: { $gte: startOfDay } })
        };

        const nodes = await Node.find();

        res.json({ onlineNodeCount, endpointStats, graphData: { labels: graphLabels, data: graphCounts }, stats, nodes });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Dashboard Data Error" });
    }
});

// Client API Endpoints
app.post('/api/meter-post', (req, res) => createAndDispatch(res, 'METER_POST', req.body));
app.post('/api/fast-post', (req, res) => createAndDispatch(res, 'FAST_POST', req.body));
app.post('/api/login-check', (req, res) => createAndDispatch(res, 'LOGIN_CHECK', req.body));
app.post('/api/single-check', (req, res) => createAndDispatch(res, 'SINGLE_CHECK', req.body));
app.post('/api/all-meter-list', (req, res) => createAndDispatch(res, 'INVENTORY', req.body));

// Status Check
app.get('/api/status/:id', async (req, res) => {
    const job = await Job.findOne({ requestId: req.params.id });
    if (!job) return res.status(404).json({ error: "Not Found" });
    res.json(job);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Distributed Master Server running on port ${PORT}`));