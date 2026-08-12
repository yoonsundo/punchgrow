const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:4001';
let memoryToken = '';

export type ServerCreature = {
  id: string; catalogId: string; level: number; experience: string; affection: number; uniqueColor: boolean;
};

export type ServerGameState = {
  tokenBalance: string;
  totalUsage: string;
  pityCount: number;
  weeklyUsage: Partial<Record<'claude_code' | 'codex', string>>;
  activityBoost: number;
  rarityWeights: Record<'PROCESS' | 'AGENT' | 'DAEMON' | 'ORACLE' | 'ARCHITECT' | 'ORIGIN', number>;
  creatures: ServerCreature[];
  items: Array<{ itemType: string; quantity: number }>;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await sessionToken();
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `API 오류 ${response.status}`);
  return value as T;
}

async function sessionToken() {
  const storage = (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;
  const persisted = storage?.getItem('punchgrow-session');
  if (persisted) return persisted;
  if (memoryToken) return memoryToken;
  const response = await fetch(`${API_URL}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new Error('세션을 만들 수 없습니다.');
  memoryToken = (await response.json() as { token: string }).token;
  storage?.setItem('punchgrow-session', memoryToken);
  return memoryToken;
}

export const mobileApi = {
  state: () => request<ServerGameState>('/api/game-state'),
  draw: () => request<{ creature: { id: string; catalogId: string; uniqueColor: boolean } }>('/api/gacha', {
    method: 'POST', body: JSON.stringify({ requestId: randomUUID() }),
  }),
  feed: (creatureId: string) => request('/api/inventory/use', {
    method: 'POST', body: JSON.stringify({ creatureId, itemType: 'food' }),
  }),
};

function randomUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 3) | 8).toString(16);
  });
}
