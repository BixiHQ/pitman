import * as vscode from 'vscode';
import type { PitmanSettings } from './schemas';

const DEFAULTS: PitmanSettings = {
  defaultCollection: 'default',
  defaultEnvironment: 'local',
  timeoutMs: 30000,
  followRedirects: true,
  verifyTls: true,
  historyBodyPreviewLimit: 20000,
  redactHeaders: ['authorization', 'cookie', 'set-cookie', 'x-api-key'],
};

export async function loadSettings(root: vscode.Uri): Promise<PitmanSettings> {
  try {
    const uri = vscode.Uri.joinPath(root, 'settings.json');
    const raw = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as Partial<PitmanSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(
  root: vscode.Uri,
  updates: Partial<PitmanSettings>,
): Promise<PitmanSettings> {
  // Preserve any unknown keys already in the file
  let existing: Record<string, unknown> = {};
  try {
    const uri = vscode.Uri.joinPath(root, 'settings.json');
    const raw = await vscode.workspace.fs.readFile(uri);
    existing = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>;
  } catch {
    /* start fresh */
  }

  const merged = { ...existing, ...updates } as PitmanSettings;
  const uri = vscode.Uri.joinPath(root, 'settings.json');
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(merged, null, 2), 'utf8'));
  return { ...DEFAULTS, ...merged };
}
