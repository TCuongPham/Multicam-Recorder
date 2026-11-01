// Sinh chứng chỉ tự ký cho HTTPS trong mạng LAN (kèm mọi IP hiện có của máy).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const certDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../certs');
fs.mkdirSync(certDir, { recursive: true });

const ips = Object.values(os.networkInterfaces())
  .flat()
  .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4')
  .map((i) => i.address);

const pems = selfsigned.generate([{ name: 'commonName', value: 'multicam.local' }], {
  keySize: 2048,
  days: 825,
  algorithm: 'sha256',
  extensions: [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [{ type: 2, value: 'localhost' }, { type: 2, value: 'multicam.local' }, ...ips.map((ip) => ({ type: 7, ip }))],
    },
  ],
});

fs.writeFileSync(path.join(certDir, 'key.pem'), pems.private);
fs.writeFileSync(path.join(certDir, 'cert.pem'), pems.cert);
console.log(`Đã tạo chứng chỉ tại ${certDir} cho: localhost, ${ips.join(', ')}`);
