import { parse, type AnyNode, type Node } from 'acorn';

/** 脚本只编排既有窄工具；不解释宿主 JavaScript，不向脚本暴露对象原型或可调用的宿主函数。 */
export const BrowserScriptMethods = {
  navigate: 'BrowserNavigate', snapshot: 'BrowserSnapshot', screenshot: 'BrowserScreenshot',
  readPage: 'BrowserReadPage', fill: 'BrowserFill', click: 'BrowserClick', press: 'BrowserPressKey',
  select: 'BrowserSelect', setChecked: 'BrowserSetChecked', uploadFile: 'BrowserUploadFile',
  fillForm: 'BrowserFillForm', validateForm: 'BrowserValidateForm', wait: 'BrowserWait',
  switchTab: 'BrowserSwitchTab', goBack: 'BrowserGoBack',
} as const;
export type BrowserScriptMethod = keyof typeof BrowserScriptMethods;
export type ScriptValue = null | boolean | number | string | ScriptValue[] | { [key: string]: ScriptValue };
const BlockedProperties = new Set(['__proto__', 'prototype', 'constructor']);
const ReservedNames = new Set(['page', 'console', 'undefined', ...BlockedProperties]);
const AllowedNodes = new Set([
  'Program', 'BlockStatement', 'EmptyStatement', 'ExpressionStatement', 'VariableDeclaration', 'VariableDeclarator',
  'Identifier', 'Literal', 'ArrayExpression', 'ObjectExpression', 'Property', 'MemberExpression', 'CallExpression',
  'AwaitExpression', 'IfStatement', 'ForOfStatement', 'ForStatement', 'AssignmentExpression', 'UpdateExpression',
  'BinaryExpression', 'LogicalExpression', 'UnaryExpression', 'ConditionalExpression', 'TemplateLiteral',
  'TemplateElement', 'ReturnStatement', 'BreakStatement', 'ContinueStatement',
]);

export class BrowserScriptError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
class Flow {
  constructor(readonly kind: 'return' | 'break' | 'continue', readonly value: ScriptValue = null) {}
}

/** 预检整个 AST，包括不会执行的分支；非法代码不能在前面的合法动作产生副作用后才被发现。 */
function ValidateScript(source: string): AnyNode {
  if (!source.trim() || source.length > 16000) throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', 'Script must contain 1 to 16000 characters.');
  let ast: Node;
  try { ast = parse(source, { ecmaVersion: 2022, sourceType: 'module', allowReturnOutsideFunction: true }); }
  catch { throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', 'Invalid JavaScript syntax.'); }
  let count = 0;
  const visit = (node: AnyNode, parent?: AnyNode, depth = 0): void => {
    if (++count > 2500 || depth > 40) throw new BrowserScriptError('BROWSER_SCRIPT_LIMIT', 'Script syntax is too large or deeply nested.');
    const invalid = (message: string): never => { throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', message); };
    if (!AllowedNodes.has(node.type)) invalid(`Unsupported syntax: ${node.type}. Use await page methods, variables, if and bounded for loops.`);
    if (node.type === 'Literal' && (node.regex || typeof node.value === 'bigint')) invalid('Regular expressions and bigint are unavailable.');
    if (node.type === 'VariableDeclarator' && (node.id.type !== 'Identifier' || ReservedNames.has(node.id.name))) invalid('Use a simple non-reserved variable name.');
    if (node.type === 'Property' && (node.kind !== 'init' || node.method || node.computed)) invalid('Only plain object properties are supported.');
    if (node.type === 'ForOfStatement' && (node.await || node.left.type !== 'VariableDeclaration' || node.left.declarations.length !== 1)) invalid('Use for (const item of array).');
    if (node.type === 'AssignmentExpression' && (node.operator !== '=' || node.left.type !== 'Identifier')) invalid('Only assignment to a let variable is supported.');
    if (node.type === 'UpdateExpression' && node.argument.type !== 'Identifier') invalid('Only a numeric loop variable can be incremented.');
    if (node.type === 'CallExpression') {
      const c = node.callee;
      if (c.type !== 'MemberExpression' || c.computed || c.optional || c.object.type !== 'Identifier' || c.property.type !== 'Identifier') invalid('Only await page.method(...) and console.log(...) are callable.');
      if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.property.type === 'Identifier') {
        if (c.object.name === 'page') {
          if (!Object.hasOwn(BrowserScriptMethods, c.property.name) || parent?.type !== 'AwaitExpression') invalid('Use await with a documented page method.');
        } else if (c.object.name !== 'console' || c.property.name !== 'log') invalid('Only page methods and console.log are callable.');
      }
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === 'object' && typeof child.type === 'string') visit(child as AnyNode, node, depth + 1);
      }
    }
  };
  visit(ast as AnyNode);
  return ast as AnyNode;
}

