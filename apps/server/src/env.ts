import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const env = {
  root,
  port: Number(process.env.PORT ?? 3000),
  httpsPort: Number(process.env.HTTPS_PORT ?? 3443),
  jwtSecret: process.env.JWT_SECRET ?? 'multicam-dev-secret-change-me',
  storageDir: path.resolve(root, process.env.STORAGE_DIR ?? './storage'),
  certDir: path.resolve(root, 'certs'),
  webDist: path.resolve(root, '../web/dist'),
  accessTtlSeconds: 3600,
  refreshTtlDays: 30,
  inviteTtlMinutes: 10,
  uploadTtlHours: 2,
  downloadTicketMinutes: 10,
  signedUrlSeconds: 6 * 3600,
};

export const dirs = {
  uploads: path.join(env.storageDir, 'uploads'),
  videos: path.join(env.storageDir, 'videos'),
};
