import { useState } from 'react';
import { Card } from '@/components/ui';
import CopyButton from '@/components/CopyButton';
import type { ChannelStats, Endpoints } from '@/types';

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

function Endpoint({ label, value, method }: { label: string; value: string; method?: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <div className="mt-1 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
        {method && <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[11px] font-bold text-white">{method}</span>}
        <code className="min-w-0 flex-1 break-all text-sm text-gray-900" data-testid="endpoint-url">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

function Traffic({ s, what }: { s: ChannelStats; what: string }) {
  const bad = s.errors24h > 0;
  return (
    <div className="space-y-1 text-sm">
      <p className="text-gray-700">
        Last {what}: <span className="font-medium">{ago(s.lastAt)}</span> · last 24 h: <span className="font-medium">{s.calls24h}</span> request{s.calls24h === 1 ? '' : 's'}
        {bad && <span className="ml-1 font-medium text-amber-700">· {s.errors24h} failed</span>}
      </p>
      {s.lastError && (
        <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">
          Latest problem {ago(s.lastError.at)}{s.lastError.httpStatus ? ` (HTTP ${s.lastError.httpStatus})` : ''}: {s.lastError.detail ?? 'no detail'}
        </p>
      )}
    </div>
  );
}

const UrlNote = ({ fromEnv }: { fromEnv: boolean }) => (
  <p className="text-xs text-gray-500">
    {fromEnv
      ? 'This address is set on the server (PUBLIC_API_URL).'
      : 'Shown from the address you are using now. On a server, set PUBLIC_API_URL if Workato must reach a different address.'}
  </p>
);

/** Where Workato sends job logs, for a tenant that pushes. Follows wherever this is deployed. */
export function IngestEndpointCard({ endpoints, stats, sourceMode }: { endpoints: Endpoints; stats: ChannelStats; sourceMode: string }) {
  if (sourceMode !== 'push') {
    return (
      <Card title="Workato ingestion endpoint" className="lg:col-span-2">
        <p className="text-sm text-gray-600">This organisation's source mode is <strong>{sourceMode}</strong>, so EDI360 fetches logs itself and Workato does not need to push anything. The endpoint appears here when the source mode is push.</p>
      </Card>
    );
  }
  const curl = `curl -X POST '${endpoints.ingestUrl}' \\\n  -H 'x-api-key: <your ingestion key>' \\\n  -H 'Content-Type: application/json' \\\n  -d @job-log.json`;
  return (
    <Card title="Workato ingestion endpoint" className="lg:col-span-2">
      <div className="space-y-3">
        <p className="text-sm text-gray-600">Point the Workato recipe's HTTP action at this address and send the key below in the <code>x-api-key</code> header. One job log, a list of them, or <code>{'{"events": [...]}'}</code>.</p>
        <Endpoint label="Endpoint" value={endpoints.ingestUrl} method="POST" />
        <UrlNote fromEnv={endpoints.urlFromEnv} />
        <Traffic s={stats} what="log received" />
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-blue-700">Example request</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">{curl}</pre>
          <div className="mt-1"><CopyButton value={curl} /></div>
        </details>
      </div>
    </Card>
  );
}

const KEY = '<your MCP key>';

/** Setup text for each AI tool, filled in with this deployment's address. */
export function mcpSnippets(url: string) {
  return {
    'Claude Code': {
      lang: 'Run in a terminal',
      text: `claude mcp add --transport http edi360 ${url} --header "Authorization: Bearer ${KEY}"`,
      note: 'Then ask Claude Code about your EDI documents. /mcp shows the connection.',
    },
    'Claude Desktop': {
      lang: 'claude_desktop_config.json',
      text: JSON.stringify({ mcpServers: { edi360: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${EDI360_AUTH}'], env: { EDI360_AUTH: `Bearer ${KEY}` } } } }, null, 2),
      note: 'Needs Node.js. Restart Claude Desktop after saving. (The Connectors screen cannot send a custom key, so this uses the mcp-remote bridge.)',
    },
    'Gemini CLI': {
      lang: '~/.gemini/settings.json',
      text: JSON.stringify({ mcpServers: { edi360: { httpUrl: url, headers: { Authorization: `Bearer ${KEY}` } } } }, null, 2),
      note: 'Restart Gemini CLI, then /mcp lists the EDI360 tools.',
    },
    'Other client': {
      lang: 'Generic MCP settings',
      text: JSON.stringify({ mcpServers: { edi360: { url, headers: { Authorization: `Bearer ${KEY}` } } } }, null, 2),
      note: 'Any client that supports remote (Streamable HTTP) MCP servers with a custom header. Setting names vary; the address and header are what matter.',
    },
  } as const;
}

/** Read-only access for AI tools (MCP clients), with its own keys, and the setup for the common ones. */
export function McpAccessCard({ endpoints, stats }: { endpoints: Endpoints; stats: ChannelStats }) {
  const snippets = mcpSnippets(endpoints.mcpUrl);
  const names = Object.keys(snippets) as (keyof ReturnType<typeof mcpSnippets>)[];
  const [tool, setTool] = useState<(typeof names)[number]>('Claude Code');
  const sn = snippets[tool];
  const test = `curl -X POST '${endpoints.mcpUrl}' \\\n  -H 'Authorization: Bearer ${KEY}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
  return (
    <Card title="MCP access (AI tools)" className="lg:col-span-2">
      <div className="space-y-3">
        <p className="text-sm text-gray-600">Lets an AI assistant such as Claude or Gemini look up this organisation's documents, 997 status, partners, tickets and rules. <strong>Read only</strong>: it cannot create, send or change anything. Create an <strong>MCP key</strong> below and put it where it says <code>{KEY}</code>. An ingestion key will not work here.</p>
        {!endpoints.mcpEnabled && <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">The MCP server is switched off on this platform (MCP_ENABLED=false).</p>}
        <Endpoint label="MCP endpoint" value={endpoints.mcpUrl} method="POST" />
        <UrlNote fromEnv={endpoints.urlFromEnv} />
        <Traffic s={stats} what="call" />

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Connect your AI tool</p>
          <div role="tablist" aria-label="AI tool" className="mt-1 flex flex-wrap gap-1 border-b border-gray-200">
            {names.map((n) => (
              <button key={n} role="tab" type="button" aria-selected={tool === n} onClick={() => setTool(n)}
                className={`border-b-2 px-3 py-1.5 text-sm font-medium ${tool === n ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>{n}</button>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-500">{sn.lang}</p>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100" data-testid="mcp-snippet">{sn.text}</pre>
          <div className="mt-1 flex items-center gap-2"><CopyButton value={sn.text} /><span className="text-xs text-gray-500">{sn.note}</span></div>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-blue-700">Test the connection from a terminal</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">{test}</pre>
          <div className="mt-1 flex items-center gap-2"><CopyButton value={test} /><span className="text-xs text-gray-500">Returns the list of tools. A 401 means the key is wrong or is an ingestion key.</span></div>
        </details>
        <p className="text-xs text-gray-500">Tools offered: find documents, get a document, pending 997s, list partners, list tickets, list 997 rules. Each call is limited to this organisation and appears in the activity shown above.</p>
      </div>
    </Card>
  );
}
