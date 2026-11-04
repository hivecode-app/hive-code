"""Small deterministic fixtures, plus an uncompressed 150MB ZIP for resumability."""
import pathlib, sys, zipfile
p = pathlib.Path(sys.argv[1]); p.mkdir(exist_ok=True)
with zipfile.ZipFile(p / 'book.xlsx', 'w') as z:
    z.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + ''.join('<sheet name="Sheet%d" sheetId="%d" r:id="r%d"/>' % (i,i,i) for i in range(1,4)) + '</sheets></workbook>')
    z.writestr('xl/_rels/workbook.xml.rels', '<Relationships>' + ''.join('<Relationship Id="r%d" Target="worksheets/sheet%d.xml"/>' % (i,i) for i in range(1,4)) + '</Relationships>')
    for i in range(1,4): z.writestr('xl/worksheets/sheet%d.xml' % i, '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hello</t></is></c><c r="C1"><v>42</v></c></row></sheetData></worksheet>')
with zipfile.ZipFile(p / 'files.zip', 'w') as z:
    for i in range(37): z.writestr('folder/file%d.txt' % i, 'file %d' % i)
    z.writestr('manifest.txt', 'original manifest content')
with zipfile.ZipFile(p / 'document.docx', 'w') as z:
    z.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>החוזה בתוקף לשלושים יום</w:t></w:r></w:p></w:body></w:document>')
with zipfile.ZipFile(p / 'unsafe.zip', 'w') as z: z.writestr('../../escape.txt', 'bad')
objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [' + ' '.join('%d 0 R' % i for i in range(3,15)) + '] /Count 12 >>']
for i in range(12): objects.append('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 512 512] /Resources << >> /Contents 15 0 R >>')
objects.append('<< /Length 0 >>\nstream\n\nendstream')
data = b'%PDF-1.4\n'; offsets = [0]
for i, obj in enumerate(objects, 1):
    offsets.append(len(data)); data += ('%d 0 obj\n%s\nendobj\n' % (i,obj)).encode()
xref = len(data)
data += ('xref\n0 %d\n0000000000 65535 f \n' % len(offsets)).encode()
for off in offsets[1:]: data += ('%010d 00000 n \n' % off).encode()
data += ('trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(offsets),xref)).encode()
(p / 'pages.pdf').write_bytes(data)
if len(sys.argv) > 2:
    with zipfile.ZipFile(p / 'large.zip', 'w', compression=zipfile.ZIP_STORED) as z:
        with z.open('payload.dat', 'w') as f:
            for i in range(150): f.write(bytes([i % 251]) * 1024 * 1024)

for ext, kind in [('odt','text'),('ods','spreadsheet'),('odp','presentation')]:
    with zipfile.ZipFile(p / ('sample.' + ext),'w') as z:
        z.writestr('mimetype','application/vnd.oasis.opendocument.' + kind)
        z.writestr('content.xml','<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><text:p>example</text:p></office:document>')
