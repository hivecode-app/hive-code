"""Deterministic PDF fixtures with an embedded repo font and a real Hebrew text layer.
Run from packages/app: python3 tool/media_fixtures.py. Uses only Python's standard library.
"""
from pathlib import Path
import struct
import math
import zlib
root = Path(__file__).resolve().parents[1]
font = (root / 'assets/fonts/Heebo-400.ttf').read_bytes()
u16 = lambda at: struct.unpack_from('>H', font, at)[0]
tables = {font[12+i*16:16+i*16]: struct.unpack_from('>II', font, 20+i*16) for i in range(u16(4))}
cmap = tables[b'cmap'][0]
subtables = [cmap+struct.unpack_from('>I', font, cmap+8+i*8)[0] for i in range(u16(cmap+2))]
fmt = next(at for at in subtables if u16(at) == 4)
segments = u16(fmt+6)//2
end_at, start_at = fmt+14, fmt+16+segments*2
delta_at, range_at = start_at+segments*2, start_at+segments*4

def glyph(cp):
    for i in range(segments):
        if u16(start_at+i*2) <= cp <= u16(end_at+i*2):
            distance = u16(range_at+i*2)
            value = u16(range_at+i*2+distance+2*(cp-u16(start_at+i*2))) if distance else cp
            return (value+u16(delta_at+i*2)) & 65535 if value else 0
    return 0

# Each RTL line has its own direction; widths come from the embedded font.
english = ['Field notes', 'Media and version history', '04 Nov 2026', 'Reading a file without a connection',
           'Original files stay available when a preview cannot be prepared.',
           'A response points to the selected file and its exact version.',
           'An interrupted upload resumes from the parts already received.',
           'File', 'Size', 'Status', 'Service contract.pdf', '2.3 MB', 'Ready',
           'Site photographs.jpg', '840 KB', 'Ready', 'Project notes.docx', '89 KB', 'Ready',
           'Review notes', 'The original file is retained. A preview is a separate view.', 'Source: local test fixture', 'Page 0123456789']
hebrew = ['סקירת קבצים ותוצרים', 'המסמך נשאר קריא גם בלי רשת.',
          'כל גרסה שומרת על התוכן המקורי שלה.', 'תגובות חוזרות אל הקובץ והגרסה שנבחרו.',
          'שליחה ממשיכה לאחר ניתוק ושומרת על הטיוטה.']
codes = sorted(set(map(ord, ''.join(english+hebrew))))
gids = b''.join(struct.pack('>H',glyph(cp)) for cp in range(max(codes)+1))
units = u16(tables[b'head'][0]+18)
metrics = u16(tables[b'hhea'][0]+34)
def advance(cp):
    return round(u16(tables[b'hmtx'][0]+min(glyph(cp),metrics-1)*4)*1000/units)
widths = ' '.join('%d [%d]' % (cp,advance(cp)) for cp in codes)
encoding = ('/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /HeeboUnicode def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange %d beginbfchar\n' % len(codes) + '\n'.join('<%04X> <%04X>' % (cp,cp) for cp in codes) + '\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end').encode()
def line(text,x,y,size=12,rtl=False):
    if rtl:
        x -= sum(advance(ord(c)) for c in text)*size/1000
        text = text[::-1]
    return 'BT /F1 %s Tf %s %s Td <%s> Tj ET\n' % (size,x,y,text.encode('utf-16-be').hex())

