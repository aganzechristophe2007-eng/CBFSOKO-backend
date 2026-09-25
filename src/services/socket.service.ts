import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET as string;

export const onlineUsers = new Map<string, Set<string>>();
export const activeConversation = new Map<string, string>();

let io: SocketIOServer | null = null;

function parseCookieHeader(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;

    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }

  return cookies;
}

export function getIO(): SocketIOServer {
  if (!io) throw new Error("Socket.io n'est pas encore initialisé — appelle initSocket() au démarrage du serveur.");
  return io;
}

export function isUserOnline(userId: string): boolean {
  return onlineUsers.has(userId);
}

export function initSocket(httpServer: HTTPServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: process.env.FRONTEND_URL || true, credentials: true },
    maxHttpBufferSize: 1e6,
  });

  io.use((socket, next) => {
    try {
      const raw = socket.handshake.headers.cookie;
      if (!raw) return next(new Error('Non authentifié'));
      const parsed = parseCookieHeader(raw);
      const token = parsed.token;
      if (!token) return next(new Error('Non authentifié'));
      const payload = jwt.verify(token, JWT_SECRET) as { id: string };
      (socket.data as { userId: string }).userId = payload.id;
      next();
    } catch {
      next(new Error('Session invalide ou expirée'));
    }
  });

  io.on('connection', (socket) => {
    const userId = (socket.data as { userId: string }).userId;

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId)!.add(socket.id);
    socket.join(`user:${userId}`);
    io!.emit('presence:update', { userId, online: true });

    socket.on('conversation:open', ({ with: partnerId }: { with: string }) => {
      if (typeof partnerId === 'string') activeConversation.set(userId, partnerId);
    });

    socket.on('conversation:close', () => {
      activeConversation.delete(userId);
    });

    socket.on('typing', ({ to }: { to: string }) => {
      if (typeof to === 'string') io!.to(`user:${to}`).emit('typing', { from: userId });
    });

    socket.on('call:invite', ({ to, callType, offer }: { to: string; callType: 'AUDIO' | 'VIDEO'; offer: unknown }) => {
      if (!isUserOnline(to)) {
        socket.emit('call:unavailable', { to });
        return;
      }
      io!.to(`user:${to}`).emit('call:incoming', { from: userId, callType, offer });
    });

    socket.on('call:answer', ({ to, answer }: { to: string; answer: unknown }) => {
      io!.to(`user:${to}`).emit('call:answered', { from: userId, answer });
    });

    socket.on('call:ice-candidate', ({ to, candidate }: { to: string; candidate: unknown }) => {
      io!.to(`user:${to}`).emit('call:ice-candidate', { from: userId, candidate });
    });

    socket.on('call:decline', ({ to }: { to: string }) => {
      io!.to(`user:${to}`).emit('call:declined', { from: userId });
    });

    socket.on('call:cancel', ({ to }: { to: string }) => {
      io!.to(`user:${to}`).emit('call:cancelled', { from: userId });
    });

    socket.on('call:end', ({ to }: { to: string }) => {
      io!.to(`user:${to}`).emit('call:ended', { from: userId });
    });

    socket.on('disconnect', () => {
      const sockets = onlineUsers.get(userId);
      if (!sockets) return;
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        onlineUsers.delete(userId);
        activeConversation.delete(userId);
        io!.emit('presence:update', { userId, online: false });
      }
    });
  });

  return io;
}