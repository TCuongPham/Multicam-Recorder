import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Camera,
  useCameraDevice,
  useCameraFormat,
  useCameraPermission,
  useCodeScanner,
  useMicrophonePermission,
} from 'react-native-vision-camera';
import { Codes, MIN_FREE_STORAGE, formatBytes, formatDuration, inviteCodeSchema } from '@multicam/shared';
import { useNow, useStore } from '@multicam/shared/react';
import { api, errorMessage, isApiError } from '../../services/api';
import { getFreeStorage } from '../../services/clips';
import { cameraBridge, resolveCameraName } from '../../services/recorder';
import { remoteAgent } from '../../services/remote';
import { leaveCurrentRoom, leftByUserRecently } from '../../services/runtime';
import { session } from '../../services/session';
import { setCameraName } from '../../services/storage';
import { useAppState } from '../../hooks';
import { Banner, Button, Checkbox, Field, Muted } from '../../ui/components';
import { colors, radius, spacing } from '../../ui/theme';

function parseResolution(res: string): { width: number; height: number } {
  const [w, h] = res.split('x').map(Number);
  return { width: w || 1920, height: h || 1080 };
}

/** Lấy mã mời 6 ký tự từ nội dung QR (QR chứa đúng mã mời, hoặc một URL có chứa mã). */
function extractInvite(raw: string): string | null {
  const v = raw.trim().toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(v)) return v;
  const m = /(?:CODE=|\/)([A-Z0-9]{6})(?:\b|$)/.exec(v);
  return m ? m[1] : null;
}

type PermissionState = ReturnType<typeof useCameraPermission>;

function PermissionGate({ cam, mic }: { cam: PermissionState; mic: PermissionState }) {
  return (
    <View style={styles.center}>
      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700', textAlign: 'center' }}>Cần quyền camera và micro để quay video</Text>
      <Button
        title="Cấp quyền"
        onPress={async () => {
          const okCam = await cam.requestPermission();
          await mic.requestPermission();
          if (!okCam) {
            Alert.alert('Chưa có quyền camera', 'Mở Cài đặt để cấp quyền camera cho ứng dụng.', [
              { text: 'Để sau', style: 'cancel' },
              { text: 'Mở Cài đặt', onPress: () => void Linking.openSettings() },
            ]);
          }
        }}
      />
    </View>
  );
}

/** Đồng hồ quay tách riêng để không vẽ lại cả màn camera mỗi 500 ms. */
function RecTimer({ startedAt }: { startedAt: number | null }) {
  const now = useNow(500);
  return <Text style={styles.pillText}>● REC {formatDuration(startedAt ? now - startedAt : 0)}</Text>;
}

