import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Dimensions,
  Animated, Platform, ScrollView, Alert, AppState,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Speech from 'expo-speech';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocalIp, getApiBase } from './src/services/config';
import { startBackgroundTask, stopBackgroundTask, isTaskRunning, checkPendingAlert } from './src/services/backgroundService';

const WS_PORT = 3004;
const HBEAT_MS = 3000;
const ALERT_DISPLAY_MS = 10000;

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
  id: string;
  title: string;
  body: string | null;
  priority: number;
  startAt: string | null;
  endAt: string | null;
  isActive: boolean;
  updatedAt: string;
  type: 'strip' | 'card';
  durationSec: number;
  opacity: number;
  backgroundColor: string | null;
  textColor: string | null;
};

type AnswerMap = Record<string, string | string[] | number>;

function getDeviceId(): string {
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 12; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

async function loadDeviceId(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem('deviceId');
    if (stored) return stored;
  } catch {}
  const id = getDeviceId();
  try { await AsyncStorage.setItem('deviceId', id); } catch {}
  return id;
}

function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export default function App() {
  const [screen, setScreen] = useState<'loading' | 'login' | 'alert' | 'survey' | 'news' | 'dashboard'>('loading');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [alert, setAlert] = useState<AlertData | null>(null);
  const [surveyData, setSurveyData] = useState<SurveyData | null>(null);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [surveySubmitted, setSurveySubmitted] = useState(false);
  const [newsData, setNewsData] = useState<NewsData | null>(null);
  const [clock, setClock] = useState(new Date());
  const [status, setStatus] = useState('Starting...');
  const [mode, setMode] = useState<'guest' | 'user' | null>(null);
  const [monitoring, setMonitoring] = useState(false);
  const [alertHistory, setAlertHistory] = useState<AlertData[]>([]);
  const pulse = useRef(new Animated.Value(1)).current;
  const deviceId = useRef('');
  const localIp = useRef('0.0.0.0');
  const apiBaseRef = useRef('http://192.168.1.100:3000');
  const tokenRef = useRef<string | null>(null);
  const appStateRef = useRef(AppState.currentState);

  const showAlert = useCallback((data: AlertData) => {
    setAlert(data); setSurveyData(null); setNewsData(null); setAnswers({}); setSurveySubmitted(false);
    setScreen('alert');
    setAlertHistory((prev) => [data, ...prev].slice(0, 20));
    if (data.voiceEnabled !== false) {
      const location = data.incidentLocation || data.codeLocation || data.locationName || '';
      const text = data.voiceText || [data.label || 'Alert', location ? `in ${location}` : '', data.message].filter(Boolean).join('. ');
      Speech.stop();
      Speech.speak(text, { language: 'en', rate: data.voiceRate || 1.0, pitch: data.voicePitch || 1.0, volume: ((data.voiceVolume ?? 80) / 100) });
    }
    Animated.sequence([Animated.timing(pulse, { toValue: 1.03, duration: 300, useNativeDriver: true }), Animated.timing(pulse, { toValue: 1, duration: 300, useNativeDriver: true })]).start();
    setTimeout(() => { setAlert(null); setScreen('dashboard'); }, ALERT_DISPLAY_MS);
  }, []);

  const showSurvey = useCallback((data: SurveyData) => {
    setSurveyData(data); setAlert(null); setNewsData(null); setAnswers({}); setSurveySubmitted(false); setScreen('survey');
    setTimeout(() => { setSurveyData(null); setSurveySubmitted(false); setScreen('dashboard'); }, 300000);
  }, []);

  const showNews = useCallback((data: NewsData) => {
    setNewsData(data); setAlert(null); setSurveyData(null); setAnswers({}); setSurveySubmitted(false); setScreen('news');
    setTimeout(() => { setNewsData(null); setScreen('dashboard'); }, (data.durationSec || 10) * 1000);
  }, []);

  const removeNews = useCallback((id: string) => {
    setNewsData((prev) => prev?.id === id ? null : prev);
    setScreen('dashboard');
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      deviceId.current = await loadDeviceId();
      localIp.current = await getLocalIp();
      if (!mounted) return;
      setStatus(`Discovering backend... (${localIp.current})`);

      try {
        apiBaseRef.current = await getApiBase();
        setStatus(`Backend: ${apiBaseRef.current}`);
      } catch (e: any) { setStatus(`Discovery failed: ${e.message}`); }
      if (!mounted) return;

      try {
        const res = await fetch(`${apiBaseRef.current}/auth/guest`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
        });
        if (res.ok) {
          const data = await res.json();
          tokenRef.current = data.token;
          if (mounted) { setMode('guest'); setScreen('dashboard'); }
        } else {
          if (mounted) setScreen('login');
        }
      } catch {
        if (mounted) setScreen('login');
      }
    })();
    return () => { mounted = false; };
  }, []);

  const doHeartbeat = useCallback(async () => {
    const ip = await getLocalIp();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tokenRef.current) headers['Authorization'] = `Bearer ${tokenRef.current}`;
    try {
      const res = await fetch(`${apiBaseRef.current}/devices/heartbeat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ip, port: WS_PORT, pcName: `Mobile-${deviceId.current}`, primaryMac: deviceId.current, appVersion: '1.0.0', osVersion: `${Platform.OS} ${Platform.Version}`, online: true, type: 'mobile' }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.commands && Array.isArray(data.commands)) {
          for (const cmd of data.commands) {
            if (cmd.type === 'alert' && cmd.data) showAlert(cmd.data);
            else if (cmd.type === 'survey-campaign' && cmd.data) showSurvey(cmd.data);
            else if (cmd.type === 'it-news-update' && cmd.data) showNews(cmd.data);
            else if (cmd.type === 'it-news-remove') removeNews(cmd.data?.id || cmd.requestId);
          }
        }
      }
    } catch {}
  }, [showAlert, showSurvey, showNews, removeNews]);

  useEffect(() => {
    if (screen === 'dashboard' || screen === 'alert') {
      doHeartbeat();
      const hb = setInterval(doHeartbeat, HBEAT_MS);
      const clk = setInterval(() => setClock(new Date()), 1000);
      return () => { clearInterval(hb); clearInterval(clk); };
    }
  }, [screen, doHeartbeat]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextState) => {
      if (appStateRef.current.match(/inactive|background/) && nextState === 'active') {
        const pending = await checkPendingAlert();
        if (pending && screen !== 'alert') {
          showAlert(pending);
        }
      }
      appStateRef.current = nextState;
    });
    return () => sub.remove();
  }, [screen, showAlert]);

  const handleToggleMonitoring = useCallback(async () => {
    if (monitoring) {
      await stopBackgroundTask();
      setMonitoring(false);
    } else {
      await startBackgroundTask({
        apiBase: apiBaseRef.current,
        deviceId: deviceId.current,
        token: tokenRef.current || undefined,
      });
      setMonitoring(true);
    }
  }, [monitoring]);

  const handleLogout = useCallback(async () => {
    await stopBackgroundTask();
    setMonitoring(false);
    tokenRef.current = null;
    setMode(null);
    setUsername('');
    setPassword('');
    setScreen('login');
  }, []);

  const handleGuestLogin = useCallback(async () => {
    setLoginError('');
    try {
      const res = await fetch(`${apiBaseRef.current}/auth/guest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) { setLoginError(`Guest login failed (${res.status})`); return; }
      const data = await res.json();
      tokenRef.current = data.token;
      setMode('guest');
      setScreen('dashboard');
    } catch (e: any) { setLoginError(`Connection error: ${e.message}`); }
  }, []);

  const handleUserLogin = useCallback(async () => {
    setLoginError('');
    if (!username.trim() || !password.trim()) { setLoginError('Username and password required'); return; }
    try {
      const res = await fetch(`${apiBaseRef.current}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password: password.trim() }),
      });
      if (!res.ok) { setLoginError(`Login failed (${res.status})`); return; }
      const data = await res.json();
      tokenRef.current = data.accessToken;
      setMode('user');
      setScreen('dashboard');
    } catch (e: any) { setLoginError(`Connection error: ${e.message}`); }
  }, [username, password]);

  const handleAcknowledge = useCallback(async () => {
    if (!alert?.id) return;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tokenRef.current) headers['Authorization'] = `Bearer ${tokenRef.current}`;
      await fetch(`${apiBaseRef.current}/alerts/${alert.id}/ack`, {
        method: 'POST', headers,
        body: JSON.stringify({ deviceId: deviceId.current, acknowledgedBy: mode === 'user' ? username : 'guest' }),
      });
    } catch {}
    setAlert(null); setScreen('dashboard');
  }, [alert, mode, username]);

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
    const formatted = surveyData.survey.questions.map((q) => ({ questionId: q.id, value: answers[q.id] ?? null }));
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tokenRef.current) headers['Authorization'] = `Bearer ${tokenRef.current}`;
      await fetch(`${apiBaseRef.current}/survey/response`, {
        method: 'POST', headers,
        body: JSON.stringify({ surveyId: surveyData.survey.id, campaignId: surveyData.campaignId, answers: formatted, deviceId: deviceId.current }),
      });
    } catch {}
    setSurveySubmitted(true);
    Alert.alert('Submitted', 'Survey response submitted.');
    setTimeout(() => { setSurveyData(null); setSurveySubmitted(false); setScreen('dashboard'); }, 1500);
  }, [surveyData, answers, surveySubmitted]);

  const renderQuestion = (q: SurveyQuestion, idx: number) => {
    const answer = answers[q.id];
    if (!answer && q.type === 'yes_no') { /* no default */ }
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
              <TouchableOpacity key={opt} style={[styles.choiceBtn, answer === opt && styles.choiceSelected]} onPress={() => updateAnswer(q.id, opt)}><Text style={styles.choiceText}>{opt}</Text></TouchableOpacity>
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
            <TextInput style={styles.textAnswer} value={String(answer || '')} onChangeText={(v) => updateAnswer(q.id, v)} placeholder="Type your answer..." placeholderTextColor="#ffffff60" multiline />
          </View>
        );
      default: return null;
    }
  };

  if (screen === 'loading') {
    return (
      <View style={[styles.container, { backgroundColor: '#1a1a2e' }]}>
        <Text style={[styles.codeLabel, { color: '#ffffff80' }]}>AlertFlow</Text>
        <Text style={[styles.status, { color: '#ffffff60', marginTop: 20 }]}>{status}</Text>
      </View>
    );
  }

  if (screen === 'alert' && alert) {
    const bg = alert.color || '#d32f2f';
    const light = luminance(bg) > 0.6;
    const tc = light ? '#000' : '#fff';
    const location = alert.incidentLocation || alert.codeLocation || alert.locationName || '';
    const title = [alert.label || 'ALERT', location ? `in ${location}` : ''].join(' ');
    return (
      <View style={[styles.container, { backgroundColor: bg }]}>
        <StatusBar hidden />
        <Animated.View style={[styles.overlay, { transform: [{ scale: pulse }] }]}>
          <Text style={[styles.codeLabel, { color: tc }]}>{title}</Text>
          {alert.message ? <Text style={[styles.message, { color: tc }]}>{alert.message}</Text> : null}
          <TouchableOpacity style={[styles.ackBtn, { backgroundColor: light ? '#00000030' : '#ffffff30' }]} onPress={handleAcknowledge}><Text style={[styles.ackBtnText, { color: tc }]}>Acknowledge</Text></TouchableOpacity>
        </Animated.View>
      </View>
    );
  }

  if (screen === 'survey' && surveyData) {
    const survey = surveyData.survey;
    return (
      <View style={[styles.container, { backgroundColor: '#1a1a2e', paddingTop: 40 }]}>
        <StatusBar hidden />
        <ScrollView style={{ flex: 1, width: '100%' }} contentContainerStyle={{ padding: 20 }}>
          <Text style={[styles.codeLabel, { color: '#ffffffcc', fontSize: 28, marginBottom: 8 }]}>{survey.title}</Text>
          {survey.description && <Text style={{ color: '#ffffffa0', fontSize: 16, marginBottom: 20 }}>{survey.description}</Text>}
          {survey.questions.map((q, i) => renderQuestion(q, i))}
          {surveySubmitted ? (
            <Text style={{ color: '#4caf50', fontSize: 18, textAlign: 'center', marginTop: 20 }}>✓ Submitted</Text>
          ) : (
            <TouchableOpacity style={styles.submitBtn} onPress={submitSurvey}><Text style={styles.submitBtnText}>Submit</Text></TouchableOpacity>
          )}
        </ScrollView>
      </View>
    );
  }

  if (screen === 'news' && newsData) {
    const bg = newsData.backgroundColor || '#1a1a2e';
    const tc = newsData.textColor || '#fff';
    return (
      <View style={[styles.container, { backgroundColor: bg }]}>
        <StatusBar hidden />
        <View style={styles.newsCard}>
          <Text style={[styles.newsTitle, { color: tc }]}>{newsData.title}</Text>
          {newsData.body ? <Text style={[styles.newsBody, { color: tc + 'cc' }]}>{newsData.body}</Text> : null}
          <Text style={[styles.newsTimer, { color: tc + '60' }]}>Dismissing in {newsData.durationSec || 10}s</Text>
        </View>
      </View>
    );
  }

  if (screen === 'login') {
    return (
      <View style={[styles.container, { backgroundColor: '#1a1a2e' }]}>
        <StatusBar hidden />
        <Text style={[styles.codeLabel, { color: '#ffffffcc' }]}>AlertFlow</Text>
        <Text style={{ color: '#ffffff60', marginBottom: 30, fontSize: 16 }}>Sign in for full access</Text>
        <TextInput style={styles.input} placeholder="Username" placeholderTextColor="#ffffff60" value={username} onChangeText={setUsername} autoCapitalize="none" />
        <TextInput style={styles.input} placeholder="Password" placeholderTextColor="#ffffff60" value={password} onChangeText={setPassword} secureTextEntry />
        <TouchableOpacity style={styles.loginBtn} onPress={handleUserLogin}><Text style={styles.loginBtnText}>Sign In</Text></TouchableOpacity>
        <TouchableOpacity style={[styles.loginBtn, { backgroundColor: '#ffffff20', marginTop: 10 }]} onPress={handleGuestLogin}><Text style={[styles.loginBtnText, { color: '#ffffffb0' }]}>Continue as Guest</Text></TouchableOpacity>
        {loginError ? <Text style={styles.error}>{loginError}</Text> : null}
      </View>
    );
  }

  if (screen === 'dashboard') {
    const connected = mode !== null;
    const recentAlerts = alertHistory.slice(0, 10);
    return (
      <View style={[styles.container, { backgroundColor: '#1a1a2e', paddingTop: 50 }]}>
        <StatusBar hidden />
        <ScrollView style={{ flex: 1, width: '100%' }} contentContainerStyle={{ padding: 20 }}>
          <Text style={[styles.codeLabel, { color: '#ffffffcc', fontSize: 28, marginBottom: 4 }]}>AlertFlow</Text>
          <Text style={{ color: '#ffffff60', fontSize: 13, marginBottom: 24 }}>Monitoring Dashboard</Text>

          <View style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}><Text style={{ color: connected ? '#4caf50' : '#f44336', fontSize: 16 }}>●</Text> Connection</Text>
              <Text style={[styles.rowValue, { color: connected ? '#4caf50' : '#f44336' }]}>{connected ? 'Connected' : 'Disconnected'}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Device ID</Text>
              <Text style={[styles.rowValue, { fontFamily: 'monospace', fontSize: 11 }]}>{deviceId.current}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Backend</Text>
              <Text style={[styles.rowValue, { fontSize: 12 }]}>{apiBaseRef.current.replace('http://', '')}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Signed in as</Text>
              <Text style={styles.rowValue}>{mode === 'user' ? username : 'Guest'}</Text>
            </View>
          </View>

          <View style={[styles.card, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16 }]}>
            <View>
              <Text style={{ color: '#ffffffcc', fontSize: 14, fontWeight: '600' }}>⚡ Monitoring</Text>
              <Text style={{ color: '#ffffff60', fontSize: 11, marginTop: 2 }}>{monitoring ? 'Listening for alerts in background' : 'Tap to start listening'}</Text>
            </View>
            <TouchableOpacity
              style={[styles.toggleBtn, { backgroundColor: monitoring ? '#4caf50' : '#ffffff30' }]}
              onPress={handleToggleMonitoring}
            >
              <View style={[styles.toggleKnob, { left: monitoring ? 26 : 2 }]} />
            </TouchableOpacity>
          </View>

          <Text style={styles.sectionTitle}>Recent Alerts</Text>

          {recentAlerts.length === 0 ? (
            <Text style={{ color: '#ffffff40', fontSize: 13, textAlign: 'center', paddingVertical: 24 }}>No alerts received yet</Text>
          ) : (
            recentAlerts.map((item, idx) => {
              const loc = item.incidentLocation || item.codeLocation || item.locationName || '';
              const title = [item.label || 'Alert', loc ? `in ${loc}` : ''].join(' ');
              return (
                <View key={idx} style={styles.alertItem}>
                  <View style={[styles.alertDot, { backgroundColor: item.color || '#f44336' }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.alertTitle}>{title}</Text>
                    {item.message ? <Text style={styles.alertMeta}>{item.message}</Text> : null}
                  </View>
                </View>
              );
            })
          )}

          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
            <Text style={styles.logoutBtnText}>Logout</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: '#1a1a2e' }]}>
      <StatusBar hidden />
      <Text style={[styles.clock, { color: '#ffffff80' }]}>{clock.toLocaleTimeString()}</Text>
      <Text style={[styles.status, { color: '#ffffff40', marginTop: 10 }]}>Connected · {mode === 'user' ? username : 'Guest'}</Text>
    </View>
  );
}

const { width } = Dimensions.get('window');
const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  codeLabel: { fontSize: Math.min(72, width * 0.1), fontWeight: '800', textAlign: 'center' },
  codeName: { fontSize: Math.min(48, width * 0.07), fontWeight: '600', marginTop: 12, textAlign: 'center', opacity: 0.9 },
  location: { fontSize: Math.min(36, width * 0.05), marginTop: 24, fontWeight: '500', textAlign: 'center', opacity: 0.85 },
  message: { fontSize: Math.min(24, width * 0.035), marginTop: 16, textAlign: 'center', opacity: 0.75 },
  clock: { fontSize: Math.min(64, width * 0.09), fontWeight: '200' },
  status: { fontSize: 14, textAlign: 'center' },
  input: { width: '100%', maxWidth: 400, padding: 14, fontSize: 16, backgroundColor: '#ffffff15', borderRadius: 8, color: '#fff', marginBottom: 12, borderWidth: 1, borderColor: '#ffffff30' },
  loginBtn: { width: '100%', maxWidth: 400, padding: 14, borderRadius: 8, backgroundColor: '#3a7bd5', alignItems: 'center' },
  loginBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: '#ff6b6b', marginTop: 12, fontSize: 14, textAlign: 'center' },
  ackBtn: { paddingHorizontal: 40, paddingVertical: 14, borderRadius: 8, marginTop: 30 },
  ackBtnText: { fontSize: 20, fontWeight: '600' },
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
  newsCard: { margin: 20, padding: 24, borderRadius: 12, backgroundColor: '#ffffff15', borderWidth: 1, borderColor: '#ffffff30', maxWidth: 500, width: '100%' },
  newsTitle: { fontSize: 24, fontWeight: '700', marginBottom: 12, textAlign: 'center' },
  newsBody: { fontSize: 16, lineHeight: 24, textAlign: 'center' },
  newsTimer: { fontSize: 12, textAlign: 'center', marginTop: 16 },
  card: { backgroundColor: '#ffffff0d', borderWidth: 1, borderColor: '#ffffff15', borderRadius: 16, padding: 20, marginBottom: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  rowLabel: { color: '#ffffff80', fontSize: 13 },
  rowValue: { color: '#ffffffcc', fontSize: 13, fontWeight: '600' },
  toggleBtn: { width: 52, height: 28, borderRadius: 14, justifyContent: 'center', position: 'relative' },
  toggleKnob: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#fff', position: 'absolute', top: 2, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, elevation: 3 },
  sectionTitle: { color: '#ffffff80', fontSize: 14, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
  alertItem: { backgroundColor: '#ffffff0d', borderWidth: 1, borderColor: '#ffffff10', borderRadius: 12, padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 12 },
  alertDot: { width: 12, height: 12, borderRadius: 6, flexShrink: 0 },
  alertTitle: { color: '#ffffffcc', fontSize: 15, fontWeight: '600' },
  alertMeta: { color: '#ffffff60', fontSize: 12, marginTop: 2 },
  logoutBtn: { width: '100%', padding: 14, borderRadius: 12, borderWidth: 1, borderColor: '#ffffff20', alignItems: 'center', marginTop: 12 },
  logoutBtnText: { color: '#ffffff80', fontSize: 15, fontWeight: '600' },
});
