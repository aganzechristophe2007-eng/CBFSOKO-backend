import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET as string;
const CALL_RING_TIMEOUT_MS = 30_000; // durée de sonnerie avant "appel manqué", comme WhatsApp

export const onlineUsers = new Map<string, Set<string>>();
export const activeConversation = new Map<string, string>();

// Appels en attente de réponse (clé: "appelant->appelé"), pour déclencher le timeout de sonnerie.
const pendingCalls = new Map<string, ReturnType<typeof setTimeout>>();

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

function clearPendingCall(from: string, to: string) {
  const key = `${from}->${to}`;
  const timeout = pendingCalls.get(key);
  if (timeout) {
    clearTimeout(timeout);
    pendingCalls.delete(key);
  }
}

export function initSocket(httpServer: HTTPServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: process.env.FRONTEND_URL || true, credentials: true },
    maxHttpBufferSize: 1e6,
    // Permet de restaurer l'état (rooms) après une micro-coupure réseau (fréquent en 3G/4G)
    // sans repasser par le middleware d'auth, pour que l'appli ne se sente pas "déconnectée".
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: true,
    },
    // Détection plus rapide des déconnexions (présence + appels) : par défaut Socket.io
    // met ~45s à détecter une coupure ; ici environ 15s.
    pingInterval: 10_000,
    pingTimeout: 5_000,
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

      // Si personne ne répond dans le délai imparti, on prévient les deux côtés (appel manqué),
      // au lieu de laisser l'appelant sonner indéfiniment dans le vide.
      clearPendingCall(userId, to);
      const key = `${userId}->${to}`;
      pendingCalls.set(
        key,
        setTimeout(() => {
          io!.to(`user:${userId}`).emit('call:no-answer', { to });
          io!.to(`user:${to}`).emit('call:cancelled', { from: userId });
          pendingCalls.delete(key);
        }, CALL_RING_TIMEOUT_MS)
      );
    });

    socket.on('call:answer', ({ to, answer }: { to: string; answer: unknown }) => {
      clearPendingCall(userId, to);
      io!.to(`user:${to}`).emit('call:answered', { from: userId, answer });
    });

    socket.on('call:ice-candidate', ({ to, candidate }: { to: string; candidate: unknown }) => {
      io!.to(`user:${to}`).emit('call:ice-candidate', { from: userId, candidate });
    });

    socket.on('call:decline', ({ to }: { to: string }) => {
      clearPendingCall(to, userId);
      io!.to(`user:${to}`).emit('call:declined', { from: userId });
    });

    socket.on('call:cancel', ({ to }: { to: string }) => {
      clearPendingCall(userId, to);
      io!.to(`user:${to}`).emit('call:cancelled', { from: userId });
    });

    socket.on('call:end', ({ to }: { to: string }) => {
      clearPendingCall(userId, to);
      clearPendingCall(to, userId);
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

        // Nettoie les appels en attente concernant cet utilisateur (évite une fuite mémoire).
        for (const key of pendingCalls.keys()) {
          if (key.startsWith(`${userId}->`) || key.endsWith(`->${userId}`)) {
            clearTimeout(pendingCalls.get(key)!);
            pendingCalls.delete(key);
          }
        }
      }
    });
  });

  return io;
}