import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Codes, formatBytes, formatDuration, uuid, type CreateRoomResult, type StopRecordingResult } from '@multicam/shared';
import { useNow, useRoomConfig, useRoomController, useSessionClock, useSessionSummary, type MemberView, type SummaryRow } from '@multicam/shared/react';
import { api, errorMessage, isApiError } from '../../services/api';
import { roomChanged } from '../../services/runtime';
import { previewStore, usePreviewFrame } from '../../services/previews';
import { useAppState } from '../../hooks';
import {
  Banner,
  Button,
  Card,
  Chips,
  Empty,
  Field,
  Icon,
  IconButton,
  Loading,
  Muted,
  ProgressBar,
  RecDot,
  RotatingIcon,
  Row,
  Screen,
  SectionTitle,
  Stat,
} from '../../ui/components';
import { colors, font, radius, spacing } from '../../ui/theme';

const RESOLUTIONS = ['1280x720', '1920x1080', '3840x2160'] as const;
const FPS_OPTIONS = [24, 30, 60] as const;
const PAGE_SIZE = 6;
/** Khung xem trước cũ hơn mức này coi như mất hình. */
const FRAME_STALE_MS = 5000;
/** Chờ camera_facing đổi tối đa 6 giây rồi bỏ trạng thái "đang lật". */
const FLIP_TIMEOUT_MS = 6000;

type FlipPending = Record<string, { from: string | null; at: number }>;

function facingLabel(f: string | null) {
  return f === 'front' ? 'Trước' : f === 'back' ? 'Sau' : '—';
}

function statusText(m: MemberView): { text: string; color: string } {
  if (m.recording_state === 'recording') return { text: 'Đang quay', color: colors.danger };
  if (m.upload_state === 'uploaded') return { text: 'Đã tải lên', color: colors.success };
  if (m.upload_state === 'failed' || m.recording_state === 'failed') return { text: 'Lỗi', color: colors.danger };
  if (m.recording_state === 'saved') return { text: 'Đã lưu', color: colors.text };
  return { text: 'Sẵn sàng', color: colors.muted };
}

/** Giờ hết hạn mã mời dạng HH:mm. */
function hhmm(ms: number) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Khung hình xem trước
// ---------------------------------------------------------------------------

/**
 * Hai lớp ảnh thay phiên: khung mới nạp ở lớp dưới, nạp xong mới đưa lên trên —
 * luôn giữ khung cuối cùng, không nháy trắng giữa hai khung.
 */
function BufferedImage({ uri }: { uri: string }) {
  const [layers, setLayers] = useState<{ a: string | null; b: string | null; top: 'a' | 'b' }>({ a: uri, b: null, top: 'a' });
  useEffect(() => {
    setLayers((l) => {
      if (l[l.top] === uri) return l;
      const back = l.top === 'a' ? 'b' : 'a';
      return l[back] === uri ? l : { ...l, [back]: uri };
    });
  }, [uri]);
  const render = (key: 'a' | 'b') => {
    const src = layers[key];
    if (!src) return null;
    const isTop = layers.top === key;
    return (
      <Image
        key={key}
        source={{ uri: src }}
        style={[StyleSheet.absoluteFill, { zIndex: isTop ? 1 : 0 }]}
        resizeMode="contain"
        fadeDuration={0}
        onLoad={() => {
          if (!isTop) setLayers((l) => (l[key] === src ? { ...l, top: key } : l));
        }}
      />
    );
  };
  return (
    <>
      {render('a')}
      {render('b')}
    </>
  );
}

