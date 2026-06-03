import * as vscode from 'vscode';
import {
  listCollections,
  loadCollection,
  saveCollection,
  createCollection,
  renameCollection,
  duplicateCollection,
  deleteCollection,
  createRequest,
  saveRequest,
  duplicateRequest,
  deleteRequest,
} from './collections';
import {
  loadEnvironments,
  loadRawEnvironment,
  createEnvironment,
  saveEnvironment,
  renameEnvironment,
  deleteEnvironment,
} from './environments';
import { loadSettings, saveSettings } from './settings';
import { initializePitmanWorkspace } from './initializer';
import {
  appendHistoryEntry,
  loadHistory,
  clearHistory,
  redactHeaders,
  generateHistoryId,
} from './history';
import { sendHttpRequest } from './http-client';
import { executeChain } from './chain';
import type { ChainStep } from './chain';
import type {
  HttpCollection,
  HttpEnvironment,
  HttpRequest,
  PitmanSettings,
  RawEnvironmentData,
} from './schemas';

// ── Types ────────────────────────────────────────────────────────────────────

interface WebviewState {
  collections: Record<string, HttpCollection>;
  environments: Record<string, HttpEnvironment>;
  settings: PitmanSettings;
  rootPath: string;
}

interface IncomingMessage {
  requestId?: string;
  type: string;
  [key: string]: unknown;
}

// ── Module-level panel & channel ─────────────────────────────────────────────

let panel: vscode.WebviewPanel | undefined;
let out: vscode.OutputChannel | undefined;

function log(msg: string): void {
  out ??= vscode.window.createOutputChannel('Pitman');
  out.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function send(payload: unknown): void {
  panel?.webview.postMessage(payload);
}

// ── Entry point ───────────────────────────────────────────────────────────────

/** Post a navigate message to the open Pitman panel. No-op if the panel is not open yet. */
export function navigatePitmanPanel(payload: {
  collectionId?: string;
  requestId?: string;
  envId?: string;
}): void {
  if (panel) {
    void panel.webview.postMessage({ type: 'navigate', ...payload });
  }
}

export async function openPitmanWebview(
  context: vscode.ExtensionContext,
  root: vscode.Uri,
): Promise<void> {
  log(`Opening. Root: ${root.fsPath}`);

  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    return;
  }

  const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');

  panel = vscode.window.createWebviewPanel('pitman', 'Pitman', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [mediaUri],
  });

  panel.onDidDispose(
    () => {
      panel = undefined;
    },
    null,
    context.subscriptions,
  );

  panel.webview.onDidReceiveMessage(
    async (msg: IncomingMessage) => {
      if (!panel) {
        return;
      }

      if (!msg.requestId) {
        if (msg.type === 'ready') {
          const state = await buildState(root);
          send({ type: 'state', payload: state });
        }
        return;
      }

      try {
        const data = await dispatch(msg, root);
        send({ requestId: msg.requestId, success: true, data });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log(`[${msg.type}] error: ${error}`);
        send({ requestId: msg.requestId, success: false, error });
      }
    },
    undefined,
    context.subscriptions,
  );

  const initialState = await buildState(root);
  const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'webview.js'));
  panel.webview.html = buildHtml(panel.webview, scriptUri, initialState);
  log('Webview ready.');
}

// ── State builder ─────────────────────────────────────────────────────────────

