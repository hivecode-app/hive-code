#!/usr/bin/env python3
"""Top widget builds in a Flutter timeline (traced with debugProfileBuildsEnabled).
Self time per widget type: an event's duration minus its children's. Usage:
  timeline_top.py <file.timeline.json> [N]"""
import json
import sys
from collections import defaultdict

path = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 25
ev = json.load(open(path))
ev = ev['traceEvents'] if isinstance(ev, dict) else ev
ui = [e for e in ev if e.get('ph') in ('B', 'E', 'X')]
by_tid = defaultdict(list)
for e in ui:
    by_tid[e['tid']].append(e)

self_t = defaultdict(float)
total_t = defaultdict(float)
count = defaultdict(int)
for tid, es in by_tid.items():
    es.sort(key=lambda e: (e['ts'], 0 if e['ph'] == 'E' else 1))
    stack = []  # [name, start, child_time]
    for e in es:
        if e['ph'] == 'X':
            d = e.get('dur', 0)
            total_t[e['name']] += d; self_t[e['name']] += d; count[e['name']] += 1
            if stack: stack[-1][2] += d
        elif e['ph'] == 'B':
            stack.append([e['name'], e['ts'], 0.0])
        elif stack:
            name, ts, child = stack.pop()
            d = e['ts'] - ts
            total_t[name] += d; self_t[name] += d - child; count[name] += 1
            if stack: stack[-1][2] += d

frames = count.get('BUILD', 0) or count.get('Frame', 0) or 1
print(f'frames with a build phase: {count.get("BUILD", 0)}')
for name in ['BUILD', 'LAYOUT', 'PAINT', 'COMPOSITING', 'Animator::BeginFrame']:
    if name in total_t:
        print(f'{name:<24} total {total_t[name]/1000:8.1f} ms  per frame {total_t[name]/1000/frames:6.2f} ms')
print(f'\n{"widget (self time)":<40} {"ms":>8} {"count":>7} {"ms/frame":>9}')
skip = {'BUILD', 'LAYOUT', 'PAINT', 'COMPOSITING', 'Frame', 'Animator::BeginFrame', 'Animate', 'VSYNC'}
for name, t in sorted(self_t.items(), key=lambda x: -x[1])[:n]:
    if name in skip:
        continue
    print(f'{name[:40]:<40} {t/1000:8.1f} {count[name]:7d} {t/1000/frames:9.3f}')
