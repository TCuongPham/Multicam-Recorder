import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Codes, splitAccount } from '@multicam/shared';
import { useStore } from '@multicam/shared/react';
import { api, errorMessage, isApiError } from '../../services/api';
import { session } from '../../services/session';
import { getServerUrl, normalizeServerUrl, setServerUrl } from '../../services/storage';
import { deviceFields } from '../../hooks';
import { Banner, Button, Card, Field, Muted, Row, Screen, Title } from '../../ui/components';
import { colors } from '../../ui/theme';
import type { AuthScreenProps } from '../../navigation/types';

export function LoginScreen({ navigation }: AuthScreenProps<'Login'>) {
  const { notice } = useStore(session);
  const [server, setServer] = useState(getServerUrl());
  const [serverStatus, setServerStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ account?: string; password?: string; form?: string }>({});
  const [loading, setLoading] = useState(false);

  async function saveServer() {
    const url = normalizeServerUrl(server);
    setServer(url);
    await setServerUrl(url);
    return url;
  }

  async function checkServer() {
    setChecking(true);
    setServerStatus(null);
    try {
      const url = await saveServer();
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${url}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      const json = (await res.json()) as { code?: string };
      setServerStatus(json.code === Codes.OK ? { ok: true, text: 'Kết nối server thành công' } : { ok: false, text: `Server trả mã ${json.code}` });
    } catch {
      setServerStatus({ ok: false, text: 'Không kết nối được server. Kiểm tra địa chỉ IP và mạng LAN.' });
    } finally {
      setChecking(false);
    }
  }

  async function onLogin() {
    const next: typeof errors = {};
    if (!account.trim()) next.account = 'Nhập email, số điện thoại hoặc tên đăng nhập';
    if (!password) next.password = 'Nhập mật khẩu';
    setErrors(next);
    if (Object.keys(next).length) return;

    setLoading(true);
    try {
      await saveServer();
      const target = splitAccount(account);
      const data = await api.login({ ...target, password, ...deviceFields() });
      await session.signIn({
        role: data.account_role,
        user: data.user,
        deviceId: data.device?.device_id ?? null,
        cameraName: data.device?.camera_name ?? null,
      });
    } catch (e) {
      if (isApiError(e, Codes.USER_NOT_VALIDATED)) {
        const d = e.data as { verify_required?: string; email?: string | null; phone?: string | null } | null;
        if (d?.verify_required === '1') {
          // Tài khoản chưa kích hoạt → sang màn nhập mã xác thực.
          const t = splitAccount(account);
          navigation.navigate('Verify', { email: d.email ?? t.email, phone: d.email ? undefined : (d.phone ?? t.phone), autoSend: true });
          return;
        }
        setErrors({ account: 'Tài khoản không tồn tại' });
      } else if (isApiError(e, Codes.PARAM_VALUE_INVALID) && e.field === 'password') {
        setErrors({ password: 'Sai mật khẩu' });
      } else if (isApiError(e, Codes.NOT_ACCESS) && (e.data as { reason?: string } | null)?.reason === 'locked') {
        setErrors({ form: 'Tài khoản đã bị khóa' });
      } else {
        setErrors({ form: errorMessage(e) });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      <View style={{ alignItems: 'center', marginVertical: 12 }}>
        <Text style={{ fontSize: 40 }}>🎥</Text>
        <Title>Multi-Cam Recorder</Title>
        <Muted>Một Controller điều khiển nhiều máy quay</Muted>
      </View>

      {notice ? <Banner kind="success">{notice}</Banner> : null}

      <Card>
        <Field
          label="Địa chỉ server (máy Controller)"
          value={server}
          onChangeText={(v) => {
            setServer(v);
            setServerStatus(null);
          }}
          onBlur={() => void saveServer()}
          autoCapitalize="none"
          keyboardType="url"
          placeholder="http://192.168.1.2:3000"
          hint="Server chạy trên laptop Controller, cùng mạng Wi-Fi với điện thoại"
        />
        <Row>
          <Button title="Kiểm tra kết nối" variant="secondary" small onPress={checkServer} loading={checking} />
          {serverStatus ? (
            <Text style={{ flex: 1, color: serverStatus.ok ? colors.success : colors.danger, fontSize: 12 }}>{serverStatus.text}</Text>
          ) : null}
        </Row>
      </Card>

      <Card>
        <Field
          label="Email / Số điện thoại"
          value={account}
          onChangeText={setAccount}
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="email@vidu.com hoặc 0912345678"
          error={errors.account}
        />
        <Field label="Mật khẩu" value={password} onChangeText={setPassword} secureTextEntry placeholder="••••••" error={errors.password} />
        {errors.form ? <Text style={{ color: colors.danger }}>{errors.form}</Text> : null}
        <Button title="Đăng nhập" onPress={onLogin} loading={loading} />
        <Row style={{ justifyContent: 'space-between' }}>
          <Button title="Quên mật khẩu?" variant="ghost" small onPress={() => navigation.navigate('Forgot')} />
          <Button title="Tạo tài khoản" variant="ghost" small onPress={() => navigation.navigate('Signup')} />
        </Row>
      </Card>
      <Muted style={{ textAlign: 'center' }}>Tài khoản đăng ký mới luôn là máy quay (Remote).</Muted>
    </Screen>
  );
}
