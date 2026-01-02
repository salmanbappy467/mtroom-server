# mtroom-server

Minimal scaffold for a worker-managed server.

Quick start

1. Install dependencies:

```powershell
npm install
```

2. Start the server:

```powershell
npm run dev
# or
npm start
```

3. Launch a worker (node):

```powershell
cd worker_client
node launcher.js
```

Environment

- `PORT` - server port (default 3000)
- `MONGO_URI` - MongoDB connection string (default mongodb://127.0.0.1:27017/mtroom)

Files of interest

- `server.js` - main entry (Express + Socket.IO)
- `src/db.js` - MongoDB connection and Worker model
- `src/manager.js` - worker registration and simple load-balancer
- `src/routes.js` - example HTTP endpoints
- `public/worker_core.js` - placeholder for OTA worker code
- `worker_client/launcher.js` - simple node worker client
