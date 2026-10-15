/** Gemini declares schema types in capitals; OpenAI, Anthropic and MCP want standard JSON Schema. */
export function toJsonSchema(s: any): any {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (s && typeof s === 'object') {
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'type' && typeof v === 'string' ? v.toLowerCase() : toJsonSchema(v)]));
  }
  return s;
}
