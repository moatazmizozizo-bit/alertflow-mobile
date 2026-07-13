import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { log } from '../utils/log';

const BACKGROUND_NOTIF_TASK = 'ALERTFLOW_BG_NOTIFICATION';

export type AlertFlowNotificationType = 'alert' | 'survey' | 'news';

export interface NotificationPayload {
  type: AlertFlowNotificationType;
  id?: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// Foreground notification handler — show banner + sound for all types
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const type = (notification.request.content.data?.type as string) || '';
    return {
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: type === 'alert',
      shouldSetBadge: type === 'alert',
    };
  },
});

// Define the background notification task
TaskManager.defineTask(BACKGROUND_NOTIF_TASK, async ({ data, error }) => {
  if (error) {
    log.warn('Background notification task error:', error);
    return;
  }
  log.info('Background notification received:', data);
});

export function registerBackgroundTask(): void {
  Notifications.registerTaskAsync(BACKGROUND_NOTIF_TASK).catch(() => {
    log.warn('Failed to register background notification task');
  });
}

export async function requestNotificationPermissions(): Promise<boolean> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('alerts', {
        name: 'AlertFlow Alerts',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#3b82f6',
        sound: 'default',
      });
      await Notifications.setNotificationChannelAsync('surveys', {
        name: 'AlertFlow Surveys',
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 100, 100, 100],
        lightColor: '#22c55e',
      });
      await Notifications.setNotificationChannelAsync('news', {
        name: 'AlertFlow News',
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 100],
        lightColor: '#3b82f6',
      });
    }

    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      });
      finalStatus = status;
    }
    return finalStatus === 'granted';
  } catch {
    log.warn('Failed to request notification permissions');
    return false;
  }
}

export async function getExpoPushToken(projectId: string): Promise<string | null> {
  try {
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    return tokenData.data;
  } catch {
    log.warn('Failed to get Expo push token');
    return null;
  }
}

export async function registerPushTokenWithBackend(
  apiBase: string,
  token: string,
  pushToken: string,
  deviceId: string,
  platform: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/push-tokens/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        pushToken,
        deviceId,
        platform,
      }),
    });
    return res.ok;
  } catch {
    log.warn('Failed to register push token with backend');
    return false;
  }
}

export async function unregisterPushTokenWithBackend(
  apiBase: string,
  token: string,
  pushToken: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/push-tokens/unregister`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ pushToken }),
    });
    return res.ok;
  } catch {
    log.warn('Failed to unregister push token');
    return false;
  }
}

export async function showLocalNotification(payload: NotificationPayload): Promise<void> {
  try {
    const channelId =
      payload.type === 'alert' ? 'alerts' : payload.type === 'survey' ? 'surveys' : 'news';
    await Notifications.scheduleNotificationAsync({
      content: {
        title: payload.title,
        body: payload.body,
        data: { type: payload.type, id: payload.id, ...payload.data },
        sound: payload.type === 'alert' ? 'default' : undefined,
        ...(Platform.OS === 'android' ? { channelId } : {}),
      },
      trigger: null,
    });
  } catch {
    log.warn('Failed to show local notification');
  }
}

export function addNotificationResponseListener(
  handler: (type: AlertFlowNotificationType, id?: string, data?: Record<string, unknown>) => void,
): { remove: () => void } {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const content = response.notification.request.content;
    const nType = (content.data?.type as AlertFlowNotificationType) || 'alert';
    const nId = content.data?.id as string | undefined;
    const nData = content.data as Record<string, unknown> | undefined;
    handler(nType, nId, nData);
  });
  return { remove: () => subscription.remove() };
}

export function checkForPendingNotificationResponse(): { type: AlertFlowNotificationType; id?: string; data?: Record<string, unknown> } | null {
  try {
    const response = Notifications.getLastNotificationResponse();
    if (response?.notification) {
      const content = response.notification.request.content;
      const nType = (content.data?.type as AlertFlowNotificationType) || 'alert';
      const nId = content.data?.id as string | undefined;
      return { type: nType, id: nId, data: content.data as Record<string, unknown> | undefined };
    }
  } catch {
    // ignore
  }
  return null;
}
