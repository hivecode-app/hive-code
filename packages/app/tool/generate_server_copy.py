"""Generate Android's server-health text from the same ARB source as Flutter."""
import json
from html import escape
from pathlib import Path
root = Path(__file__).resolve().parent.parent
for language, folder in [('en', 'values'), ('he', 'values-he')]:
    arb = json.loads((root / f'lib/l10n/app_{language}.arb').read_text())
    pairs = [('server_silent_title', 'serverSilentTitle'), ('server_silent_body', 'serverSilentBody'), ('server_silent_channel', 'serverSilentChannel')]
    content = f'<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated from lib/l10n/app_{language}.arb by tool/generate_server_copy.py -->\n<resources>\n'
    content += ''.join(f'    <string name="{key}">{escape(arb[value])}</string>\n' for key, value in pairs)
    content += '</resources>\n'
    (root / f'android/app/src/main/res/{folder}/server_connection.xml').write_text(content)
