// The panel: what extension.js sends (messages, context, link) on screen, and what he writes back to it.
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let withContext = true;
let hasContext = false;
let atBottom = true;

const STATE = { sending: 'נשלחת…', queued: 'ממתינה', delivered: 'נמסרה', seen: 'נקראה', handled: 'נקראה', failed: 'לא נשלחה' };
const hhmm = (t) => new Date(t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

$('list').addEventListener('scroll', () => { const l = $('list'); atBottom = l.scrollHeight - l.scrollTop - l.clientHeight < 40; });

window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'unpaired') { $('unpaired').hidden = false; $('chat').hidden = true; }
  if (m.type === 'link') { $('link').textContent = m.ok ? '' : 'אין חיבור, מנסה שוב'; }
  if (m.type === 'context') {
    hasContext = !!m.label;
    $('ctx').hidden = !hasContext;
    $('ctxLabel').textContent = m.label ?? '';
  }
  if (m.type === 'messages') {
    $('unpaired').hidden = true; $('chat').hidden = false;
    $('who').textContent = m.name;
    $('typing').hidden = !m.typing;
    $('typing').textContent = `${m.name} עונה…`; // the same word for a man and a woman: hq sends no gender
    const list = $('list');
    list.replaceChildren(...m.messages.map(bubble));
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
});

function bubble(m) {
  const d = document.createElement('div');
  d.className = `msg ${m.mine ? 'mine' : 'theirs'}${m.note ? ' note' : ''}`;
  d.dir = 'auto';
  // What this panel attached goes under its own line; shown short, the whole block is in the message.
  const cut = m.mine ? m.body.indexOf('\n\n---\nמ-VS Code') : -1;
  d.textContent = cut < 0 ? m.body : m.body.slice(0, cut);
  if (cut >= 0) {
    const c = document.createElement('span');
    c.className = 'ctx';
    c.textContent = (m.body.slice(cut).match(/file: `([^`]+)`/) ?? [])[1] ?? '';
    d.append(c);
  }
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = m.mine ? `${hhmm(m.at)} · ${STATE[m.state] ?? ''}` : hhmm(m.at);
  d.append(meta);
  if (m.mine && m.state === 'failed') {
    const again = document.createElement('button');
    again.className = 'again';
    again.textContent = 'ניסיון נוסף';
    again.onclick = () => vscode.postMessage({ type: 'resend', id: m.id });
    d.append(again);
  }
  return d;
}

function send() {
  const text = $('input').value.trim();
  if (!text) return;
  vscode.postMessage({ type: 'send', text, withContext: hasContext && withContext });
  $('input').value = '';
  withContext = true;
  $('ctx').classList.remove('off');
  $('ctxToggle').textContent = 'הסרה';
  atBottom = true;
}

$('send').onclick = send;
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
$('ctxToggle').onclick = () => {
  withContext = !withContext;
  $('ctx').classList.toggle('off', !withContext);
  $('ctxToggle').textContent = withContext ? 'הסרה' : 'צירוף';
};
$('pair').onclick = () => vscode.postMessage({ type: 'pair' });
$('who').onclick = () => vscode.postMessage({ type: 'choose' });
vscode.postMessage({ type: 'ready' });
