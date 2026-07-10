import * as Network from 'expo-network';

let _cachedBackendIp: string | null = null;

export async function getLocalIp(): Promise<string> {
  try {
    const ip = await Network.getIpAddressAsync();
    return ip || '0.0.0.0';
  } catch {
    return '0.0.0.0';
  }
}

function probeIp(ip: string, port: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { done = true; resolve(false); }, timeoutMs);
    fetch(`http://${ip}:${port}/auth/health`)
      .then(() => { if (!done) { done = true; clearTimeout(timer); resolve(true); } })
      .catch(() => { if (!done) { done = true; clearTimeout(timer); resolve(false); } });
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
  const myPart = parseInt(parts[3], 10);
  const configuredPart = process.env.EXPO_PUBLIC_BACKEND_IP_PART;

  const candidates: string[] = [];

  // 1. Explicit env var override
  if (configuredPart) {
    candidates.push(`${subnet}${configuredPart}`);
  }

  // 2. Common gateway IPs
  candidates.push(`${subnet}1`, `${subnet}254`);

  // 3. Try the device's own IP (if backend is on same machine)
  candidates.push(localIp);

  // 4. Try my-1, my+1, my-2, my+2 (around the device)
  for (const offset of [-1, 1, -2, 2, -3, 3, -5, 5]) {
    const neighbor = myPart + offset;
    if (neighbor >= 1 && neighbor <= 254) {
      candidates.push(`${subnet}${neighbor}`);
    }
  }

  // 5. Fixed common server IPs
  for (const p of [100, 200, 50, 150, 10, 20, 30, 80, 120, 180, 250, 25, 75, 125]) {
    if (!candidates.includes(`${subnet}${p}`)) {
      candidates.push(`${subnet}${p}`);
    }
  }

  // 6. Quick sequential scan: check middle range (50-200) in batches
  for (let p = 50; p <= 200; p++) {
    if (!candidates.includes(`${subnet}${p}`)) {
      candidates.push(`${subnet}${p}`);
    }
  }

  // Deduplicate
  const unique = [...new Set(candidates)];

  // Probe concurrently in batches of 5
  for (let i = 0; i < unique.length; i += 5) {
    const batch = unique.slice(i, i + 5);
    const results = await Promise.all(batch.map((ip) => probeIp(ip, port, 1000)));
    const idx = results.indexOf(true);
    if (idx !== -1) {
      _cachedBackendIp = batch[idx];
      return _cachedBackendIp;
    }
  }

  _cachedBackendIp = `${subnet}${myPart}`;
  return _cachedBackendIp;
}

export async function getApiBase(): Promise<string> {
  const ip = await discoverBackendIp();
  const port = process.env.EXPO_PUBLIC_BACKEND_PORT || '3000';
  return `http://${ip}:${port}`;
}

export function resetBackendIp() {
  _cachedBackendIp = null;
}