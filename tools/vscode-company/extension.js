// The conversation with one worker, in VS Code, the same one the app shows (packages/app). It talks to hq
// exactly as the app does (packages/app/lib/data/hq_backend.dart), with a device token of its own:
//   GET  /api/messages?identity=<worker>   the history, both ways
//   POST /api/messages/tell                 what he writes, from: owner
//   WS   /ws?token=&after=                  message.new and engine.* (the "עונה…" line)
//   POST /api/messages/:id/handled, /api/conversations/:id/read   what he saw here
//   POST /api/auth/pair                     a pairing code (settings → devices) for the token
// Every message carries the open file, the selected lines and the repo, below a line of its own.
const vscode = require('vscode');
const crypto = require('crypto');

const TOKEN_KEY = 'company.token';
const MAX_LINES = 200;
const MAX_CHARS = 8000;

/** @param {vscode.ExtensionContext} ctx */
function activate(ctx) {
  const chat = new Chat(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('company.chat', chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('company.pair', () => chat.pair()),
    vscode.commands.registerCommand('company.choose', () => chat.choose()),
    vscode.commands.registerCommand('company.ask', () => vscode.commands.executeCommand('company.chat.focus')),
    vscode.window.onDidChangeActiveTextEditor((e) => { if (e && e.document.uri.scheme === 'file') chat.editor = e; chat.showContext(); }),
    vscode.window.onDidChangeTextEditorSelection((e) => { if (e.textEditor.document.uri.scheme === 'file') chat.editor = e.textEditor; chat.showContext(); }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('company')) chat.restart(); }),
    { dispose: () => chat.stop() },
  );
}

