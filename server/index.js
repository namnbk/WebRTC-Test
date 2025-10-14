import os from 'os';
import path from 'path';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const STATIC_ROOT = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.static(STATIC_ROOT));

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.on('connection', socket => {
  socket.on('createOrJoin', room => {
    if (!room) {
      socket.emit('error', 'Room name required');
      return;
    }

    const clientsInRoom = io.sockets.adapter.rooms.get(room);
    const numClients = clientsInRoom ? clientsInRoom.size : 0;

    if (numClients >= 2) {
      socket.emit('full', room);
      return;
    }

    socket.join(room);
    socket.data.room = room;

    if (numClients === 0) {
      socket.emit('created', room, socket.id);
    } else if (numClients === 1) {
      socket.emit('joined', room, socket.id);
      io.to(room).emit('ready');
    }
  });

  socket.on('signal', payload => {
    const room = socket.data.room;
    if (!room) {
      socket.emit('error', 'Join a room before sending signals.');
      return;
    }
    socket.to(room).emit('signal', payload);
  });

  socket.on('pingcheck', () => {
    socket.emit('pongcheck', Date.now());
  });

  socket.on('ipaddr', () => {
    const ifaces = os.networkInterfaces();
    Object.values(ifaces).forEach(addressList => {
      addressList?.forEach(details => {
        if (details.family === 'IPv4' && details.address !== '127.0.0.1') {
          socket.emit('ipaddr', details.address);
        }
      });
    });
  });

  socket.on('disconnecting', () => {
    const room = socket.data.room;
    if (room) {
      socket.to(room).emit('peerDisconnected');
    }
  });
});

httpServer.listen(PORT, () => {
  /* eslint-disable no-console */
  console.log(`Signaling server listening on :${PORT}`);
  /* eslint-enable no-console */
});
