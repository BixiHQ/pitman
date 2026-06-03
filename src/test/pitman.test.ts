import * as assert from 'assert';
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import {
  slugify,
  uniqueRequestId,
  listCollections,
  loadCollection,
  createCollection,
  renameCollection,
  duplicateCollection,
  deleteCollection,
  createRequest,
  saveRequest,
  duplicateRequest,
  deleteRequest,
} from '../pitman/collections.js';
import {
  loadEnvironments,
  loadRawEnvironment,
  createEnvironment,
  saveEnvironment,
  renameEnvironment,
  deleteEnvironment,
} from '../pitman/environments.js';
import { loadSettings, saveSettings } from '../pitman/settings.js';
import {
  appendHistoryEntry,
  loadHistory,
  clearHistory,
  isSensitiveHeader,
  redactHeaders,
  generateHistoryId,
} from '../pitman/history.js';
import { resolveVariables } from '../pitman/variables.js';
import type { HttpCollection, HttpRequest, HistoryEntry } from '../pitman/schemas.js';

// Helper: create a temp Uri backed by the real filesystem for each test.
function tmpRoot(): vscode.Uri {
  const dir = path.join(
    os.tmpdir(),
    'pitman-test-' + Date.now() + '-' + Math.random().toString(36).slice(2),
  );
  return vscode.Uri.file(dir);
}

async function initRoot(root: vscode.Uri): Promise<void> {
  const { initializePitmanWorkspace } = await import('../pitman/initializer.js');
  await initializePitmanWorkspace(root);
}

// ── Pure function tests (no filesystem) ──────────────────────────────────────

suite('slugify', () => {
  test('lower-kebab', () => assert.strictEqual(slugify('Bridge API'), 'bridge-api'));
  test('trims hyphens', () => assert.strictEqual(slugify('  --test--  '), 'test'));
  test('collapses spaces', () =>
    assert.strictEqual(slugify('My New   Collection'), 'my-new-collection'));
  test('fallback', () => assert.strictEqual(slugify('!!!'), 'collection'));
  test('numbers preserved', () => assert.strictEqual(slugify('API v2'), 'api-v2'));
});

suite('uniqueRequestId', () => {
  function col(ids: string[]): HttpCollection {
    return {
      name: 'Test',
      requests: ids.map(
        id =>
          ({
            id,
            name: id,
            method: 'GET',
            url: '',
            params: [],
            headers: [],
            auth: { type: 'none' },
            body: { type: 'none' },
            docs: '',
          }) as HttpRequest,
      ),
    };
  }
  test('no conflict', () =>
    assert.strictEqual(uniqueRequestId(col([]), 'new-request'), 'new-request'));
  test('conflict once', () =>
    assert.strictEqual(uniqueRequestId(col(['new-request']), 'new-request'), 'new-request-2'));
  test('conflict twice', () =>
    assert.strictEqual(
      uniqueRequestId(col(['new-request', 'new-request-2']), 'new-request'),
      'new-request-3',
    ));
});

suite('resolveVariables', () => {
  test('replaces known var', () =>
    assert.strictEqual(
      resolveVariables('{{baseUrl}}/api', { baseUrl: 'http://localhost:8000' }),
      'http://localhost:8000/api',
    ));
  test('leaves unknown var', () =>
    assert.strictEqual(resolveVariables('{{unknown}}', {}), '{{unknown}}'));
  test('multiple vars', () =>
    assert.strictEqual(resolveVariables('{{a}}-{{b}}', { a: 'x', b: 'y' }), 'x-y'));
  test('no vars', () => assert.strictEqual(resolveVariables('plain', { x: '1' }), 'plain'));
});

suite('isSensitiveHeader', () => {
  test('authorization', () => assert.ok(isSensitiveHeader('authorization')));
  test('Authorization (case)', () => assert.ok(isSensitiveHeader('Authorization')));
  test('x-api-key', () => assert.ok(isSensitiveHeader('x-api-key')));
  test('apiToken', () => assert.ok(isSensitiveHeader('apiToken')));
  test('password in name', () => assert.ok(isSensitiveHeader('user-password')));
  test('content-type not sensitive', () => assert.ok(!isSensitiveHeader('content-type')));
  test('accept not sensitive', () => assert.ok(!isSensitiveHeader('accept')));
});

