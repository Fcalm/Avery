/** 采集筛选忽略宽度、大小写、空白及符号差异，保留各语言文字与数字。 */
function NormalizeKeyword(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** 各来源预筛和入库筛选共用规则；全文范围逐字段匹配，避免跨标题、公司、正文拼出关键词。 */
export function MatchesCollectionKeyword(values: string | readonly string[], keyword: string): boolean {
  const normalized = NormalizeKeyword(keyword);
  // 仅含分隔符的输入与空关键词一致，不凭空引入筛选条件。
  if (!normalized) return true;
  const fields = typeof values === 'string' ? [values] : values;
  return fields.some(value => NormalizeKeyword(value).includes(normalized));
}
