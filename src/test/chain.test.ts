import * as assert from 'assert';
import {
  parseChainExpressions,
  extractFromResponse,
  collectDependencies,
  detectCycles,
} from '../pitman/chain.js';
import type { HttpRequest, HttpResponse } from '../pitman/schemas.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeResponse(overrides: Partial<HttpResponse> = {}): HttpResponse {
  return {
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '{}',
    durationMs: 10,
    sizeBytes: 2,
    requestHeaders: {},
    resolvedUrl: 'http://localhost',
    ...overrides,
  };
}

function makeRequest(name: string, fields: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: { type: 'none' },
    body: { type: 'none' },
    docs: '',
    ...fields,
  };
}

// ── parseChainExpressions ─────────────────────────────────────────────────────

suite('parseChainExpressions', () => {
  test('body path', () => {
    const exprs = parseChainExpressions('{{req(Login).body.sessionId}}');
    assert.strictEqual(exprs.length, 1);
    assert.strictEqual(exprs[0].requestName, 'Login');
    assert.deepStrictEqual(exprs[0].accessor, { type: 'body', path: ['sessionId'] });
  });

  test('nested body path', () => {
    const exprs = parseChainExpressions('{{req(Login).body.accountInformation.0.accountId}}');
    assert.strictEqual(exprs.length, 1);
    assert.deepStrictEqual(exprs[0].accessor, {
      type: 'body',
      path: ['accountInformation', '0', 'accountId'],
    });
  });

  test('status', () => {
    const exprs = parseChainExpressions('{{req(Login).status}}');
    assert.strictEqual(exprs.length, 1);
    assert.deepStrictEqual(exprs[0].accessor, { type: 'status' });
  });

  test('header plain', () => {
    const exprs = parseChainExpressions('{{req(Login).header(authorization)}}');
    assert.strictEqual(exprs.length, 1);
    assert.deepStrictEqual(exprs[0].accessor, {
      type: 'header',
      name: 'authorization',
      regex: null,
    });
  });

  test('header with match', () => {
    const exprs = parseChainExpressions('{{req(Login).header(set-cookie).match(_cyc=[^;]+)}}');
    assert.strictEqual(exprs.length, 1);
    const acc = exprs[0].accessor as { type: 'header'; name: string; regex: string | null };
    assert.strictEqual(acc.type, 'header');
    assert.strictEqual(acc.name, 'set-cookie');
    assert.ok(acc.regex);
  });

  test('cookie extractor', () => {
    const exprs = parseChainExpressions('{{req(Login).cookie(_cyc)}}');
    assert.strictEqual(exprs.length, 1);
    assert.deepStrictEqual(exprs[0].accessor, { type: 'cookie', name: '_cyc' });
  });

  test('multiple expressions in one string', () => {
    const exprs = parseChainExpressions(
      '{"sessionId":"{{req(Login).body.sessionId}}","account":"{{req(Login).body.accountId}}"}',
    );
    assert.strictEqual(exprs.length, 2);
    assert.strictEqual(exprs[0].requestName, 'Login');
    assert.strictEqual(exprs[1].requestName, 'Login');
  });

  test('no match for plain env var', () => {
    assert.strictEqual(parseChainExpressions('{{baseUrl}}').length, 0);
  });

  test('no match for malformed expression', () => {
    assert.strictEqual(parseChainExpressions('{{req(Login)}}').length, 0);
    assert.strictEqual(parseChainExpressions('{{req(Login).unknownType}}').length, 0);
  });
});

// ── extractFromResponse ───────────────────────────────────────────────────────

suite('extractFromResponse — body', () => {
  test('top-level key', () => {
    const resp = makeResponse({ body: '{"sessionId":"abc123"}' });
    assert.strictEqual(extractFromResponse(resp, { type: 'body', path: ['sessionId'] }), 'abc123');
  });

  test('nested key', () => {
    const resp = makeResponse({ body: '{"data":{"token":"xyz"}}' });
    assert.strictEqual(extractFromResponse(resp, { type: 'body', path: ['data', 'token'] }), 'xyz');
  });

  test('array index', () => {
    const resp = makeResponse({
      body: '{"accounts":[{"id":"acc-1"},{"id":"acc-2"}]}',
    });
    assert.strictEqual(
      extractFromResponse(resp, { type: 'body', path: ['accounts', '0', 'id'] }),
      'acc-1',
    );
  });

  test('missing key returns empty string', () => {
    const resp = makeResponse({ body: '{"a":1}' });
    assert.strictEqual(extractFromResponse(resp, { type: 'body', path: ['missing'] }), '');
  });

  test('invalid JSON returns empty string', () => {
    const resp = makeResponse({ body: 'not json' });
    assert.strictEqual(extractFromResponse(resp, { type: 'body', path: ['key'] }), '');
  });
});

suite('extractFromResponse — status', () => {
  test('returns status as string', () => {
    const resp = makeResponse({ status: 201 });
    assert.strictEqual(extractFromResponse(resp, { type: 'status' }), '201');
  });
});

