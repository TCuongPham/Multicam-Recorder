import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import {
  Codes,
  VERIFY_EXPIRES_SECONDS,
  VERIFY_RESEND_SECONDS,
  changePasswordSchema,
  checkVerifyCodeSchema,
  deleteAccountSchema,
  forgotPasswordSchema,
  getVerifyCodeSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  signupSchema,
} from '@multicam/shared';
import { prisma } from '../db';
import { dirs } from '../env';
import { newId, newVerifyCode } from '../lib/ids';
import { fail, parse, send } from '../lib/http';
import { hashPassword, randomToken, sha256, signAccessToken, verifyPassword } from '../lib/security';
import { auth, requireAuth } from '../middleware/auth';
import { removeFiles } from '../services/media';
import { notifySessionRevoked } from '../services/realtime';
import { leaveAllRooms } from '../services/rooms';
import { issueTokens, upsertDevice, userInfo } from '../services/tokens';

export const authRouter = Router();

function findByAccount(identifier: string) {
  const id = identifier.trim();
  return prisma.user.findFirst({ where: { OR: [{ email: id.toLowerCase() }, { phone: id }, { username: id }] } });
}

function maskTarget(target: string) {
  if (target.includes('@')) {
    const [name, domain] = target.split('@');
    return `${name.slice(0, 1)}***@${domain}`;
  }
  return target.length > 6 ? `${target.slice(0, 3)}****${target.slice(-3)}` : '***';
}

// 1. signup — tài khoản đăng ký qua ứng dụng LUÔN là Remote.
authRouter.post('/auth/signup', async (req, res) => {
  const body = parse(signupSchema, req.body);
  const existing = await prisma.user.findMany({ where: { OR: [{ email: body.email }, { phone: body.phone }] } });
  for (const u of existing) {
    if (u.active || u.role === 'controller') {
      throw fail(Codes.USER_EXISTED, { field: u.email === body.email ? 'email' : 'phone' });
    }
  }
  // Bản đăng ký cũ chưa kích hoạt thì cho đăng ký lại.
  if (existing.length) await prisma.user.deleteMany({ where: { id: { in: existing.map((u) => u.id) } } });
  const user = await prisma.user.create({
    data: {
      id: newId('u', 8),
      firstName: body.first_name,
      lastName: body.last_name,
      email: body.email,
      phone: body.phone,
      passwordHash: await hashPassword(body.password),
      role: 'remote',
      active: false,
    },
  });
  send(res, { user_id: user.id, email: user.email, phone: user.phone, account_role: 'remote', verify_required: '1' });
});

// 2. get_verify_code — dùng chung cho đăng ký và quên mật khẩu.
authRouter.post('/auth/verify-code', async (req, res) => {
  const body = parse(getVerifyCodeSchema, req.body);
  const target = (body.email ?? body.phone)!.trim().toLowerCase();
  const user = await findByAccount(target);
  if (!user) throw fail(Codes.USER_NOT_VALIDATED, { field: body.email ? 'email' : 'phone' });
  if (body.purpose === 'signup' && user.active) throw fail(Codes.PARAM_VALUE_INVALID, { field: 'email', reason: 'Account already active' });
  if (body.purpose === 'forgot_password' && !user.active) throw fail(Codes.USER_NOT_VALIDATED, { verify_required: '1' });

  const last = await prisma.verifyCode.findFirst({ where: { target, purpose: body.purpose }, orderBy: { createdAt: 'desc' } });
  if (last) {
    const elapsed = (Date.now() - last.createdAt.getTime()) / 1000;
    if (elapsed < VERIFY_RESEND_SECONDS) {
      throw fail(Codes.LIMITED_ACCESS, { retry_after: Math.ceil(VERIFY_RESEND_SECONDS - elapsed) });
    }
  }
  const code = newVerifyCode();
  await prisma.verifyCode.create({
    data: { id: newId('vc', 10), target, purpose: body.purpose, code, expiresAt: new Date(Date.now() + VERIFY_EXPIRES_SECONDS * 1000) },
  });
  // Mô phỏng gửi email/SMS: in ra log server (đặc tả cho phép trả mã luôn trong response).
  console.log(`[verify] ${body.purpose} → ${target}: ${code}`);
  send(res, { expires_in: VERIFY_EXPIRES_SECONDS, masked_target: maskTarget(target), code_verify: code });
});

async function consumeCode(target: string, purpose: string, code: string) {
  const record = await prisma.verifyCode.findFirst({
    where: { target, purpose, code, usedAt: null, expiresAt: { gt: new Date() } },
  });
  if (!record) throw fail(Codes.VERIFY_CODE_INCORRECT, { field: 'code_verify' });
  // Dùng xong thì vô hiệu mọi mã còn lại của cùng mục đích.
  await prisma.verifyCode.updateMany({ where: { target, purpose, usedAt: null }, data: { usedAt: new Date() } });
}

