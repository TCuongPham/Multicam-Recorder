import type { User } from '@prisma/client';
import { prisma } from '../db';
import { env } from '../env';
import { newId } from '../lib/ids';
import { randomToken, sha256, signAccessToken } from '../lib/security';

export interface DeviceInput {
  device_id: string; // UUID ở client
  device_type: number;
  device_name: string;
}

/** Đăng ký / cập nhật thông tin thiết bị (đã gộp register_device vào login). */
export async function upsertDevice(userId: string, input: DeviceInput) {
  return prisma.device.upsert({
    where: { userId_clientUid: { userId, clientUid: input.device_id } },
    update: { deviceType: input.device_type, deviceName: input.device_name, lastSeen: new Date() },
    create: {
      id: newId('dv', 8),
      userId,
      clientUid: input.device_id,
      deviceType: input.device_type,
      deviceName: input.device_name,
      cameraName: input.device_name.slice(0, 40),
      lastSeen: new Date(),
    },
  });
}

/**
 * Cấp access + refresh token cho một thiết bị. Không đụng tới phiên trên máy khác
 * (một tài khoản đăng nhập đồng thời nhiều máy); chỉ thay phiên cũ của chính thiết bị này.
 */
export async function issueTokens(user: Pick<User, 'id' | 'role'>, deviceId: string | null) {
  if (deviceId) {
    await prisma.authSession.updateMany({ where: { userId: user.id, deviceId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  const refreshToken = randomToken('rt', 24);
  const session = await prisma.authSession.create({
    data: {
      id: newId('ss', 12),
      userId: user.id,
      deviceId,
      refreshTokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + env.refreshTtlDays * 86400_000),
    },
  });
  const accessToken = signAccessToken({ sub: user.id, acc: user.role as 'controller' | 'remote', did: deviceId, sid: session.id });
  return { access_token: accessToken, refresh_token: refreshToken, expires_in: env.accessTtlSeconds, sessionId: session.id };
}

export function userInfo(user: User) {
  return { id: user.id, first_name: user.firstName, last_name: user.lastName, email: user.email, phone: user.phone };
}