def pdf(pages):
    objects = []
    def obj(data):
        objects.append(data.encode() if isinstance(data,str) else data)
        return len(objects)
    def stream(data, extra=''):
        packed = zlib.compress(data)
        return obj(('<< /Length %d /Filter /FlateDecode %s >>\nstream\n' % (len(packed),extra)).encode()+packed+b'\nendstream')
    catalog = obj('')
    tree = obj('')
    fontfile = stream(font, '/Length1 %d' % len(font))
    descriptor = obj('<< /Type /FontDescriptor /FontName /Heebo /Flags 4 /FontBBox [-1000 -1000 2000 2000] /ItalicAngle 0 /Ascent 1000 /Descent -300 /CapHeight 700 /StemV 80 /FontFile2 %d 0 R >>' % fontfile)
    mapping = stream(gids)
    descendant = obj('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Heebo /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor %d 0 R /CIDToGIDMap %d 0 R /W [%s] >>' % (descriptor,mapping,widths))
    unicode = stream(encoding)
    typeface = obj('<< /Type /Font /Subtype /Type0 /BaseFont /Heebo /Encoding /Identity-H /DescendantFonts [%d 0 R] /ToUnicode %d 0 R >>' % (descendant,unicode))
    children = []
    for page in range(pages):
        drawing = '0.14 0.16 0.19 rg\n' + line('Field notes',48,772,32)+line('Media and version history',48,743,16)+line('04 Nov 2026',48,717,10)
        drawing += '0.7 0.72 0.74 RG 48 700 m 547 700 l S\n'
        drawing += line(hebrew[0],547,664,24,rtl=True)
        for i,text in enumerate(hebrew[1:]): drawing += line(text,547,631-i*25,15,rtl=True)
        drawing += line(english[3],48,490,18)
        for i,text in enumerate(english[4:7]): drawing += line(text,48,462-i*22,11)
        drawing += '0.93 0.94 0.95 rg 48 359 499 30 re f 0.14 0.16 0.19 rg\n'
        for x,text in zip((58,370,460),('File','Size','Status')): drawing += line(text,x,369,11)
        for i,(name,size) in enumerate((('Service contract.pdf','2.3 MB'),('Site photographs.jpg','840 KB'),('Project notes.docx','89 KB'))):
            y=339-i*34
            for x,text in zip((58,370,460),(name,size,'Ready')): drawing += line(text,x,y,11)
            drawing += '0.84 0.85 0.86 RG 48 %d m 547 %d l S\n' % (y-12,y-12)
        drawing += line('Review notes',48,196,17)+line(english[-3],48,169,11)
        drawing += line('Source: local test fixture',48,48,9)+line('Page %d' % (page+1),490,48,9)
        content = stream(drawing.encode())
        children.append(obj('<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>' % (tree,typeface,content)))
    objects[catalog-1] = ('<< /Type /Catalog /Pages %d 0 R >>' % tree).encode()
    objects[tree-1] = ('<< /Type /Pages /Kids [%s] /Count %d >>' % (' '.join('%d 0 R' % n for n in children),pages)).encode()
    data = b'%PDF-1.7\n'; offsets = [0]
    for i, entry in enumerate(objects,1):
        offsets.append(len(data)); data += ('%d 0 obj\n' % i).encode()+entry+b'\nendobj\n'
    xref = len(data)
    data += ('xref\n0 %d\n0000000000 65535 f \n' % len(offsets)).encode()
    data += b''.join(('%010d 00000 n \n' % off).encode() for off in offsets[1:])
    data += ('trailer << /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(offsets),catalog,xref)).encode()
    return data

out = root / 'test/fixtures/media'
out.mkdir(exist_ok=True)
for count in (12,300):
    (out / ('search-%d.pdf' % count)).write_bytes(pdf(count))

# Reproducible full-size bitmap scenes for gallery and thumbnail visual tests.
def scene(number):
    width,height=960,640
    rows=[]
    for y in range(height):
        row=bytearray([0])
        for x in range(width):
            sky=(221-int(y*.04),231-int(y*.035),235-int(y*.02))
            if (x-(700-number*110))**2+(y-136)**2 < 54**2: color=(228,188,113)
            elif y>390+int(18*math.sin(x/180+number)): color=(83+int((y-390)*.08),127+int((y-390)*.06),144+int((y-390)*.04))
            elif y>335-125*math.sin(x/210+number): color=(101+number*9,124+number*7,115+number*5)
            elif y>290-94*math.sin(x/250+1+number): color=(145,159,151)
            else: color=sky
            row.extend(color)
        rows.append(bytes(row))
    def chunk(tag,data): return struct.pack('>I',len(data))+tag+data+struct.pack('>I',zlib.crc32(tag+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows)))+chunk(b'IEND',b'')
for number in range(1,4): (out/('landscape-%d.png'%number)).write_bytes(scene(number))
