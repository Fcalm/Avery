// 不依赖 PDF 库生成可移植的合成附件；候选人中文资料以 candidate.md 为准。
const fs = require('node:fs');
const path = require('node:path');
const lines = [
  ['LIN ZHIXIA', 24], ['AI Product Manager Intern | Synthetic benchmark resume', 11],
  ['13800138000 | lin.zhixia@example.com | Hangzhou, Zhejiang, China', 10],
  ['Female | Born 2003-08-16 | Chinese mainland', 10], [' ', 10],
  ['AVAILABILITY', 13], ['4 days/week | 6+ months | Available in 2 weeks | Target: Hangzhou', 10],
  ['Source: University career site | Accept location adjustment', 10], [' ', 10],
  ['EDUCATION', 13], ['Nanchang University | Business Administration | Bachelor', 11],
  ['2022-09 to 2026-06 | Full-time | GPA 3.7/4 | Top 10%', 10],
  ['Courses: Marketing, Management, Statistics, Information Systems', 10],
  ['Zhejiang University | Information Management and Information Systems', 11],
  ['2026-09 to 2029-06 (expected) | Full-time Master', 10], [' ', 10],
  ['WORK EXPERIENCE', 13], ['Hangzhou Yunxu Technology Co., Ltd. | Product Intern | Product Dept.', 11],
  ['2025-07 to 2025-12 | Internship', 10],
  ['Interviewed 20 campus users; analyzed needs and key use scenarios.', 10],
  ['Supported three prototype tests and two product experience improvements.', 10],
  ['Xuguang Information Technology Co., Ltd. | AI Product Intern', 11],
  ['2026-07 to Present | Internship', 10],
  ['Analyzed AI knowledge-base needs; designed interactions and evaluation', 10],
  ['checklists; collaborated with engineers to close user-feedback loops.', 10], [' ', 10],
  ['PROJECTS', 13], ['Campus Used Goods Exchange | Product Lead | 2024-10 to 2025-04', 11],
  ['Researched campus resale needs; owned flows, prototypes and testing.', 10],
  ['Led a four-person MVP team. https://example.com/campus', 10],
  ['AI Job Search Assistant | Product Designer | 2026-02 to Present', 11],
  ['Designed resume, job filtering and application tracking workflows;', 10],
  ['owned requirements, interaction prototypes and accuracy test cases.', 10], [' ', 10],
  ['SKILLS & PROFILE', 13], ['Requirements analysis, User research, SQL, Figma, AI applications', 10],
  ['CET-6: 512 | Portfolio: https://example.com/zhixia', 10],
  ['Hands-on product research and prototype validation; structured problem', 10],
  ['solving, data analysis and continuous learning in AI applications.', 10],
];
const escape = text => text.replace(/([\\()])/g, '\\$1');
let y = 798;
const stream = lines.map(([text, size]) => { const item = `BT /F1 ${size} Tf 48 ${y} Td (${escape(text)}) Tj ET`; y -= size + 7; return item; }).join('\n');
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
let pdf = '%PDF-1.4\n', offsets = [0];
objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(path.join(__dirname, 'lin-zhixia-resume.pdf'), pdf);
