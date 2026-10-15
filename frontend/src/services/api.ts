import axios, { AxiosError } from 'axios';
import type { DocGroup, GeneratedFile, GenerateResult, GeneratorDoc, PartnerProfile, Preset, SavedPartner, TrafficPartner, Values } from '@/types/generator';
import { viewParam } from '@/utils/savedView';
import type { ActivityOverview, HealthReport } from '@/types/platform';
import type { AlertSub, AlertTrigger } from '@/types/alerts';
import type { AckPendingDoc, AckRule, AckRuleInput, AckRunResult, AckRunRow } from '@/types/ackRules';
import type { AssistantSettings, ChatStatus, Proposal } from '@/types/chat';
import type { TicketSyncStatus, TicketDetail, TicketLink, TicketPriority, TicketProvider, TicketSummary, TicketTransition, TicketingSettings } from '@/types/actions';
import type { Flow, FlowStep, IdentifierType, PartnerRow, TrackResult } from '@/types/flow';
import type {
  AdminTenant, CredentialKind, InviteResult, Member, MemberRole, QuarantineRow, RawEdiResponse, ReadinessCheck, Recipe, Summary, TenantAdminDetail,
  TransactionDetail, TransactionFilters, TransactionList, TrendDay, User, ViewPair,
} from '@/types';

/** What the generator endpoints take: a saved partner and/or the profile on screen, the document, and its values. */
export interface GeneratorRequest {
  docType: string;
  partnerId?: number | null;
  partner?: PartnerProfile;
  sender?: 'partner' | 'us';
  values?: Values;
  control?: { isa?: number; gs?: number; st?: string };
}

const client = axios.create({ baseURL: '/api', headers: { 'Content-Type': 'application/json' } });

