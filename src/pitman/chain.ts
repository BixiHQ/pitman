/**
 * Request chaining — resolves {{req(Name).body.path}} and related expressions
 * before a request is sent.  Dependencies are executed in topological order,
 * their responses cached for the duration of one chain execution, and the
 * extracted values substituted into the dependent request's fields.
 *
 * Supported expression forms (all inside {{ }}):
 *   req(Name).body.path.to.value     – JSON body path (dot-notation, 0-index arrays)
 *   req(Name).status                 – HTTP status code as string
 *   req(Name).header(name)           – response header value
 *   req(Name).cookie(name)           – named cookie value from Set-Cookie
 *   req(Name).header(name).match(rx) – first regex match on a header value
 */

import type { HttpRequest, HttpResponse, PitmanSettings } from './schemas';
import { sendHttpRequest } from './http-client';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ChainStep {
  requestName: string;
  durationMs: number;
  status: 'ok' | 'error';
  error?: string;
}

// ── Internal expression types ─────────────────────────────────────────────────

interface BodyAccessor {
  type: 'body';
  path: string[];
}
interface StatusAccessor {
  type: 'status';
}
interface HeaderAccessor {
  type: 'header';
  name: string;
  regex: string | null;
}
interface CookieAccessor {
  type: 'cookie';
  name: string;
}

type Accessor = BodyAccessor | StatusAccessor | HeaderAccessor | CookieAccessor;

interface ParsedExpression {
  full: string; // the complete {{...}} token to replace
  requestName: string;
  accessor: Accessor;
}

// ── Expression parsing ────────────────────────────────────────────────────────

// Matches {{req(Name).accessor}} — accessor captured without the closing }}
const CHAIN_EXPR_RE = /\{\{req\(([^)]+)\)\.([^}]+)\}\}/g;

export function parseChainExpressions(input: string): ParsedExpression[] {
  const results: ParsedExpression[] = [];
  const re = new RegExp(CHAIN_EXPR_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const requestName = m[1].trim();
    const accessorStr = m[2].trim();
    const accessor = parseAccessor(accessorStr);
    if (accessor) {
      results.push({ full: m[0], requestName, accessor });
    }
  }
  return results;
}

function parseAccessor(s: string): Accessor | null {
  if (s === 'status') {
    return { type: 'status' };
  }
  if (s.startsWith('body.')) {
    return { type: 'body', path: s.slice(5).split('.').filter(Boolean) };
  }
  const cookieM = s.match(/^cookie\(([^)]+)\)$/);
  if (cookieM) {
    return { type: 'cookie', name: cookieM[1].trim() };
  }
  // header(name) or header(name).match(regex)
  // The regex in .match() may not contain unbalanced parens — a reasonable constraint.
  const headerM = s.match(/^header\(([^)]+)\)(?:\.match\((.+)\))?$/);
  if (headerM) {
    return { type: 'header', name: headerM[1].trim(), regex: headerM[2] ?? null };
  }
  return null;
}

// ── Value extraction from a response ─────────────────────────────────────────

export function extractFromResponse(response: HttpResponse, accessor: Accessor): string {
  switch (accessor.type) {
    case 'status':
      return String(response.status);

    case 'body': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        return '';
      }
      let cur: unknown = parsed;
      for (const key of accessor.path) {
        if (cur === null || cur === undefined) {
          return '';
        }
        if (Array.isArray(cur)) {
          const idx = Number(key);
          cur = Number.isNaN(idx) ? undefined : cur[idx];
        } else if (typeof cur === 'object') {
          cur = (cur as Record<string, unknown>)[key];
        } else {
          return '';
        }
      }
      return cur === null || cur === undefined ? '' : String(cur);
    }

    case 'header': {
      const raw = findHeader(response.headers, accessor.name);
      if (!raw) {
        return '';
      }
      if (!accessor.regex) {
        return raw;
      }
      // Multi-value headers (e.g. set-cookie) are stored as \n-joined lines.
      for (const line of raw.split('\n')) {
        const m = line.match(new RegExp(accessor.regex));
        if (m) {
          return m[1] ?? m[0];
        }
      }
      return '';
    }

    case 'cookie': {
      const raw = findHeader(response.headers, 'set-cookie');
      if (!raw) {
        return '';
      }
      const nameRe = new RegExp(`(?:^|[;\\s])${escapeRegex(accessor.name)}=([^;]*)`);
      for (const line of raw.split('\n')) {
        const m = line.match(nameRe);
        if (m) {
          return decodeURIComponent(m[1]);
        }
      }
      return '';
    }
  }
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Dependency discovery ──────────────────────────────────────────────────────

function requestStrings(request: HttpRequest): string[] {
  const out: string[] = [request.url];
  for (const p of request.params) {
    out.push(p.key, p.value);
  }
  for (const h of request.headers) {
    out.push(h.key, h.value);
  }
  const a = request.auth;
  if (a.type === 'bearer') {
    out.push(a.token);
  }
  if (a.type === 'basic') {
    out.push(a.username, a.password);
  }
  if (a.type === 'apiKey') {
    out.push(a.key, a.value);
  }
  const b = request.body;
  if (b.type === 'json' || b.type === 'text') {
    out.push(b.value);
  }
  if (b.type === 'form') {
    for (const f of b.fields) {
      out.push(f.key, f.value);
    }
  }
  if (b.type === 'multipart') {
    for (const f of b.fields) {
      out.push(f.key, f.value);
    }
  }
  return out.filter(Boolean);
}