suite('redactHeaders', () => {
  test('redacts listed headers', () => {
    const result = redactHeaders(
      { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      ['authorization'],
    );
    assert.strictEqual(result['Authorization'], '[redacted]');
    assert.strictEqual(result['Content-Type'], 'application/json');
  });
  test('case-insensitive redact list', () => {
    const result = redactHeaders({ 'X-API-Key': 'mykey' }, ['x-api-key']);
    assert.strictEqual(result['X-API-Key'], '[redacted]');
  });
});

suite('generateHistoryId', () => {
  test('produces non-empty string', () => assert.ok(generateHistoryId().length > 0));
  test('produces unique ids', () =>
    assert.notStrictEqual(generateHistoryId(), generateHistoryId()));
});

// ── Filesystem integration tests ──────────────────────────────────────────────

suite('collections CRUD', function () {
  this.timeout(10000);
  let root: vscode.Uri;

  setup(async () => {
    root = tmpRoot();
    await initRoot(root);
  });

  test('listCollections returns default', async () => {
    const ids = await listCollections(root);
    assert.ok(ids.includes('default'), `expected "default" in [${ids.join(',')}]`);
  });

  test('createCollection creates file with correct name', async () => {
    const id = await createCollection(root, 'Bridge API');
    assert.strictEqual(id, 'bridge-api');
    const col = await loadCollection(root, 'bridge-api');
    assert.strictEqual(col.name, 'Bridge API');
    assert.deepStrictEqual(col.requests, []);
  });

  test('createCollection appends suffix for duplicates', async () => {
    await createCollection(root, 'Test');
    const id2 = await createCollection(root, 'Test');
    assert.strictEqual(id2, 'test-2');
  });

  test('renameCollection updates name and slug', async () => {
    const id = await createCollection(root, 'Old Name');
    const newId = await renameCollection(root, id, 'New Name');
    assert.strictEqual(newId, 'new-name');
    const col = await loadCollection(root, newId);
    assert.strictEqual(col.name, 'New Name');
  });

  test('renameCollection same slug keeps file', async () => {
    await createCollection(root, 'Test Collection');
    const newId = await renameCollection(root, 'test-collection', 'Test Collection Updated');
    // Same slug would be 'test-collection-updated' which is different, but if we
    // rename to exact same name the slug matches → same id returned
    const newId2 = await renameCollection(root, newId, 'Test Collection Updated');
    assert.strictEqual(newId2, newId);
  });

  test('duplicateCollection creates copy with requests', async () => {
    const id = await createCollection(root, 'Source');
    const col = await loadCollection(root, id);
    col.requests.push({
      id: 'r1',
      name: 'R1',
      method: 'GET',
      url: '/',
      params: [],
      headers: [],
      auth: { type: 'none' },
      body: { type: 'none' },
      docs: '',
    });
    await import('../pitman/collections.js').then(m => m.saveCollection(root, id, col));

    const copyId = await duplicateCollection(root, id);
    const copy = await loadCollection(root, copyId);
    assert.strictEqual(copy.requests.length, 1);
    assert.ok(copy.name.includes('Copy'));
  });

  test('deleteCollection removes file', async () => {
    const id = await createCollection(root, 'ToDelete');
    await deleteCollection(root, id);
    const ids = await listCollections(root);
    assert.ok(!ids.includes(id));
  });
});

suite('request CRUD', function () {
  this.timeout(10000);
  let root: vscode.Uri;

  setup(async () => {
    root = tmpRoot();
    await initRoot(root);
  });

  test('createRequest adds request to collection', async () => {
    const r = await createRequest(root, 'default');
    assert.strictEqual(r.method, 'GET');
    const col = await loadCollection(root, 'default');
    assert.ok(col.requests.some(x => x.id === r.id));
  });

  test('saveRequest updates existing request', async () => {
    const r = await createRequest(root, 'default');
    r.name = 'Updated Name';
    r.url = 'http://example.com';
    await saveRequest(root, 'default', r);
    const col = await loadCollection(root, 'default');
    const saved = col.requests.find(x => x.id === r.id);
    assert.strictEqual(saved?.name, 'Updated Name');
    assert.strictEqual(saved?.url, 'http://example.com');
  });

  test('duplicateRequest creates copy', async () => {
    const r = await createRequest(root, 'default');
    const copy = await duplicateRequest(root, 'default', r.id);
    assert.notStrictEqual(copy.id, r.id);
    assert.ok(copy.name.includes('Copy'));
  });

  test('deleteRequest removes from collection', async () => {
    const r = await createRequest(root, 'default');
    await deleteRequest(root, 'default', r.id);
    const col = await loadCollection(root, 'default');
    assert.ok(!col.requests.some(x => x.id === r.id));
  });
});

suite('environment CRUD', function () {
  this.timeout(10000);
  let root: vscode.Uri;

  setup(async () => {
    root = tmpRoot();
    await initRoot(root);
  });

  test('loadEnvironments merges public and private', async () => {
    const envs = await loadEnvironments(root);
    assert.ok(envs['local']);
    // local.private.env.json has apiToken='' which should appear
    assert.ok('apiToken' in envs['local'].variables);
    // baseUrl comes from public file
    assert.strictEqual(envs['local'].variables['baseUrl'], 'http://localhost:8000');
  });

  test('private vars override public vars', async () => {
    await saveEnvironment(
      root,
      'local',
      'Local',
      { shared: 'public-value' },
      { shared: 'private-override' },
    );
    const envs = await loadEnvironments(root);
    assert.strictEqual(envs['local'].variables['shared'], 'private-override');
  });

  test('createEnvironment creates public file', async () => {
    const id = await createEnvironment(root, 'Production');
    assert.strictEqual(id, 'production');
    const raw = await loadRawEnvironment(root, id);
    assert.strictEqual(raw.publicName, 'Production');
    assert.deepStrictEqual(raw.publicVars, {});
    assert.ok(!raw.hasPrivateFile);
  });

  test('saveEnvironment creates private file when privateVars non-empty', async () => {
    const id = await createEnvironment(root, 'Staging');
    await saveEnvironment(
      root,
      id,
      'Staging',
      { baseUrl: 'https://staging.example.com' },
      { apiToken: 'secret' },
    );
    const raw = await loadRawEnvironment(root, id);
    assert.strictEqual(raw.privateVars['apiToken'], 'secret');
    assert.ok(raw.hasPrivateFile);
  });

  test('deleteEnvironment removes both files', async () => {
    const id = await createEnvironment(root, 'Temp');
    await saveEnvironment(root, id, 'Temp', {}, { key: 'val' });
    await deleteEnvironment(root, id);
    const envs = await loadEnvironments(root);
    assert.ok(!envs[id]);
  });

  test('renameEnvironment moves files', async () => {
    const id = await createEnvironment(root, 'Old');
    const newId = await renameEnvironment(root, id, 'New');
    assert.strictEqual(newId, 'new');
    const raw = await loadRawEnvironment(root, newId);
    assert.strictEqual(raw.publicName, 'New');
    const envs = await loadEnvironments(root);
    assert.ok(!envs[id]);
    assert.ok(envs[newId]);
  });
});

suite('settings', function () {
  this.timeout(10000);
  let root: vscode.Uri;

  setup(async () => {
    root = tmpRoot();
    await initRoot(root);
  });

  test('loadSettings returns defaults for missing file', async () => {
    const emptyRoot = tmpRoot();
    await vscode.workspace.fs.createDirectory(emptyRoot);
    const s = await loadSettings(emptyRoot);
    assert.strictEqual(s.timeoutMs, 30000);
    assert.ok(Array.isArray(s.redactHeaders));
  });

  test('saveSettings persists values', async () => {
    await saveSettings(root, { timeoutMs: 5000, followRedirects: false });
    const s = await loadSettings(root);
    assert.strictEqual(s.timeoutMs, 5000);
    assert.strictEqual(s.followRedirects, false);
    // Other defaults preserved
    assert.ok(Array.isArray(s.redactHeaders));
  });

  test('saveSettings preserves unknown keys', async () => {
    // Write a settings file with an unknown key
    const uri = vscode.Uri.joinPath(root, 'settings.json');
    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(JSON.stringify({ timeoutMs: 1000, unknownKey: 'preserved' })),
    );
    await saveSettings(root, { followRedirects: true });
    const raw = JSON.parse(
      Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'),
    ) as Record<string, unknown>;
    assert.strictEqual(raw['unknownKey'], 'preserved');
  });
});

