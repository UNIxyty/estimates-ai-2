/** Shapes shared by the chat components (GET /api/conversations/{id} + run events, docs/ARCHITECTURE.md). */

/**
 * Message parts written by the worker (worker/app/agent/common.py, qa.py, cards.py):
 *  {type:'text', text}
 *  {type:'chip', kind:'row', document_id, sheet, row, label}          → row chip "EL · row 58"
 *  {type:'chip', kind:'file', file_id, label, sheet?, row?}           → file chip (knowledge file)
 *  {type:'card', card_id}                                             → inline card
 */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'chip'; kind: 'row'; document_id: string; sheet: string | null; row: number; label?: string }
  | { type: 'chip'; kind: 'file'; file_id: string; label?: string; sheet?: string | null; row?: number | null }
  | { type: 'card'; card_id: string }
  | { type: string; [k: string]: unknown };

export interface ChatMessage {
  id: string;
  run_id: string | null;
  role: 'user' | 'assistant';
  content: string;
  parts: Part[];
  attachment_ids?: string[];
  reference_ids?: string[];
  tier?: string | null;
  model_id?: string | null;
  cost_usd?: number | null;
  tokens?: { input?: number; output?: number } | null;
  created_at: string;
  streaming?: boolean;
}

export interface Card {
  id: string;
  run_id: string;
  conversation_id: string;
  message_id: string | null;
  kind: string;
  status: string;
  payload: any;
  decision: any;
  decided_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at?: string;
}

export interface Step {
  step_id: string;
  label: string;
  done?: number | null;
  total?: number | null;
  current?: string | null;
  state: 'running' | 'done';
  summary?: string | null;
  warns: { message: string; rows?: { sheet: string; row: number; label: string }[] }[];
  /** ms timestamps (server event time after a reload, client time live). */
  startedAt: number;
  endedAt?: number;
}

export interface LiveRun {
  id: string;
  status: string;
  error?: string;
  steps: Record<string, Step>;
  stepOrder: string[];
  cost?: number;
  connection: 'connecting' | 'open' | 'closed' | 'error' | 'none';
  /** Live `agent.state` (thinking / searching); cleared on idle and when the run stops. */
  activity?: { state: string; tier?: string; task?: string; query?: string; since: number };
  /** While queued: GET /api/runs/{id}/queue. */
  queue?: { ahead: number; running: number };
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface Doc {
  id: string;
  run_id?: string | null;
  name: string;
  mode?: string;
  language?: string | null;
  currency?: string | null;
  totals?: any;
  version?: number;
  created_at?: string;
  updated_at?: string | null;
}

export interface UploadRef { id: string; original_name: string; ext?: string; size_bytes?: number }
export interface FileRef { id: string; original_name: string; ext?: string; tag?: string; language?: string | null; status?: string }

export const TERMINAL = ['done', 'failed', 'cancelled'];
export const BLOCKING = ['queued', 'running'];