function LiveFrame({ m, style, large }: { m: MemberView; style?: StyleProp<ViewStyle>; large?: boolean }) {
  const frame = usePreviewFrame(m.member_id);
  const stale = !frame || Date.now() - frame.receivedAt > FRAME_STALE_MS;
  const lost = !m.online || (!!frame && stale);
  const recording = m.recording_state === 'recording';
  return (
    <View style={[styles.frame, style]}>
      {frame ? (
        <View style={[StyleSheet.absoluteFill, lost && { opacity: 0.35 }]}>
          <BufferedImage uri={frame.image} />
        </View>
      ) : (
        <View style={styles.framePlaceholder}>
          {m.online ? <Icon name="camera" size={large ? 32 : 22} color={colors.onMediaMuted} /> : null}
          {m.online ? <Text style={styles.frameHint}>Đang kết nối</Text> : null}
        </View>
      )}
      {lost ? (
        <View style={styles.lostOverlay}>
          <Text style={styles.lostText}>{m.online ? 'Hình cũ' : 'Mất kết nối'}</Text>
        </View>
      ) : null}
      <View style={styles.frameTop}>
        {recording ? (
          <View style={styles.recBadge}>
            <RecDot size={7} color={colors.onMedia} />
            <Text style={styles.recText}>REC {formatDuration(m.elapsedLiveMs)}</Text>
          </View>
        ) : (
          <View />
        )}
        <View style={styles.facingBadge}>
          <Text style={styles.facingText}>{facingLabel(m.camera_facing)}</Text>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Ô camera
// ---------------------------------------------------------------------------

function FlipButton({ flipping, disabled, onPress, compact }: { flipping: boolean; disabled?: boolean; onPress: () => void; compact?: boolean }) {
  const [turns, setTurns] = useState(0);
  return (
    <Button
      // Ô nhỏ: dòng trạng thái đã hiện 'Đang lật…', nút giữ nhãn ngắn.
      title={flipping && !compact ? 'Đang lật…' : 'Lật'}
      small
      variant="secondary"
      disabled={disabled}
      accessibilityLabel="Lật camera"
      iconNode={<RotatingIcon name="flip" turns={turns} size={16} color={colors.text} />}
      onPress={() => {
        setTurns((t) => t + 1);
        onPress();
      }}
      style={compact ? { flex: 1, paddingHorizontal: spacing.sm } : undefined}
    />
  );
}

function TileInfo({ m, flipping, deferred }: { m: MemberView; flipping: boolean; deferred: boolean }) {
  const status = statusText(m);
  const pendingFlip = flipping ? 'Đang lật…' : deferred && m.recording_state === 'recording' ? 'Lật sau khi dừng' : null;
  const uploadPct = Number(m.upload_percent) || 0;
  const battery = m.battery_level == null ? null : Number(m.battery_level);
  return (
    <View style={{ gap: 6 }}>
      <Row style={{ gap: 6 }}>
        <View style={[styles.onlineDot, { backgroundColor: m.online ? colors.success : colors.muted }]} />
        <Text style={styles.tileName} numberOfLines={1}>
          {m.camera_name}
        </Text>
      </Row>
      <Row style={{ gap: spacing.md, flexWrap: 'wrap' }}>
        <Stat
          icon={m.is_charging === '1' ? 'bolt' : 'battery'}
          level={battery}
          text={battery == null ? '—' : `${battery}%`}
          color={battery != null && battery <= 15 && m.is_charging !== '1' ? colors.danger : colors.muted}
        />
        <Stat icon="storage" text={formatBytes(m.storage_free)} />
      </Row>
      {m.upload_state === 'uploading' ? (
        <View style={{ gap: 4 }}>
          <Text style={[styles.tileStatus, { color: colors.text }]}>Đang tải lên {uploadPct}%</Text>
          <ProgressBar percent={uploadPct} />
        </View>
      ) : (
        <Text style={[styles.tileStatus, { color: pendingFlip ? colors.text : status.color }]} numberOfLines={1}>
          {pendingFlip ?? status.text}
        </Text>
      )}
    </View>
  );
}

function CameraTile({
  m,
  width,
  flipping,
  deferred,
  locked,
  onOpen,
  onFlip,
  onKick,
}: {
  m: MemberView;
  width: number;
  flipping: boolean;
  deferred: boolean;
  /** Phiên đang quay: không cho lật camera. */
  locked: boolean;
  onOpen: () => void;
  onFlip: () => void;
  onKick: () => void;
}) {
  return (
    <View style={[styles.tile, { width }, !m.online && { opacity: 0.7 }]}>
      <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={m.camera_name}>
        <LiveFrame m={m} />
      </Pressable>
      <View style={{ padding: spacing.sm, gap: spacing.sm }}>
        <TileInfo m={m} flipping={flipping} deferred={deferred} />
        <Row style={{ gap: 6 }}>
          <FlipButton flipping={flipping} disabled={!m.online || locked} onPress={onFlip} compact />
          <Button
            title="Loại"
            small
            variant="secondary"
            accessibilityLabel={`Loại ${m.camera_name}`}
            onPress={onKick}
            style={{ flex: 1, paddingHorizontal: spacing.sm }}
          />
        </Row>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Tổng kết phiên
// ---------------------------------------------------------------------------

function SummaryStatus({ row }: { row: SummaryRow }) {
  switch (row.status) {
    case 'uploaded':
      return (
        <Row style={{ gap: 4 }}>
          <Text style={[styles.summaryStatus, { color: colors.success }]}>Đã tải lên</Text>
          <Icon name="check" size={14} color={colors.success} strokeWidth={2.25} />
        </Row>
      );
    case 'uploading':
      return (
        <View style={{ gap: 4, alignSelf: 'stretch', alignItems: 'flex-end' }}>
          <Text style={[styles.summaryStatus, { color: colors.text }]}>Đang tải lên {Math.round(row.percent)}%</Text>
          <ProgressBar percent={row.percent} />
        </View>
      );
    case 'stopping':
      return <Text style={[styles.summaryStatus, { color: colors.muted }]}>Đang dừng</Text>;
    case 'processing':
      return <Text style={[styles.summaryStatus, { color: colors.muted }]}>Đang xử lý</Text>;
    case 'failed':
      return <Text style={[styles.summaryStatus, { color: colors.danger }]}>Lỗi</Text>;
    case 'offline':
      return <Text style={[styles.summaryStatus, { color: colors.warning }]}>Mất kết nối</Text>;
  }
}

function SummaryModal({ summary, members, onClose }: { summary: StopRecordingResult | null; members: MemberView[]; onClose: () => void }) {
  const { rows, done } = useSessionSummary(api, summary, members);
  return (
    <Modal visible={!!summary} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.modal}>
          <SectionTitle>Phiên {summary?.session_id}</SectionTitle>
          {rows.length ? (
            <View style={[styles.summaryRow, { paddingVertical: spacing.xs }]}>
              <Text style={[styles.summaryHead, { flex: 1 }]}>Máy</Text>
              <Text style={[styles.summaryHead, { flex: 0.8 }]}>Thời lượng</Text>
              <Text style={[styles.summaryHead, { flex: 1.2, textAlign: 'right' }]}>Trạng thái</Text>
            </View>
          ) : null}
          <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 0 }}>
            {rows.length ? (
              rows.map((r) => (
                <View key={r.member_id} style={styles.summaryRow}>
                  <Text style={[styles.summaryName, { flex: 1 }]} numberOfLines={1}>
                    {r.camera_name}
                  </Text>
                  <Text style={[styles.summaryDuration, { flex: 0.8 }]}>{formatDuration(r.duration_ms)}</Text>
                  <View style={{ flex: 1.2, alignItems: 'flex-end' }}>
                    <SummaryStatus row={r} />
                  </View>
                </View>
              ))
            ) : (
              <Muted>Chưa có máy nào</Muted>
            )}
          </ScrollView>
          {done && rows.length ? <Banner kind="success">Đã tải lên xong</Banner> : null}
          <Button title="Đóng" variant="tonal" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Xem lớn một camera
// ---------------------------------------------------------------------------

function EnlargedModal({
  m,
  flipping,
  deferred,
  locked,
  onClose,
  onFlip,
  onKick,
}: {
  m: MemberView | null;
  flipping: boolean;
  deferred: boolean;
  locked: boolean;
  onClose: () => void;
  onFlip: () => void;
  onKick: () => void;
}) {
  const { width, height } = useWindowDimensions();
  // Lề backdrop + lề trong của khung modal.
  const frameW = Math.min(width - spacing.lg * 2 - spacing.xl * 2, 960);
  const frameH = Math.min((frameW * 3) / 4, height * 0.6);
  return (
    <Modal visible={!!m} transparent animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <View style={styles.backdrop}>
        {m ? (
          <View style={[styles.modal, { width: frameW + spacing.xl * 2, alignSelf: 'center' }]}>
            <Row style={{ justifyContent: 'space-between' }}>
              <SectionTitle style={{ flex: 1 }}>{m.camera_name}</SectionTitle>
              <IconButton icon="x" label="Đóng" onPress={onClose} size={32} />
            </Row>
            <LiveFrame m={m} large style={{ width: frameW, height: frameH, aspectRatio: undefined }} />
            <TileInfo m={m} flipping={flipping} deferred={deferred} />
            <Row>
              <FlipButton flipping={flipping} disabled={!m.online || locked} onPress={onFlip} />
              <Button title="Loại" small variant="ghost" icon="x" onPress={onKick} style={{ marginLeft: 'auto' }} />
            </Row>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Màn Điều khiển
// ---------------------------------------------------------------------------

export function RoomScreen() {
  const appState = useAppState();
  const now = useNow(1000);
  const { width } = useWindowDimensions();
  const [room, setRoom] = useState<CreateRoomResult | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  /** Ô nhập giới hạn (chuỗi để xóa trắng được khi gõ); giá trị số nằm trong cấu hình phòng. */
  const [maxDurationText, setMaxDurationText] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [summary, setSummary] = useState<StopRecordingResult | null>(null);
  const [flipping, setFlipping] = useState<FlipPending>({});
  /** Máy nhận lệnh lật khi đang quay: lật sau khi dừng. */
  const [deferred, setDeferred] = useState<Set<string>>(new Set());
  const [allTurns, setAllTurns] = useState(0);
  const [page, setPage] = useState(0);
  const [openMemberId, setOpenMemberId] = useState<string | null>(null);
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
  // Chỉ dừng đồng bộ khi ứng dụng vào nền. Đổi tab hoặc 'inactive' (mất focus cửa sổ) vẫn đồng bộ,
  // để quay lại không thấy trạng thái cũ / máy "mất kết nối" giả.
  const view = useRoomController(api, roomId, { paused: appState === 'background' });
  const members = view.members;
  // Đổi độ phân giải / fps / giới hạn → máy Remote cập nhật ngay, kể cả khi chưa quay.
  const { config, setConfig } = useRoomConfig(api, roomId, view.room);
  const maxDuration = maxDurationText ?? String(config.max_duration);

  // Socket báo phòng thay đổi → làm mới ngay, không chờ nhịp sync.
  useEffect(() => roomChanged.subscribe((p) => p.room_id === roomId && view.refresh()), [roomId, view.refresh]);

  useEffect(() => {
    if (isApiError(view.error, Codes.ROOM_CLOSED)) setClosed('Đã đóng phòng');
  }, [view.error]);

  // Máy rời phòng → bỏ khung hình xem trước của máy đó.
  const memberKey = members.map((m) => m.member_id).join(',');
  useEffect(() => {
    if (!view.isLoading) previewStore.retain(memberKey ? memberKey.split(',') : []);
  }, [memberKey, view.isLoading]);

  // "Đang lật…" kết thúc khi camera_facing của máy đổi, hoặc sau 6 giây.
  useEffect(() => {
    setFlipping((prev) => {
      const ids = Object.keys(prev);
      if (!ids.length) return prev;
      const t = Date.now();
      let changed = false;
      const next = { ...prev };
      for (const id of ids) {
        const m = members.find((x) => x.member_id === id);
        if (!m || (m.camera_facing ?? null) !== prev[id].from || t - prev[id].at > FLIP_TIMEOUT_MS) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // "Lật sau khi dừng" hết hiệu lực khi máy không còn quay.
    setDeferred((prev) => {
      if (!prev.size) return prev;
      const next = new Set([...prev].filter((id) => members.some((m) => m.member_id === id && m.recording_state === 'recording')));
      return next.size === prev.size ? prev : next;
    });
  }, [members]);

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

  // Phân trang lưới camera: 6 ô mỗi trang.
  const pageCount = Math.max(1, Math.ceil(members.length / PAGE_SIZE));
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);
  const pageMembers = members.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const columns = width >= 768 ? 3 : 2;
  const gridGap = spacing.md;
  const tileWidth = Math.floor((width - spacing.lg * 2 - gridGap * (columns - 1)) / columns);

  const inviteCode = view.room?.invite_code || room?.invite_code || '';
  const isRecording = view.room?.status === 'recording';
  const onlineCount = members.filter((m) => m.online).length;
  const openMember = openMemberId ? (members.find((m) => m.member_id === openMemberId) ?? null) : null;

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
      setClosed('Đã đóng phòng');
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
          config,
          client_command_id: startIdRef.current,
        });
        startIdRef.current = null;
        if (r?.rejected?.length) setNotice(`${r.rejected.length} máy mất kết nối`);
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

  // Hết giới hạn thời gian: đồng hồ dừng đúng giới hạn và phiên tự kết thúc như khi bấm Dừng.
  const clock = useSessionClock(view, now, () => void stop());

  /** Lật một máy: target = [member_id]; lật tất cả: target = 'all'. */
  const flip = async (target: 'all' | string[]) => {
    if (!roomId) return;
    const ids = target === 'all' ? members.filter((m) => m.online).map((m) => m.member_id) : target;
    const at = Date.now();
    setFlipping((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = { from: members.find((m) => m.member_id === id)?.camera_facing ?? null, at };
      return next;
    });
    const clear = (drop: string[]) =>
      setFlipping((prev) => {
        if (!drop.some((id) => prev[id])) return prev;
        const next = { ...prev };
        for (const id of drop) delete next[id];
        return next;
      });
    try {
      const r = await api.switchCamera(roomId, { target, facing: 'toggle', client_command_id: uuid() });
      const targets = r?.targets ?? [];
      clear(ids.filter((id) => !targets.includes(id)));
      const busyIds = members.filter((m) => targets.includes(m.member_id) && m.recording_state === 'recording').map((m) => m.member_id);
      if (busyIds.length) {
        // Máy đang quay lật sau khi dừng: bỏ "Đang lật…", hiện "Lật sau khi dừng" trên ô.
        clear(busyIds);
        setDeferred((prev) => new Set([...prev, ...busyIds]));
      }
      view.refresh();
    } catch (e) {
      clear(ids);
      handleCommandError(e);
    }
  };

  const kick = (m: MemberView) =>
    Alert.alert(`Loại ${m.camera_name}?`, 'Clip đang quay vẫn được lưu.', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Loại',
        style: 'destructive',
        onPress: () =>
          void run('kick', async () => {
            if (!roomId) return;
            try {
              await api.kickMember(roomId, m.member_id);
              if (openMemberId === m.member_id) setOpenMemberId(null);
              view.refresh();
            } catch (e) {
              handleCommandError(e);
            }
          }),
      },
    ]);

  const close = () =>
    Alert.alert('Đóng phòng?', isRecording ? 'Phiên quay sẽ dừng.' : 'Mọi máy sẽ rời phòng.', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Đóng phòng',
        style: 'destructive',
        onPress: () =>
          void run('close', async () => {
            if (!roomId) return;
            try {
              await api.closeRoom(roomId);
              setClosed('Đã đóng phòng');
            } catch (e) {
              handleCommandError(e);
            }
          }),
      },
    ]);

  if (!room && opening) return <Loading />;
  if (!room || closed) {
    return (
      <Screen>
        {closed ? <Banner kind="info">{closed}</Banner> : null}
        {openError ? <Banner kind="danger">{openError}</Banner> : null}
        <Button title={closed ? 'Tạo phòng' : 'Thử lại'} onPress={openRoom} loading={opening} />
      </Screen>
    );
  }

  return (
    <Screen>
      {/* ----- Mã mời ----- */}
      <Card style={styles.inviteCard}>
        <View style={styles.qrBox}>{inviteCode ? <QRCode value={inviteCode} size={104} backgroundColor="#FFFFFF" color="#000000" /> : null}</View>
        <View style={{ flex: 1, gap: 4 }}>
          <Muted>Mã mời</Muted>
          <Text style={styles.invite} selectable>
            {inviteCode}
          </Text>
          <Muted style={{ fontVariant: font.tabular }}>{now < expiresAt ? `Hết hạn ${hhmm(expiresAt)}` : 'Đang tải…'}</Muted>
        </View>
      </Card>

      {/* ----- Điều khiển quay ----- */}
      <Card style={{ gap: spacing.md }}>
        {isRecording ? (
          <View style={styles.sessionRec}>
            <RecDot size={7} color={colors.onMedia} />
            <Text style={styles.sessionRecText}>
              REC {formatDuration(clock.elapsedMs)}
              {clock.limitMs ? ` / ${formatDuration(clock.limitMs)}` : ''}
            </Text>
          </View>
        ) : null}
        <View style={{ gap: spacing.sm }}>
          <Muted>Độ phân giải</Muted>
          <Chips
            options={RESOLUTIONS}
            value={config.resolution as (typeof RESOLUTIONS)[number]}
            onChange={(resolution) => setConfig({ resolution })}
            disabled={isRecording}
          />
        </View>
        <View style={{ gap: spacing.sm }}>
          <Muted>FPS</Muted>
          <Chips options={FPS_OPTIONS} value={config.fps as (typeof FPS_OPTIONS)[number]} onChange={(fps) => setConfig({ fps })} disabled={isRecording} />
        </View>
        <Field
          label="Giới hạn (giây)"
          value={maxDuration}
          onChangeText={(v) => {
            const digits = v.replace(/\D/g, '').slice(0, 5);
            setMaxDurationText(digits);
            setConfig({ max_duration: Math.min(4 * 3600, Number(digits) || 0) });
          }}
          onBlur={() => setMaxDurationText(null)}
          keyboardType="number-pad"
          placeholder="0"
          editable={!isRecording}
        />
        <Row style={{ marginTop: spacing.xs }}>
          {isRecording ? (
            <Button
              title="Dừng"
              variant="danger"
              onPress={stop}
              loading={busy === 'stop'}
              iconNode={<View style={styles.stopGlyph} />}
              style={{ flex: 1 }}
            />
          ) : (
            <Button
              title="Quay"
              onPress={start}
              loading={busy === 'start'}
              disabled={onlineCount === 0}
              iconNode={<View style={styles.recGlyph} />}
              style={{ flex: 1 }}
            />
          )}
          <Button
            title="Lật tất cả"
            variant="tonal"
            disabled={onlineCount === 0 || isRecording}
            iconNode={<RotatingIcon name="flip" turns={allTurns} size={18} color={colors.accent} />}
            onPress={() => {
              setAllTurns((t) => t + 1);
              void flip('all');
            }}
            style={{ flex: 1 }}
          />
        </Row>
        {notice ? <Banner kind="warning">{notice}</Banner> : null}
        {view.error && !isApiError(view.error, Codes.ROOM_CLOSED) ? <Banner kind="warning">{errorMessage(view.error)}</Banner> : null}
      </Card>

      {/* ----- Lưới camera ----- */}
      <Row style={{ justifyContent: 'space-between', marginTop: spacing.sm }}>
        <Row style={{ gap: spacing.sm, flex: 1 }}>
          <SectionTitle>Camera</SectionTitle>
          <Muted style={{ fontVariant: font.tabular }}>
            {onlineCount}/{members.length} trực tuyến
          </Muted>
        </Row>
        {pageCount > 1 ? (
          <Row style={{ gap: spacing.xs }}>
            <IconButton icon="chevron-left" label="Trang trước" size={32} disabled={page === 0} onPress={() => setPage((p) => Math.max(0, p - 1))} />
            <Text style={styles.pageText}>
              {page + 1}/{pageCount}
            </Text>
            <IconButton
              icon="chevron-right"
              label="Trang sau"
              size={32}
              disabled={page >= pageCount - 1}
              onPress={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            />
          </Row>
        ) : null}
      </Row>
      {view.isLoading ? <Loading /> : null}
      {!view.isLoading && members.length === 0 ? <Empty text="Chưa có máy nào" sub="Chờ máy quay tham gia" /> : null}
      <View style={[styles.grid, { gap: gridGap }]}>
        {pageMembers.map((m) => (
          <CameraTile
            key={m.member_id}
            m={m}
            width={tileWidth}
            flipping={!!flipping[m.member_id]}
            deferred={deferred.has(m.member_id)}
            locked={isRecording}
            onOpen={() => setOpenMemberId(m.member_id)}
            onFlip={() => void flip([m.member_id])}
            onKick={() => kick(m)}
          />
        ))}
      </View>

      <Button title="Đóng phòng" variant="ghost" onPress={close} loading={busy === 'close'} style={{ marginTop: spacing.xl }} textColor={colors.danger} />

      <EnlargedModal
        m={openMember}
        flipping={!!(openMember && flipping[openMember.member_id])}
        deferred={!!(openMember && deferred.has(openMember.member_id))}
        locked={isRecording}
        onClose={() => setOpenMemberId(null)}
        onFlip={() => openMember && void flip([openMember.member_id])}
        onKick={() => openMember && kick(openMember)}
      />
      <SummaryModal summary={summary} members={members} onClose={() => setSummary(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  inviteCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  qrBox: { backgroundColor: '#FFFFFF', padding: spacing.sm, borderRadius: radius.md },
  invite: { fontSize: 32, fontWeight: font.heading, letterSpacing: 6, color: colors.text, fontVariant: font.tabular },
  sessionRec: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: colors.rec,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  sessionRecText: { color: colors.onMedia, fontWeight: font.heading, fontVariant: font.tabular, fontSize: 13 },
  recGlyph: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accentInk },
  stopGlyph: { width: 10, height: 10, borderRadius: 2, backgroundColor: colors.dangerInk },
  pageText: { color: colors.text, fontVariant: font.tabular, minWidth: 36, textAlign: 'center', fontSize: 13 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  tileName: { flex: 1, color: colors.text, fontWeight: font.heading, fontSize: 14 },
  tileStatus: { fontSize: 12 },
  onlineDot: { width: 6, height: 6, borderRadius: 3 },
  frame: { width: '100%', aspectRatio: 4 / 3, backgroundColor: colors.media, overflow: 'hidden', borderRadius: 0 },
  framePlaceholder: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 6 },
  frameHint: { color: colors.onMediaMuted, fontSize: 11 },
  lostOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 2, zIndex: 2 },
  lostText: { color: colors.onMedia, fontWeight: font.heading, fontSize: 13 },
  frameTop: {
    position: 'absolute',
    top: 6,
    left: 6,
    right: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 3,
  },
  recBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.rec,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  recText: { color: colors.onMedia, fontSize: 11, fontWeight: font.heading, fontVariant: font.tabular },
  facingBadge: { backgroundColor: colors.overlay, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  facingText: { color: colors.onMedia, fontSize: 11, fontWeight: font.medium },
  backdrop: { flex: 1, backgroundColor: colors.backdrop, justifyContent: 'center', padding: spacing.lg },
  modal: {
    backgroundColor: colors.surface,
    borderRadius: radius.xxl,
    padding: spacing.xl,
    gap: spacing.md,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  summaryHead: { color: colors.muted, fontSize: 12, fontWeight: font.medium },
  summaryName: { color: colors.text, fontWeight: font.medium, fontSize: 14 },
  summaryDuration: { color: colors.muted, fontSize: 13, fontVariant: font.tabular },
  summaryStatus: { fontSize: 13, textAlign: 'right' },
});
