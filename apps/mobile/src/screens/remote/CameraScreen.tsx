import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Linking, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
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
import { usePreviewSender } from '../../services/previewSender';
import { session } from '../../services/session';
import { setCameraName } from '../../services/storage';
import { useAppState } from '../../hooks';
import { Banner, Button, Checkbox, Field, Icon, PressableScale, RecDot, RotatingIcon } from '../../ui/components';
import { colors, font, radius, spacing } from '../../ui/theme';

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
      <Icon name="camera" size={32} color={colors.onMediaMuted} />
      <Text style={{ color: colors.onMedia, fontSize: 16, fontWeight: font.heading, textAlign: 'center' }}>Cần quyền camera và micro</Text>
      <Button
        title="Cấp quyền"
        onPress={async () => {
          const okCam = await cam.requestPermission();
          await mic.requestPermission();
          if (!okCam) {
            Alert.alert('Chưa có quyền camera', undefined, [
              { text: 'Hủy', style: 'cancel' },
              { text: 'Mở cài đặt', onPress: () => void Linking.openSettings() },
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
  return (
    <>
      <RecDot size={7} />
      <Text style={styles.pillText}>REC {formatDuration(startedAt ? now - startedAt : 0)}</Text>
    </>
  );
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
  const [flipTurns, setFlipTurns] = useState(0);

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

  // Khung hình xem trước ~1 khung/giây cho Controller khi đang ở trong phòng và camera đã sẵn sàng.
  usePreviewSender(cameraRef, agent.inRoom && bridge.ready && isActive && !!device);

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
      Alert.alert('Đã rời phòng');
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
      setJoinError('Nhập tên camera');
      return;
    }
    if (!consent) {
      setJoinError('Cần cho phép điều khiển');
      return;
    }
    if (!info?.deviceId) {
      setJoinError('Hãy đăng nhập lại');
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
        setJoinError('Mã mời không hợp lệ');
        setInviteCode('');
      } else if (isApiError(e, Codes.ROOM_FULL)) {
        setJoinError('Phòng đã đầy');
      } else if (isApiError(e, Codes.DEVICE_IN_OTHER_ROOM) && !retried) {
        const ok = await new Promise<boolean>((resolve) =>
          Alert.alert('Rời phòng hiện tại?', undefined, [
            { text: 'Hủy', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Rời phòng', onPress: () => resolve(true) },
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
    Alert.alert('Rời phòng?', recording ? 'Clip đang quay vẫn được lưu.' : undefined, [
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
      Alert.alert('Không đủ bộ nhớ', `Bộ nhớ còn ${formatBytes(free)}`);
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
    <View style={{ flex: 1, backgroundColor: colors.media }}>
      {!camPerm.hasPermission ? (
        <PermissionGate cam={camPerm} mic={micPerm} />
      ) : !device ? (
        <View style={styles.center}>
          <Text style={{ color: colors.onMedia }}>Không tìm thấy camera</Text>
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
            <Icon name="lock" size={16} color={colors.onMedia} />
            <View style={{ flex: 1 }}>
              <Text style={styles.remoteBannerText}>Đang được điều khiển từ xa</Text>
              <Text style={styles.remoteBannerSub} numberOfLines={1}>
                {agent.roomName || agent.roomId}
              </Text>
            </View>
            <PressableScale accessibilityRole="button" onPress={confirmLeave} disabled={leaving} style={[styles.leaveBtn, leaving && { opacity: 0.5 }]}>
              <Text style={styles.leaveText}>Rời phòng</Text>
            </PressableScale>
          </View>
        ) : null}
        <View style={styles.statusRow}>
          <View style={styles.pill}>
            <View style={[styles.connDot, { backgroundColor: agent.online ? colors.success : colors.muted }]} />
            <Text style={styles.pillText}>{agent.online ? 'Đã kết nối' : 'Mất kết nối'}</Text>
          </View>
          {recording ? (
            <View style={styles.pill}>
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
          <Banner kind="danger">{`Bộ nhớ còn ${formatBytes(freeBytes)}`}</Banner>
        ) : null}
        {bridge.pendingFlip ? <Banner kind="info">Lật sau khi dừng</Banner> : null}
        {cameraError ? <Banner kind="warning">Lỗi camera</Banner> : null}
        {bridge.lastError && !recording ? <Banner kind="warning">{bridge.lastError}</Banner> : null}
        {agent.recordingState === 'failed' && agent.errorCode ? <Banner kind="danger">Lỗi quay</Banner> : null}
      </View>

      {/* ----- Thanh dưới ----- */}
      <View style={[styles.bottom, { paddingBottom: spacing.lg }]}>
        <View style={styles.controls}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Lật camera"
            onPress={() => {
              setFlipTurns((t) => t + 1);
              cameraBridge.toggleFacingLocal();
            }}
            disabled={recording}
            style={[styles.roundBtn, recording && { opacity: 0.4 }]}
          >
            <RotatingIcon name="flip" turns={flipTurns} size={24} color={colors.onMedia} />
          </PressableScale>

          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={recording ? 'Dừng' : 'Quay'}
            onPress={() => void toggleStandaloneRecording()}
            disabled={agent.inRoom || !camPerm.hasPermission || (lowStorage && !recording)}
            style={[styles.recordOuter, (agent.inRoom || (lowStorage && !recording)) && { opacity: 0.45 }]}
          >
            <View style={recording ? styles.recordInnerStop : styles.recordInner} />
            {agent.inRoom ? (
              <View style={styles.lock}>
                <Icon name="lock" size={22} color={colors.onMedia} />
              </View>
            ) : null}
          </PressableScale>

          {agent.inRoom ? (
            <View style={styles.roundSpacer} />
          ) : (
            <PressableScale
              accessibilityRole="button"
              onPress={() => void openJoin()}
              style={[styles.roundBtn, recording && { opacity: 0.4 }]}
              disabled={recording}
            >
              <Icon name="qr" size={20} color={colors.onMedia} />
              <Text style={styles.smallBtnText}>Tham gia</Text>
            </PressableScale>
          )}
        </View>
        {scanning ? <Button title="Hủy" variant="secondary" small onPress={() => setScanning(false)} style={{ alignSelf: 'center' }} /> : null}
      </View>

      {/* ----- Vào phòng ----- */}
      <Modal visible={joinOpen} transparent animationType="slide" onRequestClose={() => setJoinOpen(false)} statusBarTranslucent navigationBarTranslucent>
        {/* Bàn phím mở: tấm nhập liệu được đẩy lên trên bàn phím, nội dung dài thì cuộn được. */}
        <KeyboardAvoidingView style={styles.sheetBackdrop} behavior="padding">
          <ScrollView
            style={styles.sheetScroll}
            contentContainerStyle={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}
            keyboardShouldPersistTaps="handled"
            bounces={false}
          >
            <Text style={{ fontSize: 17, fontWeight: font.heading, color: colors.text }}>Tham gia phòng</Text>
            <Field
              label="Mã mời"
              value={inviteCode}
              onChangeText={(v) => setInviteCode(v.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              autoCapitalize="characters"
              maxLength={6}
              placeholder="8F2A1C"
            />
            <Button
              title="Quét QR"
              variant="tonal"
              icon="qr"
              onPress={() => {
                setJoinOpen(false);
                setScanning(true);
              }}
            />
            <Field label="Tên camera" value={cameraName} onChangeText={setName} maxLength={40} placeholder="Cam trái" />
            <Checkbox
              checked={consent}
              onChange={setConsent}
              label="Cho phép điều khiển quay"
            />
            {joinError ? <Text style={{ color: colors.danger, fontSize: 13 }}>{joinError}</Text> : null}
            <Button title="Tham gia" onPress={() => void doJoin()} loading={joining} disabled={!consent} />
            <Button title="Hủy" variant="ghost" onPress={() => setJoinOpen(false)} />
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: spacing.md, gap: spacing.sm },
  remoteBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.overlay,
    borderRadius: radius.xl,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    paddingVertical: spacing.sm,
  },
  leaveBtn: {
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  leaveText: { color: colors.onMedia, fontSize: 13, fontWeight: font.medium },
  remoteBannerText: { color: colors.onMedia, fontWeight: font.heading, fontSize: 14 },
  remoteBannerSub: { color: colors.onMediaMuted, fontSize: 12 },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.overlay,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  connDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { color: colors.onMedia, fontSize: 12, fontWeight: font.medium, fontVariant: font.tabular },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.lg, gap: spacing.sm },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  roundBtn: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  roundSpacer: { width: 64, height: 64 },
  smallBtnText: { color: colors.onMedia, fontSize: 11, fontWeight: font.medium, textAlign: 'center' },
  recordOuter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    borderColor: colors.onMedia,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: colors.rec },
  recordInnerStop: { width: 30, height: 30, borderRadius: 6, backgroundColor: colors.rec },
  lock: { position: 'absolute' },
  sheetBackdrop: { flex: 1, backgroundColor: colors.backdrop, justifyContent: 'flex-end' },
  sheetScroll: {
    flexGrow: 0,
    flexShrink: 1,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
  },
  sheet: {
    padding: spacing.xl,
    gap: spacing.md,
  },
});
