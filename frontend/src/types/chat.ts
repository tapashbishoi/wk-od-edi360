import type { AiUse } from '@/utils/aiCost';
export type ProposalKind = 'create_997_rule' | 'create_ticket' | 'send_report' | 'comment_ticket';

/** An action the assistant prepared. Nothing has happened until the person presses Confirm. */
export interface Proposal {
  id: string;
  kind: ProposalKind;
  title: string;
  details: [string, string][];
  /** What the normal portal API is called with on Confirm */
  payload: Record<string, any>;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  proposals?: Proposal[];
  /** Cards already confirmed or cancelled, by id */
  settled?: Record<string, { ok: boolean; text: string; link?: { to: string; label: string } } | 'cancelled'>;
  error?: boolean;
}

export interface ChatStatus {
  enabled: boolean;
  configured: boolean;
  provider?: string;
  model?: string;
  dailyLimit: number;
  usedToday: number;
}

export interface AssistantSettings {
  enabled: boolean;
  dailyLimit: number | null;
  defaultLimit: number;
  usedToday: number;
  provider: 'gemini' | 'openai' | 'anthropic';
  model: string | null;
  usage30d: { chat: AiUse; explain: AiUse };
  providers: { id: 'gemini' | 'openai' | 'anthropic'; label: string; defaultModel: string; models: string[]; hasKey: boolean; keyHint: string | null }[];
}
