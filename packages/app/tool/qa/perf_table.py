#!/usr/bin/env python3
"""Frame-build summary of tool/qa/device.sh perf runs, side by side.
Usage: perf_table.py <run dir> [<run dir> ...]   (e.g. ~/.local/state/agent-company/qa/device/perf)"""
import os
import re
import sys

KEYS = ['tabs', 'open_chat_2000', 'scroll_chat_2000', 'streaming_2000', 'send']
FIELDS = [('avg', 'average_frame_build_time_millis'), ('p90', '90th_percentile_frame_build_time_millis'),
          ('p99', '99th_percentile_frame_build_time_millis'), ('worst', 'worst_frame_build_time_millis'),
          ('missed', 'missed_frame_build_budget_count')]

for d in sys.argv[1:]:
    print(f'== {os.path.basename(d.rstrip("/"))}  (UI thread build ms; missed = frames over 16ms)')
    for k in KEYS:
        f = os.path.join(d, k + '.json')
        if not os.path.exists(f):
            continue
        t = open(f).read()
        vals = []
        for label, key in FIELDS:
            m = re.search(key + r'"?: ([0-9.]+)', t)
            vals.append(f'{label} {m.group(1) if m else "?":>7}')
        print(f'  {k:<18} ' + '  '.join(vals))
