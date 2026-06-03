import * as vscode from 'vscode';
import type { HttpEnvironment, RawEnvironmentData } from './schemas';
import { slugify } from './collections';

interface EnvFile {
  name: string;
  variables: Record<string, string>;
}

async function readJson<T>(uri: vscode.Uri): Promise<T> {
  const raw = await vscode.workspace.fs.readFile(uri);
  return JSON.parse(Buffer.from(raw).toString('utf8')) as T;
}

async function writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function uniqueEnvSlug(root: vscode.Uri, base: string): Promise<string> {
  const dir = vscode.Uri.joinPath(root, 'environments');
  let slug = base;
  let i = 2;
  for (;;) {
    if (!(await fileExists(vscode.Uri.joinPath(dir, `${slug}.env.json`)))) {
      return slug;
    }
    slug = `${base}-${i++}`;
  }
}

/** Returns merged environments (public + private) for the main webview state. */
export async function loadEnvironments(root: vscode.Uri): Promise<Record<string, HttpEnvironment>> {
  const dir = vscode.Uri.joinPath(root, 'environments');
  let entries: [string, vscode.FileType][] = [];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return {};
  }

  const publicFiles = entries.filter(
    ([n, t]) =>
      t === vscode.FileType.File && n.endsWith('.env.json') && !n.endsWith('.private.env.json'),
  );
  const privateFiles = entries.filter(
    ([n, t]) => t === vscode.FileType.File && n.endsWith('.private.env.json'),
  );

  const result: Record<string, HttpEnvironment> = {};

  for (const [name] of publicFiles) {
    const logicalId = name.replace(/\.env\.json$/, '');
    try {
      const env = await readJson<EnvFile>(vscode.Uri.joinPath(dir, name));
      result[logicalId] = { name: env.name, variables: { ...env.variables } };
    } catch {
      /* skip corrupt */
    }
  }

  for (const [name] of privateFiles) {
    const logicalId = name.replace(/\.private\.env\.json$/, '');
    try {
      const env = await readJson<EnvFile>(vscode.Uri.joinPath(dir, name));
      if (result[logicalId]) {
        result[logicalId].variables = { ...result[logicalId].variables, ...env.variables };
      } else {
        result[logicalId] = { name: env.name, variables: { ...env.variables } };
      }
    } catch {
      /* skip corrupt */
    }
  }

  return result;
}

/** Returns the raw (unmerged) public+private data for the Environment Manager. */
export async function loadRawEnvironment(
  root: vscode.Uri,
  id: string,
): Promise<RawEnvironmentData> {
  const dir = vscode.Uri.joinPath(root, 'environments');
  const publicUri = vscode.Uri.joinPath(dir, `${id}.env.json`);
  const privateUri = vscode.Uri.joinPath(dir, `${id}.private.env.json`);

  let publicName = id;
  let publicVars: Record<string, string> = {};
  let privateVars: Record<string, string> = {};
  const hasPrivateFile = await fileExists(privateUri);

  try {
    const pub = await readJson<EnvFile>(publicUri);
    publicName = pub.name;
    publicVars = pub.variables ?? {};
  } catch {
    /* missing or corrupt, start empty */
  }

  if (hasPrivateFile) {
    try {
      const priv = await readJson<EnvFile>(privateUri);
      privateVars = priv.variables ?? {};
    } catch {
      /* missing or corrupt */
    }
  }

  return { publicName, publicVars, privateVars, hasPrivateFile };
}

export async function createEnvironment(root: vscode.Uri, name: string): Promise<string> {
  const base = slugify(name);
  const id = await uniqueEnvSlug(root, base);
  const uri = vscode.Uri.joinPath(root, 'environments', `${id}.env.json`);
  await writeJson(uri, { name, variables: {} });
  return id;
}

export async function saveEnvironment(
  root: vscode.Uri,
  id: string,
  publicName: string,
  publicVars: Record<string, string>,
  privateVars: Record<string, string>,
): Promise<void> {
  const dir = vscode.Uri.joinPath(root, 'environments');
  await writeJson(vscode.Uri.joinPath(dir, `${id}.env.json`), {
    name: publicName,
    variables: publicVars,
  });
  if (Object.keys(privateVars).length > 0) {
    await writeJson(vscode.Uri.joinPath(dir, `${id}.private.env.json`), {
      name: publicName + ' Private',
      variables: privateVars,
    });
  }
}

export async function renameEnvironment(
  root: vscode.Uri,
  oldId: string,
  newName: string,
): Promise<string> {
  const raw = await loadRawEnvironment(root, oldId);
  const newBase = slugify(newName);
  const newId = newBase === oldId ? oldId : await uniqueEnvSlug(root, newBase);

  if (newId !== oldId) {
    // Move public file
    const oldPub = vscode.Uri.joinPath(root, 'environments', `${oldId}.env.json`);
    const newPub = vscode.Uri.joinPath(root, 'environments', `${newId}.env.json`);
    await writeJson(newPub, { name: newName, variables: raw.publicVars });
    await vscode.workspace.fs.delete(oldPub);

    // Move private file if it exists
    if (raw.hasPrivateFile) {
      const oldPriv = vscode.Uri.joinPath(root, 'environments', `${oldId}.private.env.json`);
      const newPriv = vscode.Uri.joinPath(root, 'environments', `${newId}.private.env.json`);
      await writeJson(newPriv, { name: newName + ' Private', variables: raw.privateVars });
      await vscode.workspace.fs.delete(oldPriv);
    }
  } else {
    // Same slug, just update the name
    await writeJson(vscode.Uri.joinPath(root, 'environments', `${oldId}.env.json`), {
      name: newName,
      variables: raw.publicVars,
    });
  }

  return newId;
}

export async function deleteEnvironment(root: vscode.Uri, id: string): Promise<void> {
  const dir = vscode.Uri.joinPath(root, 'environments');
  try {
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, `${id}.env.json`));
  } catch {
    /* already gone */
  }
  try {
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, `${id}.private.env.json`));
  } catch {
    /* no private file */
  }
}