// 3. check_verify_code — đúng mã thì kích hoạt và trả token luôn.
authRouter.post('/auth/verify-code/check', async (req, res) => {
  const body = parse(checkVerifyCodeSchema, req.body);
  const target = (body.email ?? body.phone)!.trim().toLowerCase();
  const user = await findByAccount(target);
  if (!user) throw fail(Codes.USER_NOT_VALIDATED);
  await consumeCode(target, 'signup', body.code_verify);
  const activated = await prisma.user.update({ where: { id: user.id }, data: { active: true } });
  const device =
    body.device_id && body.device_type && body.device_name
      ? await upsertDevice(user.id, { device_id: body.device_id, device_type: body.device_type, device_name: body.device_name })
      : null;
  const tokens = await issueTokens(activated, device?.id ?? null);
  send(res, {
    user_id: user.id,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    account_role: activated.role,
    active: '1',
    user: userInfo(activated),
    device: device ? { device_id: device.id, camera_name: device.cameraName } : undefined,
  });
});

// 4. login — đăng nhập + đăng ký thiết bị trong một lời gọi.
authRouter.post('/auth/login', async (req, res) => {
  const body = parse(loginSchema, req.body);
  const user = await findByAccount((body.email ?? body.phone)!);
  if (!user) throw fail(Codes.USER_NOT_VALIDATED, { field: 'email' }, 'Account does not exist');
  if (!(await verifyPassword(body.password, user.passwordHash))) {
    throw fail(Codes.PARAM_VALUE_INVALID, { field: 'password', reason: 'Wrong password' }, 'Wrong password');
  }
  if (!user.active) throw fail(Codes.USER_NOT_VALIDATED, { verify_required: '1', email: user.email, phone: user.phone });
  if (user.locked) throw fail(Codes.NOT_ACCESS, { reason: 'locked' }, 'Account is locked');
  const device = await upsertDevice(user.id, body);
  const tokens = await issueTokens(user, device.id);
  send(res, {
    user: userInfo(user),
    account_role: user.role,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
    device: { device_id: device.id, camera_name: device.cameraName },
  });
});

// 5. refresh_token — xoay vòng refresh token.
authRouter.post('/auth/refresh', async (req, res) => {
  const body = parse(refreshSchema, req.body);
  const session = await prisma.authSession.findUnique({ where: { refreshTokenHash: sha256(body.refresh_token) }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt < new Date() || session.user.locked) throw fail(Codes.TOKEN_INVALID);
  const refreshToken = randomToken('rt', 24);
  await prisma.authSession.update({ where: { id: session.id }, data: { refreshTokenHash: sha256(refreshToken) } });
  const accessToken = signAccessToken({ sub: session.userId, acc: session.user.role as 'controller' | 'remote', did: session.deviceId, sid: session.id });
  send(res, { access_token: accessToken, refresh_token: refreshToken, expires_in: '3600' });
});

// 6. forgot_password — đặt lại mật khẩu qua mã xác thực.
authRouter.post('/auth/password/forgot', async (req, res) => {
  const body = parse(forgotPasswordSchema, req.body);
  const target = (body.email ?? body.phone)!.trim().toLowerCase();
  const user = await findByAccount(target);
  if (!user) throw fail(Codes.USER_NOT_VALIDATED);
  await consumeCode(target, 'forgot_password', body.code_verify);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.new_password) } });
  await prisma.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  send(res, {});
});

// 7. change_password — thu hồi phiên của các thiết bị khác, giữ phiên hiện tại.
authRouter.put('/auth/password', requireAuth, async (req, res) => {
  const a = auth(req);
  const body = parse(changePasswordSchema, req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
  if (!(await verifyPassword(body.old_password, user.passwordHash))) {
    throw fail(Codes.PARAM_VALUE_INVALID, { field: 'old_password', reason: 'Old password is incorrect' }, 'Old password is incorrect');
  }
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.new_password) } });
  await prisma.authSession.updateMany({
    where: { userId: user.id, revokedAt: null, id: { not: a.sessionId } },
    data: { revokedAt: new Date() },
  });
  send(res, {});
});

// 8. logout — chỉ hủy phiên của thiết bị đang gọi.
authRouter.post('/auth/logout', requireAuth, async (req, res) => {
  const a = auth(req);
  parse(logoutSchema, req.body);
  if (a.deviceId) await leaveAllRooms([a.deviceId]);
  await prisma.authSession.update({ where: { id: a.sessionId }, data: { revokedAt: new Date() } });
  send(res, {});
});

// 9. delete_account — xóa vĩnh viễn tài khoản và toàn bộ video đã upload.
authRouter.delete('/users/me', requireAuth, async (req, res) => {
  const a = auth(req);
  const body = parse(deleteAccountSchema, req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: a.userId }, include: { devices: true, videos: true, uploads: true } });
  if (user.role === 'controller') throw fail(Codes.NOT_ACCESS, { reason: 'controller_cannot_be_deleted' }, 'Controller account can not be deleted');
  if (!(await verifyPassword(body.password, user.passwordHash))) {
    throw fail(Codes.PARAM_VALUE_INVALID, { field: 'password', reason: 'Wrong password' }, 'Wrong password');
  }
  await leaveAllRooms(user.devices.map((d) => d.id));
  for (const v of user.videos) await removeFiles(v.filePath, v.thumbPath);
  for (const u of user.uploads) await fs.rm(path.join(dirs.uploads, u.id), { recursive: true, force: true }).catch(() => undefined);
  await prisma.user.delete({ where: { id: user.id } }); // cascade: thiết bị, phiên, video, upload
  notifySessionRevoked(user.id);
  send(res, { deleted_at: new Date().toISOString() });
});
