import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './app';
import { initDb, prisma } from './db';
import { dirs, env } from './env';
import { attachRealtime } from './services/realtime';
import { finalizeClosingRooms } from './services/rooms';

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

async function cleanupExpiredUploads() {
  const expired = await prisma.uploadSession.findMany({ where: { status: 'in_progress', expiresAt: { lt: new Date() } } });
  for (const u of expired) {
    await fs.rm(path.join(dirs.uploads, u.id), { recursive: true, force: true }).catch(() => undefined);
    await prisma.uploadSession.update({ where: { id: u.id }, data: { status: 'failed' } });
  }
  await prisma.command.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 3600_000) } } });
}

async function main() {
  await fs.mkdir(dirs.uploads, { recursive: true });
  await fs.mkdir(dirs.videos, { recursive: true });
  await initDb();

  const app = createApp();
  const servers: http.Server[] = [];

  const httpServer = http.createServer(app);
  servers.push(httpServer);
  httpServer.listen(env.port, '0.0.0.0');

  // HTTPS: trình duyệt chỉ cho mở camera trên https:// (hoặc localhost) — cần cho web Remote trong LAN.
  const keyFile = path.join(env.certDir, 'key.pem');
  const certFile = path.join(env.certDir, 'cert.pem');
  let httpsOn = false;
  if (existsSync(keyFile) && existsSync(certFile)) {
    const httpsServer = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, app);
    servers.push(httpsServer);
    httpsServer.listen(env.httpsPort, '0.0.0.0');
    httpsOn = true;
  }

  // Client giữ kết nối lâu giữa các nhịp sync/upload; tránh server đóng socket keep-alive giữa chừng.
  for (const s of servers) {
    s.keepAliveTimeout = 65_000;
    s.headersTimeout = 66_000;
  }
  attachRealtime(servers);

  setInterval(() => void finalizeClosingRooms().catch((e) => console.error('[job] closing rooms', e)), 5000);
  setInterval(() => void cleanupExpiredUploads().catch((e) => console.error('[job] cleanup', e)), 10 * 60_000);

  const ips = lanAddresses();
  console.log('Multi-Cam Recorder server đang chạy');
  console.log(`  HTTP : http://localhost:${env.port}  ${ips.map((ip) => `http://${ip}:${env.port}`).join('  ')}`);
  if (httpsOn) console.log(`  HTTPS: https://localhost:${env.httpsPort}  ${ips.map((ip) => `https://${ip}:${env.httpsPort}`).join('  ')}`);
  else console.log('  HTTPS: tắt (chạy "npm run cert -w @multicam/server" để bật, cần cho web Remote quay qua LAN)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
