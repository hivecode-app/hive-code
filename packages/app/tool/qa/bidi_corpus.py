#!/usr/bin/env python3
"""Samples real mixed Hebrew/English messages for the bidi golden corpus.

Sources: Claude Code transcripts (~/.claude/projects/*/*.jsonl, owner and assistant text) and
hq.db (messages to and from the owner). Keeps dev conversations only and drops anything that
looks private (money, banks, tokens, emails, phone numbers). Prints candidates as JSON with the
features each one exercises, so a stratified pick covers every bidi case.

Usage: bidi_corpus.py [--max 400] > /tmp/candidates.json
"""
import glob
import json
import os
import re
import sqlite3
import sys

HOME = os.path.expanduser('~')
HEB = re.compile(r'[֐-׿]')
LAT = re.compile(r'[A-Za-z]')
PRIVATE = re.compile(
    r'(₪|\$\d|USD|ILS|THB|IBAN|SWIFT|bank|בנק|הפועלים|מזרחי|Wise|Mercury|Schwab|IBKR|Stripe|Payoneer|Airwallex|'
    r'מס הכנסה|ביטוח|tax|password|סיסמ|token|טוקן|secret|api[-_]?key|Bearer|@[a-z0-9.-]+\.(com|io|co)|\+?\d[\d -]{8,}\d|'
    r'דירה|apartment|insurance|FedEx|Thailand|תאילנד|passport|דרכון|ת\.ז|health|בריאות|<system|<command|<local-command|'
    r'system-reminder|tool_use_id|\[Request interrupted|ChatGPT|Termux|mitm|proxy|Magisk|root|phone number|כרטיס|card)',
    re.I,
)
DEV_PROJECTS = re.compile(r'(agent-company|lumo|tiki-bot|voice-bot|acme-delivery)', re.I)


def features(t):
    f = []
    if '```' in t:
        f.append('fence')
    if re.search(r'`[^`\n]+`', t):
        f.append('code')
    if re.search(r'(^|\s)([\w.-]+/)+[\w.-]+', t):
        f.append('path')
    if re.search(r'https?://', t):
        f.append('url')
    if re.search(r'(PR\s*)?#\d+', t):
        f.append('pr')
    if re.search(r'^\s*([-*•]|\d+[.)])\s', t, re.M):
        f.append('list')
    if re.search(r'^#{1,4}\s', t, re.M):
        f.append('heading')
    if re.search(r'\*\*[^*]+\*\*', t):
        f.append('bold')
    if re.search(r'\d+(\.\d+)*\s?(ms|MB|GB|KB|px|dp|%|s\b)', t):
        f.append('units')
    if re.search(r'\bv?\d+\.\d+\.\d+', t):
        f.append('version')
    if re.search(r'\([^)]*[A-Za-z][^)]*\)', t) and HEB.search(t):
        f.append('parens')
    first = next((c for c in t if HEB.match(c) or LAT.match(c)), '')
    if LAT.match(first or ' ') and HEB.search(t):
        f.append('starts-latin')
    lines = [l for l in t.split('\n') if l.strip()]
    dirs = {('h' if HEB.search(l[: max(1, len(l))]) and (next((c for c in l if HEB.match(c) or LAT.match(c)), 'a') and HEB.match(next((c for c in l if HEB.match(c) or LAT.match(c)), 'a'))) else 'l') for l in lines}
    if len(dirs) > 1:
        f.append('mixed-lines')
    return f


def ok(t):
    return (
        isinstance(t, str)
        and 30 <= len(t) <= 900
        and HEB.search(t)
        and len(LAT.findall(t)) >= 4
        and not PRIVATE.search(t)
    )


def from_transcripts():
    for path in glob.glob(f'{HOME}/.claude/projects/*/*.jsonl'):
        if not DEV_PROJECTS.search(path):
            continue
        try:
            with open(path, encoding='utf-8') as fh:
                for line in fh:
                    try:
                        e = json.loads(line)
                    except Exception:
                        continue
                    if e.get('type') not in ('user', 'assistant') or e.get('isSidechain'):
                        continue
                    c = (e.get('message') or {}).get('content')
                    texts = [c] if isinstance(c, str) else [b.get('text') for b in (c or []) if isinstance(b, dict) and b.get('type') == 'text']
                    for t in texts:
                        if ok(t):
                            yield {'src': 'cc-' + e['type'], 'project': os.path.basename(os.path.dirname(path)), 'text': t.strip()}
        except OSError:
            continue


def from_hq():
    db = f'{HOME}/.local/state/agent-company/hq.db'
    if not os.path.exists(db):
        return
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    for (body,) in con.execute("select body from messages where (from_identity='owner' or to_identity='owner') and kind != 'system'"):
        if ok(body):
            yield {'src': 'hq', 'text': body.strip()}


def main():
    mx = int(sys.argv[sys.argv.index('--max') + 1]) if '--max' in sys.argv else 400
    seen, out = set(), []
    for c in list(from_hq()) + list(from_transcripts()):
        k = c['text'][:80]
        if k in seen:
            continue
        seen.add(k)
        c['features'] = features(c['text'])
        out.append(c)
    # Most feature-rich first, so the head of the list is the useful part.
    out.sort(key=lambda c: -len(c['features']))
    json.dump(out[:mx], sys.stdout, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