async function buildState(root: vscode.Uri): Promise<WebviewState> {
  const settings = await loadSettings(root);
  let ids = await listCollections(root);

  if (ids.length === 0) {
    log('No collections found — recreating workspace defaults.');
    await initializePitmanWorkspace(root);
    ids = await listCollections(root);
  }

  log(`Collections: [${ids.join(', ')}]`);

  const collections: Record<string, HttpCollection> = {};
  for (const id of ids) {
    try {
      collections[id] = await loadCollection(root, id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to load collection "${id}": ${msg}`);
      vscode.window.showErrorMessage(`Pitman: ${msg}`);
    }
  }

  const environments = await loadEnvironments(root);
  log(`Environments: [${Object.keys(environments).join(', ')}]`);

  return { collections, environments, settings, rootPath: root.fsPath };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function dispatch(msg: IncomingMessage, root: vscode.Uri): Promise<unknown> {
  switch (msg.type) {
    // ── Collections ──────────────────────────────────────────────────────────
    case 'createCollection': {
      const name = String(msg.name ?? 'New Collection');
      const id = await createCollection(root, name);
      log(`Created collection "${name}" → ${id}`);
      return { id, collections: await loadAllCollections(root) };
    }
    case 'renameCollection': {
      const oldId = String(msg.id);
      const newName = String(msg.newName);
      const newId = await renameCollection(root, oldId, newName);
      log(`Renamed collection ${oldId} → ${newId}`);
      return { id: newId, collections: await loadAllCollections(root) };
    }
    case 'duplicateCollection': {
      const id = String(msg.id);
      const newId = await duplicateCollection(root, id);
      log(`Duplicated collection ${id} → ${newId}`);
      return { id: newId, collections: await loadAllCollections(root) };
    }
    case 'deleteCollection': {
      const id = String(msg.id);
      await deleteCollection(root, id);
      log(`Deleted collection ${id}`);
      return { collections: await loadAllCollections(root) };
    }
    case 'refreshCollections': {
      return { collections: await loadAllCollections(root) };
    }
    case 'openCollectionFile': {
      const id = String(msg.id);
      const uri = vscode.Uri.joinPath(root, 'collections', `${id}.json`);
      await vscode.window.showTextDocument(uri);
      return {};
    }

    // ── Requests ─────────────────────────────────────────────────────────────
    case 'createRequest': {
      const collId = String(msg.collectionId);
      const req = await createRequest(root, collId);
      log(`Created request ${req.id} in ${collId}`);
      return { request: req, collection: await loadCollection(root, collId) };
    }
    case 'saveRequest': {
      const collId = String(msg.collectionId);
      const request = msg.request as HttpRequest;
      await saveRequest(root, collId, request);
      log(`Saved request ${request.id} in ${collId}`);
      return { collection: await loadCollection(root, collId) };
    }
    case 'duplicateRequest': {
      const collId = String(msg.collectionId);
      const reqId = String(msg.reqId);
      const req = await duplicateRequest(root, collId, reqId);
      log(`Duplicated request ${reqId} → ${req.id} in ${collId}`);
      return { request: req, collection: await loadCollection(root, collId) };
    }
    case 'deleteRequest': {
      const collId = String(msg.collectionId);
      const reqId = String(msg.reqId);
      await deleteRequest(root, collId, reqId);
      log(`Deleted request ${reqId} from ${collId}`);
      return { collection: await loadCollection(root, collId) };
    }

    // ── Environments ─────────────────────────────────────────────────────────
    case 'loadRawEnvironment': {
      const id = String(msg.id);
      const raw: RawEnvironmentData = await loadRawEnvironment(root, id);
      return raw;
    }
    case 'createEnvironment': {
      const name = String(msg.name ?? 'New Environment');
      const collId = String(msg.collectionId ?? '');
      const id = await createEnvironment(root, name);
      log(`Created environment "${name}" → ${id}`);
      // Automatically associate the new env with the requesting collection.
      if (collId) {
        const col = await loadCollection(root, collId);
        if (!col.environments) {
          col.environments = [];
        }
        if (!col.environments.includes(id)) {
          col.environments.push(id);
        }
        await saveCollection(root, collId, col);
      }
      return {
        id,
        collections: await loadAllCollections(root),
        environments: await loadEnvironments(root),
      };
    }
    case 'associateEnvironment': {
      const collId = String(msg.collectionId);
      const envId = String(msg.envId);
      const col = await loadCollection(root, collId);
      if (!col.environments) {
        col.environments = [];
      }
      if (!col.environments.includes(envId)) {
        col.environments.push(envId);
      }
      await saveCollection(root, collId, col);
      log(`Associated env ${envId} with collection ${collId}`);
      return { collections: await loadAllCollections(root) };
    }
    case 'disassociateEnvironment': {
      const collId = String(msg.collectionId);
      const envId = String(msg.envId);
      const col = await loadCollection(root, collId);
      col.environments = (col.environments ?? []).filter(e => e !== envId);
      await saveCollection(root, collId, col);
      log(`Disassociated env ${envId} from collection ${collId}`);
      return { collections: await loadAllCollections(root) };
    }
    case 'saveEnvironment': {
      const id = String(msg.id);
      const publicName = String(msg.publicName ?? id);
      const publicVars = (msg.publicVars ?? {}) as Record<string, string>;
      const privateVars = (msg.privateVars ?? {}) as Record<string, string>;
      await saveEnvironment(root, id, publicName, publicVars, privateVars);
      log(`Saved environment ${id}`);
      return { environments: await loadEnvironments(root) };
    }
    case 'renameEnvironment': {
      const oldId = String(msg.id);
      const newName = String(msg.newName);
      const collId = msg.collectionId ? String(msg.collectionId) : '';
      const newId = await renameEnvironment(root, oldId, newName);
      log(`Renamed environment ${oldId} → ${newId}`);
      // If the slug changed, update the collection's environments list.
      if (newId !== oldId && collId) {
        const col = await loadCollection(root, collId);
        col.environments = (col.environments ?? []).map(e => (e === oldId ? newId : e));
        await saveCollection(root, collId, col);
      }
      return {
        id: newId,
        collections: await loadAllCollections(root),
        environments: await loadEnvironments(root),
      };
    }
    case 'deleteEnvironment': {
      const id = String(msg.id);
      // Remove from all collections before deleting.
      const allIds = await listCollections(root);
      for (const cid of allIds) {
        try {
          const col = await loadCollection(root, cid);
          if (col.environments?.includes(id)) {
            col.environments = col.environments.filter(e => e !== id);
            await saveCollection(root, cid, col);
          }
        } catch {
          /* skip */
        }
      }
      await deleteEnvironment(root, id);
      log(`Deleted environment ${id}`);
      return {
        collections: await loadAllCollections(root),
        environments: await loadEnvironments(root),
      };
    }
    case 'openEnvironmentFile': {
      const id = String(msg.id);
      const type = msg.fileType === 'private' ? 'private' : 'public';
      const filename = type === 'private' ? `${id}.private.env.json` : `${id}.env.json`;
      const uri = vscode.Uri.joinPath(root, 'environments', filename);
      await vscode.window.showTextDocument(uri);
      return {};
    }

    // ── Settings ─────────────────────────────────────────────────────────────
    case 'saveSettings': {
      const updated = await saveSettings(root, msg.settings as Partial<PitmanSettings>);
      log('Settings saved.');
      return { settings: updated };
    }
    case 'openSettingsFile': {
      await vscode.window.showTextDocument(vscode.Uri.joinPath(root, 'settings.json'));
      return {};
    }

    // ── History ───────────────────────────────────────────────────────────────
    case 'listHistory': {
      const entries = await loadHistory(root);
      return { entries };
    }
    case 'clearHistory': {
      await clearHistory(root);
      log('History cleared.');
      return {};
    }
    case 'rerunHistoryEntry': {
      // Re-sends the original request from history. The webview sends the
      // stored request/env back; we treat it as a fresh sendRequest.
      const request = msg.request as HttpRequest;
      const environmentId = String(msg.environmentId);
      const envs = await loadEnvironments(root);
      const settings = await loadSettings(root);
      const vars = envs[environmentId]?.variables ?? {};
      const response = await sendHttpRequest(request, vars, settings);
      return { response };
    }

    // ── Request execution ─────────────────────────────────────────────────────
    case 'sendRequest': {
      const request = msg.request as HttpRequest;
      const environmentId = String(msg.environmentId);
      const collectionId = String(msg.collectionId ?? '');
      const fresh = await buildState(root);
      const vars = fresh.environments[environmentId]?.variables ?? {};

      // Build name → request map across all collections for chain resolution.
      const allRequests = new Map<string, HttpRequest>();
      for (const col of Object.values(fresh.collections)) {
        for (const req of col.requests) {
          allRequests.set(req.name, req);
        }
      }

      // Resolve chain dependencies (runs upstream requests as needed),
      // then send the fully substituted main request.
      const { resolved, steps } = await executeChain(request, allRequests, vars, fresh.settings);
      log(`Chain: ${steps.length} upstream step(s) before "${request.name}"`);

      const response = await sendHttpRequest(resolved, vars, fresh.settings);

      // Write history entry (redact sensitive headers before storing)
      const entry = {
        id: generateHistoryId(),
        timestamp: new Date().toISOString(),
        collectionId,
        requestId: request.id,
        environmentId,
        method: request.method,
        url: response.resolvedUrl,
        requestHeaders: redactHeaders(response.requestHeaders, fresh.settings.redactHeaders),
        status: response.status,
        statusText: response.statusText,
        durationMs: response.durationMs,
        sizeBytes: response.sizeBytes,
        responseHeaders: redactHeaders(response.headers, fresh.settings.redactHeaders),
        responseBodyPreview: response.body.slice(0, fresh.settings.historyBodyPreviewLimit),
      };
      await appendHistoryEntry(root, entry);

      return { response, chainSteps: steps as ChainStep[] };
    }

    // ── File picker ────────────────────────────────────────────────────────────
    case 'selectFileForMultipart': {
      const uris = await vscode.window.showOpenDialog({ canSelectMany: false });
      if (!uris || uris.length === 0) {
        return { filePath: null };
      }
      return { filePath: uris[0].fsPath };
    }

    // ── Full state refresh ────────────────────────────────────────────────────
    case 'getInitialState': {
      return await buildState(root);
    }

    default:
      throw new Error(`Unknown message type: "${msg.type}"`);
  }
}

async function loadAllCollections(root: vscode.Uri): Promise<Record<string, HttpCollection>> {
  const ids = await listCollections(root);
  const result: Record<string, HttpCollection> = {};
  for (const id of ids) {
    try {
      result[id] = await loadCollection(root, id);
    } catch {
      /* skip */
    }
  }
  return result;
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  initialState: WebviewState,
): string {
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline'`,
    `script-src ${webview.cspSource}`,
    `frame-src 'self' blob:`,
  ].join('; ');

  const stateJson = JSON.stringify(initialState)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Pitman</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);height:100vh;display:flex;flex-direction:column;overflow:hidden}

/* Buttons */
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:2px;padding:3px 10px;cursor:pointer;font-size:var(--vscode-font-size);font-family:inherit;white-space:nowrap}
button:hover{background:var(--vscode-button-hoverBackground)}
button:disabled{opacity:.5;cursor:not-allowed}
button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.sec:hover{background:var(--vscode-button-secondaryHoverBackground)}
button.danger{background:var(--vscode-inputValidation-errorBackground,#5a1d1d);color:var(--vscode-inputValidation-errorForeground,#f48771)}
button.danger:hover{filter:brightness(1.15)}
button.link{background:none;color:var(--vscode-textLink-foreground);padding:0;text-decoration:underline}
button.link:hover{color:var(--vscode-textLink-activeForeground)}
button.icon{background:none;color:var(--vscode-foreground);padding:2px 5px;border-radius:2px;font-size:14px}
button.icon:hover{background:var(--vscode-toolbar-hoverBackground)}

/* Inputs */
select,input,textarea{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:2px;padding:3px 6px;font-family:inherit;font-size:inherit;outline:none}
select:focus,input:focus,textarea:focus{border-color:var(--vscode-focusBorder)}
textarea{resize:vertical}

/* Toolbar */
#toolbar{display:flex;gap:4px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;flex-wrap:wrap;background:var(--vscode-editor-background)}
.tb-group{display:flex;align-items:center;gap:3px}
.tb-sep{color:var(--vscode-panel-border);margin:0 4px;user-select:none}
.tb-label{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}
#toolbar select{max-width:150px}

/* URL bar */
#url-bar{display:flex;gap:5px;align-items:center;padding:5px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
#method-select{width:95px;flex-shrink:0}
#url-input{flex:1;font-family:var(--vscode-editor-font-family,monospace)}
#spinner{display:none;font-size:11px;color:var(--vscode-descriptionForeground)}

/* Main layout — right pane hidden until first response */
#main{display:flex;flex:1;overflow:hidden}
#left-pane{width:100%;display:flex;flex-direction:column;overflow:hidden;transition:width .1s}
#right-pane{display:none;width:50%;flex-direction:column;overflow:hidden}
#main.panel-open #left-pane{width:50%;border-right:1px solid var(--vscode-panel-border)}
#main.panel-open #right-pane{display:flex}

/* Req name bar */
#req-name-bar{display:flex;gap:5px;align-items:center;padding:5px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
#req-name-input{flex:1;font-weight:500}
#dirty-dot{color:var(--vscode-editorWarning-foreground,#e2c08d);font-size:16px;line-height:1;display:none;cursor:default}
#dirty-dot[data-dirty="true"]{display:inline}

/* Tab bars */
.tab-bar{display:flex;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;overflow-x:auto}
.tab{padding:5px 12px;cursor:pointer;border-bottom:2px solid transparent;font-size:12px;color:var(--vscode-tab-inactiveForeground);white-space:nowrap;user-select:none}
.tab:hover{color:var(--vscode-tab-activeForeground)}
.tab.active{color:var(--vscode-tab-activeForeground);border-bottom-color:var(--vscode-focusBorder)}
.tab-content{flex:1;overflow:auto;padding:8px;display:none;flex-direction:column;gap:5px}
.tab-content.active{display:flex}

/* KV tables */
.kv-row{display:flex;gap:3px;align-items:center;min-height:24px}
.kv-row input[type=text]{flex:1;min-width:0}
.kv-row input.key{max-width:150px}
.add-row-btn{align-self:flex-start;margin-top:2px}

/* Auth / Body controls */
.field-row{display:flex;gap:6px;align-items:center;margin-bottom:4px}
.field-row label{font-size:11px;color:var(--vscode-descriptionForeground);min-width:70px}
.field-row select,.field-row input{flex:1}
.section-label{font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);margin-bottom:4px;margin-top:8px}
.section-label:first-child{margin-top:0}

/* Response panel header */
#response-panel-hdr{display:flex;align-items:center;padding:3px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;gap:4px}
#response-status{flex:1;font-size:12px;font-family:var(--vscode-editor-font-family,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status-ok{color:var(--vscode-testing-iconPassed,#4caf50)}
.status-warn{color:var(--vscode-editorWarning-foreground,#ff9800)}
.status-err{color:var(--vscode-testing-iconFailed,#f44336)}
.empty-hint{color:var(--vscode-descriptionForeground);font-size:12px}
pre{font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,12px);white-space:pre-wrap;word-break:break-all;margin:0}
.resp-hdr-table{width:100%;border-collapse:collapse;font-size:12px;font-family:var(--vscode-editor-font-family,monospace)}
.resp-hdr-table td{padding:2px 6px;border-bottom:1px solid var(--vscode-panel-border);word-break:break-all}
.resp-hdr-table td:first-child{color:var(--vscode-descriptionForeground);width:35%;word-break:normal;white-space:nowrap}
/* Code preview with syntax highlighting */
.code-preview{font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,12px);background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);white-space:pre-wrap;word-break:break-all;margin:0}
.json-key{color:var(--vscode-symbolIcon-propertyForeground,#9CDCFE)}
.json-string{color:var(--vscode-debugTokenExpression-string,#CE9178)}
.json-number{color:var(--vscode-debugTokenExpression-number,#B5CEA8)}
.json-boolean,.json-null{color:var(--vscode-debugTokenExpression-boolean,#569CD6)}
.xml-tag{color:var(--vscode-symbolIcon-classForeground,#4EC9B0)}
.xml-attr-name{color:var(--vscode-symbolIcon-propertyForeground,#9CDCFE)}
.xml-attr-val{color:var(--vscode-debugTokenExpression-string,#CE9178)}
/* Preview iframe */
#preview-iframe{width:100%;flex:1;border:none;background:#fff;min-height:200px}
/* History entries in response panel */
.resp-hist-row{padding:4px 6px;border-bottom:1px solid var(--vscode-panel-border);font-size:12px;cursor:pointer;display:flex;gap:8px;align-items:baseline}
.resp-hist-row:hover{background:var(--vscode-list-hoverBackground)}
.resp-hist-method{font-family:var(--vscode-editor-font-family,monospace);font-weight:600;min-width:46px}
.resp-hist-meta{color:var(--vscode-descriptionForeground);font-size:11px}

/* Modals */
dialog{background:var(--vscode-editor-background);color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border);border-radius:4px;padding:0;max-width:90vw;max-height:90vh;box-shadow:0 4px 24px rgba(0,0,0,.4)}
dialog::backdrop{background:rgba(0,0,0,.5)}
.dlg-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);font-weight:600;font-size:13px}
.dlg-body{display:flex;overflow:hidden;height:calc(90vh - 100px)}
.dlg-footer{padding:8px 14px;border-top:1px solid var(--vscode-panel-border);display:flex;gap:6px;justify-content:flex-end}

/* Collection manager */
#col-mgr{width:560px}
.col-mgr-list{width:180px;border-right:1px solid var(--vscode-panel-border);overflow-y:auto;padding:6px}
.col-mgr-detail{flex:1;padding:10px 12px;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.list-item{padding:5px 8px;border-radius:3px;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:4px}
.list-item:hover{background:var(--vscode-list-hoverBackground)}
.list-item.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.list-item-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Env manager */
#env-mgr{width:680px}
.env-mgr-list{width:160px;border-right:1px solid var(--vscode-panel-border);overflow-y:auto;padding:6px}
.env-mgr-detail{flex:1;padding:10px 12px;overflow-y:auto;display:flex;flex-direction:column;gap:6px}

/* Settings */
#settings-dlg{width:440px}
.settings-form{padding:14px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;max-height:70vh}
.settings-row{display:flex;align-items:center;gap:8px}
.settings-row label{min-width:170px;font-size:12px;color:var(--vscode-descriptionForeground)}
.settings-row input,.settings-row select{flex:1}
.settings-row input[type=checkbox]{flex:0}
.redact-list{display:flex;flex-direction:column;gap:3px}
.redact-item{display:flex;gap:4px;align-items:center}
.redact-item input{flex:1}

/* History */
#history-dlg{width:800px}
.hist-toolbar{padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);display:flex;gap:6px;align-items:center;flex-shrink:0}
.hist-split{display:flex;flex:1;overflow:hidden}
.hist-list{width:340px;border-right:1px solid var(--vscode-panel-border);overflow-y:auto}
.hist-detail{flex:1;padding:10px;overflow-y:auto;font-size:12px}
.hist-row{padding:5px 8px;border-bottom:1px solid var(--vscode-panel-border);cursor:pointer;font-size:12px}
.hist-row:hover{background:var(--vscode-list-hoverBackground)}
.hist-row.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.hist-method{display:inline-block;width:50px;font-weight:600;font-family:var(--vscode-editor-font-family,monospace);font-size:11px}
.hist-status{display:inline-block;width:40px;font-family:var(--vscode-editor-font-family,monospace);font-size:11px}
.hist-url{color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;display:inline-block;vertical-align:middle}
.hist-meta{font-size:10px;color:var(--vscode-descriptionForeground)}
.detail-section{margin-bottom:8px}
.detail-section h4{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:3px;font-weight:600}
</style>
</head>
<body>

<script id="initial-state" type="application/json">${stateJson}</script>

<!-- ── Toolbar ───────────────────────────────────────────────────────────── -->
<div id="toolbar">
  <span class="tb-group">
    <span class="tb-label">Collection</span>
    <select id="collection-select"></select>
    <button class="sec" id="btn-col-manage">Manage</button>
  </span>
  <span class="tb-sep">|</span>
  <span class="tb-group">
    <span class="tb-label">Request</span>
    <select id="request-select"></select>
    <button class="sec" id="btn-req-new" title="New request">New</button>
    <button class="sec" id="btn-req-dup" title="Duplicate request">Dup</button>
    <button class="sec danger" id="btn-req-del" title="Delete request">Del</button>
  </span>
  <span class="tb-sep">|</span>
  <span class="tb-group">
    <span class="tb-label">Env</span>
    <select id="env-select"></select>
    <button class="sec" id="btn-env-manage">Manage</button>
  </span>
  <span class="tb-sep" style="flex:1"></span>
  <button class="sec" id="btn-history">History</button>
  <button class="sec icon" id="btn-settings" title="Settings">⚙</button>
</div>

<!-- ── URL bar ───────────────────────────────────────────────────────────── -->
<div id="url-bar">
  <select id="method-select">
    <option>GET</option><option>POST</option><option>PUT</option>
    <option>PATCH</option><option>DELETE</option><option>HEAD</option><option>OPTIONS</option>
  </select>
  <input id="url-input" type="text" placeholder="{{baseUrl}}/path"/>
  <button id="send-btn">Send</button>
  <span id="spinner">Sending…</span>
</div>

<!-- ── Main ──────────────────────────────────────────────────────────────── -->
<div id="main">
  <!-- Left pane: request editor -->
  <div id="left-pane">
    <div id="req-name-bar">
      <input id="req-name-input" type="text" placeholder="Request name"/>
      <span id="dirty-dot" title="Unsaved changes">●</span>
      <button class="sec" id="btn-save-req">Save</button>
    </div>
    <div class="tab-bar" id="left-tabs">
      <div class="tab active" data-tab="params">Params</div>
      <div class="tab" data-tab="req-headers">Headers</div>
      <div class="tab" data-tab="auth">Auth</div>
      <div class="tab" data-tab="body">Body</div>
      <div class="tab" data-tab="docs">Docs</div>
    </div>

    <div class="tab-content active" id="tab-params">
      <div id="params-rows"></div>
      <button class="sec add-row-btn" id="add-param">+ Add</button>
    </div>

    <div class="tab-content" id="tab-req-headers">
      <div id="headers-rows"></div>
      <button class="sec add-row-btn" id="add-header">+ Add</button>
    </div>

    <div class="tab-content" id="tab-auth">
      <div class="field-row">
        <label>Type</label>
        <select id="auth-type" style="max-width:160px">
          <option value="none">None</option>
          <option value="bearer">Bearer Token</option>
          <option value="basic">Basic Auth</option>
          <option value="apiKey">API Key</option>
        </select>
      </div>
      <div id="auth-fields"></div>
    </div>

    <div class="tab-content" id="tab-body">
      <div class="field-row">
        <label>Type</label>
        <select id="body-type" style="max-width:160px">
          <option value="none">None</option>
          <option value="json">JSON</option>
          <option value="text">Text</option>
          <option value="form">Form URL-encoded</option>
          <option value="multipart">Multipart</option>
        </select>
      </div>
      <div id="body-type-controls" style="display:flex;gap:4px;margin-bottom:4px"></div>
      <div id="body-fields" style="flex:1;display:flex;flex-direction:column"></div>
    </div>

    <div class="tab-content" id="tab-docs">
      <textarea id="docs-input" style="flex:1;width:100%;min-height:200px"
        placeholder="Markdown notes about this request…"></textarea>
    </div>
  </div>

  <!-- Right pane: response viewer (hidden until first response) -->
  <div id="right-pane">
    <div id="response-panel-hdr">
      <div id="response-status"></div>
      <button class="icon" id="resp-panel-close" title="Close response panel">✕</button>
    </div>
    <div class="tab-bar" id="right-tabs">
      <div class="tab active" data-tab="preview">Preview</div>
      <div class="tab" data-tab="raw">Raw</div>
      <div class="tab" data-tab="resp-headers">Headers</div>
      <div class="tab" data-tab="timing">Timing</div>
      <div class="tab" data-tab="resp-tests">Tests</div>
      <div class="tab" data-tab="resp-history">History</div>
    </div>
    <div class="tab-content active" id="tab-preview">
      <div id="preview-container" style="flex:1;overflow:auto;display:flex;flex-direction:column"></div>
    </div>
    <div class="tab-content" id="tab-raw"><pre id="raw-body"></pre></div>
    <div class="tab-content" id="tab-resp-headers">
      <div class="section-label" style="margin-bottom:4px">Request Headers</div>
      <table class="resp-hdr-table" style="margin-bottom:10px"><tbody id="req-hdr-body"></tbody></table>
      <div class="section-label" style="margin-bottom:4px">Response Headers</div>
      <table class="resp-hdr-table"><tbody id="resp-hdr-body"></tbody></table>
    </div>
    <div class="tab-content" id="tab-timing"><pre id="timing-info"></pre></div>
    <div class="tab-content" id="tab-resp-tests">
      <span class="empty-hint" id="tests-placeholder">No test assertions are defined for this request.</span>
    </div>
    <div class="tab-content" id="tab-resp-history">
      <div id="resp-history-list" style="flex:1;overflow:auto"></div>
    </div>
  </div>
</div>

<!-- ── Collection Manager ────────────────────────────────────────────────── -->
<dialog id="col-mgr">
  <div class="dlg-header">
    <span>Collection Manager</span>
    <button class="icon" id="col-mgr-close">✕</button>
  </div>
  <div class="dlg-body">
    <div class="col-mgr-list" id="col-mgr-list"></div>
    <div class="col-mgr-detail" id="col-mgr-detail">
      <span class="empty-hint">Select a collection.</span>
    </div>
  </div>
  <div class="dlg-footer">
    <button class="sec" id="col-mgr-new">+ New Collection</button>
  </div>
</dialog>

<!-- ── Environment Manager ───────────────────────────────────────────────── -->
<dialog id="env-mgr">
  <div class="dlg-header">
    <span>Environment Manager</span>
    <button class="icon" id="env-mgr-close">✕</button>
  </div>
  <div class="dlg-body">
    <div class="env-mgr-list" id="env-mgr-list"></div>
    <div class="env-mgr-detail" id="env-mgr-detail">
      <span class="empty-hint">Select an environment.</span>
    </div>
  </div>
  <div class="dlg-footer">
    <button class="sec" id="env-mgr-assoc" style="display:none">Associate existing…</button>
    <button class="sec" id="env-mgr-new">+ New Environment</button>
  </div>
</dialog>

<!-- ── Settings ──────────────────────────────────────────────────────────── -->
<dialog id="settings-dlg">
  <div class="dlg-header">
    <span>Settings</span>
    <button class="icon" id="settings-close">✕</button>
  </div>
  <div class="settings-form" id="settings-form"></div>
  <div class="dlg-footer">
    <button class="sec" id="settings-open-file">Open File</button>
    <button class="sec" id="settings-cancel">Cancel</button>
    <button id="settings-save">Save</button>
  </div>
</dialog>

<!-- ── History ────────────────────────────────────────────────────────────── -->
<dialog id="history-dlg">
  <div class="dlg-header">
    <span>History</span>
    <button class="icon" id="history-close">✕</button>
  </div>
  <div class="hist-toolbar">
    <select id="hist-filter-status" style="width:130px">
      <option value="">All statuses</option>
      <option value="2">2xx</option>
      <option value="3">3xx</option>
      <option value="4">4xx</option>
      <option value="5">5xx</option>
      <option value="err">Errors</option>
    </select>
    <input id="hist-filter-text" type="text" placeholder="Filter URL…" style="flex:1"/>
    <button class="sec danger" id="history-clear">Clear History</button>
  </div>
  <div class="hist-split" style="height:calc(90vh - 150px)">
    <div class="hist-list" id="hist-list"></div>
    <div class="hist-detail" id="hist-detail"><span class="empty-hint">Select an entry.</span></div>
  </div>
</dialog>

<!-- ── Custom prompt dialog ───────────────────────────────────────────────── -->
<dialog id="prompt-dlg" style="width:320px;padding:0;border-radius:4px">
  <div class="dlg-header">
    <span id="prompt-title">Input</span>
    <button class="icon" id="prompt-cancel-x">✕</button>
  </div>
  <div style="padding:12px 14px">
    <div id="prompt-msg" style="margin-bottom:8px;font-size:12px"></div>
    <input id="prompt-input" type="text" style="width:100%"/>
  </div>
  <div class="dlg-footer">
    <button class="sec" id="prompt-cancel">Cancel</button>
    <button id="prompt-ok">OK</button>
  </div>
</dialog>

<!-- ── Custom confirm dialog ─────────────────────────────────────────────── -->
<dialog id="confirm-dlg" style="width:320px;padding:0;border-radius:4px">
  <div class="dlg-header">
    <span id="confirm-title">Confirm</span>
  </div>
  <div style="padding:12px 14px;font-size:12px" id="confirm-msg"></div>
  <div class="dlg-footer">
    <button class="sec" id="confirm-no">Cancel</button>
    <button class="danger" id="confirm-yes">Confirm</button>
  </div>
</dialog>

<script src="${scriptUri}"></script>
</body>
</html>`;
}
