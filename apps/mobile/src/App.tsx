import React, { useEffect } from 'react';
import { Alert, AppState, Platform, View } from 'react-native';
import { NavigationContainer, DarkTheme, DefaultTheme, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { useStore } from '@multicam/shared/react';
import { session } from './services/session';
import { startRuntime } from './services/runtime';
import { remoteAgent } from './services/remote';
import { cameraBridge } from './services/recorder';
import { Icon, Logo, Loading, type IconName } from './ui/components';
import { colors, font, scheme } from './ui/theme';
import type { AppStackParams, AuthStackParams, TabParams } from './navigation/types';
import { LoginScreen } from './screens/auth/LoginScreen';
import { SignupScreen } from './screens/auth/SignupScreen';
import { VerifyScreen } from './screens/auth/VerifyScreen';
import { ForgotPasswordScreen } from './screens/auth/ForgotPasswordScreen';
import { RoomScreen } from './screens/controller/RoomScreen';
import { ControllerLibraryScreen } from './screens/controller/ControllerLibraryScreen';
import { CameraScreen } from './screens/remote/CameraScreen';
import { RemoteLibraryScreen } from './screens/remote/RemoteLibraryScreen';
import { DeleteAccountScreen } from './screens/remote/DeleteAccountScreen';
import { SettingsScreen } from './screens/common/SettingsScreen';
import { ChangePasswordScreen } from './screens/common/ChangePasswordScreen';
import { PlayerScreen } from './screens/common/PlayerScreen';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
});

// TanStack Query: coi ứng dụng "đang focus" theo AppState (tạm dừng polling khi vào nền).
focusManager.setEventListener((handleFocus) => {
  const sub = AppState.addEventListener('change', (state) => {
    if (Platform.OS !== 'web') handleFocus(state === 'active');
  });
  return () => sub.remove();
});

export const navigationRef = createNavigationContainerRef<AppStackParams>();

// Lệnh quay từ Controller tới khi người dùng đang ở tab khác → đưa về tab Quay để camera chạy.
cameraBridge.setOnNeedCamera(() => {
  if (navigationRef.isReady()) navigationRef.navigate('Tabs', { screen: 'Camera' });
});

/** Đang quay thì không cho rời tab Quay (tránh camera bị tạm dừng làm hỏng clip). */
const blockWhileRecording = {
  tabPress: (e: { preventDefault: () => void }) => {
    if (remoteAgent.getState().recordingState === 'recording' || cameraBridge.getState().recording) {
      e.preventDefault();
      Alert.alert('Đang quay', 'Dừng quay trước khi chuyển.');
    }
  },
};

const AuthStack = createNativeStackNavigator<AuthStackParams>();
const AppStack = createNativeStackNavigator<AppStackParams>();
const Tabs = createBottomTabNavigator<TabParams>();

const baseTheme = scheme === 'dark' ? DarkTheme : DefaultTheme;
const navTheme = {
  ...baseTheme,
  colors: {
    ...baseTheme.colors,
    background: colors.bg,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    primary: colors.accent,
    notification: colors.rec,
  },
};

const tabIcon =
  (name: IconName) =>
  ({ color }: { color: string }) => <Icon name={name} size={22} color={color} />;

function HeaderLogo() {
  return (
    <View style={{ marginLeft: 16 }}>
      <Logo />
    </View>
  );
}

const headerOptions = {
  headerTitleAlign: 'center' as const,
  headerStyle: { backgroundColor: colors.bg },
  headerTintColor: colors.text,
  headerTitleStyle: { fontWeight: font.heading, fontSize: 16, color: colors.text },
  headerShadowVisible: false,
};

const tabOptions = {
  ...headerOptions,
  headerLeft: () => <HeaderLogo />,
  tabBarActiveTintColor: colors.accent,
  tabBarInactiveTintColor: colors.muted,
  tabBarStyle: { backgroundColor: colors.surface, borderTopWidth: 0, elevation: 0 },
  tabBarLabelStyle: { fontSize: 11, fontWeight: font.medium },
};

