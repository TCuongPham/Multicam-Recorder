import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import QRCode from 'react-native-qrcode-svg';
import {
  Codes,
  formatBytes,
  formatDuration,
  uuid,
  type CreateRoomResult,
  type StopRecordingResult,
} from '@multicam/shared';
import { useNow, useRoomController } from '@multicam/shared/react';
import { api, errorMessage, isApiError } from '../../services/api';
import { roomChanged } from '../../services/runtime';
import { useAppState } from '../../hooks';
import { Badge, Banner, Button, Card, Empty, Field, Loading, Muted, ProgressBar, Row, Screen } from '../../ui/components';
import { colors, radius, spacing } from '../../ui/theme';

type MemberView = ReturnType<typeof useRoomController>['members'][number];

const RESOLUTIONS = ['1280x720', '1920x1080', '3840x2160'];
const FPS_OPTIONS = [24, 30, 60];

function Chips<T extends string | number>({ options, value, onChange, disabled }: { options: T[]; value: T; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <Row style={{ flexWrap: 'wrap' }}>
      {options.map((o) => {
        const active = o === value;
        return (
          <Pressable
            key={String(o)}
            disabled={disabled}
            onPress={() => onChange(o)}
            style={[styles.chip, active && styles.chipActive, disabled && { opacity: 0.5 }]}
          >
            <Text style={{ color: active ? '#fff' : colors.text, fontWeight: '600', fontSize: 13 }}>{String(o)}</Text>
          </Pressable>
        );
      })}
    </Row>
  );
}

