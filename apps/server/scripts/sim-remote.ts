// Giả lập N máy Remote vào phòng để demo/kiểm thử Controller mà không cần điện thoại.
// Dùng: npm run sim -w @multicam/server -- <MÃ_MỜI> [số_máy=2] [api=http://localhost:3000]
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import {
  ApiClient,
  MemoryKeyValueStore,
  RemoteAgent,
  UploadManager,
  buildClipBaseName,
  connectRealtime,
  uuid,
  type CameraFacing,
  type LocalClip,
  type StartRecordingOptions,
  type Tokens,
} from '@multicam/shared';

const [inviteCode, countArg, apiArg] = process.argv.slice(2);
const BASE = apiArg ?? 'http://localhost:3000';
if (!inviteCode) {
  console.error('Thiếu mã mời. Dùng: npm run sim -w @multicam/server -- <MÃ_MỜI> [số_máy]');
  process.exit(1);
}

async function simulate(index: number) {
  const name = `Sim Cam ${index + 1}`;
  const dir = path.join(os.tmpdir(), 'multicam-sim', `cam${index + 1}`);
  await fs.mkdir(dir, { recursive: true });
  let tokens: Tokens | null = null;
  const api = new ApiClient({ baseUrl: () => BASE, tokens: { get: async () => tokens, set: async (t) => void (tokens = t) } });

  const phone = '08' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const email = `sim${Date.now()}${index}@multicam.local`;
  await api.signup({ first_name: 'Sim', last_name: `Cam${index + 1}`, email, phone, password: 'sim123' });
  const vc = await api.getVerifyCode({ email, purpose: 'signup' });
  const login = await api.checkVerifyCode({ email, code_verify: vc.code_verify, device_id: uuid(), device_type: 1, device_name: name });
  const deviceId = login.device!.device_id;

  const clips: (LocalClip & { path: string; uploaded: boolean })[] = [];
  let facing: CameraFacing = 'back';
  let current: { opts: StartRecordingOptions; startedAt: number } | null = null;
  let agent: RemoteAgent;

  const uploads = new UploadManager(api, {
    kv: new MemoryKeyValueStore(),
    listPendingClips: async () => clips.filter((c) => !c.uploaded),
    hashFile: (clip) =>
      new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        createReadStream((clip as (typeof clips)[number]).path)
          .on('data', (d) => h.update(d))
          .on('end', () => resolve(h.digest('hex')))
          .on('error', reject);
      }),
    sendChunk: async (client, uploadId, clip, i, size) => {
      const fh = await fs.open((clip as (typeof clips)[number]).path, 'r');
      const buf = Buffer.alloc(Math.min(size, clip.size - i * size));
      await fh.read(buf, 0, buf.length, i * size);
      await fh.close();
      return client.uploadChunk(uploadId, i, new Blob([buf]), crypto.createHash('sha256').update(buf).digest('hex'));
    },
    markUploaded: async (clip) => {
      const c = clip as (typeof clips)[number];
      c.uploaded = true;
      await fs.writeFile(c.path.replace(/\.mp4$/, '.uploaded'), '');
      console.log(`[${name}] ✓ đã upload ${c.fileName}`);
    },
  });

  agent = new RemoteAgent({
    api,
    kv: new MemoryKeyValueStore(),
    getUploadStatus: uploads.syncStatus,
    getDeviceStatus: async () => ({ battery_level: 90 - index * 7, is_charging: 0, storage_free: 32e9, camera_facing: facing }),
    recorder: {
      startRecording: async (opts) => {
        current = { opts, startedAt: Date.now() };
        console.log(`[${name}] ● bắt đầu quay (phiên ${opts.sessionId}, lệch đồng hồ ${opts.clockOffsetMs} ms)`);
      },
      stopRecording: async () => {
        if (!current) return;
        const { opts, startedAt } = current;
        current = null;
        const seconds = Math.max(1, Math.min(30, Math.round((Date.now() - startedAt) / 1000)));
        const uid = uuid();
        const baseName = buildClipBaseName({ recordedAt: opts.serverStartedAt, cameraName: name, sessionId: opts.sessionId, localVideoUid: uid });
        const file = path.join(dir, `${baseName}.mp4`);
        spawnSync(ffmpegPath as unknown as string, [
          '-y', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
          '-f', 'lavfi', '-i', `sine=frequency=${300 + index * 120}:duration=${seconds}`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '4M', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', file,
        ]);
        const stat = await fs.stat(file).catch(() => null);
        if (!stat) {
          agent.reportRecording('failed', { errorCode: 'FFMPEG_FAILED' });
          return;
        }
        clips.push({
          uid,
          baseName,
          fileName: `${baseName}.mp4`,
          size: stat.size,
          mimeType: 'video/mp4',
          path: file,
          uploaded: false,
          ref: file,
          metadata: {
            local_video_uid: uid,
            device_id: deviceId,
            camera_name: name,
            session_id: opts.sessionId,
            recorded_at: opts.serverStartedAt,
            duration_ms: seconds * 1000,
            resolution: '1280x720',
            fps: 30,
            clock_offset_ms: opts.clockOffsetMs,
          },
        });
        console.log(`[${name}] ■ đã lưu clip ${seconds}s → tự động upload`);
        agent.reportRecording('saved', { localVideoUid: uid });
        uploads.kick();
      },
      switchCamera: async (f) => {
        facing = f === 'toggle' ? (facing === 'front' ? 'back' : 'front') : f;
        console.log(`[${name}] ⇄ camera ${facing === 'front' ? 'trước' : 'sau'}`);
      },
    },
  });

  connectRealtime({ baseUrl: BASE, getToken: () => api.getAccessToken(), onCommand: (cmd) => agent.handlePushedCommand(cmd) });
  const joined = await api.joinRoom({ invite_code: inviteCode, device_id: deviceId, camera_name: name, grant_control: true });
  agent.markJoinedRoom(joined.room_id, joined.room_name, joined.member_id);
  await agent.start(deviceId);
  let wasInRoom = true;
  agent.subscribe((s) => {
    if (wasInRoom && !s.inRoom) console.log(`[${name}] rời phòng (bị loại hoặc phòng đóng)`);
    wasInRoom = s.inRoom;
  });
  console.log(`[${name}] đã vào phòng ${joined.room_name} (${deviceId})`);
}

const count = Math.max(1, Math.min(8, Number(countArg) || 2));
for (let i = 0; i < count; i++) {
  simulate(i).catch((e) => console.error(`[Sim Cam ${i + 1}]`, e.message, e.data ?? ''));
}