suite('extractFromResponse — header', () => {
  test('plain header', () => {
    const resp = makeResponse({ headers: { 'x-token': 'tok-abc' } });
    assert.strictEqual(
      extractFromResponse(resp, { type: 'header', name: 'x-token', regex: null }),
      'tok-abc',
    );
  });

  test('header lookup is case-insensitive', () => {
    const resp = makeResponse({ headers: { 'X-Token': 'tok-abc' } });
    assert.strictEqual(
      extractFromResponse(resp, { type: 'header', name: 'x-token', regex: null }),
      'tok-abc',
    );
  });

  test('missing header returns empty string', () => {
    const resp = makeResponse({ headers: {} });
    assert.strictEqual(
      extractFromResponse(resp, { type: 'header', name: 'x-token', regex: null }),
      '',
    );
  });

  test('header with regex match', () => {
    const resp = makeResponse({ headers: { 'set-cookie': '_cyc=abc123; Path=/' } });
    assert.strictEqual(
      extractFromResponse(resp, { type: 'header', name: 'set-cookie', regex: '_cyc=[^;]+' }),
      '_cyc=abc123',
    );
  });
});

suite('extractFromResponse — cookie', () => {
  test('extracts named cookie from single set-cookie', () => {
    const resp = makeResponse({
      headers: { 'set-cookie': '_cyc=enc%3Dvalue; Path=/; HttpOnly' },
    });
    assert.strictEqual(
      extractFromResponse(resp, { type: 'cookie', name: '_cyc' }),
      'enc=value', // URL-decoded
    );
  });

  test('extracts correct cookie from multi-value set-cookie', () => {
    // Multiple Set-Cookie headers stored newline-joined
    const resp = makeResponse({
      headers: { 'set-cookie': 'session=abc; Path=/\ncookiesession1=XYZ; Path=/' },
    });
    assert.strictEqual(extractFromResponse(resp, { type: 'cookie', name: 'session' }), 'abc');
    assert.strictEqual(
      extractFromResponse(resp, { type: 'cookie', name: 'cookiesession1' }),
      'XYZ',
    );
  });

  test('missing cookie returns empty string', () => {
    const resp = makeResponse({ headers: { 'set-cookie': 'other=val' } });
    assert.strictEqual(extractFromResponse(resp, { type: 'cookie', name: '_cyc' }), '');
  });
});

// ── collectDependencies ───────────────────────────────────────────────────────

suite('collectDependencies', () => {
  test('no chain expressions → empty', () => {
    const req = makeRequest('Balance Query', { url: '{{baseUrl}}/balance' });
    assert.deepStrictEqual(collectDependencies(req), []);
  });

  test('chain expression in URL', () => {
    const req = makeRequest('Test', {
      url: '{{baseUrl}}/sessions/{{req(Login).body.sessionId}}',
    });
    assert.deepStrictEqual(collectDependencies(req), ['Login']);
  });

  test('chain expression in body', () => {
    const req = makeRequest('Balance Query', {
      body: {
        type: 'json',
        value: '{"sessionId":"{{req(Login).body.sessionId}}"}',
      },
    });
    assert.deepStrictEqual(collectDependencies(req), ['Login']);
  });

  test('chain expression in header', () => {
    const req = makeRequest('Balance Query', {
      headers: [{ key: 'Cookie', value: '{{req(Login).cookie(_cyc)}}', enabled: true }],
    });
    assert.deepStrictEqual(collectDependencies(req), ['Login']);
  });

  test('deduplicates same dependency referenced multiple times', () => {
    const req = makeRequest('B2P Transfer', {
      body: {
        type: 'json',
        value: '{"sessionId":"{{req(Login).body.sessionId}}","token":"{{req(Login).body.token}}"}',
      },
    });
    assert.deepStrictEqual(collectDependencies(req), ['Login']);
  });

  test('collects multiple distinct dependencies', () => {
    const req = makeRequest('Transfer', {
      body: {
        type: 'json',
        value:
          '{"sessionId":"{{req(Login).body.sessionId}}","name":"{{req(FindAccount).body.ReceiverInfo.NAME}}"}',
      },
    });
    const deps = collectDependencies(req);
    assert.ok(deps.includes('Login'));
    assert.ok(deps.includes('FindAccount'));
    assert.strictEqual(deps.length, 2);
  });
});

// ── detectCycles ──────────────────────────────────────────────────────────────

suite('detectCycles', () => {
  test('no dependencies — no cycle', () => {
    const reqs = new Map([['Login', makeRequest('Login')]]);
    assert.doesNotThrow(() => detectCycles('Login', reqs));
  });

  test('linear chain — no cycle', () => {
    const login = makeRequest('Login');
    const balance = makeRequest('Balance Query', {
      body: { type: 'json', value: '{"s":"{{req(Login).body.sessionId}}"}' },
    });
    const reqs = new Map([
      ['Login', login],
      ['Balance Query', balance],
    ]);
    assert.doesNotThrow(() => detectCycles('Balance Query', reqs));
  });

  test('self-reference → throws', () => {
    const self = makeRequest('SelfRef', {
      url: '{{req(SelfRef).body.id}}',
    });
    const reqs = new Map([['SelfRef', self]]);
    assert.throws(() => detectCycles('SelfRef', reqs), /[Cc]ircular/);
  });

  test('two-node cycle → throws', () => {
    const a = makeRequest('A', { url: '{{req(B).body.x}}' });
    const b = makeRequest('B', { url: '{{req(A).body.x}}' });
    const reqs = new Map([
      ['A', a],
      ['B', b],
    ]);
    assert.throws(() => detectCycles('A', reqs), /[Cc]ircular/);
  });
});
