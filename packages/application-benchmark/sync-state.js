(function (root) {
  'use strict';
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  /** 三方合并仅保留未冲突的本地输入；解析明确覆盖的字段以服务端为准，不重放旧整表。 */
  function rebase(base, local, remote, overwritten = []) {
    const forced = new Set(overwritten);
    function merge(before, edited, latest, path) {
      if (forced.has(path) || same(before, edited)) return structuredClone(latest);
      if (same(before, latest) && !overwritten.some(field => !path || field.startsWith(path + '.'))) return structuredClone(edited);
      if (Array.isArray(before) && Array.isArray(edited) && Array.isArray(latest)) {
        const ids = value => value.map(item => item?.id);
        if (same(ids(before), ids(edited)) && same(ids(before), ids(latest))) return latest.map((item, i) => merge(before[i], edited[i], item, path + '.' + i));
        // 并发增删经历不能按索引猜测归属，保留远端结构并提示用户重新核对。
        return structuredClone(latest);
      }
      if (object(before) && object(edited) && object(latest)) {
        const result = {};
        for (const key of new Set([...Object.keys(before), ...Object.keys(edited), ...Object.keys(latest)])) {
          const value = merge(before[key], edited[key], latest[key], path ? path + '.' + key : key);
          if (value !== undefined) result[key] = value;
        }
        return result;
      }
      return structuredClone(latest);
    }
    return merge(base, local, remote, '');
  }
  const api = { rebase };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CareerSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
