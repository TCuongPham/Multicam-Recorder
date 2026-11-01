import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function initDb() {
  await prisma.$connect();
  // WAL: nhiều máy sync 3–5 giây/lần, cho phép đọc song song khi đang ghi.
  await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000;');
}