class Chat {
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {vscode.TextEditor | undefined} the last text editor; focus in the panel leaves activeTextEditor alone, but not always */
    this.editor = vscode.window.activeTextEditor;
    this.view = undefined;
    this.messages = new Map(); // id → hq's message row, or a pending one of ours
    this.people = new Map(); // identity → its row in /api/org
    this.gen = 0; // which start() a reply belongs to
    this.seq = undefined;
    this.ws = undefined;
    this.timer = undefined;
    this.typing = false;
    this.stopped = false;
  }

  get url() { return vscode.workspace.getConfiguration('company').get('url').replace(/\/+$/, ''); }
  get identity() { return vscode.workspace.getConfiguration('company').get('identity'); }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview, this.ctx.extensionUri);
    view.webview.onDidReceiveMessage((m) => {
      if (m.type === 'ready') this.start();
      if (m.type === 'send') this.send(m.text, m.withContext);
      if (m.type === 'resend') this.deliver(m.id);
      if (m.type === 'pair') this.pair();
      if (m.type === 'choose') this.choose();
    });
    view.onDidChangeVisibility(() => { if (view.visible) this.markSeen(); });
  }

  post(m) { this.view?.webview.postMessage(m); }

  /** The device token; one left in ~/.config/agent-company/vscode-token (paired from outside) moves into secrets once. */
  async token() {
    const kept = await this.ctx.secrets.get(TOKEN_KEY);
    if (kept) return kept;
    const file = require('path').join(require('os').homedir(), '.config', 'agent-company', 'vscode-token');
    try {
      const t = require('fs').readFileSync(file, 'utf8').trim();
      if (!t) return undefined;
      await this.ctx.secrets.store(TOKEN_KEY, t);
      require('fs').rmSync(file);
      return t;
    } catch { return undefined; }
  }

  async api(method, path, body) {
    const token = await this.token();
    if (!token) throw new Unpaired();
    const r = await fetch(this.url + path, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401) throw new Unpaired();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return r.json();
  }

  async pair() {
    const code = await vscode.window.showInputBox({
      title: 'חיבור לחברה', prompt: 'קוד התאמה מהאפליקציה: הגדרות ← מכשירים ← מכשיר חדש', placeHolder: 'ABCD-EFGH', ignoreFocusOut: true,
    });
    if (!code) return;
    try {
      const r = await fetch(this.url + '/api/auth/pair', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), name: 'VS Code' }), signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`pair: ${r.status} ${await r.text()}`);
      await this.ctx.secrets.store(TOKEN_KEY, (await r.json()).token);
      this.restart();
    } catch (e) {
      console.error(e);
      vscode.window.showErrorMessage('הקוד לא התקבל. אפשר ליצור קוד חדש באפליקציה ולנסות שוב.');
    }
  }

  async choose() {
    try {
      const org = await this.api('GET', '/api/org');
      const people = org.identities.filter((i) => i.id !== 'owner' && i.id !== 'hq' && (i.lifecycle !== 'ephemeral' || i.live));
      const pick = await vscode.window.showQuickPick(
        people.map((i) => ({ label: i.name, description: i.title ?? '', id: i.id })),
        { title: 'שיחה עם', matchOnDescription: true });
      if (pick) await vscode.workspace.getConfiguration('company').update('identity', pick.id, vscode.ConfigurationTarget.Global);
    } catch (e) { this.fail(e); }
  }

  restart() { this.messages.clear(); this.seq = undefined; this.typing = false; this.start(); }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = undefined;
  }

  async start() {
    if (!this.view) return;
    this.stop(); // a view built again says ready again: one link at a time
    this.stopped = false;
    const gen = ++this.gen;
    this.showContext();
    if (!(await this.token())) return this.post({ type: 'unpaired' });
    try {
      const [org, res] = await Promise.all([this.api('GET', '/api/org'), this.api('GET', `/api/messages?identity=${encodeURIComponent(this.identity)}&limit=200`)]);
      if (gen !== this.gen) return;
      for (const i of org.identities) this.people.set(i.id, i);
      for (const m of res.messages) if (this.ours(m)) this.messages.set(m.id, m);
      this.post({ type: 'link', ok: true });
      this.render();
      this.markSeen();
      this.connect(gen);
    } catch (e) { this.fail(e); this.retry(); }
  }

  /** A message of this conversation: between him and the worker, not hq's own lines. */
  ours(m) {
    return m.kind !== 'system' && ((m.from_identity === 'owner' && m.to_identity === this.identity) || (m.from_identity === this.identity && m.to_identity === 'owner'));
  }

  connect(gen) {
    if (this.stopped) return;
    if (typeof WebSocket === 'undefined') return this.poll(gen);
    this.token().then((token) => {
      if (gen !== this.gen || this.stopped || !token) return;
      const u = new URL(this.url + '/ws');
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      u.searchParams.set('token', token);
      if (this.seq !== undefined) u.searchParams.set('after', String(this.seq));
      const ws = new WebSocket(u);
      this.ws = ws;
      let live = this.seq !== undefined;
      let silent = setTimeout(() => ws.close(), 60000);
      ws.onmessage = (ev) => {
        clearTimeout(silent);
        silent = setTimeout(() => ws.close(), 60000); // hq says something every 20 s; silence is a dead link
        const e = JSON.parse(ev.data);
        if (e.seq) this.seq = e.seq;
        if (e.type === 'live') { this.seq = e.seq; live = true; return; }
        // The replay too: what came between the history and this link (the map keeps one row per id).
        if (live) this.event(e);
        else if (e.type === 'message.state' || (e.type === 'message.new' && !this.messages.has(e.data?.id))) this.event(e); // the history's row is newer
      };
      ws.onclose = (ev) => {
        clearTimeout(silent);
        if (this.ws !== ws) return;
        this.ws = undefined;
        if (ev.code === 4401) return this.fail(new Unpaired());
        this.post({ type: 'link', ok: false });
        this.retry(); // through start(): the history again, and a revoked token shows as such (hq refuses the upgrade with 401)
      };
      ws.onopen = () => this.post({ type: 'link', ok: true });
    });
  }

  /** Without a WebSocket in this VS Code: the history again every 5 s. */
  poll(gen) {
    if (this.stopped || gen !== this.gen) return;
    this.timer = setTimeout(async () => {
      try {
        const res = await this.api('GET', `/api/messages?identity=${encodeURIComponent(this.identity)}&limit=50`);
        let fresh = false;
        for (const m of res.messages) if (this.ours(m) && this.messages.get(m.id)?.state !== m.state) { this.messages.set(m.id, m); fresh = true; }
        this.post({ type: 'link', ok: true });
        if (fresh) { this.render(); this.markSeen(); }
      } catch (e) { this.fail(e); }
      this.poll(gen);
    }, 5000);
  }

  retry() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), 5000);
  }

  event(e) {
    if (e.type === 'message.new' && e.data && this.ours(e.data)) {
      this.messages.set(e.data.id, e.data);
      if (e.data.from_identity === this.identity) this.typing = false;
      this.render();
      this.markSeen();
    } else if (e.type === 'message.state' && e.data && this.messages.has(e.data.id)) {
      this.messages.get(e.data.id).state = e.data.state;
      this.render();
    } else if (e.identity === this.identity && typeof e.type === 'string' && e.type.startsWith('engine.')) {
      const typing = e.type !== 'engine.result';
      if (typing !== this.typing) { this.typing = typing; this.render(); }
    } else if (e.identity === this.identity && e.type === 'shift.state' && this.typing) {
      this.typing = false;
      this.render();
    }
  }

  render() {
    const list = [...this.messages.values()].sort((a, b) => a.created_at - b.created_at);
    const who = this.people.get(this.identity);
    this.post({ type: 'messages', name: who?.name ?? this.identity, typing: this.typing, messages: list.map((m) => ({
      id: m.id, mine: m.from_identity === 'owner', body: m.body, at: m.created_at, state: m.state, note: m.kind === 'note',
    })) });
  }

  /** What he saw here counts as seen in the app too, as when the conversation is open there. */
  markSeen() {
    if (!this.view?.visible) return;
    let any = false;
    for (const m of this.messages.values()) {
      if (m.from_identity !== this.identity || m.state === 'handled' || m.kind === 'note' || m.seenHere) continue;
      m.seenHere = true;
      any = true;
      this.api('POST', `/api/messages/${encodeURIComponent(m.id)}/handled`).catch(() => {});
    }
    if (any) this.api('POST', `/api/conversations/${encodeURIComponent(this.identity)}/read`).catch(() => {});
  }

  async send(text, withContext) {
    const ctx = withContext ? await this.context() : undefined;
    const body = ctx ? `${text}\n\n---\n${ctx.text}` : text;
    const id = `vsc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    this.messages.set(id, { id, from_identity: 'owner', to_identity: this.identity, kind: 'tell', body, created_at: Date.now(), state: 'sending' });
    await this.deliver(id);
  }

  /** Sends [id] (again, after a failure: the same msg_id, which hq takes once; an answer to an open ask is the exception, mailbox.ts). */
  async deliver(id) {
    const m = this.messages.get(id);
    if (!m) return;
    m.state = 'sending';
    this.render();
    try {
      const r = await this.api('POST', '/api/messages/tell', { msg_id: id, from: 'owner', to: m.to_identity, body: m.body, priority: 'now' });
      const row = r.message;
      if (row && row.id !== id) {
        // An answer to an open ask comes back as that answer's row, under its own id.
        this.messages.delete(id);
        if (!this.messages.has(row.id)) this.messages.set(row.id, row);
      } else if (row && this.messages.get(id)?.state === 'sending') this.messages.set(id, row); // message.new may have come first
    } catch (e) {
      if (this.messages.get(id)?.state === 'sending') this.messages.get(id).state = 'failed';
      this.fail(e);
    }
    this.render();
  }

  /** The file, the lines and the repo, as one block under the message. */
  async context() {
    const ed = this.editor;
    if (!ed || ed.document.isClosed) return undefined;
    const doc = ed.document, sel = ed.selection;
    const repo = gitRepo(doc.uri);
    const root = repo?.rootUri ?? vscode.workspace.getWorkspaceFolder(doc.uri)?.uri;
    const path = root ? relative(root, doc.uri) : doc.uri.fsPath;
    const from = sel.start.line + 1;
    const to = sel.isEmpty ? from : sel.end.line + (sel.end.character === 0 && sel.end.line > sel.start.line ? 0 : 1);
    const where = sel.isEmpty ? `${path}:${from}` : `${path}:${from}-${to}`;
    const head = [];
    if (repo) {
      const remote = repo.state.remotes.find((r) => r.name === 'origin') ?? repo.state.remotes[0];
      const name = remote?.fetchUrl ? remote.fetchUrl.replace(/\.git$/, '').replace(/^.*[:/]([^/:]+\/[^/]+)$/, '$1') : root.path.split('/').pop();
      head.push(`repo: \`${name}\``);
      if (repo.state.HEAD?.name) head.push(`branch: \`${repo.state.HEAD.name}\``);
      else if (repo.state.HEAD?.commit) head.push(`commit: \`${repo.state.HEAD.commit.slice(0, 8)}\``);
    }
    head.push(`file: \`${where}\``);
    let text = `מ-VS Code בלפטופ · ${head.join(' · ')}`;
    if (!sel.isEmpty) {
      let code = doc.getText(new vscode.Range(sel.start.line, 0, to - 1, doc.lineAt(to - 1).text.length));
      const lines = code.split('\n');
      if (lines.length > MAX_LINES) code = lines.slice(0, MAX_LINES).join('\n') + `\n… (${lines.length - MAX_LINES} שורות נוספות)`;
      if (code.length > MAX_CHARS) code = code.slice(0, MAX_CHARS) + '\n…';
      const fence = '`'.repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((r) => r.length + 1)));
      text += `\n${fence}${doc.languageId}\n${code}\n${fence}`;
    }
    return { text, label: where };
  }

  async showContext() {
    const ctx = await this.context();
    this.post({ type: 'context', label: ctx?.label ?? null });
  }

  fail(e) {
    if (e instanceof Unpaired) { this.stop(); return this.post({ type: 'unpaired' }); }
    console.error('[company]', e);
    this.post({ type: 'link', ok: false });
  }
}

