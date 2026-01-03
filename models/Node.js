const mongoose = require('mongoose');

const NodeSchema = new mongoose.Schema({
    machineId: { type: String, required: true, unique: true }, // যেমন: PC-01
    secretKey: { type: String, required: true }, // পাসওয়ার্ড
    name: { type: String }, 
    status: { type: String, default: 'offline' },
    lastSeen: { type: Date, default: Date.now },
    ipAddress: { type: String },
    totalSuccess: { type: Number, default: 0 },
    totalFailed: { type: Number, default: 0 }
});

module.exports = mongoose.model('Node', NodeSchema);