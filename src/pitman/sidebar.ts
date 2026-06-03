import * as vscode from 'vscode';
import { resolvePitmanRoot } from './workspace';
import { listCollections, loadCollection } from './collections';
import { loadEnvironments } from './environments';
import { loadHistory } from './history';

// ── Slim data types for the navigator ────────────────────────────────────────

interface SidebarRequest {
  id: string;
  name: string;
  method: string;
}

interface SidebarCollection {
  id: string;
  name: string;
  requests: SidebarRequest[];
}

interface SidebarEnvironment {
  id: string;
  name: string;
}

interface SidebarHistoryEntry {
  id: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  timestamp: string;
  collectionId: string;
  requestId: string;
  environmentId: string;
}

interface SidebarState {
  rootPath: string;
  collections: SidebarCollection[];
  environments: SidebarEnvironment[];
  history: SidebarHistoryEntry[];
}

// ── Data loader ───────────────────────────────────────────────────────────────

async function loadSidebarState(context: vscode.ExtensionContext): Promise<SidebarState> {
  const root = resolvePitmanRoot(context);
  const rootPath = root.fsPath;

  const collectionIds = await listCollections(root);
  const collections: SidebarCollection[] = [];
  for (const id of collectionIds) {
    try {
      const col = await loadCollection(root, id);
      collections.push({
        id,
        name: col.name,
        requests: col.requests.map(r => ({ id: r.id, name: r.name, method: r.method })),
      });
    } catch {
      /* skip corrupt */
    }
  }

  const envMap = await loadEnvironments(root);
  const environments: SidebarEnvironment[] = Object.entries(envMap).map(([id, env]) => ({
    id,
    name: env.name,
  }));

  const allHistory = await loadHistory(root);
  const history: SidebarHistoryEntry[] = allHistory.slice(0, 10).map(e => ({
    id: e.id,
    method: e.method,
    url: e.url,
    status: e.status,
    durationMs: e.durationMs,
    timestamp: e.timestamp,
    collectionId: e.collectionId,
    requestId: e.requestId,
    environmentId: e.environmentId,
  }));

  return { rootPath, collections, environments, history };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export type SidebarNavigateMessage =
  | { type: 'selectRequest'; collectionId: string; requestId: string }
  | { type: 'selectEnvironment'; envId: string }
  | { type: 'open' }
  | { type: 'refresh' };

export class PitmanSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private onNavigate?: (msg: SidebarNavigateMessage) => void;

  constructor(private readonly context: vscode.ExtensionContext) {}

  setNavigateHandler(handler: (msg: SidebarNavigateMessage) => void): void {
    this.onNavigate = handler;
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }
    const state = await loadSidebarState(this.context);
    void this.view.webview.postMessage({ type: 'state', payload: state });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = buildNavigatorHtml();

    // Load and push data when the sidebar becomes visible.
    const pushState = () => {
      loadSidebarState(this.context)
        .then(state => webviewView.webview.postMessage({ type: 'state', payload: state }))
        .catch(() => {
          /* ignore */
        });
    };

    webviewView.webview.onDidReceiveMessage(
      (msg: SidebarNavigateMessage | { type: 'ready' }) => {
        if (msg.type === 'ready') {
          pushState();
          return;
        }
        if (this.onNavigate) {
          this.onNavigate(msg as SidebarNavigateMessage);
        }
      },
      undefined,
      this.context.subscriptions,
    );

    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) {
          pushState();
        }
      },
      undefined,
      this.context.subscriptions,
    );
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function buildNavigatorHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:var(--vscode-font-family);
  font-size:var(--vscode-font-size,13px);
  color:var(--vscode-foreground);
  background:var(--vscode-sideBar-background,var(--vscode-editor-background));
  overflow-y:auto;height:100vh;
}

/* Header */
#header{
  display:flex;align-items:center;gap:4px;
  padding:6px 8px;
  border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,var(--vscode-panel-border));
}
#btn-open{
  flex:1;
  background:var(--vscode-button-background);
  color:var(--vscode-button-foreground);
  border:none;border-radius:2px;padding:4px 8px;
  cursor:pointer;font-size:12px;font-family:inherit;text-align:center;
}
#btn-open:hover{background:var(--vscode-button-hoverBackground)}
#btn-refresh{
  background:none;border:none;color:var(--vscode-foreground);
  padding:3px 5px;cursor:pointer;border-radius:2px;font-size:14px;line-height:1;
}
#btn-refresh:hover{background:var(--vscode-toolbar-hoverBackground)}

/* Root path */
#root-path{
  font-size:10px;color:var(--vscode-descriptionForeground);
  padding:4px 8px 3px;
  border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,var(--vscode-panel-border));
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  cursor:default;
}

