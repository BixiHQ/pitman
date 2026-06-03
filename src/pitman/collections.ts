import * as vscode from 'vscode';
import type { HttpCollection, HttpRequest } from './schemas';

async function readJson<T>(uri: vscode.Uri): Promise<T> {
  const raw = await vscode.workspace.fs.readFile(uri);
  return JSON.parse(Buffer.from(raw).toString('utf8')) as T;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'collection';
}

async function uniqueSlug(root: vscode.Uri, base: string): Promise<string> {
  const dir = vscode.Uri.joinPath(root, 'collections');
  let slug = base;
  let i = 2;
  for (;;) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, `${slug}.json`));
      slug = `${base}-${i++}`;
    } catch {
      return slug;
    }
  }
}

export function uniqueRequestId(collection: HttpCollection, base: string): string {
  const existing = new Set(collection.requests.map(r => r.id));
  let id = base;
  let i = 2;
  while (existing.has(id)) {
    id = `${base}-${i++}`;
  }
  return id;
}

export async function listCollections(root: vscode.Uri): Promise<string[]> {
  const dir = vscode.Uri.joinPath(root, 'collections');
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'))
      .map(([name]) => name.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export async function loadCollection(root: vscode.Uri, id: string): Promise<HttpCollection> {
  const uri = vscode.Uri.joinPath(root, 'collections', `${id}.json`);
  try {
    return await readJson<HttpCollection>(uri);
  } catch (err) {
    throw new Error(
      `Failed to load collection "${id}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function saveCollection(
  root: vscode.Uri,
  id: string,
  collection: HttpCollection,
): Promise<void> {
  const uri = vscode.Uri.joinPath(root, 'collections', `${id}.json`);
  await vscode.workspace.fs.writeFile(
    uri,
    Buffer.from(JSON.stringify(collection, null, 2), 'utf8'),
  );
}

export async function createCollection(root: vscode.Uri, name: string): Promise<string> {
  const base = slugify(name);
  const id = await uniqueSlug(root, base);
  const collection: HttpCollection = { name, requests: [] };
  await saveCollection(root, id, collection);
  return id;
}

export async function renameCollection(
  root: vscode.Uri,
  oldId: string,
  newName: string,
): Promise<string> {
  const old = await loadCollection(root, oldId);
  old.name = newName;
  const newBase = slugify(newName);
  // If slug is unchanged keep the same file, just update name
  if (newBase === oldId) {
    await saveCollection(root, oldId, old);
    return oldId;
  }
  const newId = await uniqueSlug(root, newBase);
  await saveCollection(root, newId, old);
  await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, 'collections', `${oldId}.json`));
  return newId;
}

export async function duplicateCollection(root: vscode.Uri, id: string): Promise<string> {
  const src = await loadCollection(root, id);
  const base = slugify(src.name + '-copy');
  const newId = await uniqueSlug(root, base);
  const copy: HttpCollection = {
    name: src.name + ' Copy',
    requests: src.requests.map(r => ({ ...r })),
  };
  await saveCollection(root, newId, copy);
  return newId;
}

export async function deleteCollection(root: vscode.Uri, id: string): Promise<void> {
  await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, 'collections', `${id}.json`));
}

export async function createRequest(root: vscode.Uri, collectionId: string): Promise<HttpRequest> {
  const collection = await loadCollection(root, collectionId);
  const id = uniqueRequestId(collection, 'new-request');
  const req: HttpRequest = {
    id,
    name: 'New Request',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: { type: 'none' },
    body: { type: 'none' },
    docs: '',
  };
  collection.requests.push(req);
  await saveCollection(root, collectionId, collection);
  return req;
}

export async function saveRequest(
  root: vscode.Uri,
  collectionId: string,
  request: HttpRequest,
): Promise<void> {
  const collection = await loadCollection(root, collectionId);
  const idx = collection.requests.findIndex(r => r.id === request.id);
  if (idx === -1) {
    collection.requests.push(request);
  } else {
    collection.requests[idx] = request;
  }
  await saveCollection(root, collectionId, collection);
}

export async function duplicateRequest(
  root: vscode.Uri,
  collectionId: string,
  requestId: string,
): Promise<HttpRequest> {
  const collection = await loadCollection(root, collectionId);
  const src = collection.requests.find(r => r.id === requestId);
  if (!src) {
    throw new Error(`Request "${requestId}" not found in collection "${collectionId}".`);
  }
  const newId = uniqueRequestId(collection, slugify(src.name + '-copy'));
  const copy: HttpRequest = { ...src, id: newId, name: src.name + ' Copy' };
  collection.requests.push(copy);
  await saveCollection(root, collectionId, collection);
  return copy;
}

export async function deleteRequest(
  root: vscode.Uri,
  collectionId: string,
  requestId: string,
): Promise<void> {
  const collection = await loadCollection(root, collectionId);
  collection.requests = collection.requests.filter(r => r.id !== requestId);
  await saveCollection(root, collectionId, collection);
}
