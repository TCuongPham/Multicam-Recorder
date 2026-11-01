import type { NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type AuthStackParams = {
  Login: undefined;
  Signup: undefined;
  Verify: { email?: string; phone?: string; autoSend?: boolean };
  Forgot: undefined;
};

export type TabParams = {
  Room: undefined;
  Camera: undefined;
  Library: undefined;
  Settings: undefined;
};

export type AppStackParams = {
  Tabs: NavigatorScreenParams<TabParams> | undefined;
  Player: { title: string; videoId?: string; uri?: string };
  ChangePassword: undefined;
  DeleteAccount: undefined;
};

export type AuthScreenProps<K extends keyof AuthStackParams> = NativeStackScreenProps<AuthStackParams, K>;
export type AppScreenProps<K extends keyof AppStackParams> = NativeStackScreenProps<AppStackParams, K>;
