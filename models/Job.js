const mongoose = require('mongoose');

const JobSchema = new mongoose.Schema({
    requestId: { type: String, required: true, unique: true },
    taskType: { type: String, required: true },
    status: { 
        type: String, 
        enum: ['queued', 'processing', 'completed', 'failed'], 
        default: 'queued' 
    },
    workerName: { type: String, default: null },
    payload: { type: Object }, 
    progress: {
        current: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
        lastMeter: { type: String, default: "" }
    },
    result: { type: Object, default: {} },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date }
});

module.exports = mongoose.model('Job', JobSchema);
