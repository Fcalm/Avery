import Ajv from 'ajv';
import { createHash, randomUUID } from 'node:crypto';
import type {
  RegisteredAgentTool, ToolCallFragment, ToolContext, ToolExecutionResult, ToolLedgerEntry,
  ToolReceipt, ToolsModule,
} from '@offerget/agent-sdk';
import { AgentDefaultPorts } from './ports';
import { CreateToolResult, RequireString, type PendingResumeEdit } from './helpers';

/** 工具定义组装：声明 JSON Schema，参数表统一禁止额外字段。 */
function CreateDefinition(name: string, description: string, parameters: Record<string, unknown>): RegisteredAgentTool['definition'] {
  return { type: 'function', function: { name, description, parameters } };
}

const EmptyParameters = { type: 'object', properties: {}, additionalProperties: false };

/** 旧工具名 → 新工具名兼容映射；新 Run 不再向模型暴露旧名，旧快照重放时仍可安全执行。 */
const ToolAliases: Record<string, string> = {
  EditResume: 'UpdateResume',
  TaskCreate: 'CreateTodo',
  TaskUpdate: 'UpdateTodo',
  TaskList: 'ReadTodo',
  TaskGet: 'ReadTodo',
};

/** 内置工具注册表：按 Agent-design 03-tools 的 MVP 白名单组织，写工具带幂等/资源键。 */
function BuildRegistry(): RegisteredAgentTool[] {
  const registry: RegisteredAgentTool[] = [
    {
      definition: CreateDefinition('Read', 'Read a user-authorized text attachment or a text file inside the session-bound project environment. Paths outside that environment are blocked.', { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }),
      timeoutMs: 20000,
      isConcurrencySafe: true,
      sideEffect: 'none',
      risk: 'low',
      idempotency: 'not_needed',
      resourceKeys: (input) => [`file:${String(input?.path ?? '')}`],
    },
    {
      definition: CreateDefinition('Glob', 'Match names among user-authorized attachments and files inside the session-bound project environment. This tool is read-only.', { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
      timeoutMs: 20000,
      isConcurrencySafe: true,
      sideEffect: 'none',
      risk: 'low',
      idempotency: 'not_needed',
      resourceKeys: () => ['workspace:glob'],
    },
    {
      definition: CreateDefinition('Grep', 'Search text in user-authorized attachments and the session-bound project environment with a regular expression. This tool is read-only.', { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
      timeoutMs: 20000,
      isConcurrencySafe: true,
      sideEffect: 'none',
      risk: 'low',
      idempotency: 'not_needed',
      resourceKeys: () => ['workspace:grep'],
    },
    {
      definition: CreateDefinition('ReadProfile', 'Read the current user profile snapshot. This tool is read-only.', EmptyParameters),
      timeoutMs: 10000,
      isConcurrencySafe: true,
      sideEffect: 'none',
      risk: 'low',
      idempotency: 'not_needed',
      resourceKeys: () => ['profile'],
    },
    {
      definition: CreateDefinition('ReadResume', 'Read the current resume draft and its revision metadata. This tool is read-only.', EmptyParameters),
      timeoutMs: 10000,
      isConcurrencySafe: true,
      sideEffect: 'none',
      risk: 'low',
      idempotency: 'not_needed',
      resourceKeys: () => ['resume'],
    },
    {
      definition: CreateDefinition('CreateResume', 'Create a new resume from user-provided facts. Only use after the user has clearly requested a new resume.', { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } }, required: ['name', 'content', 'reason'], additionalProperties: false }),
      timeoutMs: 10000,
      isConcurrencySafe: false,
      sideEffect: 'local_write',
      risk: 'medium',
      confirmation: 'scenario_policy',
      idempotency: 'required',
      resourceKeys: () => ['resume:new'],
    },
    {
      definition: CreateDefinition('UpdateResume', 'Apply a structured patch to the current resume. Only use after the user has clearly requested a resume edit.', { type: 'object', properties: { resumeId: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } }, required: ['resumeId', 'content', 'reason'], additionalProperties: false }),
      timeoutMs: 10000,
      isConcurrencySafe: false,
      sideEffect: 'local_write',
      risk: 'medium',
      confirmation: 'scenario_policy',
      idempotency: 'required',
      resourceKeys: (input) => [`resume:${String(input?.resumeId ?? '')}`],
    },
    {
      definition: CreateDefinition('UpdateProfile', 'Update the user profile snapshot with a structured patch.', { type: 'object', properties: { items: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { id: { type: 'string' }, category: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['id', 'category', 'title', 'content'], additionalProperties: false } } }, required: ['items'], additionalProperties: false }),
      timeoutMs: 10000,
      isConcurrencySafe: false,
      sideEffect: 'local_write',
      risk: 'medium',
      confirmation: 'scenario_policy',
      idempotency: 'required',
      resourceKeys: () => ['profile'],
    },
    {
      definition: CreateDefinition('AskUserQuestion', 'Ask up to three structured questions when essential information is missing. The final option must be Other.', { type: 'object', properties: { questions: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', properties: { id: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } } }, required: ['id', 'question', 'options'], additionalProperties: false } } }, required: ['questions'], additionalProperties: false }),
      timeoutMs: 10000,
      isConcurrencySafe: false,
      sideEffect: 'none',
      risk: 'low',
      idempotency: 'not_needed',
      resourceKeys: () => ['run:interaction'],
    },
    {
      definition: CreateDefinition('CreateTodo', 'Create todos for the current Run. Use only when the user goal, expected deliverable, and necessary scope are already clear; ask first when key ambiguity exists, and do not create todos for a simple single-step task.', { type: 'object', properties: { todos: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' } }, required: ['title'], additionalProperties: false } } }, required: ['todos'], additionalProperties: false }),
      timeoutMs: 10000,
      isConcurrencySafe: false,
      sideEffect: 'local_write',
      risk: 'low',
      confirmation: 'scenario_policy',
      idempotency: 'required',
      resourceKeys: () => ['run:todos'],
    },
    {
      definition: CreateDefinition('UpdateTodo', 'Update a todo in the current Run.', { type: 'object', properties: { todoId: { type: 'string' }, status: { type: 'string', enum: ['pending', 'inProgress', 'in_progress', 'completed', 'cancelled'] }, title: { type: 'string' }, description: { type: 'string' } }, required: ['todoId'], additionalProperties: false }),
      timeoutMs: 10000,
      isConcurrencySafe: false,
      sideEffect: 'local_write',
      risk: 'low',
      confirmation: 'scenario_policy',
      idempotency: 'required',
      resourceKeys: (input) => [`run:todos:${String(input?.todoId ?? '')}`],
    },
    {
      definition: CreateDefinition('ReadTodo', 'Read the full todo list of the current Run.', EmptyParameters),
      timeoutMs: 10000,
      isConcurrencySafe: true,
      sideEffect: 'none',
      risk: 'low',
      idempotency: 'not_needed',
      resourceKeys: () => ['run:todos'],
    },
  ];
  return registry;
}

/** 工具模块：统一执行管道（Schema 校验/一次修复/幂等账本/超时/结构化错误码/统一 disposition）。 */
export function CreateToolsModule(ports: AgentDefaultPorts): ToolsModule {
  const registry = BuildRegistry();
  const byName = new Map(registry.map((tool) => [tool.definition.function.name, tool]));
  const writeTools = new Set(
    registry.filter((tool) => tool.sideEffect === 'local_write' || tool.sideEffect === 'external_action').map((tool) => tool.definition.function.name),
  );
  const executedToolCalls = new Map<string, Record<string, unknown>>();
  let toolValidators: Map<string, (value: unknown) => boolean> | null = null;

  function NormalizeToolName(name: string): string {
    return ToolAliases[name] ?? name;
  }

  function GetToolMeta(name: string): RegisteredAgentTool | undefined {
    return byName.get(NormalizeToolName(name));
  }

  /** 惰性编译各工具参数 JSON Schema；Ajv 实例为每个管道共享。 */
  function EnsureToolValidators() {
    if (toolValidators) return toolValidators;
    const ajv = new Ajv();
    toolValidators = new Map();
    for (const tool of registry) {
      toolValidators.set(tool.definition.function.name, ajv.compile(tool.definition.function.parameters));
    }
    return toolValidators;
  }

  /** 按 schema 声明的类型做一次确定性纠正（字符串数字→数字、字符串布尔→布尔），不猜测。 */
  function FixArguments(args: Record<string, unknown>, schema: Record<string, unknown>) {
    const fixed = { ...args };
    for (const [key, property] of Object.entries(schema?.properties ?? {})) {
      if (!(key in fixed) || fixed[key] == null || typeof fixed[key] !== 'string') continue;
      const value = fixed[key] as string;
      if ((property.type === 'number' || property.type === 'integer') && value.trim() !== '' && !Number.isNaN(Number(value))) {
        fixed[key] = Number(value);
      } else if (property.type === 'boolean' && (value === 'true' || value === 'false' || value === '1' || value === '0')) {
        fixed[key] = value === 'true' || value === '1';
      }
    }
    return fixed;
  }

  /** 记录写工具的首次结果，供同 tool_call 幂等重放；缓存键含会话标识，防止跨会话重放写结果；限制缓存规模。 */
  function CacheToolResult(sessionId: string, callId: string, result: ToolExecutionResult) {
    let payload: Record<string, unknown> | null = null;
    try { payload = JSON.parse(result.content); } catch { return; }
    if (!payload) return;
    executedToolCalls.set(`${sessionId}:${callId}`, payload);
    if (executedToolCalls.size > 200) {
      const oldestKey = executedToolCalls.keys().next().value as string | undefined;
      if (oldestKey !== undefined) executedToolCalls.delete(oldestKey);
    }
  }

  function HashArguments(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value ?? {})).digest('hex');
  }

  function CreateIdempotencyKey(context: ToolContext, toolName: string, proposalHash: string): string {
    return `session:${context.sessionId}:run:${context.runId ?? 'session'}:tool:${toolName}:proposal:${proposalHash}`;
  }

  function GetLedger(context: ToolContext) {
    if (!context.ledger) throw new Error('Persistent Tool Ledger is required for write tools.');
    return context.ledger;
  }

  async function StartLedger(context: ToolContext, toolName: string, args: Record<string, unknown>, idempotencyKey: string): Promise<ToolLedgerEntry> {
    const ledgerId = `ledger-${randomUUID()}`;
    const entry: Omit<ToolLedgerEntry, 'status' | 'receipt' | 'errorCode' | 'finishedAt'> = {
      ledgerId,
      runId: context.runId,
      toolCallId: context.requestId,
      toolName,
      idempotencyKey,
      argumentsHash: HashArguments(args),
      actor: `agent:${context.requestId}`,
      resourceIds: GetToolMeta(toolName)?.resourceKeys?.(args) ?? [],
      startedAt: Date.now(),
    };
    await GetLedger(context).Start(entry);
    return { ...entry, status: 'started' };
  }

  async function FinishLedger(context: ToolContext, ledger: ToolLedgerEntry, status: ToolLedgerEntry['status'], extra?: { receipt?: ToolReceipt; errorCode?: string }) {
    await GetLedger(context).Finish(ledger.ledgerId, status, { ...extra, finishedAt: Date.now() });
  }

  /** 提取含待确认标签的条目；按非空行展示，避免把整份简历正文塞进交互事件。 */
  function ExtractUncertainItems(content: string): Array<{ id: string; text: string }> {
    return content.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes('【待确认】'))
      .slice(0, 20)
      .map((text, index) => ({ id: String(index + 1), text: text.slice(0, 1000) }));
  }

  /** 保存 Run 内待确认草稿并通过文本交互等待；不获取简历锁，也不写入正式简历。 */
  function WaitForDraftTextConfirmation(context: ToolContext, callId: string, pending: PendingResumeEdit): ToolExecutionResult {
    const draftId = `resume-draft-${randomUUID()}`;
    const items = pending.uncertainItems ?? [];
    context.pendingEdits.set(draftId, pending);
    const itemText = items.map((item) => `${item.id}. ${item.text}`).join('\n');
    const question = `以下推测性补全已标记为【待确认】，尚未写入正式简历：\n${itemText}\n请明确回复“全部确认”，或说明要删除/修改的条目。`;
    const questions = [{ id: draftId, question, options: ['全部确认', '我要修改', '其他'] }];
    context.pendingQuestions.set(context.sessionId, questions);
    context.emit({ type: 'question_requested', requestId: context.requestId, sessionId: context.sessionId, questions });
    return CreateToolResult(callId, {
      ok: false, code: 'CONFIRMATION_REQUIRED', awaitingUser: true, draftId,
      message: 'The draft contains 【待确认】 items and has not been written. Wait for explicit text confirmation or modification.',
      uncertainItems: items,
    }, { disposition: 'wait_user_input' });
  }

  /** 读取用户附件或会话绑定项目中的文本文件；项目外路径一律被拒绝。 */
  async function Read(context: ToolContext, callId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const filePath = RequireString(args.path, 'path', 1000);
    const attachment = context.attachments.find((item) => item.path === filePath);
    if (attachment) {
      const resolved = await ports.file.ResolveAttachmentUri(filePath);
      if (!resolved) throw new Error('The attachment store is unavailable.');
      return CreateToolResult(callId, { ok: true, path: filePath, ...await ports.file.ReadAuthorizedFile(resolved, attachment.name, { signal: context.signal, deadline: context.deadline }) });
    }
    const resolvedPath = ports.file.ResolveProjectPath(context.projectRoot, filePath);
    return CreateToolResult(callId, { ok: true, path: resolvedPath, ...await ports.file.ReadAuthorizedFile(resolvedPath, undefined, { signal: context.signal, deadline: context.deadline }) });
  }

  /** 在授权附件清单与项目环境中完成文件名匹配，不遍历用户未授权目录。 */
  function Glob(context: ToolContext, callId: string, args: Record<string, unknown>): ToolExecutionResult {
    const pattern = RequireString(args.pattern, 'pattern', 300);
    const matcher = ports.file.CreateGlobMatcher(pattern);
    const attachments = context.attachments.filter((item) => matcher.test(item.name)).map((item) => ({ name: item.name, path: item.path }));
    const projectFiles = context.projectRoot ? ports.file.ListProjectFiles(context.projectRoot).filter((item) => matcher.test(item.name)).map((item) => ({ name: item.name, path: item.name })) : [];
    return CreateToolResult(callId, { ok: true, files: [...attachments, ...projectFiles].slice(0, 1000) });
  }

  /** 在授权的纯文本附件与项目文件中执行受限正则搜索，并限制结果规模。 */
  async function Grep(context: ToolContext, callId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const pattern = RequireString(args.pattern, 'pattern', 300);
    const matcher = new RegExp(pattern, 'i');
    const matches: Array<{ path: string; line: number; content: string }> = [];
    for (const attachment of context.attachments) {
      if (!/\.(txt|md|json|yaml|yml|csv)$/i.test(attachment.name) || matches.length >= 100) continue;
      try {
        const resolved = await ports.file.ResolveAttachmentUri(attachment.path);
        if (!resolved) continue;
        const lines = ports.file.ReadTextFile(resolved).content.split(/\r?\n/);
        lines.forEach((line, index) => { if (matches.length < 100 && matcher.test(line)) matches.push({ path: attachment.path, line: index + 1, content: line.slice(0, 1000) }); });
      } catch { /* Unreadable files do not broaden access or fail the full search. */ }
    }
    for (const fileItem of context.projectRoot ? ports.file.ListProjectFiles(context.projectRoot) : []) {
      if (matches.length >= 100) break;
      try {
        const lines = ports.file.ReadTextFile(fileItem.path).content.split(/\r?\n/);
        lines.forEach((line, index) => { if (matches.length < 100 && matcher.test(line)) matches.push({ path: fileItem.name, line: index + 1, content: line.slice(0, 1000) }); });
      } catch { /* Binary and unreadable project files are skipped. */ }
    }
    return CreateToolResult(callId, { ok: true, matches });
  }

  /** 创建一份新简历：先生成冻结提案；确认模式不持锁等待，确认时由 Interaction 重新加锁。 */
  async function CreateResume(context: ToolContext, callId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (context.resumeEditing) throw new Error('The user is editing a resume. Do not create another resume until the user saves or exits edit mode.');
    const resumeId = `resume-${randomUUID()}`;
    const name = RequireString(args.name, 'name', 200);
    const content = RequireString(args.content, 'content', 100000);
    const reason = RequireString(args.reason, 'reason', 1000);
    const canonical = { kind: 'create', resumeId, name, content, reason };
    const proposalHash = HashArguments(canonical);
    const idempotencyKey = CreateIdempotencyKey(context, 'CreateResume', proposalHash);
    const ledger = GetLedger(context);
    const previous = await ledger.FindByIdempotencyKey(idempotencyKey);
    if (previous?.status === 'succeeded' && previous.receipt) {
      return CreateToolResult(callId, { ok: true, saved: true, resumeId, revision: previous.receipt.revisions?.resume ?? 0, replayed: true }, { disposition: 'continue', receipt: previous.receipt });
    }
    const uncertainItems = ExtractUncertainItems(content);
    if (uncertainItems.length) {
      return WaitForDraftTextConfirmation(context, callId, {
        kind: 'create', resumeId, name, content, reason, baseRevision: undefined,
        ownerId: `agent-${context.requestId}`, proposalHash, canonicalArguments: canonical, idempotencyKey, uncertainItems,
      });
    }
    if (context.confirmationMode === '需要确认') {
      const pending: PendingResumeEdit = { kind: 'create', resumeId, name, content, reason, baseRevision: undefined, ownerId: `agent-${context.requestId}`, proposalHash, canonicalArguments: canonical, idempotencyKey };
      const confirmationId = `resume-confirmation-${randomUUID()}`;
      context.pendingEdits.set(confirmationId, pending);
      context.emit({ type: 'resume_confirmation', requestId: context.requestId, confirmationId, resumeId, resumeName: name, content, reason });
      return CreateToolResult(callId, { ok: false, code: 'CONFIRMATION_REQUIRED', message: 'A user confirmation card has been shown. Do not repeat this creation. Wait for a new user message after confirmation or rejection.', confirmationId, proposalHash }, { disposition: 'wait_confirmation' });
    }
    const ownerId = `agent-${context.requestId}`;
    const ledgerEntry = await StartLedger(context, 'CreateResume', canonical, idempotencyKey);
    const lockResult = await context.ports.resumeWrite.AcquireLock({ resumeId, owner: 'agent', ownerId });
    if (!lockResult.acquired) {
      await FinishLedger(context, ledgerEntry, 'failed', { errorCode: lockResult.code });
      throw Object.assign(new Error('User is editing this resume.'), { code: lockResult.code });
    }
    let saved;
    try {
      saved = await context.ports.resumeWrite.Save({ resume: { id: resumeId, name, content, updatedAt: '', targetRoles: [], summary: content.slice(0, 120) } });
    } catch (error) {
      await FinishLedger(context, ledgerEntry, 'failed', { errorCode: 'SAVE_FAILED' });
      throw error;
    } finally {
      await context.ports.resumeWrite.ReleaseLock(resumeId, ownerId);
    }
    const receipt: ToolReceipt = { receiptId: `receipt-${randomUUID()}`, toolDefinitionId: 'CreateResume', resourceIds: [resumeId], revisions: { resume: saved.revision }, idempotencyKey };
    await FinishLedger(context, ledgerEntry, 'succeeded', { receipt });
    context.emit({ type: 'resume_created', requestId: context.requestId, resumeId, resumeName: name, content, reason, revision: saved.revision });
    return CreateToolResult(callId, { ok: true, saved: true, resumeId, revision: saved.revision }, { disposition: 'continue', receipt });
  }

  /** 用当前会话的只读快照校验并整份保存 Agent 简历编辑；确认模式不持锁，确认时由 Interaction 重新加锁并校验 revision。 */
  async function UpdateResume(context: ToolContext, callId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!context.resumeSnapshot || args.resumeId !== context.resumeSnapshot.id) throw new Error('The selected resume is unavailable or does not match resumeId.');
    if (context.resumeEditing) throw new Error('The user is editing this resume. Do not retry until the user saves or exits edit mode.');
    const content = RequireString(args.content, 'content', 100000);
    const reason = RequireString(args.reason, 'reason', 1000);
    const baseRevision = context.resumeSnapshot.revision;
    const canonical = { kind: 'edit', resumeId: args.resumeId, content, reason, baseRevision };
    const proposalHash = HashArguments(canonical);
    const idempotencyKey = CreateIdempotencyKey(context, 'UpdateResume', proposalHash);
    const ledger = GetLedger(context);
    const previous = await ledger.FindByIdempotencyKey(idempotencyKey);
    if (previous?.status === 'succeeded' && previous.receipt) {
      return CreateToolResult(callId, { ok: true, saved: true, resumeId: args.resumeId, revision: previous.receipt.revisions?.resume ?? baseRevision ?? 0, replayed: true }, { disposition: 'continue', receipt: previous.receipt });
    }
    const uncertainItems = ExtractUncertainItems(content);
    if (uncertainItems.length) {
      return WaitForDraftTextConfirmation(context, callId, {
        kind: 'edit', resumeId: args.resumeId as string, content, reason, baseRevision,
        ownerId: `agent-${context.requestId}`, resume: { ...context.resumeSnapshot }, proposalHash,
        canonicalArguments: canonical, idempotencyKey, uncertainItems,
      });
    }
    if (context.confirmationMode === '需要确认') {
      const pending: PendingResumeEdit = { kind: 'edit', resumeId: args.resumeId, content, reason, baseRevision, ownerId: `agent-${context.requestId}`, resume: { ...context.resumeSnapshot }, proposalHash, canonicalArguments: canonical, idempotencyKey };
      const confirmationId = `resume-confirmation-${randomUUID()}`;
      context.pendingEdits.set(confirmationId, pending);
      context.emit({ type: 'resume_confirmation', requestId: context.requestId, confirmationId, resumeId: args.resumeId, content, reason });
      return CreateToolResult(callId, { ok: false, code: 'CONFIRMATION_REQUIRED', message: 'A user confirmation card has been shown. Do not repeat this edit. Wait for a new user message after confirmation or rejection.', confirmationId, proposalHash }, { disposition: 'wait_confirmation' });
    }
    const ownerId = `agent-${context.requestId}`;
    const ledgerEntry = await StartLedger(context, 'UpdateResume', canonical, idempotencyKey);
    const lockResult = await context.ports.resumeWrite.AcquireLock({ resumeId: args.resumeId, owner: 'agent', ownerId, baseRevision });
    if (!lockResult.acquired) {
      await FinishLedger(context, ledgerEntry, 'failed', { errorCode: lockResult.code });
      throw Object.assign(new Error('User is editing this resume.'), { code: lockResult.code });
    }
    let saved;
    try {
      saved = await context.ports.resumeWrite.Save({ resume: { ...context.resumeSnapshot, content }, baseRevision });
    } catch (error) {
      await FinishLedger(context, ledgerEntry, 'failed', { errorCode: 'SAVE_FAILED' });
      throw error;
    } finally {
      await context.ports.resumeWrite.ReleaseLock(args.resumeId, ownerId);
    }
    const receipt: ToolReceipt = { receiptId: `receipt-${randomUUID()}`, toolDefinitionId: 'UpdateResume', resourceIds: [args.resumeId], revisions: { resume: saved.revision }, idempotencyKey };
    await FinishLedger(context, ledgerEntry, 'succeeded', { receipt });
    context.emit({ type: 'resume_updated', requestId: context.requestId, resumeId: args.resumeId, content, reason, revision: saved.revision });
    return CreateToolResult(callId, { ok: true, saved: true, resumeId: args.resumeId, revision: saved.revision }, { disposition: 'continue', receipt });
  }

  /** 更新档案：仅在宿主注入 profileWrite 端口时可用，否则安全拒绝。 */
  async function UpdateProfile(context: ToolContext, callId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!context.ports.profileWrite) return CreateToolResult(callId, { ok: false, code: 'RESOURCE_NOT_AUTHORIZED', message: 'Profile update is not available in the current host capability set.' });
    if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > 100) throw new Error('UpdateProfile requires one to one hundred items.');
    const idempotencyKey = CreateIdempotencyKey(context, 'UpdateProfile', HashArguments(args));
    const ledger = GetLedger(context);
    const previous = await ledger.FindByIdempotencyKey(idempotencyKey);
    if (previous?.status === 'succeeded') return CreateToolResult(callId, { ok: true, saved: true, replayed: true }, { disposition: 'continue', receipt: previous.receipt });
    if (context.confirmationMode === '需要确认') {
      // 当前宿主尚未提供 Profile 提案确认通道；不能伪造等待卡，安全拒绝写入。
      return CreateToolResult(callId, { ok: false, code: 'RESOURCE_NOT_AUTHORIZED', message: 'Profile confirmation is not yet supported by the host; no profile was changed.', proposalHash: HashArguments(args) });
    }
    const ledgerEntry = await StartLedger(context, 'UpdateProfile', args, idempotencyKey);
    let result;
    try {
      result = await context.ports.profileWrite.Save({ profiles: args.items as never, actor: `agent:${context.requestId}`, idempotencyKey });
    } catch (error) {
      await FinishLedger(context, ledgerEntry, 'failed', { errorCode: 'SAVE_FAILED' });
      throw error;
    }
    const receipt: ToolReceipt = { receiptId: `receipt-${randomUUID()}`, toolDefinitionId: 'UpdateProfile', resourceIds: ['profile'], revisions: result.revision ? { profile: result.revision } : undefined, idempotencyKey };
    await FinishLedger(context, ledgerEntry, 'succeeded', { receipt });
    return CreateToolResult(callId, { ok: true, saved: true, count: result.count }, { disposition: 'continue', receipt });
  }

  /** 展示结构化澄清问题；运行循环在问题卡展示后停止，等待用户下一条真实消息。 */
  function AskUserQuestion(context: ToolContext, callId: string, args: Record<string, unknown>): ToolExecutionResult {
    if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3) throw new Error('AskUserQuestion requires one to three questions.');
    const seen = new Set<string>();
    const questions = args.questions.map((item) => {
      const record = item as Record<string, unknown>;
      const id = RequireString(record?.id, 'question.id', 100);
      if (seen.has(id)) throw new Error('Question ids must be unique.');
      seen.add(id);
      const question = RequireString(record?.question, 'question.question', 500);
      if (!Array.isArray(record?.options) || record.options.length < 1 || record.options.length > 4) throw new Error('Each question requires one to four options.');
      const options = [...new Set(record.options.map((option) => RequireString(option, 'question.option', 200)).filter((option) => option !== '其他'))].slice(0, 3);
      return { id, question, options: [...options, '其他'] };
    });
    context.pendingQuestions.set(context.sessionId, questions);
    context.emit({ type: 'question_requested', requestId: context.requestId, sessionId: context.sessionId, questions });
    return CreateToolResult(callId, { ok: true, awaitingUser: true, message: 'The questions are shown to the user. Stop this turn and wait for the next user message.' }, { disposition: 'wait_user_input' });
  }

  /** 创建当前 Run 的 Todo；初始状态为 pending，单次 1–10 条，Run 上限 20 条；写操作计入业务幂等账本。 */
  async function CreateTodo(context: ToolContext, callId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!Array.isArray(args.todos) || args.todos.length < 1 || args.todos.length > 10) throw new Error('CreateTodo requires one to ten todos.');
    if (context.tasks.size + args.todos.length > 20) throw new Error('This Run already has 20 todos; update or cancel existing todos before creating more.');
    const normalizedTodos = args.todos.map((item) => {
      const record = item as Record<string, unknown>;
      return {
        title: RequireString(record?.title, 'todo.title', 300),
        description: typeof record?.description === 'string' ? record.description.slice(0, 2000) : '',
      };
    });
    const idempotencyKey = CreateIdempotencyKey(context, 'CreateTodo', HashArguments(args));
    const ledger = GetLedger(context);
    const previous = await ledger.FindByIdempotencyKey(idempotencyKey);
    if (previous?.status === 'succeeded') return CreateToolResult(callId, { ok: true, replayed: true, todos: [...context.tasks.values()] });
    const ledgerEntry = await StartLedger(context, 'CreateTodo', args, idempotencyKey);
    const created = normalizedTodos.map((item) => {
      const todo = { id: `todo-${randomUUID()}`, title: item.title, description: item.description, status: 'pending' };
      context.tasks.set(todo.id, todo);
      context.emit({ type: 'task_created', sessionId: context.sessionId, task: todo });
      return todo;
    });
    context.persistSessionState();
    const receipt: ToolReceipt = { receiptId: `receipt-${randomUUID()}`, toolDefinitionId: 'CreateTodo', resourceIds: ['run:todos'], idempotencyKey };
    await FinishLedger(context, ledgerEntry, 'succeeded', { receipt });
    return CreateToolResult(callId, { ok: true, todos: created, tasks: [...context.tasks.values()] }, { receipt });
  }

  /** 更新当前 Run 的 Todo；completed/cancelled 为终态，不允许 blocked；写操作计入业务幂等账本。 */
  async function UpdateTodo(context: ToolContext, callId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const task = context.tasks.get(args.todoId as string);
    if (!task) throw new Error('Todo not found in this Run.');
    if (args.status && !['pending', 'inProgress', 'in_progress', 'completed', 'cancelled'].includes(args.status as string)) throw new Error('Todo status is invalid; blocked is not allowed.');
    const nextTitle = typeof args.title === 'string' ? RequireString(args.title, 'title', 300) : task.title;
    const nextDescription = typeof args.description === 'string' ? args.description.slice(0, 2000) : task.description;
    const nextStatus = args.status ? (args.status === 'in_progress' ? 'inProgress' : args.status as string) : task.status;
    const idempotencyKey = CreateIdempotencyKey(context, 'UpdateTodo', HashArguments(args));
    const ledger = GetLedger(context);
    const previous = await ledger.FindByIdempotencyKey(idempotencyKey);
    if (previous?.status === 'succeeded') return CreateToolResult(callId, { ok: true, replayed: true, todo: task, tasks: [...context.tasks.values()] });
    const ledgerEntry = await StartLedger(context, 'UpdateTodo', args, idempotencyKey);
    task.title = nextTitle;
    task.description = nextDescription;
    task.status = nextStatus;
    context.persistSessionState();
    context.emit({ type: 'task_updated', sessionId: context.sessionId, task });
    const receipt: ToolReceipt = { receiptId: `receipt-${randomUUID()}`, toolDefinitionId: 'UpdateTodo', resourceIds: ['run:todos'], idempotencyKey };
    await FinishLedger(context, ledgerEntry, 'succeeded', { receipt });
    return CreateToolResult(callId, { ok: true, todo: task, tasks: [...context.tasks.values()] }, { receipt });
  }

  /** 读取当前 Run 的完整 Todo 列表。 */
  function ReadTodo(context: ToolContext, callId: string): ToolExecutionResult {
    const tasks = [...context.tasks.values()];
    return CreateToolResult(callId, { ok: true, todos: tasks, tasks, counts: {
      pending: tasks.filter((task) => task.status === 'pending').length,
      inProgress: tasks.filter((task) => task.status === 'inProgress').length,
      completed: tasks.filter((task) => task.status === 'completed').length,
      cancelled: tasks.filter((task) => task.status === 'cancelled').length,
    } });
  }

  /** 岗位搜索：仅在宿主注入 jobSearch 端口时可用，否则安全拒绝；结果仅作为 Run 临时数据。 */
  async function SearchJobs(context: ToolContext, callId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!context.ports.jobSearch) return CreateToolResult(callId, { ok: false, code: 'RESOURCE_NOT_AUTHORIZED', message: 'Job search is not available in the current host capability set.' });
    const query = RequireString(args.query, 'query', 500);
    const result = await context.ports.jobSearch.Search({ query, page: typeof args.page === 'number' ? args.page : 1, signal: context.signal, deadline: context.deadline });
    return CreateToolResult(callId, { ok: true, items: result.items, hasMore: result.hasMore, cursor: result.cursor });
  }

  /** 读取选中岗位 URL：仅在宿主注入 urlRead 端口时可用，否则安全拒绝。 */
  async function ReadUrl(context: ToolContext, callId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!context.ports.urlRead) return CreateToolResult(callId, { ok: false, code: 'RESOURCE_NOT_AUTHORIZED', message: 'URL reading is not available in the current host capability set.' });
    const url = RequireString(args.url, 'url', 2000);
    const result = await context.ports.urlRead.Read({ url, signal: context.signal, deadline: context.deadline });
    return CreateToolResult(callId, { ok: true, content: result.content, truncated: result.truncated, finalUrl: result.finalUrl, fetchedAt: result.fetchedAt });
  }

  /** 执行单个工具调用并应用统一超时/取消；写工具超时标记 STATUS_UNKNOWN，不自动重试。 */
  async function ExecuteWithTimeout(context: ToolContext, callId: string, toolName: string, args: Record<string, unknown>, execution: (executionContext: ToolContext) => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    const meta = GetToolMeta(toolName);
    const timeoutMs = meta?.timeoutMs ?? 10000;
    const isWrite = writeTools.has(NormalizeToolName(toolName));
    const deadline = Math.min(context.deadline ?? Number.POSITIVE_INFINITY, Date.now() + timeoutMs);
    const remainingMs = Math.max(0, deadline - Date.now());
    const executionController = new AbortController();
    const startedLedgerIds = new Set<string>();
    let acceptsToolEvents = true;
    const abortFromRun = () => executionController.abort(context.signal?.reason);
    if (context.signal?.aborted) abortFromRun();
    else context.signal?.addEventListener('abort', abortFromRun, { once: true });
    const executionContext: ToolContext = {
      ...context,
      signal: executionController.signal,
      deadline,
      emit: (event) => {
        if (acceptsToolEvents && !executionController.signal.aborted && Date.now() < deadline) context.emit(event);
      },
      ...(context.ledger ? {
        ledger: {
          Start: async (entry) => {
            startedLedgerIds.add(entry.ledgerId);
            await context.ledger!.Start(entry);
          },
          Finish: async (ledgerId, status, extra) => {
            await context.ledger!.Finish(ledgerId, status, extra);
            if (status !== 'started') startedLedgerIds.delete(ledgerId);
          },
          FindByIdempotencyKey: (idempotencyKey) => context.ledger!.FindByIdempotencyKey(idempotencyKey),
        },
      } : {}),
    };
    return await new Promise<ToolExecutionResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<ToolExecutionResult>((resolveTimeout) => {
        timer = setTimeout(async () => {
          acceptsToolEvents = false;
          executionController.abort(new Error('Tool execution timed out.'));
          if (isWrite) {
            await Promise.allSettled([...startedLedgerIds].map((ledgerId) => context.ledger?.Finish(ledgerId, 'status_unknown', { errorCode: 'TIMEOUT', finishedAt: Date.now() })));
            resolveTimeout(CreateToolResult(callId, { ok: false, code: 'STATUS_UNKNOWN', message: 'Tool execution timed out; the write outcome is unknown and will not be retried without reconciliation.', retryable: false }, { disposition: 'pause' }));
          } else {
            resolveTimeout(CreateToolResult(callId, { ok: false, code: 'TIMEOUT', message: 'Tool execution timed out.' }));
          }
        }, remainingMs);
      });
      const abort = () => {
        acceptsToolEvents = false;
        clearTimeout(timer);
        resolve(CreateToolResult(callId, { ok: false, code: 'CANCELLED', message: 'Tool execution was cancelled.' }));
      };
      context.signal?.addEventListener('abort', abort, { once: true });
      Promise.race([execution(executionContext), timeout]).then((result) => {
        acceptsToolEvents = false;
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', abort);
        context.signal?.removeEventListener('abort', abortFromRun);
        resolve(result);
      }).catch((error) => {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', abort);
        context.signal?.removeEventListener('abort', abortFromRun);
        const message = error instanceof Error ? error.message : 'Tool validation failed.';
        const isAuthorization = /outside|unavailable|not authorized|not accessible/i.test(message);
        const code = isAuthorization ? 'RESOURCE_NOT_AUTHORIZED' : 'VALIDATION_ERROR';
        resolve(CreateToolResult(callId, { ok: false, code, message }));
      });
    });
  }

  return {
    packageName: '@offerget/agent-modules-defaults',
    name: 'offerget.agent-defaults',
    version: '0.1.0',
    sdkVersion: '0.1.0',
    slot: 'tools',
    capabilities: ['tools:12'],
    /** 返回设计文档 MVP 白名单工具；旧名仅兼容旧快照，不再向新模型暴露。 */
    GetToolDefinitions() { return registry; },
    /** 统一执行管道：Schema 校验与一次修复、写工具幂等账本、按工具超时、结构化错误码、统一 disposition。 */
    async ExecuteToolCall(call: ToolCallFragment, context: ToolContext): Promise<ToolExecutionResult> {
      const rawName = call.function.name;
      const toolName = NormalizeToolName(rawName);
      if (!GetToolMeta(toolName)) {
        return CreateToolResult(call.id, { ok: false, code: 'TOOL_NOT_ALLOWED', message: 'This tool is not available in the current scenario.' });
      }
      if (writeTools.has(toolName) && !context.ledger) {
        return CreateToolResult(call.id, { ok: false, code: 'PERSISTENT_LEDGER_REQUIRED', message: 'A persistent Tool Ledger is required before this write can run.' }, { disposition: 'pause' });
      }
      let args: Record<string, unknown>;
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { return CreateToolResult(call.id, { ok: false, code: 'INVALID_JSON', message: 'Tool arguments are invalid JSON. Please correct the call once.' }); }
      const validator = EnsureToolValidators().get(toolName);
      if (validator && !validator(args)) {
        const schema = GetToolMeta(toolName)?.definition?.function?.parameters;
        const fixed = FixArguments(args, schema ?? {});
        if (JSON.stringify(fixed) !== JSON.stringify(args) && validator(fixed)) args = fixed;
        else return CreateToolResult(call.id, { ok: false, code: 'INVALID_TOOL_ARGUMENTS', message: 'Tool arguments do not match the schema. Please correct the call once.' });
      }
      if (writeTools.has(toolName)) {
        const cached = executedToolCalls.get(`${context.sessionId}:${call.id}`);
        if (cached) return CreateToolResult(call.id, cached);
      }
      const execution = async (executionContext: ToolContext) => {
        switch (toolName) {
          case 'Read': return await Read(executionContext, call.id, args);
          case 'Glob': return Glob(executionContext, call.id, args);
          case 'Grep': return await Grep(executionContext, call.id, args);
          case 'ReadProfile': return CreateToolResult(call.id, { ok: true, profiles: executionContext.profileSnapshot });
          case 'ReadResume': return CreateToolResult(call.id, { ok: true, resume: executionContext.resumeSnapshot });
          case 'CreateResume': return await CreateResume(executionContext, call.id, args);
          case 'UpdateResume': return await UpdateResume(executionContext, call.id, args);
          case 'UpdateProfile': return await UpdateProfile(executionContext, call.id, args);
          case 'AskUserQuestion': return AskUserQuestion(executionContext, call.id, args);
          case 'CreateTodo': return CreateTodo(executionContext, call.id, args);
          case 'UpdateTodo': return UpdateTodo(executionContext, call.id, args);
          case 'ReadTodo': return ReadTodo(executionContext, call.id);
          case 'SearchJobs': return await SearchJobs(executionContext, call.id, args);
          case 'ReadUrl': return await ReadUrl(executionContext, call.id, args);
          default: return CreateToolResult(call.id, { ok: false, code: 'TOOL_NOT_ALLOWED', message: 'This tool is not available in the current scenario.' });
        }
      };
      const result = await ExecuteWithTimeout(context, call.id, toolName, args, execution);
      if (writeTools.has(toolName)) CacheToolResult(context.sessionId, call.id, result);
      return result;
    },
  };
}