export function CameraScreen() {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const appState = useAppState();
  const agent = useStore(remoteAgent);
  const bridge = useStore(cameraBridge);
  const { info } = useStore(session);
  const camPerm = useCameraPermission();
  const micPerm = useMicrophonePermission();

  const device = useCameraDevice(bridge.facing);
  const format = useCameraFormat(device, [{ videoResolution: parseResolution(bridge.config.resolution) }, { fps: bridge.config.fps }]);
  const cameraRef = useRef<Camera>(null);

  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [cameraName, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const recording = agent.recordingState === 'recording' || bridge.recording;
  // Camera chạy khi màn hình đang hiển thị, hoặc khi đang quay (không để mất clip khi đổi tab).
  const isActive = appState === 'active' && (isFocused || recording);
  const lowStorage = freeBytes !== null && freeBytes < MIN_FREE_STORAGE;

  // ----- Gắn camera vào bridge để lệnh từ Controller điều khiển được -----
  // Ref ổn định: chỉ gọi khi Camera gắn / gỡ (không chạy lại mỗi lần render).
  const setCameraRef = useCallback((c: Camera | null) => {
    cameraRef.current = c;
    cameraBridge.attach(c);
  }, []);
  useEffect(() => {
    if (!isActive) cameraBridge.setReady(false);
  }, [isActive]);

  // ----- Dung lượng trống: kiểm tra khi mở màn hình và định kỳ -----
  const refreshStorage = useCallback(() => {
    void getFreeStorage().then(setFreeBytes);
  }, []);
  useFocusEffect(
    useCallback(() => {
      refreshStorage();
      const id = setInterval(refreshStorage, 30_000);
      return () => clearInterval(id);
    }, [refreshStorage]),
  );
  useEffect(() => {
    if (agent.recordingState !== 'recording') refreshStorage();
  }, [agent.recordingState, refreshStorage]);

  // ----- Bị loại / phòng đóng: thông báo khi tự dưng rời phòng -----
  const prevInRoom = useRef(agent.inRoom);
  useEffect(() => {
    if (prevInRoom.current && !agent.inRoom && !leftByUserRecently()) {
      Alert.alert('Đã rời phòng', 'Máy đã bị loại khỏi phòng hoặc phòng đã đóng. Quay lại chế độ quay độc lập.');
    }
    prevInRoom.current = agent.inRoom;
  }, [agent.inRoom]);

  // ----- Quét QR mã mời -----
  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: (codes) => {
      const value = codes.find((c) => c.value)?.value;
      const code = value ? extractInvite(value) : null;
      if (!code) return;
      setScanning(false);
      setInviteCode(code);
      setJoinOpen(true);
    },
  });

  async function openJoin() {
    setJoinError(null);
    setName(await resolveCameraName());
    setJoinOpen(true);
  }

  async function doJoin(retried = false): Promise<void> {
    const parsed = inviteCodeSchema.safeParse(inviteCode);
    if (!parsed.success) {
      setJoinError(parsed.error.issues[0]?.message ?? 'Mã mời gồm 6 ký tự');
      return;
    }
    if (!cameraName.trim()) {
      setJoinError('Nhập tên máy quay');
      return;
    }
    if (!consent) {
      setJoinError('Bạn cần cho phép Controller điều khiển quay để vào phòng');
      return;
    }
    if (!info?.deviceId) {
      setJoinError('Thiếu mã thiết bị, vui lòng đăng nhập lại');
      return;
    }
    setJoining(true);
    setJoinError(null);
    try {
      if (recording) await remoteAgent.stopRecording(); // vào phòng thì dừng quay độc lập
      const res = await api.joinRoom({
        invite_code: parsed.data,
        device_id: info.deviceId,
        camera_name: cameraName.trim(),
        grant_control: true,
      });
      await setCameraName(cameraName);
      await session.updateInfo({ cameraName: cameraName.trim() });
      remoteAgent.markJoinedRoom(res.room_id, res.room_name, res.member_id);
      setJoinOpen(false);
      setInviteCode('');
      setConsent(false);
    } catch (e) {
      if (isApiError(e, Codes.INVITE_NOT_FOUND)) {
        setJoinError('Mã mời không đúng hoặc đã hết hạn. Hãy xin mã mới từ Controller.');
        setInviteCode('');
      } else if (isApiError(e, Codes.ROOM_FULL)) {
        setJoinError('Phòng đã đầy');
      } else if (isApiError(e, Codes.DEVICE_IN_OTHER_ROOM) && !retried) {
        const ok = await new Promise<boolean>((resolve) =>
          Alert.alert('Đang ở phòng khác', 'Thiết bị đang ở trong một phòng khác. Rời phòng cũ để vào phòng mới?', [
            { text: 'Không', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Rời phòng cũ', onPress: () => resolve(true) },
          ]),
        );
        if (ok) {
          try {
            if (!remoteAgent.getState().roomId) await remoteAgent.syncNow(); // lấy room_id của phòng cũ
            await leaveCurrentRoom();
            setJoining(false);
            return doJoin(true);
          } catch (err) {
            setJoinError(errorMessage(err));
          }
        }
      } else {
        setJoinError(errorMessage(e));
      }
    } finally {
      setJoining(false);
    }
  }

  function confirmLeave() {
    Alert.alert('Rời phòng', recording ? 'Máy đang quay. Clip sẽ được lưu rồi rời phòng.' : 'Rời phòng và thu hồi quyền điều khiển của Controller?', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Rời phòng',
        style: 'destructive',
        onPress: async () => {
          setLeaving(true);
          try {
            await leaveCurrentRoom();
          } catch (e) {
            if (!isApiError(e, Codes.ROOM_CLOSED)) Alert.alert('Lỗi', errorMessage(e));
          } finally {
            setLeaving(false);
          }
        },
      },
    ]);
  }

  async function toggleStandaloneRecording() {
    if (agent.inRoom) return; // khóa khi đang được điều khiển từ xa
    if (recording) {
      await remoteAgent.stopRecording();
      return;
    }
    const free = await getFreeStorage();
    setFreeBytes(free);
    if (free !== null && free < MIN_FREE_STORAGE) {
      Alert.alert('Không đủ dung lượng', `Bộ nhớ trống chỉ còn ${formatBytes(free)} (cần tối thiểu ${formatBytes(MIN_FREE_STORAGE)}). Hãy giải phóng bộ nhớ trước khi quay.`);
      return;
    }
    if (!micPerm.hasPermission) await micPerm.requestPermission();
    await remoteAgent.startRecording({
      sessionId: null,
      resolution: bridge.config.resolution,
      fps: bridge.config.fps,
      maxDurationSec: 0,
    });
  }

  const fps = format ? Math.min(bridge.config.fps, format.maxFps) : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {!camPerm.hasPermission ? (
        <PermissionGate cam={camPerm} mic={micPerm} />
      ) : !device ? (
        <View style={styles.center}>
          <Text style={{ color: '#fff' }}>Không tìm thấy camera {bridge.facing === 'front' ? 'trước' : 'sau'}</Text>
        </View>
      ) : (
        <Camera
          ref={setCameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          format={format}
          fps={fps}
          isActive={isActive}
          video
          audio={micPerm.hasPermission}
          outputOrientation="device"
          codeScanner={scanning ? codeScanner : undefined}
          onStarted={() => {
            setCameraError(null);
            cameraBridge.setReady(true);
          }}
          onStopped={() => cameraBridge.setReady(false)}
          onError={(e) => {
            setCameraError(e.message);
            cameraBridge.setReady(false);
          }}
        />
      )}

      {/* ----- Thanh trên ----- */}
      <View style={[styles.top, { paddingTop: insets.top + spacing.sm }]}>
        {agent.inRoom ? (
          <View style={styles.remoteBanner}>
            <Text style={styles.remoteBannerText}>● Đang được điều khiển từ xa</Text>
            <Text style={{ color: '#fecaca', fontSize: 12 }}>Phòng: {agent.roomName || agent.roomId}</Text>
          </View>
        ) : null}
        <View style={styles.statusRow}>
          <View style={[styles.pill, { backgroundColor: agent.online ? 'rgba(22,163,74,0.8)' : 'rgba(100,116,139,0.8)' }]}>
            <Text style={styles.pillText}>{agent.online ? 'Đã kết nối server' : 'Mất kết nối server'}</Text>
          </View>
          {recording ? (
            <View style={[styles.pill, { backgroundColor: 'rgba(239,68,68,0.9)' }]}>
              <RecTimer startedAt={agent.recordingStartedAt} />
            </View>
          ) : null}
          <View style={styles.pill}>
            <Text style={styles.pillText}>
              {bridge.config.resolution} · {bridge.config.fps}fps
            </Text>
          </View>
        </View>
        {lowStorage ? (
          <Banner kind="danger">{`Bộ nhớ trống thấp (${formatBytes(freeBytes)}). Cần tối thiểu 500 MB để quay.`}</Banner>
        ) : null}
        {bridge.pendingFlip ? <Banner kind="info">Controller yêu cầu lật camera — sẽ lật sau khi dừng quay</Banner> : null}
        {cameraError ? <Banner kind="warning">{`Lỗi camera: ${cameraError}`}</Banner> : null}
        {bridge.lastError && !recording ? <Banner kind="warning">{bridge.lastError}</Banner> : null}
        {agent.recordingState === 'failed' && agent.errorCode ? <Banner kind="danger">{`Quay lỗi: ${agent.errorCode}`}</Banner> : null}
        {scanning ? <Banner kind="info">Đưa mã QR trên màn hình Controller vào khung camera…</Banner> : null}
      </View>

      {/* ----- Thanh dưới ----- */}
      <View style={[styles.bottom, { paddingBottom: spacing.lg }]}>
        <View style={styles.controls}>
          <Pressable
            accessibilityLabel="Lật camera"
            onPress={() => cameraBridge.toggleFacingLocal()}
            disabled={recording}
            style={[styles.roundBtn, recording && { opacity: 0.4 }]}
          >
            <Text style={{ fontSize: 22 }}>🔄</Text>
          </Pressable>

          <Pressable
            accessibilityLabel={recording ? 'Dừng quay' : 'Quay'}
            onPress={() => void toggleStandaloneRecording()}
            disabled={agent.inRoom || !camPerm.hasPermission || (lowStorage && !recording)}
            style={[styles.recordOuter, (agent.inRoom || (lowStorage && !recording)) && { opacity: 0.4 }]}
          >
            <View style={recording ? styles.recordInnerStop : styles.recordInner} />
            {agent.inRoom ? <Text style={styles.lock}>🔒</Text> : null}
          </Pressable>

          {agent.inRoom ? (
            <Pressable onPress={confirmLeave} style={styles.roundBtn} disabled={leaving}>
              <Text style={styles.smallBtnText}>{leaving ? '…' : 'Rời\nphòng'}</Text>
            </Pressable>
          ) : (
            <Pressable onPress={() => void openJoin()} style={styles.roundBtn} disabled={recording}>
              <Text style={[styles.smallBtnText, recording && { opacity: 0.4 }]}>Vào{'\n'}phòng</Text>
            </Pressable>
          )}
        </View>
        {scanning ? <Button title="Hủy quét" variant="secondary" small onPress={() => setScanning(false)} /> : null}
        {agent.inRoom ? <Muted style={{ color: '#e2e8f0', textAlign: 'center' }}>Nút quay bị khóa khi máy đang ở trong phòng</Muted> : null}
      </View>

      {/* ----- Vào phòng ----- */}
      <Modal visible={joinOpen} transparent animationType="slide" onRequestClose={() => setJoinOpen(false)}>
        <View style={styles.sheetBackdrop}>
          <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>Tham gia phòng</Text>
            <Field
              label="Mã mời (6 ký tự)"
              value={inviteCode}
              onChangeText={(v) => setInviteCode(v.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              autoCapitalize="characters"
              maxLength={6}
              placeholder="8F2A1C"
            />
            <Button
              title="Quét mã QR"
              variant="secondary"
              onPress={() => {
                setJoinOpen(false);
                setScanning(true);
              }}
            />
            <Field label="Tên máy quay" value={cameraName} onChangeText={setName} maxLength={40} placeholder="Cam Trái" />
            <Checkbox
              checked={consent}
              onChange={setConsent}
              label="Tôi cho phép Controller điều khiển quay (bắt đầu/dừng quay, lật camera) trên máy này"
            />
            {joinError ? <Text style={{ color: colors.danger }}>{joinError}</Text> : null}
            <Button title="Tham gia" onPress={() => void doJoin()} loading={joining} disabled={!consent} />
            <Button title="Hủy" variant="ghost" onPress={() => setJoinOpen(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: spacing.md, gap: spacing.sm },
  remoteBanner: { backgroundColor: colors.danger, borderRadius: radius.md, padding: spacing.md, alignItems: 'center' },
  remoteBannerText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: { backgroundColor: 'rgba(15,23,42,0.7)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.lg, gap: spacing.sm },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  roundBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(15,23,42,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallBtnText: { color: '#fff', fontSize: 12, fontWeight: '700', textAlign: 'center' },
  recordOuter: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 5,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: colors.recording },
  recordInnerStop: { width: 32, height: 32, borderRadius: 6, backgroundColor: colors.recording },
  lock: { position: 'absolute', fontSize: 22 },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
});
