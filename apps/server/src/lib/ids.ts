import crypto from 'node:crypto';

const ALNUM = 'abcdefghijkmnpqrstuvwxyz23456789';
// Mã mời / mã phiên: chữ hoa + số, bỏ ký tự dễ nhầm (I, O, 0, 1).
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomFrom(alphabet: string, length: number) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export const newId = (prefix: string, length = 10) => `${prefix}_${randomFrom(ALNUM, length)}`;
export const newInviteCode = () => randomFrom(UPPER, 6);
export const newSessionCode = () => `S${randomFrom(UPPER, 5)}`;
export const newVerifyCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
