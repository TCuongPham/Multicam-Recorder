import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';

function run(bin: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface ProbeResult {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  isMp4: boolean;
}

/** Đọc thông số video bằng ffprobe (thời lượng, độ phân giải, codec). */
export async function probeVideo(file: string): Promise<ProbeResult | null> {
  const { code, stdout } = await run(ffprobe.path, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  if (code !== 0) return null;
  try {
    const info = JSON.parse(stdout) as {
      streams?: { codec_type: string; codec_name: string; width?: number; height?: number; avg_frame_rate?: string }[];
      format?: { duration?: string; format_name?: string };
    };
    const v = info.streams?.find((s) => s.codec_type === 'video');
    const a = info.streams?.find((s) => s.codec_type === 'audio');
    const [num, den] = (v?.avg_frame_rate ?? '0/1').split('/').map(Number);
    return {
      durationMs: info.format?.duration ? Math.round(Number(info.format.duration) * 1000) : null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      fps: den ? Math.round((num / den) * 100) / 100 : null,
      codec: [v?.codec_name, a?.codec_name].filter(Boolean).join('/') || null,
      isMp4: (info.format?.format_name ?? '').includes('mp4'),
    };
  } catch {
    return null;
  }
}

/** Sinh thumbnail .jpg cùng tên với clip. */
export async function makeThumbnail(file: string, out: string, durationMs: number | null): Promise<boolean> {
  if (!ffmpegPath) return false;
  const at = durationMs && durationMs > 2000 ? '1' : '0';
  const { code } = await run(ffmpegPath as unknown as string, ['-y', '-ss', at, '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out]);
  if (code !== 0) return false;
  return fs
    .stat(out)
    .then((s) => s.size > 0)
    .catch(() => false);
}

export async function removeFiles(...paths: (string | null | undefined)[]) {
  for (const p of paths) if (p) await fs.rm(p, { force: true }).catch(() => undefined);
}