export function collectDependencies(request: HttpRequest): string[] {
  const deps = new Set<string>();
  for (const s of requestStrings(request)) {
    for (const expr of parseChainExpressions(s)) {
      deps.add(expr.requestName);
    }
  }
  return [...deps];
}

// ── Cycle detection ───────────────────────────────────────────────────────────

export function detectCycles(
  startName: string,
  allRequests: ReadonlyMap<string, HttpRequest>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(name: string): void {
    if (visited.has(name)) {
      return;
    }
    if (visiting.has(name)) {
      throw new Error(`Circular dependency: "${name}" is part of a dependency cycle.`);
    }
    visiting.add(name);
    const req = allRequests.get(name);
    if (req) {
      for (const dep of collectDependencies(req)) {
        visit(dep);
      }
    }
    visiting.delete(name);
    visited.add(name);
  }

  visit(startName);
}

// ── Substitution ──────────────────────────────────────────────────────────────

function applySubstitutions(request: HttpRequest, subs: Map<string, string>): HttpRequest {
  if (subs.size === 0) {
    return request;
  }
  const sub = (s: string) => {
    let r = s;
    for (const [expr, val] of subs) {
      r = r.split(expr).join(val);
    }
    return r;
  };

  const a = request.auth;
  const resolvedAuth: HttpRequest['auth'] =
    a.type === 'bearer'
      ? { ...a, token: sub(a.token) }
      : a.type === 'basic'
        ? { ...a, username: sub(a.username), password: sub(a.password) }
        : a.type === 'apiKey'
          ? { ...a, key: sub(a.key), value: sub(a.value) }
          : a;

  const bdy = request.body;
  const resolvedBody: HttpRequest['body'] =
    bdy.type === 'json' || bdy.type === 'text'
      ? { ...bdy, value: sub(bdy.value) }
      : bdy.type === 'form'
        ? { ...bdy, fields: bdy.fields.map(f => ({ ...f, key: sub(f.key), value: sub(f.value) })) }
        : bdy.type === 'multipart'
          ? {
              ...bdy,
              fields: bdy.fields.map(f => ({ ...f, key: sub(f.key), value: sub(f.value) })),
            }
          : bdy;

  return {
    ...request,
    url: sub(request.url),
    params: request.params.map(p => ({ ...p, key: sub(p.key), value: sub(p.value) })),
    headers: request.headers.map(h => ({ ...h, key: sub(h.key), value: sub(h.value) })),
    auth: resolvedAuth,
    body: resolvedBody,
  };
}

// ── Chain executor ────────────────────────────────────────────────────────────

async function runUpstream(
  requestName: string,
  allRequests: ReadonlyMap<string, HttpRequest>,
  env: Record<string, string>,
  settings: PitmanSettings,
  cache: Map<string, HttpResponse>,
  steps: ChainStep[],
  executing: Set<string>,
): Promise<HttpResponse> {
  const cached = cache.get(requestName);
  if (cached) {
    return cached;
  }

  const request = allRequests.get(requestName);
  if (!request) {
    throw new Error(
      `Chain dependency not found: "${requestName}". ` +
        `Make sure a request with this exact name exists in your collections.`,
    );
  }
  if (executing.has(requestName)) {
    throw new Error(`Circular dependency detected involving "${requestName}".`);
  }

  executing.add(requestName);
  const resolved = await resolveRequest(
    request,
    allRequests,
    env,
    settings,
    cache,
    steps,
    executing,
  );
  executing.delete(requestName);

  const start = Date.now();
  try {
    const response = await sendHttpRequest(resolved, env, settings);
    steps.push({ requestName, durationMs: Date.now() - start, status: 'ok' });
    cache.set(requestName, response);
    return response;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    steps.push({ requestName, durationMs: Date.now() - start, status: 'error', error });
    throw new Error(`Dependency "${requestName}" failed: ${error}`);
  }
}

async function resolveRequest(
  request: HttpRequest,
  allRequests: ReadonlyMap<string, HttpRequest>,
  env: Record<string, string>,
  settings: PitmanSettings,
  cache: Map<string, HttpResponse>,
  steps: ChainStep[],
  executing: Set<string>,
): Promise<HttpRequest> {
  const deps = collectDependencies(request);
  if (deps.length === 0) {
    return request;
  }

  const subs = new Map<string, string>();

  for (const s of requestStrings(request)) {
    for (const expr of parseChainExpressions(s)) {
      if (subs.has(expr.full)) {
        continue;
      }
      const upstream = await runUpstream(
        expr.requestName,
        allRequests,
        env,
        settings,
        cache,
        steps,
        executing,
      );
      subs.set(expr.full, extractFromResponse(upstream, expr.accessor));
    }
  }

  return applySubstitutions(request, subs);
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function executeChain(
  request: HttpRequest,
  allRequests: ReadonlyMap<string, HttpRequest>,
  env: Record<string, string>,
  settings: PitmanSettings,
): Promise<{ resolved: HttpRequest; steps: ChainStep[] }> {
  detectCycles(request.name, allRequests);

  const cache = new Map<string, HttpResponse>();
  const steps: ChainStep[] = [];
  const executing = new Set<string>([request.name]); // prevents self-reference

  const resolved = await resolveRequest(
    request,
    allRequests,
    env,
    settings,
    cache,
    steps,
    executing,
  );

  return { resolved, steps };
}
