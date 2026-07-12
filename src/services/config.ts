import * as Network from 'expo-network';
import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = '[AlertFlow]';
const log = { warn: (...args: unknown[]) => console.warn(PREFIX, ...args) };

const MANUAL_KEY = 'backendBase';
const CACHED_DISCOVERED_IP_KEY = 'discoveredBackendIp';
const CACHED_DISCOVERED_TS_KEY = 'discoveredBackendIpTs';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const HEALTH_PATH = '/health';

let _cachedBackendIp: string | null = null;
let _cachedBase: string | null = null;

export async function getLocalIp(): Promise<string> {
  try {
    const ip = await Network.getIpAddressAsync();
    return ip || '0.0.0.0';
  } catch {
    log.warn('getLocalIp failed');
    return '0.0.0.0';
  }
}

export async function getManualBackend(): Promise<string | null> {
  try {
    const v = await AsyncStorage.getItem(MANUAL_KEY);
    return v && v.trim() ? v.trim().replace(/\/+$/, '') : null;
  } catch {
    log.warn('getManualBackend read failed');
    return null;
  }
}

export async function setManualBackend(base: string): Promise<void> {
  try {
    const v = (base || '').trim().replace(/\/+$/, '');
    if (v) await AsyncStorage.setItem(MANUAL_KEY, v);
    else await AsyncStorage.removeItem(MANUAL_KEY);
  } catch { log.warn('setManualBackend write failed'); }
}

function probeIp(ip: string, port: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => finish(false), timeoutMs);
    fetch(`http://${ip}:${port}${HEALTH_PATH}`)
      .then((res) => finish(res.ok))
      .catch(() => finish(false));
  });
}

export async function discoverBackendIp(): Promise<string> {
  if (_cachedBackendIp) return _cachedBackendIp;

  const localIp = await getLocalIp();
  const parts = localIp.split('.');
  const port = process.env.EXPO_PUBLIC_BACKEND_PORT || '3000';

  if (parts.length !== 4) {
    _cachedBackendIp = '192.168.1.100';
    return _cachedBackendIp;
  }

  const subnet = `${parts[0]}.${parts[1]}.${parts[2]}.`;

  // Try disk-cached IP first with a single fast probe
  try {
    const cachedIp = await AsyncStorage.getItem(CACHED_DISCOVERED_IP_KEY);
    const cachedTs = await AsyncStorage.getItem(CACHED_DISCOVERED_TS_KEY);
    if (cachedIp && cachedTs && (Date.now() - parseInt(cachedTs, 10) < CACHE_TTL_MS)) {
      const ok = await probeIp(cachedIp, port, 700);
      if (ok) {
        _cachedBackendIp = cachedIp;
        return _cachedBackendIp;
      }
    }
  } catch { log.warn('Failed to read cached backend IP'); }

  const myPart = parseInt(parts[3], 10);
  const configuredPart = process.env.EXPO_PUBLIC_BACKEND_IP_PART;

  const candidates: string[] = [];

  if (configuredPart) candidates.push(`${subnet}${configuredPart}`);
  candidates.push(`${subnet}1`, `${subnet}254`);
  candidates.push(localIp);
  for (const offset of [-1, 1, -2, 2, -3, 3, -5, 5, -10, 10]) {
    const neighbor = myPart + offset;
    if (neighbor >= 1 && neighbor <= 254) candidates.push(`${subnet}${neighbor}`);
  }
  for (const p of [100, 144, 200, 50, 150, 10, 20, 30, 80, 120, 180, 250, 25, 75, 125]) {
    if (!candidates.includes(`${subnet}${p}`)) candidates.push(`${subnet}${p}`);
  }
  for (let p = 1; p <= 254; p++) {
    if (!candidates.includes(`${subnet}${p}`)) candidates.push(`${subnet}${p}`);
  }

  const unique = [...new Set(candidates)];

  const BATCH = 12;
  const TIMEOUT = 700;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((ip) => probeIp(ip, port, TIMEOUT)));
    const idx = results.indexOf(true);
    if (idx !== -1) {
      _cachedBackendIp = batch[idx];
      try {
        await AsyncStorage.setItem(CACHED_DISCOVERED_IP_KEY, _cachedBackendIp);
        await AsyncStorage.setItem(CACHED_DISCOVERED_TS_KEY, String(Date.now()));
      } catch { log.warn('Failed to cache discovered backend IP'); }
      return _cachedBackendIp;
    }
  }

  _cachedBackendIp = `${subnet}${myPart}`;
  return _cachedBackendIp;
}

export async function getApiBase(): Promise<string> {
  if (_cachedBase) return _cachedBase;
  const manual = await getManualBackend();
  if (manual) {
    _cachedBase = manual;
    return _cachedBase;
  }
  const ip = await discoverBackendIp();
  const port = process.env.EXPO_PUBLIC_BACKEND_PORT || '3000';
  _cachedBase = `http://${ip}:${port}`;
  return _cachedBase;
}

export async function saveApiBase(base: string): Promise<void> {
  const v = (base || '').trim().replace(/\/+$/, '');
  _cachedBase = v;
  await setManualBackend(v);
}

export function resetBackendIp() {
  _cachedBackendIp = null;
  _cachedBase = null;
  try {
    AsyncStorage.removeItem(CACHED_DISCOVERED_IP_KEY);
    AsyncStorage.removeItem(CACHED_DISCOVERED_TS_KEY);
  } catch { log.warn('Failed to clear cached backend IP'); }
}
