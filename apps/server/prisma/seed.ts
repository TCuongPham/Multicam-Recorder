import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/security';

const prisma = new PrismaClient();

// Tài khoản Controller duy nhất do nhà phát hành cấp sẵn: admin / admin.
async function main() {
  const existing = await prisma.user.findFirst({ where: { role: 'controller' } });
  if (existing) {
    console.log(`Controller đã tồn tại: ${existing.username}`);
    return;
  }
  await prisma.user.create({
    data: {
      id: 'u_controller',
      username: 'admin',
      firstName: 'Admin',
      lastName: 'Controller',
      email: 'admin@multicam.local',
      passwordHash: await hashPassword('admin'),
      role: 'controller',
      active: true,
      storageQuota: 500n * 1024n * 1024n * 1024n,
    },
  });
  console.log('Đã tạo tài khoản Controller: admin / admin');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