function ControllerTabs() {
  return (
    <Tabs.Navigator screenOptions={tabOptions}>
      <Tabs.Screen
        name="Room"
        component={RoomScreen}
        options={{ title: 'Phòng', tabBarIcon: tabIcon('grid') }}
      />
      <Tabs.Screen
        name="Library"
        component={ControllerLibraryScreen}
        options={{ title: 'Thư viện', tabBarIcon: tabIcon('library') }}
      />
      <Tabs.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: 'Cài đặt', tabBarIcon: tabIcon('settings') }}
      />
    </Tabs.Navigator>
  );
}

function RemoteTabs() {
  return (
    <Tabs.Navigator screenOptions={tabOptions}>
      <Tabs.Screen
        name="Camera"
        component={CameraScreen}
        options={{ title: 'Quay', headerShown: false, tabBarIcon: tabIcon('camera') }}
      />
      <Tabs.Screen
        name="Library"
        component={RemoteLibraryScreen}
        listeners={blockWhileRecording}
        options={{ title: 'Thư viện', tabBarIcon: tabIcon('library') }}
      />
      <Tabs.Screen
        name="Settings"
        component={SettingsScreen}
        listeners={blockWhileRecording}
        options={{ title: 'Cài đặt', tabBarIcon: tabIcon('settings') }}
      />
    </Tabs.Navigator>
  );
}

function SignedInStack({ role }: { role: 'controller' | 'remote' }) {
  return (
    <AppStack.Navigator screenOptions={{ ...headerOptions, headerBackButtonDisplayMode: 'minimal' as const, contentStyle: { backgroundColor: colors.bg } }}>
      <AppStack.Screen name="Tabs" component={role === 'controller' ? ControllerTabs : RemoteTabs} options={{ headerShown: false }} />
      <AppStack.Screen name="Player" component={PlayerScreen} options={({ route }) => ({ title: route.params.title })} />
      <AppStack.Screen name="ChangePassword" component={ChangePasswordScreen} options={{ title: 'Đổi mật khẩu' }} />
      {role === 'remote' ? (
        <AppStack.Screen name="DeleteAccount" component={DeleteAccountScreen} options={{ title: 'Xóa tài khoản' }} />
      ) : null}
    </AppStack.Navigator>
  );
}

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ ...headerOptions, headerBackButtonDisplayMode: 'minimal' as const, contentStyle: { backgroundColor: colors.bg } }}>
      <AuthStack.Screen name="Login" component={LoginScreen} options={{ title: 'Đăng nhập', headerShown: false }} />
      <AuthStack.Screen name="Signup" component={SignupScreen} options={{ title: 'Tạo tài khoản' }} />
      <AuthStack.Screen name="Verify" component={VerifyScreen} options={{ title: 'Nhập mã' }} />
      <AuthStack.Screen name="Forgot" component={ForgotPasswordScreen} options={{ title: 'Đặt lại mật khẩu' }} />
    </AuthStack.Navigator>
  );
}

function Root() {
  const s = useStore(session);

  useEffect(() => {
    void session.restore().then(() => startRuntime());
  }, []);

  useEffect(() => {
    // Đăng xuất / hết phiên: bỏ cache truy vấn của tài khoản cũ.
    if (s.status === 'signedOut') queryClient.clear();
  }, [s.status]);

  if (s.status === 'loading') return <Loading />;
  // key theo vai trò + thiết bị để dựng lại toàn bộ cây khi đổi tài khoản.
  if (s.status === 'signedIn' && s.info) return <SignedInStack key={`${s.info.role}:${s.info.deviceId}`} role={s.info.role} />;
  return <AuthNavigator />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <NavigationContainer ref={navigationRef} theme={navTheme}>
          <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
          <Root />
        </NavigationContainer>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
