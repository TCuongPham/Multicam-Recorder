import crypto from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { env } from '../env';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: string, keylen: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, hex] = stored.split('$');
  if (!salt || !hex) return false;
  const key = await scrypt(password, salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

export const sha256 = (input: string | Buffer) => crypto.createHash('sha256').update(input).digest('hex');

export function randomToken(prefix: string, bytes = 32) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;
}

export interface AccessClaims {
  sub: string; // user id
  acc: 'controller' | 'remote'; // vai trò — chặn quyền ngay ở tầng xác thực
  did: string | null; // device id
  sid: string; // auth session id
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.jwtSecret, { expiresIn: env.accessTtlSeconds, algorithm: 'HS256' });
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    return jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] }) as AccessClaims;
  } catch {
    return null;
  }
}

/** URL có chữ ký và thời hạn (phát video, thumbnail, tải về). */
export function signPath(pathname: string, ttlSeconds = env.signedUrlSeconds) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = crypto.createHmac('sha256', env.jwtSecret).update(`${pathname}:${exp}`).digest('hex').slice(0, 32);
  return { url: `${pathname}?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000) };
}

export function verifySignedPath(pathname: string, exp: unknown, sig: unknown): boolean {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now() / 1000 || typeof sig !== 'string') return false;
  const expected = crypto.createHmac('sha256', env.jwtSecret).update(`${pathname}:${e}`).digest('hex').slice(0, 32);
  return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
