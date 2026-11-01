import type { NextFunction, Request, Response } from 'express';
import { Codes } from '@multicam/shared';
import { prisma } from '../db';
import { fail } from '../lib/http';
import { verifyAccessToken, type AccessClaims } from '../lib/security';

export interface AuthContext {
  userId: string;
  role: AccessClaims['acc'];
  deviceId: string | null;
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export async function resolveToken(token: string | undefined | null): Promise<AuthContext | null> {
  if (!token) return null;
  const claims = verifyAccessToken(token);
  if (!claims) return null;
  // Phiên bị thu hồi (đổi mật khẩu ở máy khác / đăng xuất) → token hết hiệu lực ngay ở lần gọi kế tiếp.
  const session = await prisma.authSession.findUnique({ where: { id: claims.sid }, select: { revokedAt: true, userId: true } });
  if (!session || session.revokedAt || session.userId !== claims.sub) return null;
  return { userId: claims.sub, role: claims.acc, deviceId: claims.did, sessionId: claims.sid };
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const auth = await resolveToken(token);
  if (!auth) throw fail(Codes.TOKEN_INVALID);
  req.auth = auth;
  next();
}

/** Chỉ tài khoản Controller (claim acc trong token). */
export function requireController(req: Request, _res: Response, next: NextFunction) {
  if (req.auth?.role !== 'controller') throw fail(Codes.NOT_ACCESS);
  next();
}

export function auth(req: Request): AuthContext {
  if (!req.auth) throw fail(Codes.TOKEN_INVALID);
  return req.auth;
}