function MemberRow({
  m,
  onFlip,
  onKick,
}: {
  m: MemberView;
  onFlip: () => void;
  onKick: () => void;
}) {
  const recording = m.recording_state === 'recording';
  const uploadPct = Number(m.upload_percent) || 0;
  return (
    <View style={[styles.member, !m.online && { opacity: 0.45 }]}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row style={{ flex: 1 }}>
          <View style={[styles.dot, { backgroundColor: m.online ? colors.success : colors.muted }]} />
          <Text style={styles.memberName} numberOfLines={1}>
            {m.camera_name}
          </Text>
          {recording ? (
            <Row style={{ gap: 4 }}>
              <View style={[styles.dot, { backgroundColor: colors.recording }]} />
              <Text style={{ color: colors.recording, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{formatDuration(m.elapsedLiveMs)}</Text>
            </Row>
          ) : null}
        </Row>
        {!m.online ? <Badge text="Mất kết nối" /> : null}
      </Row>
      <Muted>
        🔋 {m.battery_level ?? '—'}%{m.is_charging === '1' ? ' ⚡' : ''} · 💾 {formatBytes(m.storage_free)} trống · 📷{' '}
        {m.camera_facing === 'front' ? 'trước' : m.camera_facing === 'back' ? 'sau' : '—'}
      </Muted>
      <Row style={{ flexWrap: 'wrap' }}>
        <Badge
          text={
            recording ? 'Đang quay' : m.recording_state === 'saved' ? 'Đã lưu clip' : m.recording_state === 'failed' ? 'Quay lỗi' : 'Sẵn sàng'
          }
          color={recording || m.recording_state === 'failed' ? colors.danger : colors.text}
          bg={recording || m.recording_state === 'failed' ? colors.dangerBg : colors.border}
        />
        {m.upload_state === 'uploaded' ? <Badge text="Đã upload ✓" color={colors.success} bg={colors.successBg} /> : null}
        {m.upload_state === 'failed' ? <Badge text="Upload lỗi" color={colors.danger} bg={colors.dangerBg} /> : null}
        {m.error_code && m.error_code !== 'null' ? <Badge text={`Lỗi: ${m.error_code}`} color={colors.warning} bg={colors.warningBg} /> : null}
      </Row>
      {m.upload_state === 'uploading' ? (
        <View style={{ gap: 2 }}>
          <Muted>Đang upload {uploadPct}%</Muted>
          <ProgressBar percent={uploadPct} />
        </View>
      ) : null}
      <Row>
        <Button title="Lật camera" small variant="secondary" onPress={onFlip} disabled={!m.online} />
        <Button title="Loại khỏi phòng" small variant="ghost" onPress={onKick} style={{ marginLeft: 'auto' }} />
      </Row>
    </View>
  );
}

export function RoomScreen() {
  const isFocused = useIsFocused();
  const appState = useAppState();
  const now = useNow(1000);
  const [room, setRoom] = useState<CreateRoomResult | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [resolution, setResolution] = useState('1920x1080');
  const [fps, setFps] = useState(30);
  const [maxDuration, setMaxDuration] = useState('0');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [summary, setSummary] = useState<StopRecordingResult | null>(null);
  const startIdRef = useRef<string | null>(null);
  const stopIdRef = useRef<string | null>(null);
  const refreshingInvite = useRef(false);

  // create_room khi mở màn hình (server trả lại phòng đang mở nếu có, và làm mới mã mời đã hết hạn).
  const openRoom = useCallback(async () => {
    setOpening(true);
    setOpenError(null);
    try {
      const r = await api.createRoom({});
      setRoom(r);
      setClosed(null);
    } catch (e) {
      setOpenError(errorMessage(e));
    } finally {
      setOpening(false);
    }
  }, []);

  useEffect(() => {
    void openRoom();
  }, [openRoom]);

  const roomId = room && !closed ? room.room_id : null;
  const view = useRoomController(api, roomId, { paused: !isFocused || appState !== 'active' });

  // Socket báo phòng thay đổi → làm mới ngay, không chờ nhịp sync.
  useEffect(() => roomChanged.subscribe((p) => p.room_id === roomId && view.refresh()), [roomId, view.refresh]);

  useEffect(() => {
    if (isApiError(view.error, Codes.ROOM_CLOSED)) setClosed('Phòng đã bị đóng');
  }, [view.error]);

  // Mã mời hết hạn → gọi lại create_room để lấy mã mới.
  const expiresAt = room ? Date.parse(room.expires_at) : 0;
  useEffect(() => {
    if (!room || closed || !expiresAt || now < expiresAt || refreshingInvite.current) return;
    refreshingInvite.current = true;
    void api
      .createRoom({})
      .then((r) => setRoom(r))
      .catch(() => undefined)
      .finally(() => {
        refreshingInvite.current = false;
      });
  }, [now, expiresAt, room, closed]);

  const inviteCode = view.room?.invite_code || room?.invite_code || '';
  const isRecording = view.room?.status === 'recording';
  const sessionElapsed = isRecording && view.room?.started_at ? now + view.serverOffsetMs - Date.parse(view.room.started_at) : 0;
  const onlineCount = view.members.filter((m) => m.online).length;
  const uploading = view.members.filter((m) => m.upload_state === 'uploading').length;
  const nameOf = useMemo(() => {
    const map = new Map(view.members.map((m) => [m.member_id, m.camera_name]));
    return (id: string) => map.get(id) ?? id;
  }, [view.members]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setNotice(null);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  function handleCommandError(e: unknown) {
    if (isApiError(e, Codes.INVALID_SESSION_STATE) || isApiError(e, Codes.NOT_ROOM_OWNER)) {
      view.refresh(); // đồng bộ lại trạng thái nút ở lần sync_room kế tiếp
      return;
    }
    if (isApiError(e, Codes.ROOM_CLOSED)) {
      setClosed('Phòng đã bị đóng');
      return;
    }
    Alert.alert('Lỗi', errorMessage(e));
  }

  const start = () =>
    run('start', async () => {
      if (!roomId) return;
      startIdRef.current ??= uuid(); // giữ nguyên id khi gửi lại do mạng chập chờn
      try {
        const r = await api.startRecording(roomId, {
          target: 'all',
          config: { resolution, fps, max_duration: Math.max(0, Math.floor(Number(maxDuration) || 0)) },
          client_command_id: startIdRef.current,
        });
        startIdRef.current = null;
        if (r?.rejected?.length) setNotice(`${r.rejected.length} máy không nhận lệnh (mất kết nối): ${r.rejected.map(nameOf).join(', ')}`);
        view.refresh();
      } catch (e) {
        if (!isApiError(e, 'NETWORK')) startIdRef.current = null;
        handleCommandError(e);
      }
    });

  const stop = () =>
    run('stop', async () => {
      if (!roomId) return;
      stopIdRef.current ??= uuid();
      try {
        const r = await api.stopRecording(roomId, { target: 'all', client_command_id: stopIdRef.current });
        stopIdRef.current = null;
        if (r?.results) setSummary(r);
        view.refresh();
      } catch (e) {
        if (!isApiError(e, 'NETWORK')) stopIdRef.current = null;
        handleCommandError(e);
      }
    });

  const flip = (target: 'all' | string[]) =>
    run('flip', async () => {
      if (!roomId) return;
      try {
        const r = await api.switchCamera(roomId, { target, facing: 'toggle', client_command_id: uuid() });
        setNotice(`Đã gửi lệnh lật camera tới ${r?.targets?.length ?? 0} máy`);
      } catch (e) {
        handleCommandError(e);
      }
    });

  const kick = (m: MemberView) =>
    Alert.alert('Loại khỏi phòng', `Loại "${m.camera_name}" khỏi phòng? Nếu máy đang quay, clip sẽ được lưu và upload trước khi bị loại.`, [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Loại',
        style: 'destructive',
        onPress: () =>
          void run('kick', async () => {
            if (!roomId) return;
            try {
              await api.kickMember(roomId, m.member_id);
              setNotice(`Đã loại "${m.camera_name}" khỏi phòng`);
              view.refresh();
            } catch (e) {
              handleCommandError(e);
            }
          }),
      },
    ]);

  const close = () =>
    Alert.alert(
      'Đóng phòng',
      isRecording ? 'Phòng đang quay. Server sẽ dừng quay ở mọi máy, chờ upload xong rồi đóng hẳn. Tiếp tục?' : 'Đóng phòng và vô hiệu hóa mã mời?',
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Đóng phòng',
          style: 'destructive',
          onPress: () =>
            void run('close', async () => {
              if (!roomId) return;
              try {
                const r = await api.closeRoom(roomId);
                setClosed(r.session_stopped ? 'Đã đóng phòng (đã dừng phiên quay đang chạy)' : 'Đã đóng phòng');
              } catch (e) {
                handleCommandError(e);
              }
            }),
        },
      ],
    );

  if (!room && opening) return <Loading />;
  if (!room || closed) {
    return (
      <Screen>
        {closed ? <Banner kind="info">{closed}</Banner> : null}
        {openError ? <Banner kind="danger">{openError}</Banner> : null}
        <Button title={closed ? 'Tạo phòng mới' : 'Thử lại'} onPress={openRoom} loading={opening} />
      </Screen>
    );
  }

  const secondsLeft = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return (
    <Screen>
      <Card style={{ alignItems: 'center' }}>
        <Muted>Mã mời — máy Remote nhập hoặc quét QR để vào phòng</Muted>
        <Text style={styles.invite} selectable>
          {inviteCode}
        </Text>
        {inviteCode ? <QRCode value={inviteCode} size={170} /> : null}
        <Muted>
          {secondsLeft > 0 ? `Mã hết hạn sau ${formatDuration(secondsLeft * 1000)} (tự động làm mới)` : 'Đang làm mới mã mời…'}
        </Muted>
      </Card>

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.section}>Điều khiển quay</Text>
          {isRecording ? (
            <Row style={{ gap: 4 }}>
              <View style={[styles.dot, { backgroundColor: colors.recording }]} />
              <Text style={{ color: colors.recording, fontWeight: '700' }}>REC {formatDuration(sessionElapsed)}</Text>
            </Row>
          ) : (
            <Muted>
              {onlineCount}/{view.members.length} máy online
            </Muted>
          )}
        </Row>
        <Muted>Độ phân giải</Muted>
        <Chips options={RESOLUTIONS} value={resolution} onChange={setResolution} disabled={isRecording} />
        <Muted>FPS</Muted>
        <Chips options={FPS_OPTIONS} value={fps} onChange={setFps} disabled={isRecording} />
        <Field
          label="Thời lượng tối đa (giây, 0 = không giới hạn)"
          value={maxDuration}
          onChangeText={(v) => setMaxDuration(v.replace(/\D/g, ''))}
          keyboardType="number-pad"
          editable={!isRecording}
        />
        {isRecording ? (
          <Button title="■ Dừng quay" variant="danger" onPress={stop} loading={busy === 'stop'} />
        ) : (
          <Button title="● Bắt đầu quay" onPress={start} loading={busy === 'start'} disabled={onlineCount === 0} />
        )}
        <Button title="Lật camera tất cả máy" variant="secondary" onPress={() => flip('all')} disabled={onlineCount === 0 || !!busy} />
        {uploading > 0 ? <Muted>{uploading} máy đang upload clip…</Muted> : null}
        {notice ? <Banner kind="info">{notice}</Banner> : null}
        {view.error && !isApiError(view.error, Codes.ROOM_CLOSED) ? <Banner kind="warning">{errorMessage(view.error)}</Banner> : null}
      </Card>

      <Text style={styles.section}>Thiết bị trong phòng ({view.members.length})</Text>
      {view.isLoading ? <Loading /> : null}
      {!view.isLoading && view.members.length === 0 ? <Empty text="Chưa có máy Remote nào trong phòng" /> : null}
      {view.members.map((m) => (
        <MemberRow key={m.member_id} m={m} onFlip={() => flip([m.member_id])} onKick={() => kick(m)} />
      ))}

      <Button title="Đóng phòng" variant="danger" onPress={close} loading={busy === 'close'} style={{ marginTop: spacing.lg }} />

      <Modal visible={!!summary} transparent animationType="fade" onRequestClose={() => setSummary(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modal}>
            <Text style={styles.section}>Tổng kết phiên {summary?.session_id}</Text>
            {summary?.results.length ? (
              summary.results.map((r) => (
                <View key={r.member_id} style={styles.summaryRow}>
                  <Text style={{ flex: 1, color: colors.text, fontWeight: '600' }} numberOfLines={1}>
                    {nameOf(r.member_id)}
                  </Text>
                  <Text style={{ width: 60, color: colors.text }}>{formatDuration(r.duration_ms)}</Text>
                  <Text style={{ width: 70, color: colors.text }}>{r.size ? formatBytes(r.size) : '—'}</Text>
                  <Text style={{ width: 70, color: r.status === 'failed' ? colors.danger : colors.success }}>
                    {r.status === 'failed' ? 'Lỗi' : r.status === 'saved' ? 'Đã lưu' : r.status}
                  </Text>
                </View>
              ))
            ) : (
              <Muted>Không có kết quả</Muted>
            )}
            <Muted>Các máy tự động upload clip. Theo dõi tiến độ trên từng dòng thiết bị.</Muted>
            <Button title="Đóng" onPress={() => setSummary(null)} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  invite: { fontSize: 44, fontWeight: '800', letterSpacing: 8, color: colors.text, marginVertical: spacing.xs },
  section: { fontSize: 16, fontWeight: '700', color: colors.text },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  dot: { width: 10, height: 10, borderRadius: 5 },
  member: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  memberName: { fontSize: 15, fontWeight: '700', color: colors.text, flexShrink: 1 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', justifyContent: 'center', padding: spacing.lg },
  modal: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  summaryRow: { flexDirection: 'row', gap: 6, paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
});