/** 使用词法作用域隔离变量；只存 JSON 数据，无法访问 Node、页面 DOM、网络或任意对象方法。 */
class Scope {
  private readonly values = new Map<string, { value: ScriptValue; constant: boolean }>();
  constructor(private readonly parent?: Scope) {}
  declare(name: string, value: ScriptValue, constant: boolean): void {
    if (this.values.has(name)) throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', 'Variable already declared.');
    this.values.set(name, { value, constant });
  }
  get(name: string): ScriptValue {
    if (name === 'undefined') return null;
    const binding = this.values.get(name);
    if (binding) return binding.value;
    if (this.parent) return this.parent.get(name);
    throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', `Unknown variable: ${name}.`);
  }
  set(name: string, value: ScriptValue): void {
    const binding = this.values.get(name);
    if (binding) {
      if (binding.constant) throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', 'Cannot assign to const.');
      binding.value = value;
    } else if (this.parent) this.parent.set(name, value);
    else throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', 'Assignment requires a declared let variable.');
  }
}

export async function RunBrowserScript(input: {
  script: string;
  signal?: AbortSignal;
  deadline?: number;
  call: (method: BrowserScriptMethod, args: ScriptValue[]) => Promise<ScriptValue>;
}): Promise<{ output: ScriptValue[][]; value: ScriptValue }> {
  const ast = ValidateScript(input.script);
  const output: ScriptValue[][] = [];
  const sizes = new WeakMap<object, number>();
  let ticks = 0, outputSize = 0;
  const guard = async (): Promise<void> => {
    input.signal?.throwIfAborted();
    if (++ticks > 8000 || Date.now() >= (input.deadline ?? Infinity)) throw new BrowserScriptError('BROWSER_SCRIPT_LIMIT', 'Script execution budget exhausted. Completed actions are not rolled back.');
    // 有界循环也定期让出事件循环，保证取消、IPC 和浏览器心跳能及时被处理。
    if (ticks % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const bounded = (value: ScriptValue): ScriptValue => {
    if ((typeof value === 'string' && value.length > 96000) || (typeof value === 'number' && !Number.isFinite(value))) throw new BrowserScriptError('BROWSER_SCRIPT_LIMIT', 'Script value exceeds the allowed size.');
    if (value && typeof value === 'object' && !sizes.has(value)) {
      let size = 2;
      for (const [key, item] of Object.entries(value)) {
        bounded(item);
        size += key.length + 4 + (item && typeof item === 'object' ? sizes.get(item)! : typeof item === 'string' ? item.length * 6 + 2 : 24);
        if (size > 96000) throw new BrowserScriptError('BROWSER_SCRIPT_LIMIT', 'Script data exceeds the allowed size.');
      }
      sizes.set(value, size);
    }
    return value;
  };
  const primitive = (value: ScriptValue): null | string | number | boolean => {
    if (value !== null && typeof value === 'object') throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', 'Use a primitive value in this expression.');
    return value;
  };
  const run = async (n: AnyNode, scope: Scope): Promise<ScriptValue> => {
    await guard();
    switch (n.type) {
      case 'Program': case 'BlockStatement': {
        const local = new Scope(scope);
        for (const statement of n.body) await run(statement as AnyNode, local);
        return null;
      }
      case 'EmptyStatement': return null;
      case 'ExpressionStatement': return run(n.expression as AnyNode, scope);
      case 'VariableDeclaration':
        for (const d of n.declarations) {
          if (d.id.type !== 'Identifier') throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', 'Invalid binding.');
          scope.declare(d.id.name, d.init ? await run(d.init as AnyNode, scope) : null, n.kind === 'const');
        }
        return null;
      case 'Literal': return bounded(n.value as ScriptValue);
      case 'Identifier': return scope.get(n.name);
      case 'ArrayExpression': {
        const values: ScriptValue[] = [];
        for (const element of n.elements) values.push(element ? await run(element as AnyNode, scope) : null);
        return bounded(values);
      }
      case 'ObjectExpression': {
        const result: Record<string, ScriptValue> = Object.create(null);
        for (const p of n.properties) {
          if (p.type !== 'Property') throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', 'Invalid property.');
          const key = p.key.type === 'Identifier' ? p.key.name : String(await run(p.key as AnyNode, scope));
          if (BlockedProperties.has(key)) throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', 'Reserved property.');
          result[key] = await run(p.value as AnyNode, scope);
        }
        return bounded(result);
      }
      case 'MemberExpression': {
        const object = await run(n.object as AnyNode, scope);
        const key = n.computed ? String(primitive(await run(n.property as AnyNode, scope))) : (n.property as { name: string }).name;
        if (BlockedProperties.has(key)) throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', 'Object prototypes are unavailable.');
        if (key === 'length' && (Array.isArray(object) || typeof object === 'string')) return object.length;
        if (typeof object === 'string' && /^\d+$/.test(key)) return object[Number(key)] ?? null;
        if (!object || typeof object !== 'object') return null;
        return (Object.getOwnPropertyDescriptor(object, key)?.value as ScriptValue | undefined) ?? null;
      }
      case 'AwaitExpression': return run(n.argument as AnyNode, scope);
      case 'CallExpression': {
        const c = n.callee as import('acorn').MemberExpression;
        const args: ScriptValue[] = [];
        for (const arg of n.arguments) args.push(await run(arg as AnyNode, scope));
        if ((c.object as { name: string }).name === 'console') {
          outputSize += JSON.stringify(args).length;
          if (outputSize > 16000) throw new BrowserScriptError('BROWSER_SCRIPT_LIMIT', 'Console output exceeds 16000 characters. Print only needed values.');
          output.push(args);
          return null;
        }
        return bounded(await input.call((c.property as { name: BrowserScriptMethod }).name, args));
      }
      case 'IfStatement': return await run(n.test as AnyNode, scope) ? run(n.consequent as AnyNode, scope) : n.alternate ? run(n.alternate as AnyNode, scope) : null;
      case 'ConditionalExpression': return run((await run(n.test as AnyNode, scope) ? n.consequent : n.alternate) as AnyNode, scope);
      case 'ForOfStatement': {
        const items = await run(n.right as AnyNode, scope);
        if (!Array.isArray(items) || items.length > 128) throw new BrowserScriptError('BROWSER_SCRIPT_LIMIT', 'for-of requires an array of at most 128 items.');
        const declaration = n.left as import('acorn').VariableDeclaration;
        const name = (declaration.declarations[0].id as { name: string }).name;
        for (const item of items) {
          const local = new Scope(scope); local.declare(name, item, declaration.kind === 'const');
          try { await run(n.body as AnyNode, local); } catch (flow) {
            if (!(flow instanceof Flow) || flow.kind === 'return') throw flow;
            if (flow.kind === 'break') break;
          }
        }
        return null;
      }
      case 'ForStatement': {
        const local = new Scope(scope);
        if (n.init) await run(n.init as AnyNode, local);
        while (!n.test || await run(n.test as AnyNode, local)) {
          await guard();
          try { await run(n.body as AnyNode, local); } catch (flow) {
            if (!(flow instanceof Flow) || flow.kind === 'return') throw flow;
            if (flow.kind === 'break') break;
          }
          if (n.update) await run(n.update as AnyNode, local);
        }
        return null;
      }
      case 'AssignmentExpression': {
        const value = await run(n.right as AnyNode, scope); scope.set((n.left as { name: string }).name, value); return value;
      }
      case 'UpdateExpression': {
        const name = (n.argument as { name: string }).name, value = scope.get(name);
        if (typeof value !== 'number') throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', 'Increment requires a number.');
        const next = value + (n.operator === '++' ? 1 : -1); scope.set(name, bounded(next)); return n.prefix ? next : value;
      }
      case 'LogicalExpression': {
        const left = await run(n.left as AnyNode, scope);
        return (n.operator === '&&' ? !!left : n.operator === '??' ? left === null : !left) ? run(n.right as AnyNode, scope) : left;
      }
      case 'BinaryExpression': {
        const left = primitive(await run(n.left as AnyNode, scope)), right = primitive(await run(n.right as AnyNode, scope));
        switch (n.operator) {
          case '===': case '==': return left === right;
          case '!==': case '!=': return left !== right;
          case '+': return bounded(typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : Number(left) + Number(right));
          case '-': return bounded(Number(left) - Number(right));
          case '*': return bounded(Number(left) * Number(right));
          case '/': return bounded(Number(left) / Number(right));
          case '%': return bounded(Number(left) % Number(right));
          case '<': return (left ?? 0) < (right ?? 0);
          case '<=': return (left ?? 0) <= (right ?? 0);
          case '>': return (left ?? 0) > (right ?? 0);
          case '>=': return (left ?? 0) >= (right ?? 0);
          default: throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', 'Unsupported binary operator.');
        }
      }
      case 'UnaryExpression': {
        const value = await run(n.argument as AnyNode, scope);
        if (n.operator === '!') return !value;
        if (n.operator === '+') return bounded(Number(primitive(value)));
        if (n.operator === '-') return bounded(-Number(primitive(value)));
        if (n.operator === 'typeof') return value === null ? 'undefined' : typeof value;
        throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', 'Unsupported unary operator.');
      }
      case 'TemplateLiteral': {
        let text = n.quasis[0].value.cooked ?? '';
        for (let i = 0; i < n.expressions.length; i++) text = String(bounded(text + String(primitive(await run(n.expressions[i] as AnyNode, scope))) + (n.quasis[i + 1].value.cooked ?? '')));
        return text;
      }
      case 'ReturnStatement': throw new Flow('return', n.argument ? await run(n.argument as AnyNode, scope) : null);
      case 'BreakStatement': throw new Flow('break');
      case 'ContinueStatement': throw new Flow('continue');
      default: throw new BrowserScriptError('BROWSER_SCRIPT_INVALID', 'Unsupported executable node.');
    }
  };
  let value: ScriptValue = null;
  try { await run(ast, new Scope()); } catch (flow) {
    if (!(flow instanceof Flow) || flow.kind !== 'return') throw flow;
    value = flow.value;
  }
  if (JSON.stringify(value).length + outputSize > 16000) throw new BrowserScriptError('BROWSER_SCRIPT_LIMIT', 'Script output exceeds 16000 characters.');
  return { output, value };
}
