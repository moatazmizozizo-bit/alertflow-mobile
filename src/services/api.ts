import { getApiBase } from './config';

export interface AlertEntity {
  id: string;
  code: string;
  label: string;
  color: string;
  message: string | null | undefined;
  createdBy: string | null | undefined;
  incidentLocation: string | null | undefined;
  targetMode: string | null | undefined;
  targetLocationName: string | null | undefined;
  targetGroupId: string | null | undefined;
  targetDeviceCount: number | null | undefined;
  status: string | null | undefined;
  createdAt: Date;
}

export interface AgentNewsEntity {
  id: string;
  title: string;
  body: string | null | undefined;
  priority: number;
  startAt: Date | null | undefined;
  endAt: Date | null | undefined;
  isActive: boolean;
  type: string;
  durationSec: number;
  opacity: number;
  backgroundColor: string | null | undefined;
  textColor: string | null | undefined;
  createdBy: string | null | undefined;
  createdAt: Date;
  updatedAt: Date;
}

export interface SurveyCampaignEntity {
  id: string;
  surveyId: string;
  targetMode: string;
  locationName: string | null;
  groupId: string | null;
  status: string;
  createdBy: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  surveyTitle?: string;
  responseCount?: number;
}

export interface CodeEntity {
  id: string;
  code: string;
  label: string;
  color: string;
  soundFileName: string | null | undefined;
  defaultMessage: string | null | undefined;
  voiceGender: string;
  isActive: boolean;
  sortOrder: number;
}

export interface SurveyEntityFull {
  id: string;
  title: string;
  description: string | null;
  isAnonymous: boolean;
  allowMultipleSubmissions: boolean;
  expiresAt: string | null;
  questions: SurveyQuestionDto[];
}

export interface SurveyQuestionDto {
  id: string;
  orderNo: number;
  type: 'single_choice' | 'multiple_choice' | 'rating' | 'text' | 'yes_no';
  text: string;
  isRequired: boolean;
  options: string[];
  scoreValue: number;
}

function authHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export async function loginApi(base: string, username: string, password: string): Promise<{ accessToken: string }> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const msg = res.status === 401 ? 'Invalid username or password.' : `Login failed (${res.status})`;
    throw new Error(msg);
  }
  return res.json();
}

export async function getAlertsApi(base: string, token: string, limit = 200): Promise<AlertEntity[]> {
  const res = await fetch(`${base}/alerts?limit=${limit}`, { headers: authHeaders(token) });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`Failed to fetch alerts: ${res.status}`);
  return res.json();
}

export async function getNewsApi(base: string, token: string): Promise<AgentNewsEntity[]> {
  const res = await fetch(`${base}/it/news`, { headers: authHeaders(token) });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`Failed to fetch news: ${res.status}`);
  return res.json();
}

export async function getCampaignsApi(base: string, token: string, limit = 50): Promise<SurveyCampaignEntity[]> {
  const res = await fetch(`${base}/survey/campaigns?limit=${limit}`, { headers: authHeaders(token) });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`Failed to fetch campaigns: ${res.status}`);
  return res.json();
}

export async function getSurveyApi(base: string, token: string, surveyId: string): Promise<SurveyEntityFull> {
  const res = await fetch(`${base}/survey/surveys/${surveyId}`, { headers: authHeaders(token) });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`Failed to fetch survey: ${res.status}`);
  return res.json();
}

export async function getCodesApi(base: string, token: string): Promise<CodeEntity[]> {
  const res = await fetch(`${base}/codes`, { headers: authHeaders(token) });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`Failed to fetch codes: ${res.status}`);
  return res.json();
}

export async function ackAlertApi(base: string, token: string, alertId: string, deviceId: string, acknowledgedBy: string): Promise<void> {
  const res = await fetch(`${base}/alerts/${alertId}/ack`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ deviceId, acknowledgedBy }),
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`Ack failed: ${res.status}`);
}

export async function submitSurveyApi(
  base: string, token: string,
  surveyId: string, campaignId: string, answers: { questionId: string; value: string | string[] | number | null }[],
  deviceId: string,
): Promise<void> {
  const res = await fetch(`${base}/survey/response`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ surveyId, campaignId, answers, deviceId }),
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`Survey submission failed: ${res.status}`);
}

export async function heartbeatApi(base: string, token: string | null, body: Record<string, unknown>): Promise<{ commands?: any[] } | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}/devices/heartbeat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return res.json();
}