client.interceptors.request.use((config) => {
  const token = localStorage.getItem('wk.token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

client.interceptors.response.use(
  (r) => r,
  (error: AxiosError) => {
    // A 401 anywhere except the login call itself means the session is gone
    if (error.response?.status === 401 && !error.config?.url?.includes('/auth/login')) {
      localStorage.removeItem('wk.token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

/** The server's own message when it sent one, else a generic fallback. */
export function errorMessage(error: unknown, fallback = 'Something went wrong'): string {
  const e = error as AxiosError<{ error?: string }>;
  return e?.response?.data?.error ?? e?.message ?? fallback;
}

/** Drops empty filters so they don't appear in the query string. */
function clean(params: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

/** My View narrows a browse, but not an explicit search or a hand-picked selection. */
const viewFor = (f: { q?: string; ids?: string }) => (f.q || f.ids ? undefined : viewParam());

const t = (tenantId: number) => `/tenants/${tenantId}`;

export const api = {
  // ---- auth
  async login(email: string, password: string): Promise<string> {
    const { data } = await client.post<{ token: string }>('/auth/login', { email, password });
    return data.token;
  },
  async me(): Promise<User> {
    const { data } = await client.get<{ user: User }>('/auth/me');
    return data.user;
  },

  // ---- reading
  async summary(tenantId: number, f: TransactionFilters = {}): Promise<Summary> {
    return (await client.get(`${t(tenantId)}/summary`, { params: clean({ ...f, limit: undefined, offset: undefined, status: undefined, view: viewFor(f) }) })).data;
  },
  async trend(tenantId: number, days: number, environment?: string): Promise<{ timezone: string; days: TrendDay[] }> {
    return (await client.get(`${t(tenantId)}/trend`, { params: clean({ days, environment, view: viewParam() }) })).data;
  },
  async transactions(tenantId: number, f: TransactionFilters = {}): Promise<TransactionList> {
    return (await client.get(`${t(tenantId)}/transactions`, { params: clean({ ...f, view: viewFor(f) }) })).data;
  },
  /** The filtered list (or a hand-picked selection) as a CSV Blob, ready to save. */
  async exportTransactionsCsv(tenantId: number, f: TransactionFilters = {}): Promise<Blob> {
    const res = await client.get(`${t(tenantId)}/export/transactions.csv`, { params: clean({ ...f, limit: undefined, offset: undefined, view: viewFor(f) }), responseType: 'blob' });
    return res.data as Blob;
  },
  async transaction(tenantId: number, id: number): Promise<TransactionDetail> {
    return (await client.get(`${t(tenantId)}/transactions/${id}`)).data;
  },

  // ---- raw EDI
  async rawEdi(tenantId: number, id: number): Promise<RawEdiResponse> {
    return (await client.get(`${t(tenantId)}/transactions/${id}/raw-edi`)).data;
  },
  async refreshOrderfulStatus(tenantId: number, id: number): Promise<{ result: 'updated' | 'unchanged' }> {
    return (await client.post(`${t(tenantId)}/transactions/${id}/orderful-status/refresh`)).data;
  },
  async convertRawEdi(tenantId: number, id: number): Promise<{ result: string; error: string | null }> {
    return (await client.post(`${t(tenantId)}/transactions/${id}/raw-edi/convert`)).data;
  },

  // ---- recipes
  /** The user guide PDF, fetched with the signed-in session. */
  async userGuide(): Promise<Blob> {
    return (await client.get('/help/user-guide.pdf', { responseType: 'blob' })).data;
  },
  async recipes(tenantId: number): Promise<Recipe[]> {
    return (await client.get(`${t(tenantId)}/recipes`)).data.recipes;
  },
  async saveRecipe(tenantId: number, recipeId: string, body: Partial<Pick<Recipe, 'direction' | 'document_type' | 'is_active' | 'ingest_mode'>>) {
    return (await client.put(`${t(tenantId)}/recipes/${recipeId}`, body)).data as { recipe: Recipe; renormalizing: number };
  },

  // ---- admin
  async adminTenants(): Promise<AdminTenant[]> {
    return (await client.get('/admin/tenants')).data.tenants;
  },
  async createTenant(body: { name: string; slug: string; timezone?: string; source_mode?: string; workato_account_id?: string }): Promise<AdminTenant> {
    return (await client.post('/admin/tenants', body)).data.tenant;
  },
  async adminTenant(tenantId: number): Promise<TenantAdminDetail> {
    return (await client.get(`/admin/tenants/${tenantId}`)).data;
  },
  async updateTenant(tenantId: number, body: Record<string, unknown>): Promise<AdminTenant> {
    return (await client.patch(`/admin/tenants/${tenantId}`, body)).data.tenant;
  },
  async setTenantStatus(tenantId: number, status: string): Promise<void> {
    await client.post(`/admin/tenants/${tenantId}/status`, { status });
  },
  async readiness(tenantId: number): Promise<{ ok: boolean; checks: ReadinessCheck[] }> {
    return (await client.post(`/admin/tenants/${tenantId}/readiness`)).data;
  },
  async setCredential(tenantId: number, kind: CredentialKind, secret: string, extra?: { senderEmail?: string }) {
    return (await client.put(`/admin/tenants/${tenantId}/credentials/${kind}`, { secret, extra })).data;
  },
  /** The organisation id behind "Open in Orderful" links; the API key is not needed again. */
  async setOrderfulOrganisation(tenantId: number, viewAs: string) {
    return (await client.put(`/admin/tenants/${tenantId}/credentials/orderful`, { extra: { viewAs } })).data;
  },
  async createApiKey(tenantId: number, name: string, scope: 'ingest' | 'mcp' = 'ingest'): Promise<{ apiKey: string; id: string; key_prefix: string; scope: 'ingest' | 'mcp' }> {
    return (await client.post(`/admin/tenants/${tenantId}/api-keys`, { name, scope })).data;
  },
  async revokeApiKey(tenantId: number, keyId: string): Promise<void> {
    await client.delete(`/admin/tenants/${tenantId}/api-keys/${keyId}`);
  },
  // ---- members
  async members(tenantId: number): Promise<{ members: Member[]; roles: { role: MemberRole; description: string }[]; emailConfigured: boolean }> {
    return (await client.get(`/admin/tenants/${tenantId}/members`)).data;
  },
  async addMember(tenantId: number, body: { email: string; role: MemberRole; firstName?: string; lastName?: string }): Promise<InviteResult & { member: Member }> {
    return (await client.post(`/admin/tenants/${tenantId}/members`, body)).data;
  },
  async updateMember(tenantId: number, userId: string, body: { role?: MemberRole; isActive?: boolean }): Promise<Member> {
    return (await client.patch(`/admin/tenants/${tenantId}/members/${userId}`, body)).data.member;
  },
  async inviteMember(tenantId: number, userId: string): Promise<InviteResult> {
    return (await client.post(`/admin/tenants/${tenantId}/members/${userId}/invite`)).data;
  },

  // ---- invitation links (public: the person has no account yet)
  async inviteInfo(token: string): Promise<{ email: string; firstName: string | null; tenantName: string }> {
    return (await client.get(`/auth/invite/${encodeURIComponent(token)}`)).data;
  },
  async acceptInvite(token: string, password: string): Promise<string> {
    return (await client.post('/auth/accept-invite', { token, password })).data.token;
  },

  async saveMyView(savedView: ViewPair[]): Promise<ViewPair[]> {
    return (await client.put('/auth/me/saved-view', { savedView })).data.savedView;
  },

  // ---- tickets and emailed reports about documents
  async ticketingStatus(tenantId: number): Promise<{ provider: TicketProvider | null }> {
    return (await client.get(`${t(tenantId)}/actions/ticketing`)).data;
  },
  async createTicket(tenantId: number, body: { transactionIds: number[]; reason: string; priority: TicketPriority; summary?: string }): Promise<{ id: number; provider: TicketProvider; key: string; url: string }> {
    return (await client.post(`${t(tenantId)}/actions/tickets`, body)).data;
  },
  // ---- assistant
  async chatStatus(tenantId: number): Promise<ChatStatus> {
    return (await client.get(`${t(tenantId)}/chat/status`)).data;
  },
  async chat(tenantId: number, messages: { role: 'user' | 'assistant'; text: string }[]): Promise<{ reply: string; proposals: Proposal[] }> {
    return (await client.post(`${t(tenantId)}/chat`, { messages }, { timeout: 90_000 })).data;
  },
  async assistantSettings(tenantId: number): Promise<AssistantSettings> {
    return (await client.get(`/admin/tenants/${tenantId}/assistant`)).data;
  },
  async saveAssistantSettings(tenantId: number, body: { enabled: boolean; dailyLimit: number | null; provider: 'gemini' | 'openai' | 'anthropic'; model: string | null }): Promise<void> {
    await client.put(`/admin/tenants/${tenantId}/assistant`, body);
  },
  async ticketSyncStatus(tenantId: number): Promise<TicketSyncStatus> {
    return (await client.get(`/admin/tenants/${tenantId}/ticketing/sync`)).data;
  },
  async syncTicketsNow(tenantId: number): Promise<TicketSyncStatus & { checked: number; failed: number }> {
    return (await client.post(`/admin/tenants/${tenantId}/ticketing/sync`, {}, { timeout: 120_000 })).data;
  },
  async tickets(tenantId: number, openOnly = false): Promise<TicketSummary[]> {
    return (await client.get(`${t(tenantId)}/actions/tickets`, { params: openOnly ? { state: 'open' } : undefined })).data.tickets;
  },
  async ticket(tenantId: number, id: number, refresh = false): Promise<TicketDetail> {
    return (await client.get(`${t(tenantId)}/actions/tickets/${id}`, { params: refresh ? { refresh: 1 } : undefined, timeout: 60_000 })).data;
  },
  async refreshTicket(tenantId: number, id: number): Promise<TicketDetail> {
    return (await client.post(`${t(tenantId)}/actions/tickets/${id}/refresh`, {}, { timeout: 60_000 })).data;
  },
  async commentOnTicket(tenantId: number, id: number, body: string): Promise<TicketDetail> {
    return (await client.post(`${t(tenantId)}/actions/tickets/${id}/comments`, { body }, { timeout: 60_000 })).data;
  },
  async ticketTransitions(tenantId: number, id: number): Promise<{ transitions: TicketTransition[]; canChange: boolean }> {
    return (await client.get(`${t(tenantId)}/actions/tickets/${id}/transitions`)).data;
  },
  async transitionTicket(tenantId: number, id: number, transitionId: string): Promise<TicketDetail> {
    return (await client.post(`${t(tenantId)}/actions/tickets/${id}/transition`, { transitionId }, { timeout: 60_000 })).data;
  },
  async transactionTickets(tenantId: number, id: number): Promise<TicketLink[]> {
    return (await client.get(`${t(tenantId)}/actions/transactions/${id}/tickets`)).data.tickets;
  },
  async emailReport(tenantId: number, body: { transactionIds: number[]; to: string[]; subject: string; note?: string }): Promise<{ status: string; sent: number; failed: { to: string; error?: string }[] }> {
    return (await client.post(`${t(tenantId)}/actions/reports/email`, body)).data;
  },
  async ticketingSettings(tenantId: number): Promise<TicketingSettings> {
    return (await client.get(`/admin/tenants/${tenantId}/ticketing`)).data;
  },
  async saveTicketing(tenantId: number, body: Record<string, unknown>): Promise<{ provider: TicketProvider | null }> {
    return (await client.put(`/admin/tenants/${tenantId}/ticketing`, body)).data;
  },
  async testTicketing(tenantId: number): Promise<{ ok: boolean; detail: string }> {
    return (await client.post(`/admin/tenants/${tenantId}/ticketing/test`)).data;
  },

  // ---- platform admin: health and the API description
  async platformHealth(): Promise<HealthReport> {
    return (await client.get('/platform/health')).data;
  },
  async platformActivity(): Promise<ActivityOverview> {
    return (await client.get('/platform/activity')).data;
  },
  async openApiSpec(): Promise<object> {
    return (await client.get('/platform/openapi.json')).data;
  },

  // ---- 997 reminder rules
  async ackRules(tenantId: number): Promise<{ emailConfigured: boolean; timezone: string; rules: AckRule[] }> {
    return (await client.get(`${t(tenantId)}/ack-rules`)).data;
  },
  async saveAckRule(tenantId: number, id: number | null, body: AckRuleInput): Promise<AckRule> {
    return (id ? await client.put(`${t(tenantId)}/ack-rules/${id}`, body) : await client.post(`${t(tenantId)}/ack-rules`, body)).data;
  },
  async toggleAckRule(tenantId: number, id: number, isActive: boolean): Promise<void> {
    await client.patch(`${t(tenantId)}/ack-rules/${id}`, { isActive });
  },
  async deleteAckRule(tenantId: number, id: number): Promise<void> {
    await client.delete(`${t(tenantId)}/ack-rules/${id}`);
  },
  async previewAckRule(tenantId: number, id: number): Promise<{ total: number; documents: AckPendingDoc[] }> {
    return (await client.get(`${t(tenantId)}/ack-rules/${id}/preview`)).data;
  },
  async ackRuleRuns(tenantId: number, id: number): Promise<AckRunRow[]> {
    return (await client.get(`${t(tenantId)}/ack-rules/${id}/runs`)).data;
  },
  async runAckRule(tenantId: number, id: number): Promise<AckRunResult> {
    return (await client.post(`${t(tenantId)}/ack-rules/${id}/run`, {}, { timeout: 120_000 })).data;
  },

  // ---- explain EDI and email alerts
  async explainEdi(tenantId: number, id: number, language: string, refresh = false): Promise<{ html: string; language: string; cached: boolean; model: string | null; createdAt: string }> {
    return (await client.get(`${t(tenantId)}/transactions/${id}/explain`, { params: clean({ language, refresh: refresh ? 1 : undefined }), timeout: 90_000 })).data;
  },
  async alerts(tenantId: number): Promise<{ emailConfigured: boolean; subscriptions: AlertSub[] }> {
    return (await client.get(`${t(tenantId)}/alerts`)).data;
  },
  async createAlert(tenantId: number, body: { partnerId: string | null; documentType: string | null; trigger: AlertTrigger }): Promise<AlertSub> {
    return (await client.post(`${t(tenantId)}/alerts`, body)).data;
  },
  async updateAlert(tenantId: number, id: number, body: { isActive?: boolean; trigger?: AlertTrigger }): Promise<void> {
    await client.patch(`${t(tenantId)}/alerts/${id}`, body);
  },
  async deleteAlert(tenantId: number, id: number): Promise<void> {
    await client.delete(`${t(tenantId)}/alerts/${id}`);
  },
  async testAlertEmail(tenantId: number): Promise<{ sent: boolean; to?: string; error?: string }> {
    return (await client.post(`${t(tenantId)}/alerts/test`)).data;
  },

  // ---- partners, flows, tracking
  async partners(tenantId: number): Promise<PartnerRow[]> {
    return (await client.get(`${t(tenantId)}/partners`)).data.partners;
  },
  async savePartnerSettings(tenantId: number, partnerId: string, body: { trackInboundAck?: boolean; expectOutboundAck?: boolean }) {
    return (await client.put(`${t(tenantId)}/partners/${encodeURIComponent(partnerId)}/settings`, body)).data;
  },
  async partnerFlows(tenantId: number, partnerId: string): Promise<Flow[]> {
    return (await client.get(`${t(tenantId)}/partners/${encodeURIComponent(partnerId)}/flows`)).data.flows;
  },
  async saveFlow(tenantId: number, partnerId: string, flow: { id?: number; name: string; steps: FlowStep[] }): Promise<Flow> {
    const base = `${t(tenantId)}/partners/${encodeURIComponent(partnerId)}/flows`;
    return (flow.id ? await client.put(`${base}/${flow.id}`, flow) : await client.post(base, flow)).data;
  },
  async deleteFlow(tenantId: number, partnerId: string, id: number): Promise<void> {
    await client.delete(`${t(tenantId)}/partners/${encodeURIComponent(partnerId)}/flows/${id}`);
  },
  async trackFlow(tenantId: number, body: { partnerId: string; identifierType: IdentifierType; value: string; flowId?: number }): Promise<TrackResult> {
    return (await client.post(`${t(tenantId)}/partners/track`, body)).data;
  },

  // ---- test EDI generator
  async generatorDocs(tenantId: number): Promise<{ groups: DocGroup[]; docs: GeneratorDoc[] }> {
    return (await client.get(`${t(tenantId)}/generator/doc-types`)).data;
  },
  async generatorPresets(tenantId: number): Promise<Preset[]> {
    return (await client.get(`${t(tenantId)}/generator/presets`)).data.presets;
  },
  async generatorTrafficPartners(tenantId: number): Promise<TrafficPartner[]> {
    return (await client.get(`${t(tenantId)}/generator/traffic-partners`)).data.partners;
  },
  async generatorPartners(tenantId: number): Promise<SavedPartner[]> {
    return (await client.get(`${t(tenantId)}/generator/partners`)).data.partners;
  },
  async createGeneratorPartner(tenantId: number, partner: PartnerProfile): Promise<{ id: number; partner: PartnerProfile }> {
    return (await client.post(`${t(tenantId)}/generator/partners`, { partner })).data;
  },
  async updateGeneratorPartner(tenantId: number, id: number, partner: PartnerProfile, isaControlNext?: number): Promise<{ id: number; partner: PartnerProfile }> {
    return (await client.put(`${t(tenantId)}/generator/partners/${id}`, { partner, isaControlNext })).data;
  },
  async deleteGeneratorPartner(tenantId: number, id: number): Promise<void> {
    await client.delete(`${t(tenantId)}/generator/partners/${id}`);
  },
  async generatorDefaults(tenantId: number, body: GeneratorRequest): Promise<{ sender: 'partner' | 'us'; values: Values }> {
    return (await client.post(`${t(tenantId)}/generator/defaults`, body)).data;
  },
  async generatorPreview(tenantId: number, body: GeneratorRequest): Promise<GenerateResult> {
    return (await client.post(`${t(tenantId)}/generator/preview`, body)).data;
  },
  /** Builds the file for real: takes the partner's next control numbers and records it in the history. */
  async generateFile(tenantId: number, body: GeneratorRequest): Promise<GenerateResult> {
    return (await client.post(`${t(tenantId)}/generator/generate`, body)).data;
  },
  async generatorHistory(tenantId: number): Promise<GeneratedFile[]> {
    return (await client.get(`${t(tenantId)}/generator/history`)).data.files;
  },
  async downloadGenerated(tenantId: number, id: number): Promise<Blob> {
    return (await client.get(`${t(tenantId)}/generator/history/${id}/download`, { responseType: 'blob' })).data as Blob;
  },

  async quarantine(tenantId: number): Promise<QuarantineRow[]> {
    return (await client.get(`/admin/tenants/${tenantId}/quarantine`)).data.quarantine;
  },
};
