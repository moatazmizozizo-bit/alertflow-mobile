import BackgroundService from 'react-native-background-actions';
import AsyncStorage from '@react-native-async-storage/async-storage';

const HBEAT_MS = 3000;
const PENDING_ALERT_KEY = 'bg_pendingAlert';

interface BackgroundOptions {
  apiBase: string;
  deviceId: string;
  token?: string;
}

const backgroundTask = async (taskData?: BackgroundOptions) => {
  const { apiBase, deviceId, token } = taskData || { apiBase: '', deviceId: '', token: undefined };

  while (BackgroundService.isRunning()) {
    try {
      const res = await fetch(`${apiBase}/devices/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          ip: '0.0.0.0',
          port: 0,
          pcName: `Mobile-${deviceId}`,
          primaryMac: deviceId,
          appVersion: '1.0.0',
          osVersion: 'android',
          online: true,
          type: 'mobile',
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.commands && Array.isArray(data.commands)) {
          const alerts = data.commands.filter((cmd: any) => cmd.type === 'alert' && cmd.data);
          if (alerts.length > 0) {
            const latest = alerts[alerts.length - 1].data;
            await AsyncStorage.setItem(PENDING_ALERT_KEY, JSON.stringify(latest));
            await BackgroundService.updateNotification({
              taskDesc: `Alert: ${latest.label || 'Code'}${latest.incidentLocation ? ` in ${latest.incidentLocation}` : ''}`,
            });
          }
        }
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, HBEAT_MS));
  }
};

export async function startBackgroundTask(options: BackgroundOptions) {
  if (BackgroundService.isRunning()) return;
  await BackgroundService.start(backgroundTask, {
    taskName: 'AlertFlow Monitoring',
    taskTitle: 'AlertFlow',
    taskDesc: 'Monitoring for alerts...',
    taskIcon: { name: 'ic_launcher', type: 'mipmap' },
    color: '#d32f2f',
    linkingURI: 'alertflow://',
    parameters: options,
    progressBar: { max: 100, value: 0, indeterminate: true },
  });
}

export async function stopBackgroundTask() {
  if (!BackgroundService.isRunning()) return;
  await BackgroundService.stop();
}

export async function isTaskRunning(): Promise<boolean> {
  return BackgroundService.isRunning();
}

export async function checkPendingAlert(): Promise<any | null> {
  try {
    const json = await AsyncStorage.getItem(PENDING_ALERT_KEY);
    if (json) {
      await AsyncStorage.removeItem(PENDING_ALERT_KEY);
      return JSON.parse(json);
    }
  } catch {}
  return null;
}
