'use strict';
const E = require('./engine.js');
/** 从本轮事实生成确定性的合成附件，避免缺失资料或同名场景被固定旧简历污染。 */
function createResumePdf(state) {
  const lines = ['合成候选人简历', '所有资料均为本地测评虚构数据'];
  for (const [section, title] of E.SECTIONS) {
    if (section === 'resume') continue;
    lines.push('', title);
    for (const field of E.fields(state).filter(item => item.path.startsWith(section + '.'))) {
      const value = field.disabled ? '至今' : E.get(state, field.path);
      if (E.isEmpty(value)) continue;
      const prefix = ['education', 'work', 'projects'].includes(section) ? `第${Number(field.path.split('.')[1]) + 1}段 ` : '';
      const text = `${prefix}${field.label}：${Array.isArray(value) ? value.join('、') : value}`;
      const chars = Array.from(text);
      for (let offset = 0; offset < chars.length; offset += 42) lines.push(chars.slice(offset, offset + 42).join(''));
    }
  }
  const objects = [], add = object => { objects.push(object); return objects.length; };
  const catalog = add(''), pages = add('');
  const unicode = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /AveryUCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <FFFF> <0000> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end';
  const cmap = add(`<< /Length ${Buffer.byteLength(unicode)} >>\nstream\n${unicode}\nendstream`);
  const descriptor = add('<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>');
  const descendant = add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /FontDescriptor ${descriptor} 0 R /DW 1000 /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>`);
  const font = add(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${cmap} 0 R >>`);
  const pageIds = [];
  for (let start = 0; start < lines.length; start += 40) {
    const content = lines.slice(start, start + 40).map((text, index) => `BT /F1 11 Tf 42 ${795 - index * 18} Td <${Buffer.from(text, 'utf16le').swap16().toString('hex')}> Tj ET`).join('\n');
    const stream = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objects[pages - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
module.exports = { createResumePdf };
