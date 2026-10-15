export type TicketPriority = 'critical' | 'high' | 'medium' | 'low';
export type TicketProvider = 'jira' | 'servicenow';

/** A document picked for a ticket or an emailed report: just enough to name it in the dialog. */
export interface PickedDoc {
  id: number;
  type: string | null;
  number: string | null;
  status: string;
}

export interface TicketLink {
  status?: string | null;
  status_category?: StatusCategory | null;
  id: number;
  provider: TicketProvider;
  external_key: string;
  external_url: string | null;
  priority: TicketPriority;
  created_at: string;
}

/** The ticket connection an admin saved (never the secret). */
export interface TicketingSettings {
  provider: TicketProvider | null;
  connections: {
    jira?: { baseUrl: string; email: string; projectKey: string; issueType: string; priorityNames?: Record<TicketPriority, string>; secretHint?: string | null };
    servicenow?: { baseUrl: string; username: string; category?: string; assignmentGroup?: string; secretHint?: string | null };
  };
}

export type StatusCategory = 'open' | 'in_progress' | 'done';

/** A ticket raised from the portal, as last read from Jira or ServiceNow. */
export interface TicketSummary {
  id: number;
  provider: TicketProvider;
  external_key: string;
  external_url: string | null;
  summary: string;
  priority: TicketPriority;
  external_priority: string | null;
  status: string | null;
  status_category: StatusCategory | null;
  assignee: string | null;
  external_updated_at: string | null;
  synced_at: string | null;
  sync_error: string | null;
  created_at: string;
  created_by_name: string | null;
  documents: { id: number; type: string | null; number: string | null; status?: string }[];
}

export interface TicketComment {
  id: number;
  author: string | null;
  body: string;
  /** portal = written here by a portal user; external = written in the ticket system */
  source: 'portal' | 'external';
  created_at: string;
}

export interface TicketDetail extends TicketSummary {
  reason: string;
  comments: TicketComment[];
}

export interface TicketTransition {
  id: string;
  name: string;
  to: string;
  category: StatusCategory;
}

/** How ticket syncing is going for a tenant. */
export interface TicketSyncStatus {
  tracked: number;
  open: number;
  finished: number;
  failing: number;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  recentErrors: { key: string; error: string; at: string | null }[];
  worker: { running: boolean; lastRunAt: string | null; lastError: string | null };
}
