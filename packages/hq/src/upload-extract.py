"""Readable office/archive files. Runs in a bounded child process, never executes document macros."""
import csv
import json
import os
import pathlib
import stat
import sys
import tarfile
import zipfile
import xml.etree.ElementTree as ET

source, dest, mime = sys.argv[1:]
root = pathlib.Path(dest)
root.mkdir(mode=0o700, exist_ok=True)
meta = {'readable': []}
MAX = 200 * 1024 * 1024

def xml(z, name):
    if z.getinfo(name).file_size > 32 * 1024 * 1024:
        raise ValueError('document XML too large')
    return ET.fromstring(z.read(name))

def target(name):
    p = pathlib.PurePosixPath(name.replace('\\', '/'))
    if p.is_absolute() or '..' in p.parts or ':' in p.parts[0]:
        raise ValueError('unsafe archive path')
    return (root / 'files').joinpath(*p.parts)

def store(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists(): path.chmod(0o600)
    path.write_bytes(data)
    path.chmod(0o400)

if zipfile.is_zipfile(source):
    with zipfile.ZipFile(source) as z:
        meta['detected_mime'] = mime if mime == 'application/vnd.android.package-archive' and 'AndroidManifest.xml' in z.namelist() else 'application/zip'
        odf = z.read('mimetype').decode('ascii',errors='replace').strip() if 'mimetype' in z.namelist() and z.getinfo('mimetype').file_size < 256 else ''
        odf_types = {'application/vnd.oasis.opendocument.' + t for t in ('text','spreadsheet','presentation')}
        entries = z.infolist()
        if len(entries) > 2000 or sum(e.file_size for e in entries) > MAX:
            raise ValueError('archive exceeds extraction limit')
        if 'xl/workbook.xml' in z.namelist():
            ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            strings = []
            if 'xl/sharedStrings.xml' in z.namelist():
                strings = [''.join(e.itertext()) for e in xml(z, 'xl/sharedStrings.xml').findall('s:si', ns)]
            sheets = xml(z, 'xl/workbook.xml').findall('s:sheets/s:sheet', ns)
            rels = {r.attrib['Id']: r.attrib['Target'] for r in xml(z, 'xl/_rels/workbook.xml.rels')}
            meta['detected_mime'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            meta['sheets'] = len(sheets)
            counts = []
            for i, sheet in enumerate(sheets):
                rid = sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']
                name = rels[rid]
                name = name.lstrip('/') if name.startswith('/') else 'xl/' + name
                rows = []
                for row in xml(z, name).findall('s:sheetData/s:row', ns):
                    cells = []
                    for c in row.findall('s:c', ns):
                        ref = c.attrib.get('r', 'A1')
                        col = 0
                        for ch in ref:
                            if ch.isalpha(): col = col * 26 + ord(ch.upper()) - 64
                        if col > 16384: raise ValueError('invalid spreadsheet column')
                        while len(cells) < max(0, col - 1): cells.append('')
                        value = c.findtext('s:v', '', ns)
                        if c.attrib.get('t') == 's': value = strings[int(value)]
                        if c.attrib.get('t') == 'inlineStr': value = ''.join(c.find('s:is', ns).itertext())
                        cells.append(value)
                    rows.append(cells)
                out = root / ('sheet-%d.csv' % (i + 1))
                if out.exists(): out.chmod(0o600)
                with out.open('w', newline='', encoding='utf-8') as f: csv.writer(f).writerows(rows)
                out.chmod(0o400)
                meta['readable'].append(str(out))
                counts.append({'name': sheet.attrib.get('name', str(i + 1)), 'rows': len(rows)})
            meta['sheet_rows'] = counts
        elif 'word/document.xml' in z.namelist() or ('content.xml' in z.namelist() and odf in odf_types) or any(n.startswith('ppt/slides/slide') and n.endswith('.xml') for n in z.namelist()):
            names = ['word/document.xml'] if 'word/document.xml' in z.namelist() else ['content.xml'] if 'content.xml' in z.namelist() else sorted(n for n in z.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml'))
            meta['detected_mime'] = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' if names[0] == 'word/document.xml' else odf if names[0] == 'content.xml' else 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            text = []
            for name in names:
                for e in xml(z, name).iter():
                    tag = e.tag.split('}')[-1]
                    if tag in ('p', 'h'):
                        text.append(('## ' if tag == 'h' else '') + ''.join(e.itertext()))
            out = root / 'document.md'
            store(out, '\n\n'.join(text).encode('utf-8'))
            meta['readable'].append(str(out))
            if names[0].startswith('ppt/'): meta['slides'] = len(names)
        else:
            names = []
            for e in entries:
                if stat.S_ISLNK(e.external_attr >> 16): raise ValueError('archive symlink refused')
                path = target(e.filename)
                if e.is_dir(): continue
                store(path, z.read(e))
                names.append(e.filename)
            meta['files'] = len(names)
            out = root / 'manifest.txt'
            store(out, '\n'.join(names).encode('utf-8'))
            meta['readable'] = [str(out), str(root / 'files')]
elif tarfile.is_tarfile(source):
    with tarfile.open(source) as tar:
        names, total = [], 0
        for e in tar:
            total += e.size
            if len(names) >= 2000 or total > MAX: raise ValueError('archive exceeds extraction limit')
            path = target(e.name)
            if e.isdir(): continue
            if not e.isfile(): raise ValueError('archive links and special files refused')
            store(path, tar.extractfile(e).read())
            names.append(e.name)
        out = root / 'manifest.txt'
        store(out, '\n'.join(names).encode('utf-8'))
        meta.update(files=len(names), readable=[str(out), str(root / 'files')])
elif mime == 'text/csv':
    with open(source, newline='', encoding='utf-8-sig') as f: count = sum(1 for _ in csv.reader(f))
    meta.update(sheets=1, sheet_rows=[{'name': 'CSV', 'rows': count}], readable=[source])
print(json.dumps(meta))