class Unpaired extends Error {}

function gitRepo(uri) {
  try {
    const git = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI(1);
    return git?.getRepository(uri) ?? undefined;
  } catch { return undefined; }
}

function relative(root, uri) {
  const r = root.path.endsWith('/') ? root.path : root.path + '/';
  return uri.path.startsWith(r) ? uri.path.slice(r.length) : uri.fsPath;
}

function html(webview, base) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'media', 'chat.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'media', 'chat.css'));
  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"></head>
<body>
  <div id="unpaired" hidden>
    <p>כדי לדבר עם החברה מכאן, צריך לחבר את VS Code פעם אחת עם קוד התאמה מהאפליקציה (הגדרות ← מכשירים).</p>
    <button id="pair">חיבור עם קוד</button>
  </div>
  <div id="chat" hidden>
    <div id="head"><button id="who" title="החלפת עובד"></button><span id="link"></span></div>
    <div id="list"></div>
    <div id="typing" hidden></div>
    <div id="compose">
      <div id="ctx" hidden><span id="ctxLabel"></span><button id="ctxToggle" title="בלי הקובץ בהודעה הזו">הסרה</button></div>
      <textarea id="input" rows="3" placeholder="הודעה" dir="auto"></textarea>
      <div id="row"><span class="hint">Enter לשליחה · Shift+Enter לשורה חדשה</span><button id="send">שליחה</button></div>
    </div>
  </div>
<script nonce="${nonce}" src="${script}"></script>
</body></html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
