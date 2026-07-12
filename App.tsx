import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Dimensions,
  Animated, Platform, ScrollView, Alert, AppState, Image, Modal,
  RefreshControl, KeyboardAvoidingView, Switch,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Speech from 'expo-speech';
import { createAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import iconPng from './assets/alertflow-icon.png';
import { getLocalIp, getApiBase, saveApiBase } from './src/services/config';
import { log } from './src/utils/log';

const WS_PORT = 3004;
const HBEAT_MS = 3000;
const AUTH_TOKEN_KEY = 'authToken';
const SECURE_AUTH_TOKEN_KEY = 'secure_authToken';
const AUTH_USERNAME_KEY = 'authUsername';
const AUTH_SAVED_AT_KEY = 'authSavedAt';
const HISTORY_ALERTS_KEY = 'history_alerts';
const HISTORY_NEWS_KEY = 'history_news';
const HISTORY_SURVEYS_KEY = 'history_surveys';
const HISTORY_SUBMITTED_KEY = 'history_submitted_campaigns';
const SETTINGS_KEY = 'user_settings';
const ACKED_KEY = 'acknowledged_alerts';
const PENDING_ACKS_KEY = 'pending_ack_retries';
const FILTER_DURATION_KEY = 'filter_duration';
const FILTER_SEVERITY_KEY = 'filter_severity';

type AlertData = {
  id?: string;
  code?: string;
  label?: string;
  color?: string;
  codeColor?: string;
  message?: string;
  codeLocation?: string;
  incidentLocation?: string;
  locationName?: string;
  voiceEnabled?: boolean;
  voiceText?: string;
  voiceRate?: number;
  voicePitch?: number;
  voiceVolume?: number;
  voiceGender?: string;
  codeDoc?: string;
  teamActions?: { title: string; description: string }[];
  isClear?: boolean;
  createdAt?: string;
  codeName?: string;
};

type SurveyData = {
  campaignId: string;
  survey: {
    id: string;
    title: string;
    description: string | null;
    isAnonymous: boolean;
    allowMultipleSubmissions: boolean;
    expiresAt: string | null;
    questions: SurveyQuestion[];
  };
};

type SurveyQuestion = {
  id: string;
  orderNo: number;
  type: 'single_choice' | 'multiple_choice' | 'rating' | 'text' | 'yes_no';
  text: string;
  isRequired: boolean;
  options: string[];
  scoreValue: number;
};

type NewsData = {
  id: string; title: string; body: string | null; priority: number;
  startAt: string | null; endAt: string | null; isActive: boolean;
  updatedAt: string; type: 'strip' | 'card'; durationSec: number;
  opacity: number; backgroundColor: string | null; textColor: string | null;
};

type PendingAck = { alertId: string; ts: number; alertData?: AlertData };
type AnswerMap = Record<string, string | string[] | number>;

const CODE_COLORS: Record<string, string> = {
  CODE_RED: '#d32f2f', CODE_BLUE: '#1565c0', CODE_YELLOW: '#fdd835',
  CODE_ORANGE: '#ff8f00', CODE_GREEN: '#2e7d32', CODE_PURPLE: '#7b1fa2',
  CODE_PINK: '#c2185b', CODE_WHITE: '#f5f5f5', CODE_BLACK: '#212121',
  CODE_GRAY: '#616161', CODE_SILVER: '#9e9e9e', CODE_BROWN: '#5d4037',
};

function codeColor(code?: string): string {
  if (!code) return '#d32f2f';
  return CODE_COLORS[code] || '#d32f2f';
}

// Icon redundancy for severity: color alone is not accessible (colorblindness,
// low-light wall displays), so every code also gets a distinct glyph.
const CODE_ICONS: Record<string, string> = {
  CODE_RED: '🔥', CODE_BLUE: '✚', CODE_YELLOW: '⚠️',
  CODE_ORANGE: '☣️', CODE_GREEN: '🏃', CODE_PURPLE: '🧒',
  CODE_PINK: '👶', CODE_WHITE: '🧍', CODE_BLACK: '💣',
  CODE_GRAY: '🛡️', CODE_SILVER: '🚨', CODE_BROWN: '🌪️',
};

function codeIcon(code?: string): string {
  if (!code) return '🚨';
  return CODE_ICONS[code] || '🚨';
}

const CODE_MEANINGS: Record<string, string> = {
  CODE_RED: 'Fire, explosion, rescue, HazMat',
  CODE_BLUE: 'Cardiac arrest, medical emergency',
  CODE_YELLOW: 'Bomb threat, suspicious package',
  CODE_ORANGE: 'HazMat, chemical spill, contamination',
  CODE_GREEN: 'Evacuation, shelter-in-place lift',
  CODE_PURPLE: 'Child abduction, missing person',
  CODE_PINK: 'Infant abduction, pediatric emergency',
  CODE_WHITE: 'All clear, situation resolved',
  CODE_BLACK: 'Bomb, explosive device, active shooter',
  CODE_GRAY: 'Security threat, intruder, lock down',
  CODE_SILVER: 'Active shooter, weapons incident',
  CODE_BROWN: 'Severe weather, tornado, natural disaster',
};

function displayLabel(data: AlertData): string {
  if (data.label) return data.label;
  if (data.code) return data.code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return 'ALERT';
}

function formatTime(d: Date): string {
  const n = new Date();
  const diff = Math.floor((n.getTime() - d.getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function getDeviceId(): string {
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 12; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

async function loadDeviceId(): Promise<string> {
  try { const stored = await AsyncStorage.getItem('deviceId'); if (stored) return stored; } catch { log.warn('Failed to read deviceId from storage'); }
  const id = getDeviceId();
  try { await AsyncStorage.setItem('deviceId', id); } catch { log.warn('Failed to write deviceId to storage'); }
  return id;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/[\s_]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.map((p) => p[0].toUpperCase()).slice(0, 2).join('');
}

function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function isValidAlertPayload(v: unknown): v is AlertData {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' || typeof o.code === 'string' || typeof o.message === 'string';
}

function isValidSurveyPayload(v: unknown): v is SurveyData {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.campaignId === 'string' && !!o.survey && typeof (o.survey as Record<string, unknown>)?.id === 'string';
}

function isValidNewsPayload(v: unknown): v is NewsData {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.title === 'string';
}

async function getSecureToken(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(SECURE_AUTH_TOKEN_KEY); } catch { return null; }
}

async function setSecureToken(token: string): Promise<void> {
  try { await SecureStore.setItemAsync(SECURE_AUTH_TOKEN_KEY, token); } catch { log.warn('Failed to save token to SecureStore'); }
}

async function removeSecureToken(): Promise<void> {
  try { await SecureStore.deleteItemAsync(SECURE_AUTH_TOKEN_KEY); } catch { log.warn('Failed to remove token from SecureStore'); }
}

function AppContent() {
  const insets = useSafeAreaInsets();
  const [screen, setScreen] = useState<'loading' | 'login' | 'alert' | 'survey' | 'news' | 'dashboard'>('loading');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [serverInput, setServerInput] = useState('');
  const [alert, setAlert] = useState<AlertData | null>(null);
  const [surveyData, setSurveyData] = useState<SurveyData | null>(null);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [surveySubmitted, setSurveySubmitted] = useState(false);
  const [newsData, setNewsData] = useState<NewsData | null>(null);
  const [newsList, setNewsList] = useState<NewsData[]>([]);
  const [surveyList, setSurveyList] = useState<SurveyData[]>([]);
  const [clock, setClock] = useState(new Date());
  const [status, setStatus] = useState('Starting...');
  const [activeTab, setActiveTab] = useState<'alerts' | 'news' | 'surveys'>('alerts');
  const [alertHistory, setAlertHistory] = useState<(AlertData & { ts: Date })[]>([]);
  const [loggingIn, setLoggingIn] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedCampaigns, setSubmittedCampaigns] = useState<Set<string>>(new Set());
  const [viewedNewsIds, setViewedNewsIds] = useState<Set<string>>(new Set());
  const [acknowledgedAlertIds, setAcknowledgedAlertIds] = useState<Set<string>>(new Set());
  const [pendingAcks, setPendingAcks] = useState<PendingAck[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCodeRef, setShowCodeRef] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [voiceToggle, setVoiceToggle] = useState(true);
  const [volumeLevel, setVolumeLevel] = useState(80);
  const [alertHistFull, setAlertHistFull] = useState(false);
  const [ackOverlay, setAckOverlay] = useState(false);
  const [connState, setConnState] = useState<'live' | 'reconnecting' | 'offline'>('live');
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<number | null>(null);
  const [pendingNotifs, setPendingNotifs] = useState<{ type: string; title: string; body: string; ts: number }[]>([]);
  const [newsRemaining, setNewsRemaining] = useState<number | null>(null);
  const [connToast, setConnToast] = useState<string | null>(null);
  const [showSaved, setShowSaved] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [durationFilter, setDurationFilter] = useState<'today' | 'week' | 'month' | 'all'>('all');
  const [severityFilter, setSeverityFilter] = useState<Set<string>>(new Set());
  const connToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatFailRef = useRef(0);
  const newsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulse = useRef(new Animated.Value(1)).current;
  const deviceId = useRef('');
  const localIp = useRef('0.0.0.0');
  const apiBaseRef = useRef('http://192.168.1.100:3000');
  const tokenRef = useRef<string | null>(null);
  const appStateRef = useRef(AppState.currentState);
  const newsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const surveySubmitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soundPlayerRef = useRef<ReturnType<typeof createAudioPlayer> | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      deviceId.current = await loadDeviceId();
      localIp.current = await getLocalIp();
      if (!mounted) return;
      setStatus(`Backend: ${apiBaseRef.current}`);
      try {
        apiBaseRef.current = await getApiBase();
        setServerInput(apiBaseRef.current);
        setStatus(`Backend: ${apiBaseRef.current}`);
      } catch (e: any) { setStatus(`Discovery: ${e.message}`); }

      try {
        let savedToken = await getSecureToken();
        // Migrate legacy AsyncStorage token to SecureStore if present
        if (!savedToken) {
          const legacyToken = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
          if (legacyToken) {
            await setSecureToken(legacyToken);
            await AsyncStorage.removeItem(AUTH_TOKEN_KEY);
            savedToken = legacyToken;
          }
        }
        const savedUsername = await AsyncStorage.getItem(AUTH_USERNAME_KEY);
        const savedAtStr = await AsyncStorage.getItem(AUTH_SAVED_AT_KEY);
        if (savedToken && savedUsername) {
          const savedAt = savedAtStr ? parseInt(savedAtStr, 10) : 0;
          const maxAge = 30 * 24 * 60 * 60 * 1000;
          if (Date.now() - savedAt < maxAge) {
            tokenRef.current = savedToken;
            setUsername(savedUsername);
            if (!mounted) return;
            setScreen('dashboard');
            return;
          }
        }
      } catch { log.warn('Failed to load saved auth token'); }

      try {
        const [alertsJson, newsJson, surveysJson, submittedJson] = await Promise.all([
          AsyncStorage.getItem(HISTORY_ALERTS_KEY),
          AsyncStorage.getItem(HISTORY_NEWS_KEY),
          AsyncStorage.getItem(HISTORY_SURVEYS_KEY),
          AsyncStorage.getItem(HISTORY_SUBMITTED_KEY),
        ]);
        if (alertsJson) {
          const parsed = JSON.parse(alertsJson);
          setAlertHistory(parsed.map((item: any) => ({ ...item, ts: new Date(item.ts) })));
        }
        if (newsJson) setNewsList(JSON.parse(newsJson));
        if (surveysJson) setSurveyList(JSON.parse(surveysJson));
        if (submittedJson) setSubmittedCampaigns(new Set(JSON.parse(submittedJson)));
      } catch { log.warn('Failed to load history from storage'); }
      try {
        const [ackedJson, settingsJson] = await Promise.all([
          AsyncStorage.getItem(ACKED_KEY),
          AsyncStorage.getItem(SETTINGS_KEY),
        ]);
        if (ackedJson) setAcknowledgedAlertIds(new Set(JSON.parse(ackedJson)));
        if (settingsJson) {
          try {
            const s = JSON.parse(settingsJson);
            if (typeof s.voiceToggle === 'boolean') setVoiceToggle(s.voiceToggle);
            if (typeof s.volumeLevel === 'number') setVolumeLevel(s.volumeLevel);
          } catch { log.warn('Failed to parse settings from storage'); }
        }
      } catch { log.warn('Failed to load acked/settings from storage'); }
      try {
        const pendingJson = await AsyncStorage.getItem(PENDING_ACKS_KEY);
        if (pendingJson) setPendingAcks(JSON.parse(pendingJson));
      } catch { log.warn('Failed to load pending acks from storage'); }
      await loadPendingNotifs();

      try {
        const dur = await AsyncStorage.getItem(FILTER_DURATION_KEY);
        if (dur === 'today' || dur === 'week' || dur === 'month' || dur === 'all') setDurationFilter(dur);
        const sev = await AsyncStorage.getItem(FILTER_SEVERITY_KEY);
        if (sev) setSeverityFilter(new Set(JSON.parse(sev)));
      } catch { log.warn('Failed to load filter preferences'); }

      try {
        const player = createAudioPlayer(require('./assets/beep.wav'));
        soundPlayerRef.current = player;
      } catch { log.warn('Failed to create audio player'); }

      setHasHydrated(true);
      setScreen('login');
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    return () => {
      if (surveySubmitTimerRef.current) {
        clearTimeout(surveySubmitTimerRef.current);
        surveySubmitTimerRef.current = null;
      }
      if (newsIntervalRef.current) {
        clearInterval(newsIntervalRef.current);
        newsIntervalRef.current = null;
      }
      if (soundPlayerRef.current) {
        try { soundPlayerRef.current.remove(); } catch { log.warn('Failed to remove sound player'); }
        soundPlayerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!hasHydrated) return;
    try { AsyncStorage.setItem(HISTORY_ALERTS_KEY, JSON.stringify(alertHistory)); } catch { log.warn('Failed to persist alert history'); }
  }, [alertHistory, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated) return;
    try { AsyncStorage.setItem(HISTORY_NEWS_KEY, JSON.stringify(newsList)); } catch { log.warn('Failed to persist news list'); }
  }, [newsList, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated) return;
    try { AsyncStorage.setItem(HISTORY_SURVEYS_KEY, JSON.stringify(surveyList)); } catch { log.warn('Failed to persist survey list'); }
  }, [surveyList, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated) return;
    try { AsyncStorage.setItem(HISTORY_SUBMITTED_KEY, JSON.stringify([...submittedCampaigns])); } catch { log.warn('Failed to persist submitted campaigns'); }
  }, [submittedCampaigns, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated) return;
    try { AsyncStorage.setItem(ACKED_KEY, JSON.stringify([...acknowledgedAlertIds])); } catch { log.warn('Failed to persist acknowledged alerts'); }
  }, [acknowledgedAlertIds, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated) return;
    try { AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ voiceToggle, volumeLevel })); } catch { log.warn('Failed to persist settings'); }
  }, [voiceToggle, volumeLevel, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated) return;
    try { AsyncStorage.setItem(PENDING_ACKS_KEY, JSON.stringify(pendingAcks)); } catch { log.warn('Failed to persist pending acks'); }
  }, [pendingAcks, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated) return;
    try { AsyncStorage.setItem(FILTER_DURATION_KEY, JSON.stringify(durationFilter)); } catch { log.warn('Failed to persist duration filter'); }
  }, [durationFilter, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated) return;
    try { AsyncStorage.setItem(FILTER_SEVERITY_KEY, JSON.stringify([...severityFilter])); } catch { log.warn('Failed to persist severity filter'); }
  }, [severityFilter, hasHydrated]);

  const playAlertSound = useCallback(async () => {
    try {
      const player = soundPlayerRef.current;
      if (player) {
        player.volume = volumeLevel / 100;
        player.play();
      }
    } catch { log.warn('Audio play failed'); }
    try { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); } catch { log.warn('Haptic impact failed'); }
  }, [volumeLevel]);

  const speakRepeated = useCallback(async (text: string, rate: number, pitch: number, volume: number) => {
    for (let i = 0; i < 3; i++) {
      Speech.stop();
      await new Promise((r) => setTimeout(r, 100));
      Speech.speak(text, { language: 'en', rate, pitch, volume });
      if (i < 2) await new Promise((r) => setTimeout(r, 2000));
    }
  }, []);

  const scheduleNotif = useCallback(async (type: string, title: string, body: string, extra: Record<string, string>) => {
    try {
      const stored = await AsyncStorage.getItem('pendingNotifs');
      const list = stored ? JSON.parse(stored) : [];
      list.push({ type, title, body, extra, ts: Date.now() });
      await AsyncStorage.setItem('pendingNotifs', JSON.stringify(list.slice(-20)));
    } catch { log.warn('Failed to schedule notification'); }
  }, []);

  const loadPendingNotifs = useCallback(async () => {
    try {
      const stored = await AsyncStorage.getItem('pendingNotifs');
      setPendingNotifs(stored ? JSON.parse(stored) : []);
    } catch { log.warn('Failed to load pending notifications'); }
  }, []);

  const dismissPendingNotifs = useCallback(async () => {
    setPendingNotifs([]);
    try { await AsyncStorage.setItem('pendingNotifs', JSON.stringify([])); } catch { log.warn('Failed to dismiss pending notifications'); }
  }, []);

  const cancelNewsTimer = useCallback(() => {
    if (newsTimerRef.current) {
      clearTimeout(newsTimerRef.current);
      newsTimerRef.current = null;
    }
    if (newsIntervalRef.current) {
      clearInterval(newsIntervalRef.current);
      newsIntervalRef.current = null;
    }
    setNewsRemaining(null);
  }, []);

  const showAlert = useCallback((data: AlertData) => {
    cancelNewsTimer();
    setAlert(data);
    setSurveyData(null);
    setNewsData(null);
    setAnswers({});
    setSurveySubmitted(false);
    setScreen('alert');
    setAlertHistory((prev) => [{ ...data, ts: new Date() }, ...prev].slice(0, 200));

    const bg = data.color || codeColor(data.code);
    const light = luminance(bg) > 0.6;
    const tc = light ? '#000' : '#fff';

    playAlertSound();

    if (data.voiceEnabled !== false) {
      const location = data.incidentLocation || data.codeLocation || data.locationName || '';
      const text = data.voiceText || [displayLabel(data), location ? `in ${location}` : '', data.message].filter(Boolean).join('. ');
      speakRepeated(text, data.voiceRate || 1.0, data.voicePitch || 1.0, ((data.voiceVolume ?? 80) / 100));
    }

    Animated.sequence([
      Animated.timing(pulse, { toValue: 1.03, duration: 300, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 300, useNativeDriver: true }),
    ]).start();
  }, [playAlertSound, speakRepeated]);

  const showSurveyScreen = useCallback((data: SurveyData) => {
    cancelNewsTimer();
    setSurveyData(data);
    setAlert(null);
    setNewsData(null);
    setAnswers({});
    setSurveySubmitted(false);
    setScreen('survey');
    setSurveyList((prev) => {
      if (prev.find((s) => s.campaignId === data.campaignId)) return prev;
      return [...prev, data].slice(-50);
    });
  }, []);

  const showNewsScreen = useCallback((data: NewsData) => {
    cancelNewsTimer();
    setNewsData(data);
    setAlert(null);
    setSurveyData(null);
    setAnswers({});
    setSurveySubmitted(false);
    setScreen('news');
    setViewedNewsIds((prev) => new Set(prev).add(data.id));
    setNewsList((prev) => {
      if (prev.find((n) => n.id === data.id)) return prev;
      return [...prev, data].slice(-50);
    });
    const total = data.durationSec || 10;
    setNewsRemaining(total);
    newsIntervalRef.current = setInterval(() => {
      setNewsRemaining((prev) => (prev !== null && prev > 0 ? prev - 1 : 0));
    }, 1000);
    newsTimerRef.current = setTimeout(() => {
      setNewsData((prev) => prev?.id === data.id ? null : prev);
      setScreen('dashboard');
    }, total * 1000);
  }, []);

  const removeNews = useCallback((id: string) => {
    cancelNewsTimer();
    setNewsData((prev) => prev?.id === id ? null : prev);
    setNewsList((prev) => prev.filter((n) => n.id !== id));
    setScreen('dashboard');
  }, [cancelNewsTimer]);

  const retryPendingAcks = useCallback(async () => {
    if (pendingAcks.length === 0) return;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tokenRef.current) headers['Authorization'] = `Bearer ${tokenRef.current}`;
    const remaining: PendingAck[] = [];
    for (const pa of pendingAcks) {
      try {
        const res = await fetch(`${apiBaseRef.current}/alerts/${pa.alertId}/ack`, {
          method: 'POST', headers,
          body: JSON.stringify({ deviceId: deviceId.current, acknowledgedBy: username || 'user' }),
        });
        if (res.ok) {
          log.info('Retried ack succeeded for alert', pa.alertId);
        } else {
          remaining.push(pa);
        }
      } catch {
        log.warn('Retry ack fetch failed for', pa.alertId);
        remaining.push(pa);
      }
    }
    setPendingAcks(remaining);
    try { await AsyncStorage.setItem(PENDING_ACKS_KEY, JSON.stringify(remaining)); } catch { log.warn('Failed to persist pending ack retries'); }
  }, [pendingAcks]);

  const handleUnauthorized = useCallback(() => {
    tokenRef.current = null;
    setUsername('');
    setPassword('');
    setLoginError('Your session expired — please sign in again.');
    removeSecureToken();
    AsyncStorage.multiRemove([AUTH_USERNAME_KEY, AUTH_SAVED_AT_KEY]);
    setScreen('login');
  }, []);

  const doHeartbeat = useCallback(async () => {
    const ip = await getLocalIp();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tokenRef.current) headers['Authorization'] = `Bearer ${tokenRef.current}`;
    try {
      const res = await fetch(`${apiBaseRef.current}/devices/heartbeat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ip, port: WS_PORT, pcName: `Mobile-${deviceId.current}`,
          primaryMac: deviceId.current, appVersion: '1.0.0',
          osVersion: `${Platform.OS} ${Platform.Version}`,
          online: true, type: 'mobile',
        }),
      });
      if (res.ok) {
        heartbeatFailRef.current = 0;
        setLastHeartbeatAt(Date.now());
        setConnState('live');
        retryPendingAcks();
        const data = await res.json();
        if (data.commands && Array.isArray(data.commands)) {
          const isBg = appStateRef.current === 'background' || appStateRef.current === 'inactive';
          for (const cmd of data.commands) {
            const payload = cmd.data?.type === cmd.type ? cmd.data.data : cmd.data;
            if (cmd.type === 'alert') {
              if (!isValidAlertPayload(payload)) { log.warn('Invalid alert payload, skipping'); continue; }
              if (isBg) {
                scheduleNotif('alert', `⚠️ ${displayLabel(payload)}`, payload.message || 'Alert received', { alertData: JSON.stringify(payload) });
              } else {
                showAlert(payload);
              }
            } else if (cmd.type === 'alert-clear') {
              if (!isValidAlertPayload(payload)) { log.warn('Invalid alert-clear payload, skipping'); continue; }
              if (!isBg) showAlert({ ...payload, isClear: true });
            } else if (cmd.type === 'survey-campaign') {
              if (!isValidSurveyPayload(payload)) { log.warn('Invalid survey payload, skipping'); continue; }
              if (isBg) {
                scheduleNotif('survey', '📋 New Survey', payload.survey?.title || 'Survey available', { surveyData: JSON.stringify(payload) });
              } else {
                showSurveyScreen(payload);
              }
            } else if (cmd.type === 'it-news-update') {
              if (!isValidNewsPayload(payload)) { log.warn('Invalid news payload, skipping'); continue; }
              if (isBg) {
                scheduleNotif('news', '📰 ' + (payload.title || ''), payload.body || '', { newsData: JSON.stringify(payload) });
              } else {
                showNewsScreen(payload);
              }
            } else if (cmd.type === 'it-news-remove') {
              removeNews(cmd.data?.id || cmd.requestId);
            }
          }
        }
      } else if (res.status === 401) {
        log.warn('Heartbeat returned 401, session expired');
        handleUnauthorized();
        return;
      } else {
        heartbeatFailRef.current += 1;
        setConnState(heartbeatFailRef.current >= 2 ? 'offline' : 'reconnecting');
      }
    } catch {
      log.warn('Heartbeat fetch failed');
      heartbeatFailRef.current += 1;
      setConnState(heartbeatFailRef.current >= 2 ? 'offline' : 'reconnecting');
    }
  }, [showAlert, showSurveyScreen, showNewsScreen, removeNews, scheduleNotif, retryPendingAcks, handleUnauthorized]);

  useEffect(() => {
    if (screen === 'dashboard' || screen === 'alert') {
      const clk = setInterval(() => setClock(new Date()), 1000);
      const scheduleNext = () => {
        const nf = heartbeatFailRef.current;
        const delay = nf >= 5 ? 30000 : nf >= 3 ? 15000 : nf >= 1 ? 10000 : HBEAT_MS;
        heartbeatTimerRef.current = setTimeout(() => {
          doHeartbeat();
          scheduleNext();
        }, delay);
      };
      doHeartbeat();
      scheduleNext();
      return () => {
        if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
        clearInterval(clk);
      };
    }
  }, [screen, doHeartbeat]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (appStateRef.current.match(/inactive|background/) && nextState === 'active') {
        doHeartbeat();
        loadPendingNotifs();
      }
      appStateRef.current = nextState;
    });
    return () => sub.remove();
  }, [showAlert, showNewsScreen, showSurveyScreen, doHeartbeat, loadPendingNotifs]);

  const handleUserLogin = useCallback(async () => {
    setLoginError('');
    setLoggingIn(true);
    if (!username.trim() || !password.trim()) { setLoginError('Username and password required'); setLoggingIn(false); return; }
    try {
      const base = serverInput.trim().replace(/\/+$/, '') || apiBaseRef.current;
      if (!base) { setLoginError('Server address is required. Enter it manually or ensure auto-discovery works.'); setLoggingIn(false); return; }
      apiBaseRef.current = base;
      if (serverInput.trim()) await saveApiBase(base);
      const res = await fetch(`${apiBaseRef.current}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password: password.trim() }),
      });
      if (res.status === 401) { setLoginError('Invalid username or password.'); setLoggingIn(false); return; }
      if (!res.ok) { setLoginError(`Login failed (${res.status}). Check credentials or server config.`); setLoggingIn(false); return; }
      const data = await res.json();
      tokenRef.current = data.accessToken;
      await setSecureToken(data.accessToken);
      await AsyncStorage.multiSet([
        [AUTH_USERNAME_KEY, username.trim()],
        [AUTH_SAVED_AT_KEY, String(Date.now())],
      ]);
      setLoggingIn(false);
      setScreen('dashboard');
    } catch (e: any) {
      if (e.message?.includes('Network request failed')) setLoginError('Cannot reach server. Check the address and ensure the backend is running.');
      else setLoginError(`Connection error: ${e.message}`);
      setLoggingIn(false);
    }
  }, [username, password]);

  const handleLogout = useCallback(() => {
    Alert.alert('Confirm Logout', 'Are you sure you want to log out? You will need to sign in again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: async () => {
        tokenRef.current = null;
        setUsername('');
        setPassword('');
        await removeSecureToken();
        await AsyncStorage.multiRemove([AUTH_USERNAME_KEY, AUTH_SAVED_AT_KEY]);
        setScreen('login');
      }},
    ]);
  }, []);

  const handleAcknowledge = useCallback(async () => {
    if (!alert) { setAlert(null); setScreen('dashboard'); return; }
    const ackedId = alert.id;
    if (ackedId) {
      setAcknowledgedAlertIds((prev) => new Set(prev).add(ackedId));
    }
    try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch { log.warn('Haptic notification failed'); }
    setAckOverlay(true);
    await new Promise((r) => setTimeout(r, 700));
    setAckOverlay(false);
    setAlert(null);
    setScreen('dashboard');

    if (!ackedId) return;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tokenRef.current) headers['Authorization'] = `Bearer ${tokenRef.current}`;
      const res = await fetch(`${apiBaseRef.current}/alerts/${ackedId}/ack`, {
        method: 'POST', headers,
        body: JSON.stringify({ deviceId: deviceId.current, acknowledgedBy: username || 'user' }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          log.warn('Ack POST returned 401, session expired');
          handleUnauthorized();
          return;
        }
        log.warn('Ack POST failed, queuing retry for', ackedId, 'status', res.status);
        const newPending = [...pendingAcks, { alertId: ackedId, ts: Date.now() }];
        setPendingAcks(newPending);
        try { await AsyncStorage.setItem(PENDING_ACKS_KEY, JSON.stringify(newPending)); } catch { log.warn('Failed to persist pending ack'); }
      }
    } catch {
      log.warn('Ack network error, queuing retry for', ackedId);
      const newPending = [...pendingAcks, { alertId: ackedId, ts: Date.now() }];
      setPendingAcks(newPending);
      try { await AsyncStorage.setItem(PENDING_ACKS_KEY, JSON.stringify(newPending)); } catch { log.warn('Failed to persist pending ack'); }
    }
  }, [alert, pendingAcks]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await doHeartbeat();
    setRefreshing(false);
  }, [doHeartbeat]);

  const showAlertDetail = useCallback((item: AlertData & { ts: Date }) => {
    const loc = item.incidentLocation || item.codeLocation || item.locationName || '';
    const msg = [
      item.code ? `Code: ${item.codeName || item.code}` : '',
      loc ? `Location: ${loc}` : '',
      item.message || '',
      item.createdAt ? `At: ${new Date(item.createdAt).toLocaleString()}` : '',
      item.codeDoc ? `\n${item.codeDoc}` : '',
    ].filter(Boolean).join('\n');
    Alert.alert(displayLabel(item), msg || 'No additional details.');
  }, []);

  const handleSaveSettings = useCallback(async (s: string) => {
    setServerInput(s);
    apiBaseRef.current = s;
    await saveApiBase(s);
    setShowSaved(true);
    setTimeout(() => setShowSaved(false), 2000);
  }, []);

  const handleSaveVoice = useCallback(async (v: boolean) => {
    setVoiceToggle(v);
  }, []);

  const handleSaveVolume = useCallback(async (v: number) => {
    setVolumeLevel(v);
  }, []);

  const updateAnswer = useCallback((questionId: string, value: string | string[] | number) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  }, []);

  const submitSurvey = useCallback(async () => {
    if (!surveyData || (!surveyData.survey.allowMultipleSubmissions && surveySubmitted)) return;
    const missing: string[] = [];
    for (const q of surveyData.survey.questions) {
      if (q.isRequired) {
        const ans = answers[q.id];
        if (!ans || (Array.isArray(ans) && ans.length === 0) || ans === '') missing.push(q.text);
      }
    }
    if (missing.length > 0) { Alert.alert('Required questions', 'Please answer: ' + missing.join(', ')); return; }
    setSubmitting(true);
    const formatted = surveyData.survey.questions.map((q) => ({ questionId: q.id, value: answers[q.id] ?? null }));
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tokenRef.current) headers['Authorization'] = `Bearer ${tokenRef.current}`;
      const res = await fetch(`${apiBaseRef.current}/survey/response`, {
        method: 'POST', headers,
        body: JSON.stringify({ surveyId: surveyData.survey.id, campaignId: surveyData.campaignId, answers: formatted, deviceId: deviceId.current }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          handleUnauthorized();
          setSubmitting(false);
          return;
        }
        Alert.alert('Submission Failed', `Server returned ${res.status}. Please try again.`); setSubmitting(false); return;
      }
    } catch (e: any) { Alert.alert('Submission Failed', `Network error: ${e.message}`); setSubmitting(false); return; }
    setSubmittedCampaigns((prev) => new Set(prev).add(surveyData.campaignId));
    setSurveySubmitted(true);
    setSubmitting(false);
    Alert.alert('Submitted', 'Survey response submitted.');
    surveySubmitTimerRef.current = setTimeout(() => { setSurveyData(null); setSurveySubmitted(false); setScreen('dashboard'); }, 1500);
  }, [surveyData, answers, surveySubmitted]);

  const renderQuestion = (q: SurveyQuestion, idx: number) => {
    const answer = answers[q.id];
    switch (q.type) {
      case 'yes_no':
        return (
          <View key={q.id} style={styles.questionBlock}>
            <Text style={styles.questionText}>{idx + 1}. {q.text}{q.isRequired ? ' *' : ''}</Text>
            <View style={styles.yesNoRow}>
              <TouchableOpacity style={[styles.choiceBtn, answer === 'yes' && styles.choiceSelected]} onPress={() => updateAnswer(q.id, 'yes')}><Text style={styles.choiceText}>Yes</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.choiceBtn, answer === 'no' && styles.choiceSelected]} onPress={() => updateAnswer(q.id, 'no')}><Text style={styles.choiceText}>No</Text></TouchableOpacity>
            </View>
          </View>
        );
      case 'single_choice':
        return (
          <View key={q.id} style={styles.questionBlock}>
            <Text style={styles.questionText}>{idx + 1}. {q.text}{q.isRequired ? ' *' : ''}</Text>
            {(q.options || []).map((opt) => (
              <TouchableOpacity key={opt} style={[styles.choiceBtn, answer === opt && styles.choiceSelected]} onPress={() => updateAnswer(q.id, opt)}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: answer === opt ? '#3a7bd5' : '#ffffff60', alignItems: 'center', justifyContent: 'center' }}>
                    {answer === opt && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#3a7bd5' }} />}
                  </View>
                  <Text style={styles.choiceText}>{opt}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        );
      case 'multiple_choice':
        return (
          <View key={q.id} style={styles.questionBlock}>
            <Text style={styles.questionText}>{idx + 1}. {q.text}{q.isRequired ? ' *' : ''}</Text>
            {(q.options || []).map((opt) => {
              const sel = Array.isArray(answer) && answer.includes(opt);
              return (
                <TouchableOpacity key={opt} style={[styles.choiceBtn, sel && styles.choiceSelected]} onPress={() => {
                  const arr = Array.isArray(answer) ? [...answer] : [];
                  if (sel) arr.splice(arr.indexOf(opt), 1); else arr.push(opt);
                  updateAnswer(q.id, arr);
                }}><Text style={styles.choiceText}>{sel ? '☑ ' : '☐ '}{opt}</Text></TouchableOpacity>
              );
            })}
          </View>
        );
      case 'rating':
        return (
          <View key={q.id} style={styles.questionBlock}>
            <Text style={styles.questionText}>{idx + 1}. {q.text}{q.isRequired ? ' *' : ''}</Text>
            <View style={styles.ratingRow}>
              {[1, 2, 3, 4, 5].map((v) => (
                <TouchableOpacity key={v} style={[styles.ratingBtn, answer === v && styles.ratingSelected]} onPress={() => updateAnswer(q.id, v)}>
                  <Text style={[styles.ratingText, answer === v && styles.ratingTextSelected]}>{v}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        );
      case 'text':
        return (
          <View key={q.id} style={styles.questionBlock}>
            <Text style={styles.questionText}>{idx + 1}. {q.text}{q.isRequired ? ' *' : ''}</Text>
            <TextInput style={styles.textAnswer} value={String(answer || '')} onChangeText={(v) => updateAnswer(q.id, v)} placeholder="Type your answer..." placeholderTextColor="#ffffff60" multiline maxLength={2000} />
            <Text style={{ color: '#ffffff70', fontSize: 11, textAlign: 'right', marginTop: 4 }}>{String(answer || '').length}/2000</Text>
          </View>
        );
      default: return null;
    }
  };

  // === LOADING ===
  if (screen === 'loading') {
    return (
      <View style={[styles.container, { backgroundColor: '#1a1a2e' }]}>
        <Image source={iconPng} style={{ width: 72, height: 72, borderRadius: 16, marginBottom: 16 }} />
        <Text style={[styles.brandTitle, { color: '#ffffffcc' }]}>AlertFlow</Text>
        <Text style={[styles.status, { color: '#ffffff60', marginTop: 20 }]}>{status}</Text>
      </View>
    );
  }

  // === LOGIN ===
  if (screen === 'login') {
    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.container, { backgroundColor: '#1a1a2e' }]}>
          <View style={styles.brandWrap}>
            <View style={styles.brandIcon}>
              <Text style={styles.brandLetters}>A<Text style={{ color: '#EF4444' }}>F</Text></Text>
            </View>
            <View>
              <Text style={styles.brandTitle}>AlertFlow</Text>
              <Text style={styles.brandSub}>Command Center</Text>
            </View>
          </View>
          <Text style={[styles.status, { color: '#ffffff60', marginBottom: 30 }]}>Sign in to receive alerts</Text>
          <TextInput style={styles.input} placeholder="http://192.168.1.x:3000" placeholderTextColor="#ffffff60" value={serverInput} onChangeText={setServerInput} autoCapitalize="none" keyboardType="url" accessibilityLabel="Server address" />
          <TextInput style={styles.input} placeholder="Username" placeholderTextColor="#ffffff60" value={username} onChangeText={setUsername} autoCapitalize="none" accessibilityLabel="Username" />
          <TextInput style={styles.input} placeholder="Password" placeholderTextColor="#ffffff60" value={password} onChangeText={setPassword} secureTextEntry accessibilityLabel="Password" />
          <TouchableOpacity style={styles.loginBtn} onPress={handleUserLogin} disabled={loggingIn} accessible={true} accessibilityLabel="Sign in" accessibilityRole="button"><Text style={styles.loginBtnText}>{loggingIn ? 'Signing in...' : 'Sign In'}</Text></TouchableOpacity>
          {loginError ? <Text style={styles.error}>{loginError}</Text> : null}
          <TouchableOpacity onPress={() => setShowAdvanced((p) => !p)} style={{ marginTop: 8 }} accessible={true} accessibilityLabel="Toggle advanced settings" accessibilityRole="button">
            <Text style={{ color: '#ffffff70', fontSize: 12, fontWeight: '600' }}>{showAdvanced ? '▾ Advanced' : '▸ Advanced'}</Text>
          </TouchableOpacity>
          {showAdvanced && (
            <View style={{ width: '100%', maxWidth: 400, marginTop: 4, padding: 12, backgroundColor: '#ffffff08', borderRadius: 8 }}>
              <Text style={{ color: '#ffffff60', fontSize: 12, lineHeight: 18 }}>
                The app auto-discovers the backend on your local network. Only set a custom address if auto-discovery fails or the server is on a different subnet. The backend runs on port 3000 by default.
              </Text>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    );
  }

  // === ALERT FULLSCREEN ===
  if (screen === 'alert' && alert) {
    const bg = alert.color || codeColor(alert.code) || '#d32f2f';
    const light = luminance(bg) > 0.6;
    const tc = light ? '#000' : '#fff';
    const location = alert.incidentLocation || alert.codeLocation || alert.locationName || '';
    const codeName = alert.codeName || alert.code || '';
    const icon = codeIcon(alert.code);
    return (
      <View style={[styles.container, { backgroundColor: bg, paddingTop: insets.top + 20, padding: 0 }]}>
        <StatusBar hidden />
        <ScrollView style={{ flex: 1, width: '100%' }} contentContainerStyle={{ padding: 24, paddingBottom: 16 }}>
          {codeName ? (
            <View style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 7, borderRadius: 999, backgroundColor: light ? '#00000020' : '#ffffff20', marginBottom: 10 }}>
              <Text style={{ fontSize: 15 }}>{icon}</Text>
              <Text style={{ color: tc, fontSize: 13, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase' }}>{codeName}</Text>
            </View>
          ) : (
            <Text style={{ fontSize: 40, textAlign: 'center', marginBottom: 2 }}>{icon}</Text>
          )}

          <Text style={[styles.alertLabel, { color: tc, marginBottom: 6 }]}>{displayLabel(alert)}</Text>

          {location ? (
            <Text style={{ color: tc + 'cc', fontSize: 16, fontWeight: '500', textAlign: 'center', marginBottom: 8 }}>📍 {location}</Text>
          ) : null}

          {alert.message ? <Text style={[styles.alertMsg, { color: tc + 'dd' }]}>{alert.message}</Text> : null}

          {alert.createdAt ? (
            <Text style={{ color: tc + '88', fontSize: 12, textAlign: 'center', marginBottom: 12 }}>
              {new Date(alert.createdAt).toLocaleString()}
            </Text>
          ) : null}

          {alert.isClear ? (
            <View style={{ alignSelf: 'center', paddingHorizontal: 24, paddingVertical: 8, borderRadius: 8, backgroundColor: '#22c55e40', marginVertical: 8 }}>
              <Text style={{ color: '#22c55e', fontSize: 16, fontWeight: '700' }}>✓ CODE CLEAR</Text>
            </View>
          ) : null}

          {alert.codeDoc ? (
            <View style={[styles.codeDocBlock, { backgroundColor: light ? '#00000010' : '#ffffff10' }]}>
              <Text style={[styles.docTitle, { color: tc }]}>About this Code</Text>
              <Text style={{ color: tc + 'dd', fontSize: 14, lineHeight: 20 }}>{alert.codeDoc}</Text>
            </View>
          ) : null}

          {alert.teamActions && alert.teamActions.length > 0 ? (
            <View style={{ marginTop: 16 }}>
              <Text style={[styles.docTitle, { color: tc, marginBottom: 10 }]}>Team Actions</Text>
              {alert.teamActions.map((a, i) => (
                <View key={i} style={[styles.teamAction, { borderColor: light ? '#00000020' : '#ffffff20' }]}>
                  <View style={[styles.tnum, { backgroundColor: light ? '#00000015' : '#ffffff15' }]}>
                    <Text style={[styles.tnumText, { color: tc }]}>{i + 1}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: tc, fontSize: 14, fontWeight: '600' }}>{a.title}</Text>
                    {a.description ? <Text style={{ color: tc + 'aa', fontSize: 12, marginTop: 2 }}>{a.description}</Text> : null}
                  </View>
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.alertBtnBar, { backgroundColor: bg, borderTopColor: light ? '#00000020' : '#ffffff25' }]}>
          {!alert.isClear ? (
            <TouchableOpacity style={[styles.alertBtnPrimary, { backgroundColor: tc }]} onPress={handleAcknowledge} activeOpacity={0.85} accessible={true} accessibilityLabel="Acknowledge alert" accessibilityRole="button">
              <Text style={{ color: bg, fontSize: 17, fontWeight: '800' }}>✓  Acknowledge</Text>
            </TouchableOpacity>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 12, width: '100%' }}>
            <TouchableOpacity style={{ flex: 1, paddingVertical: 10, alignItems: 'center' }} onPress={() => { setAlert(null); setScreen('dashboard'); }} activeOpacity={0.6} accessible={true} accessibilityLabel="Dismiss alert" accessibilityRole="button">
              <Text style={{ color: tc + '99', fontSize: 13.5, fontWeight: '600' }}>
                {alert.isClear ? 'Dismiss' : 'Dismiss'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ flex: 1, paddingVertical: 10, alignItems: 'center' }} onPress={() => Speech.stop()} activeOpacity={0.6} accessible={true} accessibilityLabel="Stop voice announcement" accessibilityRole="button">
              <Text style={{ color: tc + '99', fontSize: 13.5, fontWeight: '600' }}>✕ Stop TTS</Text>
            </TouchableOpacity>
          </View>
        </View>
        {ackOverlay && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: light ? '#ffffffdd' : '#000000dd' }}>
            <Text style={{ fontSize: 48, color: light ? '#000' : '#fff', fontWeight: '800' }}>✓</Text>
            <Text style={{ fontSize: 20, color: light ? '#000' : '#fff', fontWeight: '600', marginTop: 8 }}>Acknowledged</Text>
          </View>
        )}
      </View>
    );
  }

  // === SURVEY ===
  if (screen === 'survey' && surveyData) {
    const survey = surveyData.survey;
    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.container, { backgroundColor: '#1a1a2e', paddingTop: insets.top + 10 }]}>
        <StatusBar hidden />
        <ScrollView style={{ flex: 1, width: '100%' }} contentContainerStyle={{ padding: 20 }}>
          <Text style={[styles.brandTitle, { fontSize: 28, marginBottom: 8 }]}>{survey.title}</Text>
          {survey.description && <Text style={{ color: '#ffffffa0', fontSize: 16, marginBottom: 20 }}>{survey.description}</Text>}
          {survey.questions.map((q, i) => renderQuestion(q, i))}
          {surveySubmitted ? (
            <Text style={{ color: '#4caf50', fontSize: 18, textAlign: 'center', marginTop: 20 }}>✓ Submitted</Text>
          ) : (
            <TouchableOpacity style={styles.submitBtn} onPress={submitSurvey} disabled={submitting}><Text style={styles.submitBtnText}>{submitting ? 'Submitting...' : 'Submit'}</Text></TouchableOpacity>
          )}
        </ScrollView>
      </View>
      </KeyboardAvoidingView>
    );
  }

  // === NEWS FULLSCREEN ===
  if (screen === 'news' && newsData) {
    const bg = newsData.backgroundColor || '#1a1a2e';
    const light = luminance(bg) > 0.6;
    const tc = newsData.textColor || (light ? '#000' : '#fff');
    const total = newsData.durationSec || 10;
    const remaining = newsRemaining ?? total;
    const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
    return (
      <View style={{ flex: 1, backgroundColor: bg, paddingTop: insets.top + 20, paddingHorizontal: 24, paddingBottom: 20 }}>
        <StatusBar hidden />
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <View style={{ paddingHorizontal: 12, paddingVertical: 4, borderRadius: 6, backgroundColor: light ? '#00000020' : '#ffffff20' }}>
              <Text style={{ color: light ? '#000000aa' : '#ffffffaa', fontSize: 12, fontWeight: '600' }}>
                {newsData.type === 'card' ? 'AWARENESS' : 'UPDATE'}
              </Text>
            </View>
            <Text style={{ color: light ? '#00000080' : '#ffffff80', fontSize: 12, fontWeight: '600' }}>
              Closing in {remaining}s
            </Text>
          </View>
          <View style={{ height: 3, borderRadius: 2, backgroundColor: light ? '#00000015' : '#ffffff15', overflow: 'hidden', marginBottom: 18 }}>
            <View style={{ height: '100%', width: `${pct}%`, backgroundColor: light ? '#00000055' : '#ffffff55' }} />
          </View>
          <Text style={{ color: tc, fontSize: 28, fontWeight: '800', marginBottom: 16, lineHeight: 34 }}>{newsData.title}</Text>
          {newsData.body ? (
            <ScrollView style={{ flex: 1 }}>
              <Text style={{ color: light ? '#000000cc' : '#ffffffcc', fontSize: 17, lineHeight: 26 }}>{newsData.body}</Text>
            </ScrollView>
          ) : null}
        </View>
        <TouchableOpacity onPress={() => { cancelNewsTimer(); setNewsData(null); setScreen('dashboard'); }} style={{ alignSelf: 'center', paddingVertical: 14, paddingHorizontal: 48, borderRadius: 10, borderWidth: 1, borderColor: light ? '#00000030' : '#ffffff30', marginBottom: 10 }}>
          <Text style={{ color: light ? '#000000aa' : '#ffffffaa', fontSize: 16, fontWeight: '600' }}>Dismiss</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // === DASHBOARD (3 tabs) ===
  if (screen === 'dashboard') {
    const recentAlerts = alertHistory.slice(0, 10);
    const filterByDuration = (ts: Date | string | null | undefined): boolean => {
      if (durationFilter === 'all' || !ts) return true;
      const d = typeof ts === 'string' ? new Date(ts) : ts;
      const now = clock;
      const ms = durationFilter === 'today' ? 86400000 : durationFilter === 'week' ? 604800000 : 2592000000;
      return now.getTime() - d.getTime() < ms;
    };
    const severityFilterActive = severityFilter.size > 0;
    const filteredAlerts = alertHistory.filter((item) => {
      if (!filterByDuration(item.ts)) return false;
      if (severityFilterActive && item.code && !severityFilter.has(item.code)) return false;
      return true;
    });
    const filteredNews = newsList.filter((item) => {
      return filterByDuration(item.updatedAt || item.startAt);
    });
    const filteredSurveys = surveyList; // no timestamp for survey items
    const syncText = connState === 'live' && lastHeartbeatAt
      ? `Synced ${Math.floor((clock.getTime() - lastHeartbeatAt) / 1000)}s ago`
      : null;
    const renderEmptyState = (tab: 'alerts' | 'news' | 'surveys') => {
      const config: Record<string, { icon: string; primary: string }> = {
        alerts: { icon: '⚠️', primary: 'No alerts yet' },
        news: { icon: '📰', primary: 'No news yet' },
        surveys: { icon: '📋', primary: 'No surveys yet' },
      };
      const c = config[tab];
      const secondary = connState === 'live'
        ? "You're connected — new items will appear here automatically."
        : connState === 'reconnecting'
        ? 'Reconnecting — items may be delayed.'
        : 'Offline — check your connection.';
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 40 }}>
          <Text style={{ fontSize: 44, opacity: 0.25, marginBottom: 16 }}>{c.icon}</Text>
          <Text style={{ color: '#ffffff99', fontSize: 16, fontWeight: '600', marginBottom: 8 }}>{c.primary}</Text>
          <Text style={{ color: '#ffffff50', fontSize: 13, textAlign: 'center', paddingHorizontal: 32 }}>{secondary}</Text>
        </View>
      );
    };
    return (
      <View style={[styles.container, { backgroundColor: '#1a1a2e', paddingTop: 0, paddingHorizontal: 0 }]}>
        <StatusBar hidden />
        <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 }}>
            <Image source={iconPng} style={styles.topIcon} resizeMode="contain" />
            <View style={{ flexShrink: 1 }}>
              <Text style={{ color: '#fff', fontSize: 19, fontWeight: '800' }} numberOfLines={1} ellipsizeMode="tail">AlertFlow</Text>
              <Text style={{ color: '#5d6b86', fontSize: 10.5, fontWeight: '600', letterSpacing: 1.6, textTransform: 'uppercase' }} numberOfLines={1} ellipsizeMode="tail">Command Center</Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <TouchableOpacity
              onPress={() => {
                if (connToastTimer.current) clearTimeout(connToastTimer.current);
                const msg = connState === 'live' ? '✓ Connected' : connState === 'reconnecting' ? '⏳ Reconnecting…' : '⚠ Offline';
                setConnToast(msg);
                connToastTimer.current = setTimeout(() => setConnToast(null), 3000);
              }}
              style={[
                styles.liveDotWrap,
                connState === 'reconnecting' && styles.liveDotWrapReconnecting,
                connState === 'offline' && styles.liveDotWrapOffline,
              ]}
              accessible={true}
              accessibilityLabel={connState === 'live' ? 'Connected' : connState === 'reconnecting' ? 'Reconnecting' : 'Offline'}
              accessibilityRole="button"
            >
              <View style={[
                styles.liveDot,
                connState === 'reconnecting' && styles.reconnectingDot,
                connState === 'offline' && styles.offlineDot,
              ]} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowSettings(true)} style={styles.menuBtn} accessible={true} accessibilityLabel="Settings" accessibilityRole="button">
              <Text style={styles.menuBtnText}>⋯</Text>
            </TouchableOpacity>
          </View>
        </View>

        {(connState !== 'live' || connToast) ? (
          <View style={styles.statusRow}>
            <Text style={{ color: connState === 'offline' ? '#f87171' : connState === 'reconnecting' ? '#fbbf24' : '#86efac', fontSize: 12, fontWeight: '600' }}>
              {connToast || (connState === 'offline' ? '⚠ Not receiving live updates' : connState === 'reconnecting' ? '⏳ Reconnecting…' : '')}
              {!connToast && lastHeartbeatAt ? `  ·  last seen ${formatTime(new Date(lastHeartbeatAt))}` : ''}
            </Text>
          </View>
        ) : null}

        {pendingNotifs.length > 0 && (
          <View style={styles.pendingBanner}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={styles.pendingBannerTitle}>📥 While you were away</Text>
              <TouchableOpacity onPress={dismissPendingNotifs}><Text style={styles.pendingBannerClear}>Clear</Text></TouchableOpacity>
            </View>
            {pendingNotifs.slice(0, 5).map((n, i) => (
              <Text key={i} style={styles.pendingBannerItem} numberOfLines={1}>
                {n.type === 'alert' ? '🚨' : n.type === 'survey' ? '📋' : '📰'} {n.title}
              </Text>
            ))}
            {pendingNotifs.length > 5 ? (
              <Text style={styles.pendingBannerMore}>+{pendingNotifs.length - 5} more</Text>
            ) : null}
          </View>
        )}

        {pendingAcks.length > 0 && (
          <View style={[styles.pendingBanner, { borderColor: '#f59e0b40', backgroundColor: '#f59e0b1a' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ color: '#fbbf24', fontSize: 14 }}>⏳</Text>
              <Text style={{ color: '#fcd34d', fontSize: 13, fontWeight: '600' }}>
                {pendingAcks.length} acknowledgment{pendingAcks.length > 1 ? 's' : ''} pending retry
              </Text>
            </View>
          </View>
        )}

        <View style={styles.tabBar}>
          {(['alerts', 'news', 'surveys'] as const).map((t) => {
            const tabIcon = t === 'alerts' ? '⚠️' : t === 'news' ? '📰' : '📋';
            const label = t === 'alerts' ? `Alerts (${alertHistory.length})` : t === 'news' ? `News (${newsList.length})` : `Surveys (${surveyList.length})`;
            return (
              <TouchableOpacity key={t} style={[styles.tab, activeTab === t && styles.tabActive]} onPress={() => setActiveTab(t)}>
                <Text style={{ fontSize: 12 }}>{tabIcon}</Text>
                <Text style={[styles.tabText, activeTab === t && styles.tabTextActive]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <ScrollView
          style={{ flex: 1, width: '100%' }}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#ffffff60" />}
        >
          {activeTab === 'alerts' && (
            <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <Text style={styles.sectionTitle}>Alert History</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  {syncText ? <Text style={{ color: '#ffffff40', fontSize: 10, fontWeight: '500' }}>{syncText}</Text> : null}
                  {alertHistory.length > 0 && (
                    <TouchableOpacity onPress={() => setAlertHistory([])}>
                      <Text style={{ color: '#f87171', fontSize: 12, fontWeight: '600' }}>Clear All</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {(['today', 'week', 'month', 'all'] as const).map((d) => (
                  <TouchableOpacity key={d} onPress={() => setDurationFilter(d)}
                    style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: durationFilter === d ? '#3a7bd560' : '#ffffff10', borderWidth: 1, borderColor: durationFilter === d ? '#3a7bd5' : '#ffffff20' }}>
                    <Text style={{ color: durationFilter === d ? '#fff' : '#ffffff99', fontSize: 11, fontWeight: '600' }}>{d === 'today' ? 'Today' : d === 'week' ? 'This week' : d === 'month' ? 'This month' : 'All time'}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>
                <TouchableOpacity onPress={() => setSeverityFilter(new Set())}
                  style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, backgroundColor: !severityFilterActive ? '#3a7bd530' : '#ffffff15', borderWidth: 1, borderColor: !severityFilterActive ? '#3a7bd540' : '#ffffff30' }}>
                  <Text style={{ color: !severityFilterActive ? '#7bb3ff' : '#ffffff99', fontSize: 10, fontWeight: '600' }}>All codes</Text>
                </TouchableOpacity>
                {Object.keys(CODE_COLORS).map((code) => {
                  const selected = severityFilter.has(code);
                  return (
                    <TouchableOpacity key={code} onPress={() => {
                      const next = new Set(severityFilter);
                      if (selected) next.delete(code); else next.add(code);
                      setSeverityFilter(next.size ? next : new Set());
                    }}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, backgroundColor: selected ? CODE_COLORS[code] + '40' : '#ffffff10', borderWidth: 1, borderColor: selected ? CODE_COLORS[code] : '#ffffff20' }}>
                      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: CODE_COLORS[code] }} />
                      <Text style={{ fontSize: 11 }}>{CODE_ICONS[code] || '🚨'}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {filteredAlerts.length === 0 ? (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 40 }}>
                  <Text style={{ color: '#ffffff99', fontSize: 16, fontWeight: '600' }}>{alertHistory.length === 0 ? 'No alerts yet' : 'No alerts match this filter'}</Text>
                  <Text style={{ color: '#ffffff50', fontSize: 13, textAlign: 'center', paddingHorizontal: 32, marginTop: 8 }}>
                    {alertHistory.length === 0
                      ? (connState === 'live' ? "You're connected — new alerts will appear here automatically." : connState === 'reconnecting' ? 'Reconnecting — alerts may be delayed.' : 'Offline — check your connection.')
                      : 'Try adjusting the filters above.'}
                  </Text>
                </View>
              ) : (
                (alertHistFull ? filteredAlerts : filteredAlerts.slice(0, 50)).map((item, idx) => {
                  const loc = item.incidentLocation || item.codeLocation || item.locationName || '';
                  const title = [displayLabel(item), loc ? `in ${loc}` : ''].join(' ');
                  const bg = item.color || codeColor(item.code);
                  const acked = item.id ? acknowledgedAlertIds.has(item.id) : false;
                  return (
                    <TouchableOpacity key={idx} style={[styles.alertItem, { opacity: acked ? 0.65 : 1 }]} onPress={() => showAlertDetail(item)} activeOpacity={0.7}>
                      <View style={[styles.cardBar, { backgroundColor: bg }]} />
                      {!acked && <View style={{ position: 'absolute', left: 14, top: 12, width: 8, height: 8, borderRadius: 4, backgroundColor: '#ef4444', zIndex: 2 }} />}
                      <View style={[styles.alertIconBadge, { backgroundColor: bg + '30', borderColor: bg }]}>
                        <Text style={{ fontSize: 14 }}>{codeIcon(item.code)}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.alertItemTitle, acked && { fontWeight: '400', color: '#ffffff99' }]}>{title}</Text>
                        {item.message ? <Text style={styles.alertItemMeta}>{item.message}</Text> : null}
                      </View>
                      <Text style={{ color: '#ffffff70', fontSize: 11 }}>{formatTime(item.ts)}</Text>
                    </TouchableOpacity>
                  );
                })
              )}
              {!alertHistFull && filteredAlerts.length > 50 && (
                <TouchableOpacity onPress={() => setAlertHistFull(true)} style={{ paddingVertical: 12, alignItems: 'center' }}>
                  <Text style={{ color: '#3a7bd5', fontSize: 13, fontWeight: '600' }}>Show all ({filteredAlerts.length})</Text>
                </TouchableOpacity>
              )}
            </>
          )}

          {activeTab === 'news' && (
            <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <Text style={styles.sectionTitle}>News & Awareness</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  {syncText ? <Text style={{ color: '#ffffff40', fontSize: 10, fontWeight: '500' }}>{syncText}</Text> : null}
                  {newsList.length > 0 && (
                    <TouchableOpacity onPress={() => setNewsList([])}>
                      <Text style={{ color: '#f87171', fontSize: 12, fontWeight: '600' }}>Clear All</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {(['today', 'week', 'month', 'all'] as const).map((d) => (
                  <TouchableOpacity key={d} onPress={() => setDurationFilter(d)}
                    style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: durationFilter === d ? '#3a7bd560' : '#ffffff10', borderWidth: 1, borderColor: durationFilter === d ? '#3a7bd5' : '#ffffff20' }}>
                    <Text style={{ color: durationFilter === d ? '#fff' : '#ffffff99', fontSize: 11, fontWeight: '600' }}>{d === 'today' ? 'Today' : d === 'week' ? 'This week' : d === 'month' ? 'This month' : 'All time'}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {filteredNews.length === 0 ? (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 40 }}>
                  <Text style={{ color: '#ffffff99', fontSize: 16, fontWeight: '600' }}>{newsList.length === 0 ? 'No news yet' : 'No news match this filter'}</Text>
                  <Text style={{ color: '#ffffff50', fontSize: 13, textAlign: 'center', paddingHorizontal: 32, marginTop: 8 }}>
                    {newsList.length === 0
                      ? (connState === 'live' ? "You're connected — new news will appear here automatically." : connState === 'reconnecting' ? 'Reconnecting — news may be delayed.' : 'Offline — check your connection.')
                      : 'Try adjusting the filter above.'}
                  </Text>
                </View>
              ) : (
                filteredNews.map((item) => {
                  const viewed = viewedNewsIds.has(item.id);
                  return (
                    <TouchableOpacity key={item.id} style={[styles.newsCard, { opacity: viewed ? 0.65 : 1 }]} onPress={() => showNewsScreen(item)} activeOpacity={0.8}>
                      <View style={[styles.cardBar, { backgroundColor: item.type === 'card' ? '#9c27b0' : '#3a7bd5' }]} />
                      {!viewed && <View style={{ position: 'absolute', left: 14, top: 12, width: 8, height: 8, borderRadius: 4, backgroundColor: '#3b82f6', zIndex: 2 }} />}
                      <TouchableOpacity style={{ position: 'absolute', right: 6, top: 6, zIndex: 1, width: 24, height: 24, borderRadius: 12, backgroundColor: '#ffffff15', alignItems: 'center', justifyContent: 'center' }} onPress={() => removeNews(item.id)}>
                        <Text style={{ color: '#ffffff80', fontSize: 12, fontWeight: '700' }}>✕</Text>
                      </TouchableOpacity>
                      <View style={[styles.newsTag, { backgroundColor: item.type === 'card' ? '#7b1fa240' : '#3a7bd540' }]}>
                        <Text style={{ fontSize: 11, fontWeight: '600', color: item.type === 'card' ? '#ce93d8' : '#7bb3ff' }}>{item.type === 'card' ? 'Awareness' : 'Update'}</Text>
                      </View>
                      <Text style={{ color: '#ffffffcc', fontSize: 16, fontWeight: '600', marginBottom: 4 }}>{item.title}</Text>
                      {item.body ? <Text style={{ color: '#ffffff99', fontSize: 14, lineHeight: 20 }} numberOfLines={3}>{item.body}</Text> : null}
                    </TouchableOpacity>
                  );
                })
              )}
            </>
          )}

          {activeTab === 'surveys' && (
            <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <Text style={styles.sectionTitle}>Surveys</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  {syncText ? <Text style={{ color: '#ffffff40', fontSize: 10, fontWeight: '500' }}>{syncText}</Text> : null}
                  {surveyList.length > 0 && (
                    <TouchableOpacity onPress={() => setSurveyList([])}>
                      <Text style={{ color: '#f87171', fontSize: 12, fontWeight: '600' }}>Clear All</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {(['today', 'week', 'month', 'all'] as const).map((d) => (
                  <TouchableOpacity key={d} onPress={() => setDurationFilter(d)}
                    style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: durationFilter === d ? '#3a7bd560' : '#ffffff10', borderWidth: 1, borderColor: durationFilter === d ? '#3a7bd5' : '#ffffff20' }}>
                    <Text style={{ color: durationFilter === d ? '#fff' : '#ffffff99', fontSize: 11, fontWeight: '600' }}>{d === 'today' ? 'Today' : d === 'week' ? 'This week' : d === 'month' ? 'This month' : 'All time'}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {filteredSurveys.length === 0 ? (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 40 }}>
                  <Text style={{ color: '#ffffff99', fontSize: 16, fontWeight: '600' }}>{surveyList.length === 0 ? 'No surveys yet' : 'No surveys match this filter'}</Text>
                  <Text style={{ color: '#ffffff50', fontSize: 13, textAlign: 'center', paddingHorizontal: 32, marginTop: 8 }}>
                    {surveyList.length === 0
                      ? (connState === 'live' ? "You're connected — new surveys will appear here automatically." : connState === 'reconnecting' ? 'Reconnecting — surveys may be delayed.' : 'Offline — check your connection.')
                      : 'Try adjusting the filter above.'}
                  </Text>
                </View>
              ) : (
                filteredSurveys.map((item) => {
                  const submitted = submittedCampaigns.has(item.campaignId);
                  const expDate = item.survey.expiresAt ? new Date(item.survey.expiresAt) : null;
                  const expired = expDate && expDate < new Date();
                  return (
                    <View key={item.campaignId} style={styles.surveyCard}>
                      {!submitted && !expired && <View style={{ position: 'absolute', left: 14, top: 12, width: 8, height: 8, borderRadius: 4, backgroundColor: '#f59e0b', zIndex: 2 }} />}
                      <View style={[styles.cardBar, { backgroundColor: submitted ? '#4caf50' : expired ? '#6b7280' : '#3a7bd5' }]} />
                      <Text style={{ color: '#ffffffcc', fontSize: 16, fontWeight: '600', marginBottom: 4 }}>{item.survey.title}</Text>
                      {item.survey.description ? <Text style={{ color: '#ffffff80', fontSize: 13, marginBottom: 6 }}>{item.survey.description}</Text> : null}
                      <Text style={{ color: '#ffffff80', fontSize: 11, marginBottom: 10 }}>
                        {item.survey.questions.length} questions
                        {expDate ? `  ·  Expires ${expDate.toLocaleDateString()}` : ''}
                      </Text>
                      {submitted ? (
                        <Text style={{ color: '#4caf50', fontSize: 13, fontWeight: '600' }}>✓ Submitted</Text>
                      ) : expired ? (
                        <Text style={{ color: '#6b7280', fontSize: 13, fontWeight: '600' }}>Expired</Text>
                      ) : (
                        <TouchableOpacity style={styles.fillBtn} onPress={() => showSurveyScreen(item)}>
                          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>Fill Survey</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })
              )}
            </>
          )}

        </ScrollView>

        {/* === SETTINGS MODAL === */}
        <Modal visible={showSettings} transparent animationType="slide" onRequestClose={() => setShowSettings(false)}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000080' }}>
              <View style={{ backgroundColor: '#1a1a2e', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 36, maxHeight: '85%' }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                  <Text style={{ color: '#fff', fontSize: 20, fontWeight: '800' }}>Settings</Text>
                  <TouchableOpacity onPress={() => setShowSettings(false)}><Text style={{ color: '#7bb3ff', fontSize: 15, fontWeight: '600' }}>Done</Text></TouchableOpacity>
                </View>

                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <Text style={{ color: '#ffffff80', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 }}>Server</Text>
                  {showSaved ? <Text style={{ color: '#4caf50', fontSize: 12, fontWeight: '600' }}>✓ Saved</Text> : null}
                </View>
                <TextInput style={[styles.input, { marginBottom: 16 }]} value={serverInput} onChangeText={(v) => handleSaveSettings(v)} autoCapitalize="none" keyboardType="url" placeholder="Server address" placeholderTextColor="#ffffff60" />

                <Text style={{ color: '#ffffff80', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Voice & Sound</Text>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <Text style={{ color: '#ffffffcc', fontSize: 15 }}>Voice announcements</Text>
                  <Switch value={voiceToggle} onValueChange={handleSaveVoice} trackColor={{ false: '#ffffff30', true: '#3a7bd580' }} thumbColor={voiceToggle ? '#3a7bd5' : '#ffffff60'} />
                </View>
                <View style={{ marginBottom: 24 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text style={{ color: '#ffffffcc', fontSize: 15 }}>Volume</Text>
                    <Text style={{ color: '#ffffff80', fontSize: 13 }}>{volumeLevel}%</Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ color: '#ffffff80', fontSize: 16 }}>🔈</Text>
                    <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: '#ffffff20', overflow: 'hidden' }}>
                      <View style={{ width: `${volumeLevel}%`, height: '100%', backgroundColor: '#3a7bd5', borderRadius: 3 }} />
                    </View>
                    <Text style={{ color: '#ffffff80', fontSize: 16 }}>🔊</Text>
                  </View>
                </View>

                <TouchableOpacity onPress={() => { setShowSettings(false); setShowCodeRef(true); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 4, borderTopWidth: 1, borderTopColor: '#ffffff10', marginTop: 8 }}>
                  <Text style={{ fontSize: 18 }}>📖</Text>
                  <Text style={{ color: '#ffffffcc', fontSize: 16, fontWeight: '600' }}>Code Reference</Text>
                </TouchableOpacity>

                <TouchableOpacity onPress={() => { setShowSettings(false); handleLogout(); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 4, borderTopWidth: 1, borderTopColor: '#ffffff10' }}>
                  <Text style={{ fontSize: 18 }}>🚪</Text>
                  <Text style={{ color: '#ef4444', fontSize: 16, fontWeight: '700' }}>Log Out</Text>
                </TouchableOpacity>

                <Text style={{ color: '#ffffff30', fontSize: 11, textAlign: 'center', marginTop: 24 }}>AlertFlow Mobile v1.0.0</Text>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* === CODE REFERENCE MODAL === */}
        <Modal visible={showCodeRef} transparent animationType="slide" onRequestClose={() => setShowCodeRef(false)}>
          <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000080' }}>
            <View style={{ backgroundColor: '#1a1a2e', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 36, maxHeight: '85%' }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <Text style={{ color: '#fff', fontSize: 20, fontWeight: '800' }}>Code Reference</Text>
                <TouchableOpacity onPress={() => setShowCodeRef(false)}><Text style={{ color: '#7bb3ff', fontSize: 15, fontWeight: '600' }}>Done</Text></TouchableOpacity>
              </View>
              <ScrollView style={{ maxHeight: 500 }}>
                {Object.keys(CODE_COLORS).map((code) => (
                  <View key={code} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#ffffff08' }}>
                    <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: CODE_COLORS[code] + '30', borderWidth: 1.5, borderColor: CODE_COLORS[code], alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ fontSize: 16 }}>{CODE_ICONS[code] || '🚨'}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#ffffffcc', fontSize: 14, fontWeight: '700' }}>{code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</Text>
                      <Text style={{ color: '#ffffff80', fontSize: 12, marginTop: 1 }}>{CODE_MEANINGS[code] || ''}</Text>
                    </View>
                    <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: CODE_COLORS[code] }} />
                  </View>
                ))}
              </ScrollView>
            </View>
          </View>
        </Modal>
      </View>
    );
  }
  return null;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

const { width } = Dimensions.get('window');
const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  status: { fontSize: 14, textAlign: 'center' },
  input: { width: '100%', maxWidth: 400, padding: 14, fontSize: 16, backgroundColor: '#ffffff15', borderRadius: 8, color: '#fff', marginBottom: 12, borderWidth: 1, borderColor: '#ffffff30' },
  loginBtn: { width: '100%', maxWidth: 400, padding: 14, borderRadius: 8, backgroundColor: '#3a7bd5', alignItems: 'center' },
  loginBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: '#ff6b6b', marginTop: 12, fontSize: 14, textAlign: 'center' },
  brandWrap: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 36 },
  brandIcon: { width: 56, height: 56, borderRadius: 14, backgroundColor: '#0c1428', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#1a2a5e' },
  brandLetters: { fontSize: 22, fontWeight: '900', color: '#3B82F6', letterSpacing: -1 },
  brandTitle: { fontSize: 26, fontWeight: '800', color: '#ffffffcc', letterSpacing: -0.3 },
  brandSub: { fontSize: 12, color: '#ffffff99', fontWeight: '400', letterSpacing: 2, textTransform: 'uppercase' },
  topBar: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 14, paddingHorizontal: 20, flexShrink: 0 },
  topIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: '#0c1428', borderWidth: 1, borderColor: '#ffffff10' },
  liveDotWrap: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#22c55e1f', borderWidth: 1, borderColor: '#22c55e40', alignItems: 'center', justifyContent: 'center' },
  liveDotWrapReconnecting: { backgroundColor: '#f59e0b1f', borderColor: '#f59e0b40' },
  liveDotWrapOffline: { backgroundColor: '#ef44441f', borderColor: '#ef444440' },
  menuBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#1e293b', borderWidth: 1, borderColor: '#ffffff20', alignItems: 'center', justifyContent: 'center' },
  menuBtnText: { color: '#cbd5e1', fontSize: 18, fontWeight: '700', lineHeight: 22 },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: '#22c55e1f', borderWidth: 1, borderColor: '#22c55e40' },
  liveDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: '#22c55e' },
  liveText: { color: '#86efac', fontSize: 11, fontWeight: '600' },
  reconnectingPill: { backgroundColor: '#f59e0b1f', borderColor: '#f59e0b40' },
  reconnectingDot: { backgroundColor: '#f59e0b' },
  reconnectingText: { color: '#fcd34d' },
  offlinePill: { backgroundColor: '#ef44441f', borderColor: '#ef444440' },
  offlineDot: { backgroundColor: '#ef4444' },
  offlineText: { color: '#fca5a5' },
  pendingBanner: { marginHorizontal: 16, marginBottom: 12, padding: 14, borderRadius: 14, backgroundColor: '#3a7bd51a', borderWidth: 1, borderColor: '#3a7bd540' },
  pendingBannerTitle: { color: '#bfdbfe', fontSize: 13, fontWeight: '700' },
  pendingBannerClear: { color: '#7bb3ff', fontSize: 12.5, fontWeight: '700' },
  pendingBannerItem: { color: '#ffffffcc', fontSize: 13, marginTop: 3 },
  pendingBannerMore: { color: '#ffffff70', fontSize: 12, marginTop: 4, fontStyle: 'italic' },
  alertIconBadge: { width: 32, height: 32, borderRadius: 16, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#1e293b', borderWidth: 1, borderColor: '#ffffff20', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#cbd5e1', fontSize: 13, fontWeight: '700' },
  statusRow: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 8, paddingBottom: 4, paddingHorizontal: 16, flexShrink: 0 },
  tabBar: { width: '100%', flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingBottom: 12, flexShrink: 0 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 11, borderRadius: 13, borderWidth: 1, borderColor: '#ffffff12', backgroundColor: '#101728' },
  tabActive: { backgroundColor: '#3a7bd5', borderColor: 'transparent', shadowColor: '#3a7bd5', shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 5 },
  cardBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  tabText: { color: '#8a97b0', fontSize: 13.5, fontWeight: '600' },
  tabTextActive: { color: '#ffffff' },
  sectionTitle: { color: '#ffffff80', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
  alertItem: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: '#ffffff08', borderWidth: 1, borderColor: '#ffffff10', borderRadius: 14, marginBottom: 8, position: 'relative', overflow: 'hidden' },
  alertDot: { width: 12, height: 12, borderRadius: 6, flexShrink: 0 },
  alertItemTitle: { color: '#ffffffcc', fontSize: 15, fontWeight: '600' },
  alertItemMeta: { color: '#ffffff60', fontSize: 12, marginTop: 2 },
  alertLabel: { fontSize: 40, fontWeight: '800', textAlign: 'center', marginBottom: 6 },
  alertMsg: { fontSize: 18, textAlign: 'center', marginBottom: 20 },
  codeDocBlock: { borderRadius: 12, padding: 16, marginBottom: 8 },
  docTitle: { fontSize: 14, fontWeight: '700', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.8 },
  teamAction: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1 },
  tnum: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  tnumText: { fontSize: 13, fontWeight: '700' },
  alertBtnBar: { width: '100%', paddingHorizontal: 24, paddingTop: 12, paddingBottom: 28, borderTopWidth: 1, gap: 8, flexShrink: 0 },
  alertBtnPrimary: { width: '100%', paddingVertical: 16, borderRadius: 14, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 3 },
  alertBtnSecondary: { width: '100%', paddingVertical: 10, alignItems: 'center' },
  newsCard: { padding: 18, backgroundColor: '#ffffff08', borderWidth: 1, borderColor: '#ffffff10', borderRadius: 14, marginBottom: 12, position: 'relative', overflow: 'hidden' },
  newsTag: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 2, borderRadius: 4, marginBottom: 8 },
  surveyCard: { padding: 18, backgroundColor: '#ffffff08', borderWidth: 1, borderColor: '#ffffff10', borderRadius: 14, marginBottom: 12, position: 'relative', overflow: 'hidden' },
  fillBtn: { alignSelf: 'flex-start', paddingHorizontal: 20, paddingVertical: 8, backgroundColor: '#3a7bd5', borderRadius: 6 },
  questionBlock: { marginBottom: 20 },
  questionText: { color: '#ffffffcc', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  choiceBtn: { padding: 12, borderRadius: 8, backgroundColor: '#ffffff15', marginBottom: 6, borderWidth: 1, borderColor: '#ffffff30' },
  choiceSelected: { backgroundColor: '#3a7bd550', borderColor: '#3a7bd5' },
  choiceText: { color: '#fff', fontSize: 15 },
  yesNoRow: { flexDirection: 'row', gap: 12 },
  ratingRow: { flexDirection: 'row', gap: 8 },
  ratingBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#ffffff15', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#ffffff30' },
  ratingSelected: { backgroundColor: '#3a7bd5', borderColor: '#3a7bd5' },
  ratingText: { color: '#ffffffa0', fontSize: 16, fontWeight: '600' },
  ratingTextSelected: { color: '#fff' },
  textAnswer: { width: '100%', padding: 12, fontSize: 15, backgroundColor: '#ffffff15', borderRadius: 8, color: '#fff', borderWidth: 1, borderColor: '#ffffff30', minHeight: 80, textAlignVertical: 'top' },
  submitBtn: { width: '100%', padding: 14, borderRadius: 8, backgroundColor: '#4caf50', alignItems: 'center', marginTop: 10 },
  submitBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  emptyState: { alignItems: 'center', paddingVertical: 50 },
  emptyText: { color: '#ffffff70', fontSize: 14 },
});