suite('history', function () {
  this.timeout(10000);
  let root: vscode.Uri;

  setup(async () => {
    root = tmpRoot();
    await initRoot(root);
  });

  function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
    return {
      id: generateHistoryId(),
      timestamp: new Date().toISOString(),
      collectionId: 'default',
      requestId: 'example-get',
      environmentId: 'local',
      method: 'GET',
      url: 'http://localhost:8000',
      requestHeaders: {},
      status: 200,
      statusText: 'OK',
      durationMs: 42,
      sizeBytes: 10,
      responseHeaders: {},
      responseBodyPreview: 'Hello',
      ...overrides,
    };
  }

  test('append and load', async () => {
    const e1 = makeEntry({ method: 'GET' });
    const e2 = makeEntry({ method: 'POST' });
    await appendHistoryEntry(root, e1);
    await appendHistoryEntry(root, e2);
    const entries = await loadHistory(root);
    assert.strictEqual(entries.length, 2);
    // newest first
    assert.strictEqual(entries[0].method, 'POST');
    assert.strictEqual(entries[1].method, 'GET');
  });

  test('clear removes all entries', async () => {
    await appendHistoryEntry(root, makeEntry());
    await clearHistory(root);
    const entries = await loadHistory(root);
    assert.strictEqual(entries.length, 0);
  });

  test('load returns empty for missing file', async () => {
    const entries = await loadHistory(root);
    assert.deepStrictEqual(entries, []);
  });

  test('sensitive headers redacted before storing', () => {
    const result = redactHeaders(
      { Authorization: 'Bearer secret', 'X-Api-Key': 'key', 'Content-Type': 'application/json' },
      ['authorization', 'x-api-key'],
    );
    assert.strictEqual(result['Authorization'], '[redacted]');
    assert.strictEqual(result['X-Api-Key'], '[redacted]');
    assert.strictEqual(result['Content-Type'], 'application/json');
  });
});
