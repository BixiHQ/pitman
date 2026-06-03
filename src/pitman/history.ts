import * as vscode from 'vscode';
import type { HistoryEntry } from './schemas';

const HISTORY_FILE = 'history/history.jsonl';

const SENSITIVE_HEADER_RE = /token|secret|password|key|authorization|apitoken/i;

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_RE.test(name);
}

export function redactHeaders(
  headers: Record<string, string>,
  redactList: string[],
): Record<string, string> {
  const lower = new Set(redactList.map(h => h.toLowerCase()));
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    result[k] = lower.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return result;
}

export async function appendHistoryEntry(root: vscode.Uri, entry: HistoryEntry): Promise<void> {
  const uri = vscode.Uri.joinPath(root, HISTORY_FILE);
  const line = JSON.stringify(entry) + '\n';
  try {
    const existing = await vscode.workspace.fs.readFile(uri);
    const combined = Buffer.concat([existing, Buffer.from(line, 'utf8')]);
    await vscode.workspace.fs.writeFile(uri, combined);
  } catch {
    // File doesn't exist yet — write fresh
    await vscode.workspace.fs.writeFile(uri, Buffer.from(line, 'utf8'));
  }
}

export async function loadHistory(root: vscode.Uri): Promise<HistoryEntry[]> {
  const uri = vscode.Uri.joinPath(root, HISTORY_FILE);
  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(raw).toString('utf8');
    return text
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as HistoryEntry)
      .reverse(); // newest first
  } catch {
    return [];
  }
}

export async function clearHistory(root: vscode.Uri): Promise<void> {
  const uri = vscode.Uri.joinPath(root, HISTORY_FILE);
  try {
    await vscode.workspace.fs.delete(uri);
  } catch {
    /* already gone */
  }
}

export function generateHistoryId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
