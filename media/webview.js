(function () {
  'use strict';

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  var vscode = acquireVsCodeApi();

  var state = (function () {
    try {
      var s = document.getElementById('initial-state');
      if (s && s.textContent) return JSON.parse(s.textContent);
    } catch (_) {}
    return { collections: {}, environments: {}, settings: {}, rootPath: '' };
  }());

  var isDirty = false;
  var activeCollectionId = '';
  var activeRequestId = '';
  var activeEnvId = '';
  var historyEntries = [];

  // ── Message transport ─────────────────────────────────────────────────────

  var pending = Object.create(null);

  function req(type, payload) {
    return new Promise(function (resolve, reject) {
      var id = String(Math.random()).slice(2) + String(Math.random()).slice(2);
      pending[id] = { resolve: resolve, reject: reject };
      vscode.postMessage(Object.assign({ requestId: id, type: type }, payload || {}));
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new Error('Timeout: ' + type)); }
      }, 30000);
    });
  }

  // Pending navigation from the sidebar — applied after the first state message
  // resolves so that collections are in state before we try to select one.
  var pendingNav = null;

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (msg.requestId && pending[msg.requestId]) {
      var cb = pending[msg.requestId];
      delete pending[msg.requestId];
      if (msg.success) cb.resolve(msg.data);
      else cb.reject(new Error(msg.error || 'Unknown error'));
    } else if (msg.type === 'state') {
      applyState(msg.payload);
      if (pendingNav) { applyNavigation(pendingNav); pendingNav = null; }
    } else if (msg.type === 'navigate') {
      // If state is already loaded, apply immediately; otherwise queue.
      if (Object.keys(state.collections).length > 0) {
        applyNavigation(msg);
      } else {
        pendingNav = msg;
      }
    }
  });

  // ── Custom prompt / confirm (window.prompt/confirm are no-ops in webviews) ─

  function pitmanPrompt(title, defaultValue) {
    return new Promise(function (resolve) {
      var dlg = document.getElementById('prompt-dlg');
      document.getElementById('prompt-title').textContent = title;
      document.getElementById('prompt-msg').textContent = '';
      var input = document.getElementById('prompt-input');
      input.value = defaultValue || '';

      function finish(value) {
        dlg.close();
        input.onkeydown = null;
        resolve(value);
      }

      document.getElementById('prompt-ok').onclick = function () { finish(input.value); };
      document.getElementById('prompt-cancel').onclick = function () { finish(null); };
      document.getElementById('prompt-cancel-x').onclick = function () { finish(null); };
      input.onkeydown = function (e) {
        if (e.key === 'Enter') { finish(input.value); }
        if (e.key === 'Escape') { finish(null); }
      };

      dlg.showModal();
      input.focus();
      input.select();
    });
  }

  function pitmanConfirm(message) {
    return new Promise(function (resolve) {
      var dlg = document.getElementById('confirm-dlg');
      document.getElementById('confirm-msg').textContent = message;

      function finish(result) { dlg.close(); resolve(result); }

      document.getElementById('confirm-yes').onclick = function () { finish(true); };
      document.getElementById('confirm-no').onclick = function () { finish(false); };
      dlg.showModal();
    });
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function el(id) { return document.getElementById(id); }

  function showError(msg) {
    el('response-status').textContent = '⚠ ' + msg;
    el('response-status').className = 'status-err';
  }

  function showToast(msg) {
    el('response-status').textContent = msg;
    el('response-status').className = 'status-ok';
  }

  // ── Tab switching ─────────────────────────────────────────────────────────

  function setupTabs(barEl, paneEl) {
    barEl.addEventListener('click', function (e) {
      var tab = e.target.closest('.tab');
      if (!tab) return;
      barEl.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      paneEl.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
      var target = document.getElementById('tab-' + tab.dataset.tab);
      if (target) target.classList.add('active');
    });
  }

  setupTabs(el('left-tabs'), el('left-pane'));

  // Right tabs get a special handler: 'resp-history' tab loads history lazily.
  el('right-tabs').addEventListener('click', function (e) {
    var tab = e.target.closest('.tab');
    if (!tab) return;
    el('right-tabs').querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
    tab.classList.add('active');
    el('right-pane').querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
    var target = document.getElementById('tab-' + tab.dataset.tab);
    if (target) target.classList.add('active');
    if (tab.dataset.tab === 'resp-history') loadRespHistoryTab();
  });

  // ── Response panel visibility ─────────────────────────────────────────────

  function showResponsePanel() {
    el('main').classList.add('panel-open');
  }

  function hideResponsePanel() {
    el('main').classList.remove('panel-open');
  }

  el('resp-panel-close').addEventListener('click', hideResponsePanel);

  // ── HTML escaping (safe for innerHTML) ────────────────────────────────────

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Custom JSON syntax highlighter ────────────────────────────────────────

  function highlightJson(json) {
    var escaped = escHtml(json);
    return escaped.replace(
      /(&quot;(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\&])*&quot;(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      function (match) {
        var cls = 'json-number';
        if (match.startsWith('&quot;')) {
          cls = match.endsWith(':') ? 'json-key' : 'json-string';
        } else if (match === 'true' || match === 'false') {
          cls = 'json-boolean';
        } else if (match === 'null') {
          cls = 'json-null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
      }
    );
  }

  // ── XML pretty-print + highlight ─────────────────────────────────────────

  function prettifyXml(xml) {
    var formatted = '';
    var indent = 0;
    xml.replace(/>\s*</g, '>\n<').split('\n').forEach(function (line) {
      line = line.trim();
      if (!line) return;
      if (/^<\//.test(line)) indent = Math.max(0, indent - 1);
      formatted += '  '.repeat(indent) + line + '\n';
      if (/^<[^!?\/][^>]*[^\/]>/.test(line) && !/<.*\/>/.test(line)) indent++;
    });
    return formatted.trim();
  }

  function highlightXml(xml) {
    return escHtml(xml).replace(
      /(&lt;\/?)([\w:.-]+)((?:\s+[\w:.-]+=&quot;[^&]*&quot;)*)(\/?\s*&gt;)/g,
      function (_, open, tag, attrs, close) {
        var highlightedAttrs = attrs.replace(
          /([\w:.-]+)(=&quot;[^&]*&quot;)/g,
          '<span class="xml-attr-name">$1</span><span class="xml-attr-val">$2</span>'
        );
        return open + '<span class="xml-tag">' + escHtml(tag) + '</span>' + highlightedAttrs + close;
      }
    );
  }

  // ── Content-type helpers ──────────────────────────────────────────────────

  function getContentType(headers) {
    if (!headers) return '';
    var ct = headers['content-type'] || headers['Content-Type'] || '';
    return ct.split(';')[0].trim().toLowerCase();
  }

  function isJson(ct)  { return /application\/(vnd\.api\+|problem\+|)json|text\/json/.test(ct); }
  function isXml(ct)   { return /application\/(xml|rss\+xml|atom\+xml)|text\/xml/.test(ct); }
  function isHtml(ct)  { return /text\/html|application\/xhtml\+xml/.test(ct); }
  function isText(ct)  { return /^text\//.test(ct); }
  function isImage(ct) { return /^image\//.test(ct); }

  // ── Preview renderer ──────────────────────────────────────────────────────

  function renderPreview(body, headers, sizeBytes) {
    var container = el('preview-container');
    container.innerHTML = '';

    var ct = getContentType(headers);

    if (isJson(ct)) {
      var pre = document.createElement('pre');
      pre.className = 'code-preview';
      try {
        var pretty = JSON.stringify(JSON.parse(body), null, 2);
        pre.innerHTML = highlightJson(pretty);
      } catch (e) {
        var notice = document.createElement('div');
        notice.className = 'status-err';
        notice.style.cssText = 'font-size:11px;padding:2px 0 6px';
        notice.textContent = '⚠ JSON parse error: ' + e.message;
        container.appendChild(notice);
        pre.textContent = body;
      }
      container.appendChild(pre);
      return;
    }

    if (isXml(ct)) {
      var pre = document.createElement('pre');
      pre.className = 'code-preview';
      try { pre.innerHTML = highlightXml(prettifyXml(body)); }
      catch (_) { pre.textContent = body; }
      container.appendChild(pre);
      return;
    }

    if (isHtml(ct)) {
      var iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', '');
      iframe.style.cssText = 'flex:1;width:100%;border:none;background:#fff;min-height:200px';
      // Assign via property — no HTML-attribute escaping needed, safe from XSS.
      iframe.srcdoc = body;
      container.appendChild(iframe);
      return;
    }

    if (isImage(ct)) {
      var msg = document.createElement('div');
      msg.className = 'empty-hint';
      msg.style.padding = '12px';
      msg.textContent = 'Binary/image preview is not supported.';
      container.appendChild(msg);
      return;
    }

    if (isText(ct) || !ct) {
      var pre = document.createElement('pre');
      pre.className = 'code-preview';
      pre.textContent = body;
      container.appendChild(pre);
      return;
    }

    // Unknown / binary
    var info = document.createElement('div');
    info.style.cssText = 'padding:12px;font-size:12px';
    info.innerHTML =
      '<p><span class="empty-hint">Content-Type: </span>' + escHtml(ct) + '</p>' +
      '<p style="margin-top:4px"><span class="empty-hint">Size: </span>' + formatBytes(sizeBytes) + '</p>' +
      '<p style="margin-top:8px;color:var(--vscode-descriptionForeground)">Preview unavailable for this content type. Use Raw if available.</p>';
    container.appendChild(info);
  }

  // ── History tab in response panel ─────────────────────────────────────────

  function loadRespHistoryTab() {
    var list = el('resp-history-list');
    list.innerHTML = '<span class="empty-hint" style="padding:8px;display:block">Loading…</span>';
    req('listHistory').then(function (data) {
      var all = data.entries || [];
      var filtered = all.filter(function (e) { return e.requestId === activeRequestId; }).slice(0, 10);
      list.innerHTML = '';
      if (filtered.length === 0) {
        list.innerHTML = '<span class="empty-hint" style="padding:8px;display:block">No history for this request.</span>';
        return;
      }
      filtered.forEach(function (entry) {
        var row = document.createElement('div');
        row.className = 'resp-hist-row';
        var sc = entry.status < 300 ? 'status-ok' : entry.status < 500 ? 'status-warn' : 'status-err';
        var ts = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '';
        row.innerHTML =
          '<span class="resp-hist-method">' + escHtml(entry.method) + '</span>' +
          '<span class="' + sc + '">' + escHtml(String(entry.status)) + '</span>' +
          '<span class="resp-hist-meta">' + escHtml(entry.durationMs + 'ms · ' + ts) + '</span>';
        row.title = entry.url;
        row.addEventListener('click', function () {
          // Restore response into the preview/raw/headers/timing tabs
          showResponse({
            status: entry.status, statusText: entry.statusText,
            headers: entry.responseHeaders, body: entry.responseBodyPreview,
            durationMs: entry.durationMs, sizeBytes: entry.sizeBytes,
            requestHeaders: entry.requestHeaders,
          });
          // Switch back to preview tab
          el('right-tabs').querySelector('[data-tab=preview]').click();
        });
        list.appendChild(row);
      });
      var openBtn = document.createElement('button');
      openBtn.className = 'sec';
      openBtn.style.cssText = 'margin:8px;';
      openBtn.textContent = 'Open full History';
      openBtn.addEventListener('click', function () { el('btn-history').click(); });
      list.appendChild(openBtn);
    }).catch(function () {
      list.innerHTML = '<span class="empty-hint" style="padding:8px;display:block">Could not load history.</span>';
    });
  }

  // ── Dirty state ───────────────────────────────────────────────────────────

  function markDirty() {
    isDirty = true;
    el('dirty-dot').setAttribute('data-dirty', 'true');
  }

  function clearDirty() {
    isDirty = false;
    el('dirty-dot').setAttribute('data-dirty', 'false');
  }

  function watchDirty(container) {
    container.addEventListener('input', markDirty);
    container.addEventListener('change', markDirty);
  }

  watchDirty(el('left-pane'));
  el('url-input').addEventListener('input', markDirty);
  el('method-select').addEventListener('change', markDirty);

  // Returns a Promise<boolean> — true if ok to proceed (not dirty, or user discarded).
  function guardUnsaved() {
    if (!isDirty) return Promise.resolve(true);
    return pitmanConfirm('You have unsaved changes. Discard them?');
  }

  // ── KV row helpers ────────────────────────────────────────────────────────

  function makeKvRow(key, value, enabled) {
    key = key || ''; value = value || '';
    enabled = enabled !== false;
    var row = document.createElement('div');
    row.className = 'kv-row';
    row.innerHTML =
      '<input type="checkbox"' + (enabled ? ' checked' : '') + '/>' +
      '<input class="key" type="text" placeholder="Key" value="' + esc(key) + '"/>' +
      '<input class="val" type="text" placeholder="Value" value="' + esc(value) + '"/>' +
      '<button class="icon rm-btn" title="Remove">×</button>';
    row.querySelector('.rm-btn').addEventListener('click', function () { row.remove(); markDirty(); });
    return row;
  }

  function getKvRows(containerId) {
    var c = el(containerId);
    if (!c) return [];
    return Array.from(c.querySelectorAll('.kv-row')).map(function (row) {
      var inputs = row.querySelectorAll('input[type=text]');
      return {
        enabled: row.querySelector('input[type=checkbox]').checked,
        key: inputs[0].value,
        value: inputs[1].value,
      };
    });
  }

  function renderKvRows(containerId, rows) {
    var c = el(containerId);
    if (!c) return;
    c.innerHTML = '';
    (rows || []).forEach(function (r) { c.appendChild(makeKvRow(r.key, r.value, r.enabled !== false)); });
  }

  el('add-param').addEventListener('click', function () { el('params-rows').appendChild(makeKvRow()); markDirty(); });
  el('add-header').addEventListener('click', function () { el('headers-rows').appendChild(makeKvRow()); markDirty(); });

  // ── Auth UI ───────────────────────────────────────────────────────────────

  var authTypeEl = el('auth-type');
  var authFieldsEl = el('auth-fields');

  authTypeEl.addEventListener('change', function () { renderAuthFields(authTypeEl.value, {}); markDirty(); });

  function renderAuthFields(type, auth) {
    authFieldsEl.innerHTML = '';
    auth = auth || {};
    if (type === 'bearer') {
      authFieldsEl.innerHTML =
        '<div class="field-row"><label>Token</label>' +
        '<input id="auth-token" type="text" value="' + esc(auth.token || '') + '"/></div>';
    } else if (type === 'basic') {
      authFieldsEl.innerHTML =
        '<div class="field-row"><label>Username</label><input id="auth-user" type="text" value="' + esc(auth.username || '') + '"/></div>' +
        '<div class="field-row"><label>Password</label><input id="auth-pass" type="password" value="' + esc(auth.password || '') + '"/></div>';
    } else if (type === 'apiKey') {
      var pl = auth.placement || 'header';
      authFieldsEl.innerHTML =
        '<div class="field-row"><label>Placement</label>' +
        '<select id="auth-placement" style="max-width:140px">' +
        '<option value="header"' + (pl === 'header' ? ' selected' : '') + '>Header</option>' +
        '<option value="query"' + (pl === 'query' ? ' selected' : '') + '>Query Param</option></select></div>' +
        '<div class="field-row"><label>Key</label><input id="auth-key" type="text" value="' + esc(auth.key || '') + '"/></div>' +
        '<div class="field-row"><label>Value</label><input id="auth-val" type="text" value="' + esc(auth.value || '') + '"/></div>';
    }
  }

  function getAuth() {
    var type = authTypeEl.value;
    if (type === 'bearer') return { type: type, token: (el('auth-token') || {}).value || '' };
    if (type === 'basic') return { type: type, username: (el('auth-user') || {}).value || '', password: (el('auth-pass') || {}).value || '' };
    if (type === 'apiKey') return { type: type, placement: (el('auth-placement') || {}).value || 'header', key: (el('auth-key') || {}).value || '', value: (el('auth-val') || {}).value || '' };
    return { type: 'none' };
  }

  // ── Body UI ───────────────────────────────────────────────────────────────

  var bodyTypeEl = el('body-type');
  var bodyFieldsEl = el('body-fields');
  var bodyCtrlsEl = el('body-type-controls');

  bodyTypeEl.addEventListener('change', function () { renderBodyFields(bodyTypeEl.value, {}); markDirty(); });

  function renderBodyFields(type, body) {
    bodyFieldsEl.innerHTML = '';
    bodyCtrlsEl.innerHTML = '';
    body = body || {};

    if (type === 'json' || type === 'text') {
      var ta = document.createElement('textarea');
      ta.id = 'body-text';
      ta.style.flex = '1';
      ta.style.width = '100%';
      ta.style.minHeight = '180px';
      ta.placeholder = type === 'json' ? '{\n  "key": "value"\n}' : 'Plain text…';
      ta.value = body.value || '';
      bodyFieldsEl.appendChild(ta);

      if (type === 'json') {
        var fmtBtn = document.createElement('button');
        fmtBtn.className = 'sec';
        fmtBtn.textContent = 'Pretty';
        fmtBtn.addEventListener('click', function () {
          try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); markDirty(); }
          catch (e) { showError('Invalid JSON: ' + e.message); }
        });
        var valBtn = document.createElement('button');
        valBtn.className = 'sec';
        valBtn.textContent = 'Validate';
        valBtn.addEventListener('click', function () {
          try { JSON.parse(ta.value); showToast('✓ Valid JSON'); }
          catch (e) { showError('Invalid JSON: ' + e.message); }
        });
        bodyCtrlsEl.appendChild(fmtBtn);
        bodyCtrlsEl.appendChild(valBtn);
      }
    } else if (type === 'form') {
      var rowsDiv = document.createElement('div');
      rowsDiv.id = 'form-rows';
      bodyFieldsEl.appendChild(rowsDiv);
      (body.fields || []).forEach(function (f) { rowsDiv.appendChild(makeKvRow(f.key, f.value, f.enabled !== false)); });
      var addBtn = document.createElement('button');
      addBtn.className = 'sec add-row-btn';
      addBtn.textContent = '+ Add';
      addBtn.addEventListener('click', function () { rowsDiv.appendChild(makeKvRow()); markDirty(); });
      bodyFieldsEl.appendChild(addBtn);
    } else if (type === 'multipart') {
      var mpDiv = document.createElement('div');
      mpDiv.id = 'mp-rows';
      mpDiv.style.display = 'flex';
      mpDiv.style.flexDirection = 'column';
      mpDiv.style.gap = '4px';
      bodyFieldsEl.appendChild(mpDiv);

      function addMpRow(field) {
        field = field || { type: 'text', key: '', value: '', filePath: '', enabled: true };
        var row = document.createElement('div');
        row.className = 'kv-row';
        row.style.flexWrap = 'wrap';
        row.style.gap = '3px';

        var chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = field.enabled !== false;

        var typeSelect = document.createElement('select');
        typeSelect.style.width = '65px';
        ['text', 'file'].forEach(function (t) {
          var o = document.createElement('option');
          o.value = t; o.textContent = t;
          if (t === field.type) o.selected = true;
          typeSelect.appendChild(o);
        });

        var keyInput = document.createElement('input');
        keyInput.type = 'text';
        keyInput.placeholder = 'Key';
        keyInput.className = 'key';
        keyInput.value = field.key || '';

        var valInput = document.createElement('input');
        valInput.type = 'text';
        valInput.placeholder = 'Value or file path';
        valInput.style.flex = '1';
        valInput.value = field.type === 'file' ? (field.filePath || '') : (field.value || '');

        var pickBtn = document.createElement('button');
        pickBtn.className = 'sec';
        pickBtn.textContent = '…';
        pickBtn.title = 'Pick file';
        pickBtn.style.display = field.type === 'file' ? '' : 'none';
        pickBtn.addEventListener('click', function () {
          req('selectFileForMultipart').then(function (data) {
            if (data.filePath) { valInput.value = data.filePath; markDirty(); }
          }).catch(function (err) { showError(err.message); });
        });

        typeSelect.addEventListener('change', function () {
          pickBtn.style.display = typeSelect.value === 'file' ? '' : 'none';
          valInput.placeholder = typeSelect.value === 'file' ? 'File path' : 'Value';
          markDirty();
        });

        var rmBtn = document.createElement('button');
        rmBtn.className = 'icon rm-btn';
        rmBtn.textContent = '×';
        rmBtn.addEventListener('click', function () { row.remove(); markDirty(); });

        [chk, typeSelect, keyInput, valInput, pickBtn, rmBtn].forEach(function (e) { row.appendChild(e); });
        mpDiv.appendChild(row);
      }

      (body.fields || []).forEach(addMpRow);
      var mpAddBtn = document.createElement('button');
      mpAddBtn.className = 'sec add-row-btn';
      mpAddBtn.textContent = '+ Add';
      mpAddBtn.addEventListener('click', function () { addMpRow(); markDirty(); });
      bodyFieldsEl.appendChild(mpAddBtn);
    }
  }

  function getMpRows() {
    var mp = el('mp-rows');
    if (!mp) return [];
    return Array.from(mp.querySelectorAll('.kv-row')).map(function (row) {
      var inputs = row.querySelectorAll('input[type=text]');
      var selects = row.querySelectorAll('select');
      var type = selects[0] ? selects[0].value : 'text';
      return {
        enabled: row.querySelector('input[type=checkbox]').checked,
        type: type,
        key: inputs[0] ? inputs[0].value : '',
        value: type !== 'file' ? (inputs[1] ? inputs[1].value : '') : '',
        filePath: type === 'file' ? (inputs[1] ? inputs[1].value : '') : '',
      };
    });
  }

  function getBody() {
    var type = bodyTypeEl.value;
    if (type === 'json' || type === 'text') return { type: type, value: (el('body-text') || {}).value || '' };
    if (type === 'form') return { type: type, fields: getKvRows('form-rows') };
    if (type === 'multipart') return { type: type, fields: getMpRows() };
    return { type: 'none' };
  }

  // ── Dropdowns ─────────────────────────────────────────────────────────────

  var collectionSelect = el('collection-select');
  var requestSelect = el('request-select');
  var envSelect = el('env-select');

  function makePlaceholder(text) {
    var opt = document.createElement('option');
    opt.value = '';
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = text;
    return opt;
  }

  function populateCollections(selectId) {
    collectionSelect.innerHTML = '';
    var ids = Object.keys(state.collections);
    if (ids.length === 0) {
      collectionSelect.appendChild(makePlaceholder('Default'));
      activeCollectionId = '';
      populateRequests('');
      return;
    }
    ids.forEach(function (id) {
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = (state.collections[id] && state.collections[id].name) || id;
      collectionSelect.appendChild(opt);
    });
    var target = selectId || activeCollectionId || (state.settings && state.settings.defaultCollection);
    if (target && state.collections[target]) {
      collectionSelect.value = target;
      activeCollectionId = target;
    } else {
      collectionSelect.value = ids[0];
      activeCollectionId = ids[0];
    }
    populateRequests(collectionSelect.value);
  }

  function populateRequests(collId, selectId) {
    requestSelect.innerHTML = '';
    var col = state.collections[collId];
    if (!col || !col.requests || col.requests.length === 0) {
      requestSelect.appendChild(makePlaceholder('No requests'));
      activeRequestId = '';
      return;
    }
    col.requests.forEach(function (r) {
      var opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.name;
      requestSelect.appendChild(opt);
    });
    var target = selectId || activeRequestId;
    var hasTarget = col.requests.some(function (r) { return r.id === target; });
    if (target && hasTarget) {
      requestSelect.value = target;
      activeRequestId = target;
    } else {
      requestSelect.value = col.requests[0].id;
      activeRequestId = col.requests[0].id;
    }
    loadRequest();
  }

  /** Returns the env IDs to show for the active collection. */
  function collectionEnvIds() {
    var col = state.collections[activeCollectionId];
    if (!col) return Object.keys(state.environments);
    var list = col.environments;
    if (!list || list.length === 0) return Object.keys(state.environments);
    // Only include IDs that actually exist in state.environments.
    return list.filter(function (id) { return state.environments[id]; });
  }

  function populateEnvs(selectId) {
    envSelect.innerHTML = '';
    var ids = collectionEnvIds();
    if (ids.length === 0) {
      envSelect.appendChild(makePlaceholder('Default'));
      activeEnvId = '';
      return;
    }
    ids.forEach(function (id) {
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = (state.environments[id] && state.environments[id].name) || id;
      envSelect.appendChild(opt);
    });
    var target = selectId || activeEnvId || (state.settings && state.settings.defaultEnvironment);
    if (target && state.environments[target] && ids.indexOf(target) !== -1) {
      envSelect.value = target;
      activeEnvId = target;
    } else {
      envSelect.value = ids[0];
      activeEnvId = ids[0];
    }
  }

  // Collection change — async so we can await the confirm dialog.
  collectionSelect.addEventListener('change', function () {
    var newVal = collectionSelect.value;
    collectionSelect.value = activeCollectionId; // revert until confirmed
    guardUnsaved().then(function (ok) {
      if (!ok) return;
      activeCollectionId = newVal;
      collectionSelect.value = newVal;
      activeRequestId = '';
      populateRequests(activeCollectionId);
      populateEnvs(); // re-filter envs for the new collection
      clearDirty();
    });
  });

  // Request change — async so we can await the confirm dialog.
  requestSelect.addEventListener('change', function () {
    var newVal = requestSelect.value;
    requestSelect.value = activeRequestId; // revert until confirmed
    guardUnsaved().then(function (ok) {
      if (!ok) return;
      activeRequestId = newVal;
      requestSelect.value = newVal;
      loadRequest();
      clearDirty();
    });
  });

  envSelect.addEventListener('change', function () { activeEnvId = envSelect.value; });

  function loadRequest() {
    var col = state.collections[activeCollectionId];
    if (!col) return;
    var reqObj = col.requests && col.requests.find(function (r) { return r.id === activeRequestId; });
    if (!reqObj) return;

    el('req-name-input').value = reqObj.name || '';
    el('method-select').value = reqObj.method || 'GET';
    el('url-input').value = reqObj.url || '';
    renderKvRows('params-rows', reqObj.params);
    renderKvRows('headers-rows', reqObj.headers);
    authTypeEl.value = (reqObj.auth && reqObj.auth.type) || 'none';
    renderAuthFields(authTypeEl.value, reqObj.auth || {});
    bodyTypeEl.value = (reqObj.body && reqObj.body.type) || 'none';
    renderBodyFields(bodyTypeEl.value, reqObj.body || {});
    el('docs-input').value = reqObj.docs || '';
    clearDirty();
  }

  function buildRequestFromUI() {
    return {
      id: activeRequestId || 'adhoc',
      name: el('req-name-input').value || 'Request',
      method: el('method-select').value,
      url: el('url-input').value,
      params: getKvRows('params-rows'),
      headers: getKvRows('headers-rows'),
      auth: getAuth(),
      body: getBody(),
      docs: el('docs-input').value,
    };
  }

  // ── State application ─────────────────────────────────────────────────────

  function applyState(newState) {
    state = newState;
    populateCollections();
    populateEnvs();
  }

  function applyNavigation(nav) {
    if (nav.collectionId && state.collections[nav.collectionId]) {
      activeCollectionId = nav.collectionId;
      populateCollections(nav.collectionId);
      // Re-filter the env dropdown to this collection's environments.
      // If a specific env was also requested, honour it; otherwise pick the
      // collection default (populateEnvs will fall back to the first available).
      populateEnvs(nav.envId || undefined);
    }
    if (nav.requestId) {
      activeRequestId = nav.requestId;
      populateRequests(activeCollectionId, nav.requestId);
    }
    if (nav.envId && !nav.collectionId && state.environments[nav.envId]) {
      // env-only navigation (no collection change)
      activeEnvId = nav.envId;
      populateEnvs(nav.envId);
    }
  }

  // ── Toolbar actions ───────────────────────────────────────────────────────

  el('btn-req-new').addEventListener('click', function () {
    guardUnsaved().then(function (ok) {
      if (!ok) return;
      if (!activeCollectionId) return showError('Select a collection first.');
      req('createRequest', { collectionId: activeCollectionId })
        .then(function (data) {
          state.collections[activeCollectionId] = data.collection;
          activeRequestId = data.request.id;
          populateRequests(activeCollectionId, data.request.id);
          clearDirty();
        }).catch(function (e) { showError(e.message); });
    });
  });

  el('btn-req-dup').addEventListener('click', function () {
    if (!activeRequestId) return showError('Select a request first.');
    req('duplicateRequest', { collectionId: activeCollectionId, reqId: activeRequestId })
      .then(function (data) {
        state.collections[activeCollectionId] = data.collection;
        activeRequestId = data.request.id;
        populateRequests(activeCollectionId, data.request.id);
        clearDirty();
      }).catch(function (e) { showError(e.message); });
  });

  el('btn-req-del').addEventListener('click', function () {
    if (!activeRequestId) return showError('Select a request first.');
    var label = (requestSelect.options[requestSelect.selectedIndex] || {}).text || activeRequestId;
    pitmanConfirm('Delete "' + label + '"?').then(function (ok) {
      if (!ok) return;
      req('deleteRequest', { collectionId: activeCollectionId, reqId: activeRequestId })
        .then(function (data) {
          state.collections[activeCollectionId] = data.collection;
          activeRequestId = '';
          populateRequests(activeCollectionId);
          clearDirty();
        }).catch(function (e) { showError(e.message); });
    });
  });

  el('btn-save-req').addEventListener('click', saveCurrentRequest);

  function saveCurrentRequest() {
    if (!activeCollectionId) return Promise.reject(new Error('No collection selected.'));
    var reqObj = buildRequestFromUI();
    return req('saveRequest', { collectionId: activeCollectionId, request: reqObj })
      .then(function (data) {
        state.collections[activeCollectionId] = data.collection;
        var opt = requestSelect.querySelector('option[value="' + activeRequestId + '"]');
        if (opt) opt.textContent = reqObj.name;
        clearDirty();
        showToast('✓ Saved');
      });
  }

  // ── Send button ───────────────────────────────────────────────────────────

  el('send-btn').addEventListener('click', function () {
    var reqObj = buildRequestFromUI();
    el('send-btn').disabled = true;
    el('spinner').style.display = 'inline';
    clearResponse();
    req('sendRequest', { request: reqObj, environmentId: activeEnvId, collectionId: activeCollectionId })
      .then(function (data) { showResponse(data.response, data.chainSteps); })
      .catch(function (e) { showResponseError(e.message); })
      .finally(function () {
        el('send-btn').disabled = false;
        el('spinner').style.display = 'none';
      });
  });

  // ── Response viewer ───────────────────────────────────────────────────────

  function formatBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function clearResponse() {
    el('response-status').textContent = 'Sending…';
    el('response-status').className = '';
    el('preview-container').innerHTML = '';
    el('raw-body').textContent = '';
    el('resp-hdr-body').innerHTML = '';
    el('timing-info').textContent = '';
  }

  function showResponse(resp, chainSteps) {
    chainSteps = chainSteps || [];

    // Status bar — show chain prefix when upstream requests ran
    var statusEl = el('response-status');
    var chainPrefix = '';
    if (chainSteps.length > 0) {
      chainPrefix = chainSteps.map(function (s) {
        return s.requestName + (s.status === 'ok' ? ' ✓' : ' ✗');
      }).join(' → ') + ' → ';
    }
    statusEl.textContent = chainPrefix +
      resp.status + ' ' + resp.statusText +
      '  ·  ' + resp.durationMs + 'ms  ·  ' + formatBytes(resp.sizeBytes);
    statusEl.className = resp.status < 300 ? 'status-ok' : resp.status < 500 ? 'status-warn' : 'status-err';

    // Preview tab — content-type aware
    renderPreview(resp.body || '', resp.headers, resp.sizeBytes);

    // Raw tab — always plain text
    el('raw-body').textContent = resp.body || '';

    // Headers tab — request headers sent, then response headers received
    function fillHdrTable(tbodyId, map) {
      var tbody = el(tbodyId);
      tbody.innerHTML = '';
      Object.keys(map || {}).forEach(function (k) {
        // Multi-value headers (e.g. set-cookie) are stored newline-joined.
        var values = map[k].split('\n');
        values.forEach(function (v) {
          var tr = document.createElement('tr');
          tr.innerHTML = '<td>' + escHtml(k) + '</td><td>' + escHtml(v) + '</td>';
          tbody.appendChild(tr);
        });
      });
    }
    fillHdrTable('req-hdr-body', resp.requestHeaders);
    fillHdrTable('resp-hdr-body', resp.headers);

    // Timing tab — include chain step durations when present
    var ct = getContentType(resp.headers);
    var timingLines = [];
    if (chainSteps.length > 0) {
      timingLines.push('── Chain ──────────────────────────');
      chainSteps.forEach(function (s) {
        var mark = s.status === 'ok' ? '✓' : '✗';
        timingLines.push(mark + ' ' + s.requestName + ':  ' + s.durationMs + 'ms' +
          (s.error ? '  (' + s.error + ')' : ''));
      });
      timingLines.push('── Response ────────────────────────');
    }
    timingLines.push(
      'Status:   ' + resp.status + ' ' + resp.statusText,
      'Duration: ' + resp.durationMs + 'ms',
      'Size:     ' + formatBytes(resp.sizeBytes) + ' (' + resp.sizeBytes + ' bytes)',
      'Type:     ' + (ct || '(none)')
    );
    el('timing-info').textContent = timingLines.join('\n');

    showResponsePanel();
  }

  function showResponseError(msg) {
    el('response-status').textContent = 'Error: ' + msg;
    el('response-status').className = 'status-err';
    el('preview-container').innerHTML =
      '<div style="padding:10px"><pre class="code-preview status-err">' + escHtml(msg) + '</pre></div>';
    el('raw-body').textContent = msg;
    showResponsePanel();
  }

  // ── Collection Manager ────────────────────────────────────────────────────

  var colMgr = el('col-mgr');
  var colMgrList = el('col-mgr-list');
  var colMgrDetail = el('col-mgr-detail');
  var selectedColId = null;

  el('btn-col-manage').addEventListener('click', function () {
    renderColMgrList();
    colMgr.showModal();
  });
  el('col-mgr-close').addEventListener('click', function () { colMgr.close(); });

  el('col-mgr-new').addEventListener('click', function () {
    pitmanPrompt('New collection name').then(function (name) {
      if (!name || !name.trim()) return;
      req('createCollection', { name: name.trim() })
        .then(function (data) {
          state.collections = data.collections;
          selectedColId = data.id;
          populateCollections(activeCollectionId);
          renderColMgrList();
          renderColMgrDetail(data.id);
        }).catch(function (e) { showError(e.message); });
    });
  });

  function renderColMgrList() {
    colMgrList.innerHTML = '';
    var ids = Object.keys(state.collections);
    if (ids.length === 0) {
      colMgrList.innerHTML = '<span style="color:var(--vscode-descriptionForeground);font-size:12px;padding:4px">No collections</span>';
      return;
    }
    ids.forEach(function (id) {
      var col = state.collections[id];
      var item = document.createElement('div');
      item.className = 'list-item' + (id === selectedColId ? ' selected' : '');
      item.innerHTML = '<span class="list-item-name">' + esc((col && col.name) || id) + '</span>';
      item.addEventListener('click', function () {
        selectedColId = id;
        colMgrList.querySelectorAll('.list-item').forEach(function (i) { i.classList.remove('selected'); });
        item.classList.add('selected');
        renderColMgrDetail(id);
      });
      colMgrList.appendChild(item);
    });
  }

  function renderColMgrDetail(id) {
    var col = state.collections[id];
    if (!col) { colMgrDetail.innerHTML = '<span class="empty-hint">Collection not found.</span>'; return; }
    colMgrDetail.innerHTML =
      '<div style="font-weight:600;font-size:13px;margin-bottom:8px">' + esc(col.name) + '</div>' +
      '<div style="font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:10px">' +
      (col.requests ? col.requests.length : 0) + ' request(s)</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:5px">' +
      '<button class="sec" id="cmgr-rename">Rename</button>' +
      '<button class="sec" id="cmgr-dup">Duplicate</button>' +
      '<button class="sec" id="cmgr-open">Open File</button>' +
      '<button class="sec danger" id="cmgr-del">Delete</button>' +
      '</div>';

    colMgrDetail.querySelector('#cmgr-rename').addEventListener('click', function () {
      pitmanPrompt('Rename collection', col.name).then(function (name) {
        if (!name || !name.trim()) return;
        req('renameCollection', { id: id, newName: name.trim() })
          .then(function (data) {
            state.collections = data.collections;
            if (activeCollectionId === id) activeCollectionId = data.id;
            selectedColId = data.id;
            populateCollections(activeCollectionId);
            renderColMgrList();
            renderColMgrDetail(data.id);
          }).catch(function (e) { showError(e.message); });
      });
    });

    colMgrDetail.querySelector('#cmgr-dup').addEventListener('click', function () {
      req('duplicateCollection', { id: id })
        .then(function (data) {
          state.collections = data.collections;
          selectedColId = data.id;
          populateCollections(activeCollectionId);
          renderColMgrList();
          renderColMgrDetail(data.id);
        }).catch(function (e) { showError(e.message); });
    });

    colMgrDetail.querySelector('#cmgr-open').addEventListener('click', function () {
      req('openCollectionFile', { id: id }).catch(function (e) { showError(e.message); });
    });

    colMgrDetail.querySelector('#cmgr-del').addEventListener('click', function () {
      pitmanConfirm('Delete collection "' + col.name + '"? This is permanent.').then(function (ok) {
        if (!ok) return;
        req('deleteCollection', { id: id })
          .then(function (data) {
            state.collections = data.collections;
            if (activeCollectionId === id) { activeCollectionId = ''; activeRequestId = ''; }
            selectedColId = null;
            populateCollections();
            renderColMgrList();
            colMgrDetail.innerHTML = '<span class="empty-hint">Select a collection.</span>';
          }).catch(function (e) { showError(e.message); });
      });
    });
  }

  // ── Environment Manager ───────────────────────────────────────────────────

  var envMgr = el('env-mgr');
  var envMgrList = el('env-mgr-list');
  var envMgrDetail = el('env-mgr-detail');
  var selectedEnvId = null;

  el('btn-env-manage').addEventListener('click', function () {
    renderEnvMgrList();
    envMgr.showModal();
  });
  el('env-mgr-close').addEventListener('click', function () { envMgr.close(); });

  el('env-mgr-assoc').addEventListener('click', function () {
    var unassociated = el('env-mgr-assoc')._unassociated || [];
    if (unassociated.length === 0) return;
    // Build a select-based prompt reusing the prompt dialog.
    var dlg = el('prompt-dlg');
    el('prompt-title').textContent = 'Associate existing environment';
    el('prompt-msg').textContent = '';
    var input = el('prompt-input');
    // Replace the text input with a temporary select.
    var sel = document.createElement('select');
    sel.style.width = '100%';
    unassociated.forEach(function (id) {
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = (state.environments[id] && state.environments[id].name) || id;
      sel.appendChild(opt);
    });
    input.style.display = 'none';
    input.parentNode.insertBefore(sel, input);

    function cleanup() { sel.remove(); input.style.display = ''; }

    el('prompt-ok').onclick = function () {
      var envId = sel.value;
      cleanup(); dlg.close();
      if (!envId) return;
      req('associateEnvironment', { collectionId: activeCollectionId, envId: envId })
        .then(function (data) {
          state.collections = data.collections;
          selectedEnvId = envId;
          populateEnvs(activeEnvId);
          renderEnvMgrList();
          openEnvDetail(envId);
        }).catch(function (e) { showError(e.message); });
    };
    el('prompt-cancel').onclick = function () { cleanup(); dlg.close(); };
    el('prompt-cancel-x').onclick = function () { cleanup(); dlg.close(); };
    input.onkeydown = null;
    dlg.showModal();
    sel.focus();
  });

  el('env-mgr-new').addEventListener('click', function () {
    pitmanPrompt('New environment name').then(function (name) {
      if (!name || !name.trim()) return;
      req('createEnvironment', { name: name.trim(), collectionId: activeCollectionId })
        .then(function (data) {
          state.collections = data.collections;
          state.environments = data.environments;
          selectedEnvId = data.id;
          populateEnvs(data.id);
          renderEnvMgrList();
          openEnvDetail(data.id);
        }).catch(function (e) { showError(e.message); });
    });
  });

  function renderEnvMgrList() {
    envMgrList.innerHTML = '';
    // Show only environments associated with the active collection.
    var ids = collectionEnvIds();
    if (ids.length === 0) {
      envMgrList.innerHTML = '<span style="color:var(--vscode-descriptionForeground);font-size:12px;padding:4px">No environments</span>';
    } else {
      ids.forEach(function (id) {
        var env = state.environments[id];
        var item = document.createElement('div');
        item.className = 'list-item' + (id === selectedEnvId ? ' selected' : '');
        item.innerHTML = '<span class="list-item-name">' + esc((env && env.name) || id) + '</span>';
        item.addEventListener('click', function () {
          selectedEnvId = id;
          envMgrList.querySelectorAll('.list-item').forEach(function (i) { i.classList.remove('selected'); });
          item.classList.add('selected');
          openEnvDetail(id);
        });
        envMgrList.appendChild(item);
      });
    }

    // Update the footer "Associate" button visibility.
    var assocFooterBtn = el('env-mgr-assoc');
    if (assocFooterBtn) {
      var unassociated = Object.keys(state.environments).filter(function (id) {
        return ids.indexOf(id) === -1;
      });
      assocFooterBtn.style.display = unassociated.length > 0 ? '' : 'none';
      assocFooterBtn._unassociated = unassociated;
    }
  }

  function openEnvDetail(id) {
    envMgrDetail.innerHTML = '<span style="font-size:12px;color:var(--vscode-descriptionForeground)">Loading…</span>';
    req('loadRawEnvironment', { id: id })
      .then(function (raw) { renderEnvDetail(id, raw); })
      .catch(function (e) { envMgrDetail.innerHTML = '<span class="status-err">' + esc(e.message) + '</span>'; });
  }

  function renderEnvDetail(id, raw) {
    var d = envMgrDetail;
    d.innerHTML = '';

    var header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.gap = '6px';
    header.style.marginBottom = '10px';
    header.innerHTML =
      '<span style="font-weight:600;font-size:13px;flex:1">' + esc(raw.publicName) + '</span>' +
      '<button class="sec" id="emgr-rename">Rename</button>' +
      '<button class="sec" id="emgr-remove" title="Remove from this collection">Remove</button>' +
      '<button class="sec danger" id="emgr-del">Delete</button>';
    d.appendChild(header);

    header.querySelector('#emgr-rename').addEventListener('click', function () {
      pitmanPrompt('Rename environment', raw.publicName).then(function (name) {
        if (!name || !name.trim()) return;
        req('renameEnvironment', { id: id, newName: name.trim(), collectionId: activeCollectionId })
          .then(function (data) {
            state.collections = data.collections;
            state.environments = data.environments;
            if (activeEnvId === id) activeEnvId = data.id;
            selectedEnvId = data.id;
            populateEnvs(activeEnvId);
            renderEnvMgrList();
            openEnvDetail(data.id);
          }).catch(function (e) { showError(e.message); });
      });
    });

    header.querySelector('#emgr-remove').addEventListener('click', function () {
      pitmanConfirm('Remove "' + raw.publicName + '" from this collection? (The environment file is kept.)').then(function (ok) {
        if (!ok) return;
        req('disassociateEnvironment', { collectionId: activeCollectionId, envId: id })
          .then(function (data) {
            state.collections = data.collections;
            if (activeEnvId === id) activeEnvId = '';
            selectedEnvId = null;
            populateEnvs();
            renderEnvMgrList();
            envMgrDetail.innerHTML = '<span class="empty-hint">Select an environment.</span>';
          }).catch(function (e) { showError(e.message); });
      });
    });

    header.querySelector('#emgr-del').addEventListener('click', function () {
      pitmanConfirm('Delete environment "' + raw.publicName + '"? This removes the files permanently.').then(function (ok) {
        if (!ok) return;
        req('deleteEnvironment', { id: id })
          .then(function (data) {
            state.collections = data.collections;
            state.environments = data.environments;
            if (activeEnvId === id) activeEnvId = '';
            selectedEnvId = null;
            populateEnvs();
            renderEnvMgrList();
            envMgrDetail.innerHTML = '<span class="empty-hint">Select an environment.</span>';
          }).catch(function (e) { showError(e.message); });
      });
    });

    // Public vars
    var pubLabel = document.createElement('div');
    pubLabel.className = 'section-label';
    pubLabel.textContent = 'Public Variables (' + id + '.env.json)';
    d.appendChild(pubLabel);

    var pubRows = document.createElement('div');
    pubRows.id = 'emgr-pub-rows';
    d.appendChild(pubRows);
    Object.keys(raw.publicVars || {}).forEach(function (k) {
      pubRows.appendChild(makeEnvVarRow(k, raw.publicVars[k], false));
    });

    var pubControls = document.createElement('div');
    pubControls.style.display = 'flex';
    pubControls.style.gap = '5px';
    pubControls.style.marginTop = '4px';

    var addPubBtn = document.createElement('button');
    addPubBtn.className = 'sec';
    addPubBtn.textContent = '+ Add';
    addPubBtn.addEventListener('click', function () { pubRows.appendChild(makeEnvVarRow('', '', false)); });

    var openPubBtn = document.createElement('button');
    openPubBtn.className = 'sec';
    openPubBtn.textContent = 'Open File';
    openPubBtn.addEventListener('click', function () {
      req('openEnvironmentFile', { id: id, fileType: 'public' }).catch(function (e) { showError(e.message); });
    });

    pubControls.appendChild(addPubBtn);
    pubControls.appendChild(openPubBtn);
    d.appendChild(pubControls);

    // Private vars
    var privLabel = document.createElement('div');
    privLabel.className = 'section-label';
    privLabel.textContent = 'Private Variables (' + id + '.private.env.json — gitignored)';
    d.appendChild(privLabel);

    var privRows = document.createElement('div');
    privRows.id = 'emgr-priv-rows';
    d.appendChild(privRows);
    Object.keys(raw.privateVars || {}).forEach(function (k) {
      privRows.appendChild(makeEnvVarRow(k, raw.privateVars[k], true));
    });

    var privControls = document.createElement('div');
    privControls.style.display = 'flex';
    privControls.style.gap = '5px';
    privControls.style.marginTop = '4px';

    var addPrivBtn = document.createElement('button');
    addPrivBtn.className = 'sec';
    addPrivBtn.textContent = '+ Add';
    addPrivBtn.addEventListener('click', function () { privRows.appendChild(makeEnvVarRow('', '', true)); });

    var openPrivBtn = document.createElement('button');
    openPrivBtn.className = 'sec';
    openPrivBtn.textContent = raw.hasPrivateFile ? 'Open File' : 'Open File (will create)';
    openPrivBtn.addEventListener('click', function () {
      req('openEnvironmentFile', { id: id, fileType: 'private' }).catch(function (e) { showError(e.message); });
    });

    privControls.appendChild(addPrivBtn);
    privControls.appendChild(openPrivBtn);
    d.appendChild(privControls);

    // Save
    var saveDiv = document.createElement('div');
    saveDiv.style.marginTop = '12px';
    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save Changes';
    saveBtn.addEventListener('click', function () {
      var pubVars = collectEnvVarRows('emgr-pub-rows');
      var privVars = collectEnvVarRows('emgr-priv-rows');
      req('saveEnvironment', { id: id, publicName: raw.publicName, publicVars: pubVars, privateVars: privVars })
        .then(function (data) {
          state.environments = data.environments;
          populateEnvs(activeEnvId);
          showToast('✓ Environment saved');
          openEnvDetail(id);
        }).catch(function (e) { showError(e.message); });
    });
    saveDiv.appendChild(saveBtn);
    d.appendChild(saveDiv);
  }

  function makeEnvVarRow(key, value, isPrivate) {
    var row = document.createElement('div');
    row.className = 'kv-row';
    row.innerHTML =
      '<input class="key" type="text" placeholder="Key" value="' + esc(key) + '"/>' +
      '<input class="val" type="' + (isPrivate ? 'password' : 'text') + '" placeholder="Value" value="' + esc(value) + '" style="flex:1"/>' +
      '<button class="icon" title="Remove">×</button>';
    row.querySelector('.icon').addEventListener('click', function () { row.remove(); });
    return row;
  }

  function collectEnvVarRows(containerId) {
    var c = el(containerId);
    if (!c) return {};
    var result = {};
    c.querySelectorAll('.kv-row').forEach(function (row) {
      var inputs = row.querySelectorAll('input');
      var k = inputs[0] ? inputs[0].value.trim() : '';
      var v = inputs[1] ? inputs[1].value : '';
      if (k) result[k] = v;
    });
    return result;
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  var settingsDlg = el('settings-dlg');
  var settingsForm = el('settings-form');

  el('btn-settings').addEventListener('click', function () {
    renderSettingsForm(state.settings || {});
    settingsDlg.showModal();
  });
  el('settings-close').addEventListener('click', function () { settingsDlg.close(); });
  el('settings-cancel').addEventListener('click', function () { settingsDlg.close(); });
  el('settings-open-file').addEventListener('click', function () {
    req('openSettingsFile').catch(function (e) { showError(e.message); });
  });
  el('settings-save').addEventListener('click', function () {
    var s = readSettingsForm();
    req('saveSettings', { settings: s })
      .then(function (data) {
        state.settings = data.settings;
        settingsDlg.close();
        showToast('✓ Settings saved');
      }).catch(function (e) { showError(e.message); });
  });

  function renderSettingsForm(s) {
    settingsForm.innerHTML = '';

    function addRow(label, inputHtml) {
      var row = document.createElement('div');
      row.className = 'settings-row';
      row.innerHTML = '<label>' + esc(label) + '</label>' + inputHtml;
      settingsForm.appendChild(row);
    }

    var colOpts = Object.keys(state.collections).map(function (id) {
      return '<option value="' + esc(id) + '"' + (id === s.defaultCollection ? ' selected' : '') + '>' +
        esc((state.collections[id] && state.collections[id].name) || id) + '</option>';
    }).join('');
    addRow('Default Collection', '<select id="s-def-col">' + colOpts + '</select>');

    var envOpts = Object.keys(state.environments).map(function (id) {
      return '<option value="' + esc(id) + '"' + (id === s.defaultEnvironment ? ' selected' : '') + '>' +
        esc((state.environments[id] && state.environments[id].name) || id) + '</option>';
    }).join('');
    addRow('Default Environment', '<select id="s-def-env">' + envOpts + '</select>');

    addRow('Timeout (ms)', '<input id="s-timeout" type="number" min="1000" step="1000" value="' + esc(s.timeoutMs || 30000) + '"/>');
    addRow('History Body Preview (chars)', '<input id="s-hist-limit" type="number" min="0" step="1000" value="' + esc(s.historyBodyPreviewLimit || 20000) + '"/>');
    addRow('Follow Redirects', '<input id="s-redirects" type="checkbox"' + (s.followRedirects !== false ? ' checked' : '') + '/>');
    addRow('Verify TLS', '<input id="s-tls" type="checkbox"' + (s.verifyTls !== false ? ' checked' : '') + '/>');

    var redactSection = document.createElement('div');
    redactSection.innerHTML = '<div class="section-label" style="margin-bottom:6px">Redacted Headers</div>';
    var redactList = document.createElement('div');
    redactList.className = 'redact-list';
    redactList.id = 's-redact-list';
    (s.redactHeaders || []).forEach(function (h) { addRedactItem(redactList, h); });
    var addRedactBtn = document.createElement('button');
    addRedactBtn.className = 'sec add-row-btn';
    addRedactBtn.textContent = '+ Add';
    addRedactBtn.addEventListener('click', function () { addRedactItem(redactList, ''); });
    redactSection.appendChild(redactList);
    redactSection.appendChild(addRedactBtn);
    settingsForm.appendChild(redactSection);
  }

  function addRedactItem(list, value) {
    var item = document.createElement('div');
    item.className = 'redact-item';
    item.innerHTML = '<input type="text" placeholder="header-name" value="' + esc(value) + '"/><button class="icon">×</button>';
    item.querySelector('.icon').addEventListener('click', function () { item.remove(); });
    list.appendChild(item);
  }

  function readSettingsForm() {
    var redactList = el('s-redact-list');
    var redactHeaders = redactList
      ? Array.from(redactList.querySelectorAll('input[type=text]'))
          .map(function (i) { return i.value.trim().toLowerCase(); }).filter(Boolean)
      : [];
    return {
      defaultCollection: (el('s-def-col') || {}).value || '',
      defaultEnvironment: (el('s-def-env') || {}).value || '',
      timeoutMs: parseInt((el('s-timeout') || {}).value, 10) || 30000,
      historyBodyPreviewLimit: parseInt((el('s-hist-limit') || {}).value, 10) || 20000,
      followRedirects: !!(el('s-redirects') || {}).checked,
      verifyTls: !!(el('s-tls') || {}).checked,
      redactHeaders: redactHeaders,
    };
  }

  // ── History ───────────────────────────────────────────────────────────────

  var histDlg = el('history-dlg');
  var histList = el('hist-list');
  var histDetail = el('hist-detail');
  var histFilterStatus = el('hist-filter-status');
  var histFilterText = el('hist-filter-text');
  var selectedHistId = null;

  el('btn-history').addEventListener('click', function () {
    req('listHistory').then(function (data) {
      historyEntries = data.entries || [];
      renderHistList();
      histDlg.showModal();
    }).catch(function (e) { showError(e.message); });
  });
  el('history-close').addEventListener('click', function () { histDlg.close(); });

  histFilterStatus.addEventListener('change', renderHistList);
  histFilterText.addEventListener('input', renderHistList);

  el('history-clear').addEventListener('click', function () {
    pitmanConfirm('Clear all history? This cannot be undone.').then(function (ok) {
      if (!ok) return;
      req('clearHistory').then(function () {
        historyEntries = [];
        renderHistList();
        histDetail.innerHTML = '<span class="empty-hint">History cleared.</span>';
      }).catch(function (e) { showError(e.message); });
    });
  });

  function renderHistList() {
    histList.innerHTML = '';
    var statusFilter = histFilterStatus.value;
    var textFilter = histFilterText.value.toLowerCase();

    var filtered = historyEntries.filter(function (e) {
      if (statusFilter === 'err' && e.status !== 0) return false;
      if (statusFilter && statusFilter !== 'err') {
        if (String(e.status)[0] !== statusFilter) return false;
      }
      if (textFilter && e.url.toLowerCase().indexOf(textFilter) === -1) return false;
      return true;
    });

    if (filtered.length === 0) {
      histList.innerHTML = '<span class="empty-hint" style="padding:8px;display:block">No entries.</span>';
      return;
    }

    filtered.forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'hist-row' + (entry.id === selectedHistId ? ' selected' : '');
      var sc = entry.status < 300 ? 'status-ok' : entry.status < 500 ? 'status-warn' : 'status-err';
      var ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
      row.innerHTML =
        '<div>' +
        '<span class="hist-method">' + esc(entry.method) + '</span>' +
        '<span class="hist-status ' + sc + '">' + esc(String(entry.status)) + '</span>' +
        '<span class="hist-url" title="' + esc(entry.url) + '">' + esc(entry.url) + '</span>' +
        '</div>' +
        '<div class="hist-meta">' + esc(ts) + '  ' + esc(entry.durationMs + 'ms') + '</div>';
      row.addEventListener('click', function () {
        selectedHistId = entry.id;
        histList.querySelectorAll('.hist-row').forEach(function (r) { r.classList.remove('selected'); });
        row.classList.add('selected');
        renderHistDetail(entry);
      });
      histList.appendChild(row);
    });
  }

  function renderHistDetail(entry) {
    var fmtHeaders = function (h) {
      return Object.keys(h || {}).map(function (k) { return k + ': ' + h[k]; }).join('\n');
    };
    histDetail.innerHTML =
      '<div class="detail-section"><h4>Request</h4>' +
      '<pre>' + esc(entry.method + ' ' + entry.url) + '</pre></div>' +
      '<div class="detail-section"><h4>Request Headers</h4><pre>' + esc(fmtHeaders(entry.requestHeaders)) + '</pre></div>' +
      '<div class="detail-section"><h4>Response</h4>' +
      '<pre>' + esc(entry.status + ' ' + entry.statusText + '  ' + entry.durationMs + 'ms') + '</pre></div>' +
      '<div class="detail-section"><h4>Response Headers</h4><pre>' + esc(fmtHeaders(entry.responseHeaders)) + '</pre></div>' +
      '<div class="detail-section"><h4>Body Preview</h4><pre>' + esc(entry.responseBodyPreview || '') + '</pre></div>' +
      '<button id="hist-rerun">Re-run</button>';

    histDetail.querySelector('#hist-rerun').addEventListener('click', function () {
      var reqObj = {
        id: entry.requestId, name: entry.requestId, method: entry.method,
        url: entry.url, params: [], headers: [], auth: { type: 'none' },
        body: { type: 'none' }, docs: '',
      };
      req('rerunHistoryEntry', { request: reqObj, environmentId: entry.environmentId })
        .then(function (data) { histDlg.close(); showResponse(data.response); })
        .catch(function (e) { showError(e.message); });
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  populateCollections();
  populateEnvs();
  vscode.postMessage({ type: 'ready' });

}());
