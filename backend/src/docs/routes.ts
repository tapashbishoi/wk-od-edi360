/**
 * Lists every route an Express 4 app serves, as "METHOD /path/{}" with each path parameter written
 * as {}. Used by the API-docs test to keep the OpenAPI spec in step with the real routes.
 */
const ROOT = '^\\/?(?=\\/|$)';
const TAIL = /\\\/\?\(\?=\\\/\|\$\)$/;
const PARAM = /\(\?:\\\/\(\[\^\/\]\+\?\)\)/g;

export function listRoutes(app: any): string[] {
  const out: string[] = [];
  const mount = (layer: any): string => {
    const src: string = layer.regexp.source;
    if (src === ROOT) return '';
    return src.replace(/^\^/, '').replace(TAIL, '').replace(PARAM, '/{}').replace(/\\\//g, '/');
  };
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue;
          out.push(`${method.toUpperCase()} ${(prefix + layer.route.path).replace(/:[A-Za-z_]+/g, '{}')}`);
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mount(layer));
      }
    }
  };
  walk(app._router.stack, '');
  return [...new Set(out.map((r) => (r.length > 1 && r.endsWith('/') ? r.slice(0, -1) : r)))].sort();
}