/* Sections */
.section-hdr{
  display:flex;align-items:center;gap:4px;
  padding:4px 8px;
  font-size:11px;font-weight:700;
  letter-spacing:.06em;text-transform:uppercase;
  color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-foreground));
  background:var(--vscode-sideBarSectionHeader-background,transparent);
  cursor:pointer;user-select:none;
  border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,transparent);
}
.section-hdr:hover{background:var(--vscode-list-hoverBackground)}
.chev{font-size:10px;width:10px;flex-shrink:0;transition:transform .1s;display:inline-block}
.chev.open{transform:rotate(90deg)}
.section-body{overflow:hidden}
.section-body.collapsed{display:none}

/* Tree items */
.col-hdr{
  display:flex;align-items:center;gap:4px;
  padding:3px 8px 3px 14px;
  cursor:pointer;font-size:12px;
}
.col-hdr:hover{background:var(--vscode-list-hoverBackground)}
.col-chev{font-size:9px;width:9px;flex-shrink:0;transition:transform .1s;display:inline-block}
.col-chev.open{transform:rotate(90deg)}
.col-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.req-item{
  display:flex;align-items:center;gap:5px;
  padding:2px 8px 2px 28px;
  cursor:pointer;font-size:12px;
}
.req-item:hover{background:var(--vscode-list-hoverBackground)}
.req-item.active{
  background:var(--vscode-list-activeSelectionBackground);
  color:var(--vscode-list-activeSelectionForeground);
}
.method{
  font-family:var(--vscode-editor-font-family,monospace);
  font-size:9px;font-weight:700;
  min-width:30px;flex-shrink:0;
}
.m-GET{color:#4CAF50}.m-POST{color:#2196F3}.m-PUT{color:#FF9800}
.m-PATCH{color:#9C27B0}.m-DELETE{color:#F44336}
.m-HEAD,.m-OPTIONS{color:var(--vscode-descriptionForeground)}
.req-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}

.env-item{
  display:flex;align-items:center;gap:5px;
  padding:2px 8px 2px 22px;
  cursor:pointer;font-size:12px;
}
.env-item:hover{background:var(--vscode-list-hoverBackground)}
.env-item.active{
  background:var(--vscode-list-activeSelectionBackground);
  color:var(--vscode-list-activeSelectionForeground);
}
.env-icon{font-size:11px;flex-shrink:0;color:var(--vscode-descriptionForeground)}
.env-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.hist-item{
  display:flex;align-items:baseline;gap:5px;
  padding:2px 8px 2px 22px;
  cursor:pointer;font-size:11px;
}
.hist-item:hover{background:var(--vscode-list-hoverBackground)}
.hist-method{
  font-family:var(--vscode-editor-font-family,monospace);
  font-size:9px;font-weight:700;min-width:30px;flex-shrink:0;
}
.hist-url{
  flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--vscode-descriptionForeground);
}
.hist-status{font-size:9px;flex-shrink:0;font-family:monospace}
.s-ok{color:#4CAF50}.s-warn{color:#FF9800}.s-err{color:#F44336}

.empty{
  padding:6px 8px 6px 22px;
  font-size:11px;color:var(--vscode-descriptionForeground);
}
#loading{padding:12px 8px;font-size:12px;color:var(--vscode-descriptionForeground)}
</style>
</head>
<body>

<div id="header">
  <button id="btn-open">Open Pitman</button>
  <button id="btn-refresh" title="Refresh">↺</button>
</div>
<div id="root-path" title="Pitman root">Loading…</div>
<div id="content"><div id="loading">Loading…</div></div>

<script>
(function () {
  var vscode = acquireVsCodeApi();
  var state = null;

  // ── Section toggle state ─────────────────────────────────────────────────
  var collapsed = { collections: false, environments: false, history: true };
  var collExpanded = {};

  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function render(s) {
    state = s;
    document.getElementById('root-path').textContent = s.rootPath;
    document.getElementById('root-path').title = s.rootPath;

    var html = '';

    // ── Collections ──────────────────────────────────────────────────────
    html += section('collections', 'Collections', function () {
      if (!s.collections || s.collections.length === 0) {
        return '<div class="empty">No collections</div>';
      }
      return s.collections.map(function (col) {
        var expanded = collExpanded[col.id] !== false; // default open
        var reqsHtml = (col.requests || []).map(function (r) {
          var mClass = 'm-' + (r.method || 'GET');
          return '<div class="req-item" data-col="' + esc(col.id) + '" data-req="' + esc(r.id) + '">' +
            '<span class="method ' + mClass + '">' + esc(r.method) + '</span>' +
            '<span class="req-name">' + esc(r.name) + '</span></div>';
        }).join('');
        if (col.requests && col.requests.length === 0) {
          reqsHtml = '<div class="empty">No requests</div>';
        }
        return '<div class="col-hdr" data-col-toggle="' + esc(col.id) + '">' +
          '<span class="col-chev' + (expanded ? ' open' : '') + '">▶</span>' +
          '<span class="col-name">' + esc(col.name) + '</span></div>' +
          '<div class="col-body' + (expanded ? '' : ' collapsed') + '" data-col-body="' + esc(col.id) + '">' +
          reqsHtml + '</div>';
      }).join('');
    });

    // ── Environments ─────────────────────────────────────────────────────
    html += section('environments', 'Environments', function () {
      if (!s.environments || s.environments.length === 0) {
        return '<div class="empty">No environments</div>';
      }
      return s.environments.map(function (env) {
        return '<div class="env-item" data-env="' + esc(env.id) + '">' +
          '<span class="env-icon">⬡</span>' +
          '<span class="env-name">' + esc(env.name) + '</span></div>';
      }).join('');
    });

    // ── History ───────────────────────────────────────────────────────────
    html += section('history', 'History', function () {
      if (!s.history || s.history.length === 0) {
        return '<div class="empty">No history</div>';
      }
      return s.history.map(function (h) {
        var sc = h.status < 300 ? 's-ok' : h.status < 500 ? 's-warn' : 's-err';
        var mClass = 'm-' + (h.method || 'GET');
        return '<div class="hist-item" data-hist-col="' + esc(h.collectionId) + '" data-hist-req="' + esc(h.requestId) + '">' +
          '<span class="hist-method ' + mClass + '">' + esc(h.method) + '</span>' +
          '<span class="hist-url" title="' + esc(h.url) + '">' + esc(h.url) + '</span>' +
          '<span class="hist-status ' + sc + '">' + esc(String(h.status)) + '</span></div>';
      }).join('');
    });

    document.getElementById('content').innerHTML = html;
    attachListeners();
  }

  function section(id, label, bodyFn) {
    var open = !collapsed[id];
    return '<div class="section-hdr" data-toggle="' + id + '">' +
      '<span class="chev' + (open ? ' open' : '') + '">▶</span>' +
      esc(label) + '</div>' +
      '<div class="section-body' + (open ? '' : ' collapsed') + '" id="sec-' + id + '">' +
      bodyFn() + '</div>';
  }

  function attachListeners() {
    // Section headers
    document.querySelectorAll('[data-toggle]').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-toggle');
        collapsed[id] = !collapsed[id];
        var body = document.getElementById('sec-' + id);
        var chev = el.querySelector('.chev');
        if (body) body.classList.toggle('collapsed', collapsed[id]);
        if (chev) chev.classList.toggle('open', !collapsed[id]);
      });
    });

    // Collection headers (expand/collapse)
    document.querySelectorAll('[data-col-toggle]').forEach(function (el) {
      el.addEventListener('click', function () {
        var colId = el.getAttribute('data-col-toggle');
        collExpanded[colId] = !!(collExpanded[colId] === false);
        var body = document.querySelector('[data-col-body="' + colId + '"]');
        var chev = el.querySelector('.col-chev');
        var nowOpen = collExpanded[colId] !== false;
        if (body) body.classList.toggle('collapsed', !nowOpen);
        if (chev) chev.classList.toggle('open', nowOpen);
      });
    });

    // Request items
    document.querySelectorAll('.req-item').forEach(function (el) {
      el.addEventListener('click', function () {
        vscode.postMessage({
          type: 'selectRequest',
          collectionId: el.getAttribute('data-col'),
          requestId: el.getAttribute('data-req'),
        });
      });
    });

    // Environment items
    document.querySelectorAll('.env-item').forEach(function (el) {
      el.addEventListener('click', function () {
        vscode.postMessage({
          type: 'selectEnvironment',
          envId: el.getAttribute('data-env'),
        });
      });
    });

    // History items (navigate to the original request)
    document.querySelectorAll('.hist-item').forEach(function (el) {
      el.addEventListener('click', function () {
        vscode.postMessage({
          type: 'selectRequest',
          collectionId: el.getAttribute('data-hist-col'),
          requestId: el.getAttribute('data-hist-req'),
        });
      });
    });
  }

  // ── Buttons ───────────────────────────────────────────────────────────────
  document.getElementById('btn-open').addEventListener('click', function () {
    vscode.postMessage({ type: 'open' });
  });
  document.getElementById('btn-refresh').addEventListener('click', function () {
    document.getElementById('root-path').textContent = 'Refreshing…';
    vscode.postMessage({ type: 'refresh' });
  });

  // ── Extension messages ────────────────────────────────────────────────────
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (msg.type === 'state') render(msg.payload);
  });

  // Ready
  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}
