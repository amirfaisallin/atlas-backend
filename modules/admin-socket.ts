import type { Server as SocketIOServer } from 'socket.io';

let io: SocketIOServer | null = null;

export function setAdminSocket(server: SocketIOServer): void {
  io = server;
}

export function getAdminSocket(): SocketIOServer | null {
  return io;
}

export type AdminNotificationPayload =
  | { type: 'deposit_request'; id: string; accountId: string; amount: number; paymentMethod: string; userName?: string; userEmail?: string }
  | { type: 'withdrawal_request'; id: string; accountId: string; amount: number; paymentMethod: string; userName?: string; userEmail?: string }
  | { type: 'new_user'; id: string; name: string; email: string }
  | { type: 'trade'; accountId: string; pair?: string; amount: number; status: string; userName?: string; userEmail?: string };

export function emitAdminNotification(payload: AdminNotificationPayload): void {
  if (io) {
    io.emit('admin_notification', {
      ...payload,
      at: new Date().toISOString(),
    });
  }
}
