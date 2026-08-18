"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateToolsModule = CreateToolsModule;
const ajv_1 = __importDefault(require("ajv"));
const node_crypto_1 = require("node:crypto");
const helpers_1 = require("./helpers");
/** 工具定义组装：声明 JSON Schema，参数表统一禁止额外字段。 */
function CreateDefinition(name, description, parameters) {
    return { type: 'function', function: { name, description, parameters } };
}
const EmptyParameters = { type: 'object', properties: {}, additionalProperties: false };
/** 内置 12 工具注册表：只读工具默认可并行；写工具（简历/任务/提问）标记为不可并发。 */
function BuildRegistry() {
    const registry = [
        { definition: CreateDefinition('Read', 'Read a user-authorized text attachment or a text file inside the session-bound project environment. Paths outside that environment are blocked.', { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }), timeoutMs: 20000 },
        { definition: CreateDefinition('Glob', 'Match names among user-authorized attachments and files inside the session-bound project environment. This tool is read-only.', { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'], additionalProperties: false }), timeoutMs: 20000 },
        { definition: CreateDefinition('Grep', 'Search text in user-authorized attachments and the session-bound project environment with a regular expression. This tool is read-only.', { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'], additionalProperties: false }), timeoutMs: 20000 },
        { definition: CreateDefinition('ReadProfile', 'Read the current user profile snapshot. This tool is read-only.', EmptyParameters), timeoutMs: 10000 },
        { definition: CreateDefinition('ReadResume', 'Read the current resume draft and its revision metadata. This tool is read-only.', EmptyParameters), timeoutMs: 10000 },
        { definition: CreateDefinition('CreateResume', 'Create a new resume from user-provided facts. Only use after the user has clearly requested a new resume.', { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } }, required: ['name', 'content', 'reason'], additionalProperties: false }), timeoutMs: 10000 },
        { definition: CreateDefinition('EditResume', 'Replace the complete content of the current resume. Only use after the user has clearly requested a resume edit.', { type: 'object', properties: { resumeId: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } }, required: ['resumeId', 'content', 'reason'], additionalProperties: false }), timeoutMs: 10000 },
        { definition: CreateDefinition('AskUserQuestion', 'Ask up to three structured questions when essential information is missing. The final option must be Other.', { type: 'object', properties: { questions: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', properties: { id: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } } }, required: ['id', 'question', 'options'], additionalProperties: false } } }, required: ['questions'], additionalProperties: false }), timeoutMs: 10000 },
        { definition: CreateDefinition('TaskCreate', 'Create a structured task for the current conversation.', { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' } }, required: ['title'], additionalProperties: false }), timeoutMs: 10000 },
        { definition: CreateDefinition('TaskUpdate', 'Update a structured task in the current conversation.', { type: 'object', properties: { taskId: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'] }, title: { type: 'string' }, description: { type: 'string' } }, required: ['taskId'], additionalProperties: false }), timeoutMs: 10000 },
        { definition: CreateDefinition('TaskList', 'List structured tasks in the current conversation.', EmptyParameters), timeoutMs: 10000 },
        { definition: CreateDefinition('TaskGet', 'Read one structured task in the current conversation.', { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false }), timeoutMs: 10000 },
    ];
    const unsafe = new Set(['CreateResume', 'EditResume', 'AskUserQuestion', 'TaskCreate', 'TaskUpdate']);
    return registry.map((tool) => ({ ...tool, isConcurrencySafe: !unsafe.has(tool.definition.function.name) }));
}
/** 工具模块：统一执行管道（Schema 校验/一次修复/幂等/超时/结构化错误码）；文件与路径边界由宿主注入窄端口约束。 */
function CreateToolsModule(ports) {
    const registry = BuildRegistry();
    const writeTools = new Set(['CreateResume', 'EditResume', 'TaskCreate', 'TaskUpdate']);
    const executedToolCalls = new Map();
    let toolValidators = null;
    /** 惰性编译各工具参数 JSON Schema；Ajv 实例为每个管道共享。 */
    function EnsureToolValidators() {
        if (toolValidators)
            return toolValidators;
        const ajv = new ajv_1.default();
        toolValidators = new Map();
        for (const tool of registry) {
            toolValidators.set(tool.definition.function.name, ajv.compile(tool.definition.function.parameters));
        }
        return toolValidators;
    }
    /** 按 schema 声明的类型做一次确定性纠正（字符串数字→数字、字符串布尔→布尔），不猜测。 */
    function FixArguments(args, schema) {
        const fixed = { ...args };
        for (const [key, property] of Object.entries(schema?.properties ?? {})) {
            if (!(key in fixed) || fixed[key] == null || typeof fixed[key] !== 'string')
                continue;
            const value = fixed[key];
            if ((property.type === 'number' || property.type === 'integer') && value.trim() !== '' && !Number.isNaN(Number(value))) {
                fixed[key] = Number(value);
            }
            else if (property.type === 'boolean' && (value === 'true' || value === 'false' || value === '1' || value === '0')) {
                fixed[key] = value === 'true' || value === '1';
            }
        }
        return fixed;
    }
    /** 记录写工具的首次结果，供同 tool_call 幂等重放；缓存键含会话标识，防止跨会话重放写结果；限制缓存规模。 */
    function CacheToolResult(sessionId, callId, result) {
        let payload = null;
        try {
            payload = JSON.parse(result.content);
        }
        catch {
            return;
        }
        if (!payload)
            return;
        executedToolCalls.set(`${sessionId}:${callId}`, payload);
        if (executedToolCalls.size > 200) {
            const oldestKey = executedToolCalls.keys().next().value;
            if (oldestKey !== undefined)
                executedToolCalls.delete(oldestKey);
        }
    }
    /** 读取用户附件或会话绑定项目中的文本文件；项目外路径一律被拒绝。 */
    async function Read(context, callId, args) {
        const filePath = (0, helpers_1.RequireString)(args.path, 'path', 1000);
        const attachment = context.attachments.find((item) => item.path === filePath);
        if (attachment) {
            const resolved = await ports.file.ResolveAttachmentUri(filePath);
            if (!resolved)
                throw new Error('The attachment store is unavailable.');
            return (0, helpers_1.CreateToolResult)(callId, { ok: true, path: filePath, ...await ports.file.ReadAuthorizedFile(resolved, attachment.name) });
        }
        const resolvedPath = ports.file.ResolveProjectPath(context.projectRoot, filePath);
        return (0, helpers_1.CreateToolResult)(callId, { ok: true, path: resolvedPath, ...await ports.file.ReadAuthorizedFile(resolvedPath) });
    }
    /** 在授权附件清单与项目环境中完成文件名匹配，不遍历用户未授权目录。 */
    function Glob(context, callId, args) {
        const pattern = (0, helpers_1.RequireString)(args.pattern, 'pattern', 300);
        const matcher = ports.file.CreateGlobMatcher(pattern);
        const attachments = context.attachments.filter((item) => matcher.test(item.name)).map((item) => ({ name: item.name, path: item.path }));
        const projectFiles = context.projectRoot ? ports.file.ListProjectFiles(context.projectRoot).filter((item) => matcher.test(item.name)).map((item) => ({ name: item.name, path: item.name })) : [];
        return (0, helpers_1.CreateToolResult)(callId, { ok: true, files: [...attachments, ...projectFiles].slice(0, 1000) });
    }
    /** 在授权的纯文本附件与项目文件中执行受限正则搜索，并限制结果规模。 */
    async function Grep(context, callId, args) {
        const pattern = (0, helpers_1.RequireString)(args.pattern, 'pattern', 300);
        const matcher = new RegExp(pattern, 'i');
        const matches = [];
        for (const attachment of context.attachments) {
            if (!/\.(txt|md|json|yaml|yml|csv)$/i.test(attachment.name) || matches.length >= 100)
                continue;
            try {
                const resolved = await ports.file.ResolveAttachmentUri(attachment.path);
                if (!resolved)
                    continue;
                const lines = ports.file.ReadTextFile(resolved).content.split(/\r?\n/);
                lines.forEach((line, index) => { if (matches.length < 100 && matcher.test(line))
                    matches.push({ path: attachment.path, line: index + 1, content: line.slice(0, 1000) }); });
            }
            catch { /* Unreadable files do not broaden access or fail the full search. */ }
        }
        for (const fileItem of context.projectRoot ? ports.file.ListProjectFiles(context.projectRoot) : []) {
            if (matches.length >= 100)
                break;
            try {
                const lines = ports.file.ReadTextFile(fileItem.path).content.split(/\r?\n/);
                lines.forEach((line, index) => { if (matches.length < 100 && matcher.test(line))
                    matches.push({ path: fileItem.name, line: index + 1, content: line.slice(0, 1000) }); });
            }
            catch { /* Binary and unreadable project files are skipped. */ }
        }
        return (0, helpers_1.CreateToolResult)(callId, { ok: true, matches });
    }
    /** 创建一份新简历：获取 Agent 锁，确认模式持锁等待确认，否则直接经后端落库并释放锁。 */
    async function CreateResume(context, callId, args) {
        if (context.resumeEditing)
            throw new Error('The user is editing a resume. Do not create another resume until the user saves or exits edit mode.');
        const resumeId = `resume-${(0, node_crypto_1.randomUUID)()}`;
        const name = (0, helpers_1.RequireString)(args.name, 'name', 200);
        const content = (0, helpers_1.RequireString)(args.content, 'content', 100000);
        const reason = (0, helpers_1.RequireString)(args.reason, 'reason', 1000);
        const ownerId = `agent-${context.requestId}`;
        const lockResult = await context.ports.resumeWrite.AcquireLock({ resumeId, owner: 'agent', ownerId });
        if (!lockResult.acquired)
            throw Object.assign(new Error('User is editing this resume.'), { code: lockResult.code });
        const pending = { kind: 'create', resumeId, name, content, reason, baseRevision: undefined, ownerId };
        if (context.confirmationMode === '需要确认') {
            const confirmationId = `resume-confirmation-${(0, node_crypto_1.randomUUID)()}`;
            context.pendingEdits.set(confirmationId, pending);
            context.emit({ type: 'resume_confirmation', requestId: context.requestId, confirmationId, resumeId, resumeName: name, content, reason });
            return (0, helpers_1.CreateToolResult)(callId, { ok: false, code: 'CONFIRMATION_REQUIRED', message: 'A user confirmation card has been shown. Do not repeat this creation. Wait for a new user message after confirmation or rejection.', confirmationId });
        }
        // 落库失败也必须释放锁（否则残留至租约过期，阻塞用户编辑与后续 Agent 编辑）。
        let saved;
        try {
            saved = await context.ports.resumeWrite.Save({ resume: { id: resumeId, name, content, updatedAt: '', targetRoles: [], summary: content.slice(0, 120) } });
        }
        finally {
            await context.ports.resumeWrite.ReleaseLock(resumeId, ownerId);
        }
        context.emit({ type: 'resume_created', requestId: context.requestId, resumeId, resumeName: name, content, reason, revision: saved.revision });
        return (0, helpers_1.CreateToolResult)(callId, { ok: true, saved: true, resumeId, revision: saved.revision });
    }
    /** 用当前会话的只读快照校验并整份保存 Agent 简历编辑：获取锁、确认模式持锁、成功落库释放锁。 */
    async function EditResume(context, callId, args) {
        if (!context.resumeSnapshot || args.resumeId !== context.resumeSnapshot.id)
            throw new Error('The selected resume is unavailable or does not match resumeId.');
        if (context.resumeEditing)
            throw new Error('The user is editing this resume. Do not retry until the user saves or exits edit mode.');
        const content = (0, helpers_1.RequireString)(args.content, 'content', 100000);
        const reason = (0, helpers_1.RequireString)(args.reason, 'reason', 1000);
        const baseRevision = context.resumeSnapshot.revision;
        const ownerId = `agent-${context.requestId}`;
        const lockResult = await context.ports.resumeWrite.AcquireLock({ resumeId: args.resumeId, owner: 'agent', ownerId, baseRevision });
        if (!lockResult.acquired)
            throw Object.assign(new Error('User is editing this resume.'), { code: lockResult.code });
        const pending = { kind: 'edit', resumeId: args.resumeId, content, reason, baseRevision, ownerId, resume: { ...context.resumeSnapshot } };
        if (context.confirmationMode === '需要确认') {
            const confirmationId = `resume-confirmation-${(0, node_crypto_1.randomUUID)()}`;
            context.pendingEdits.set(confirmationId, pending);
            context.emit({ type: 'resume_confirmation', requestId: context.requestId, confirmationId, resumeId: args.resumeId, content, reason });
            return (0, helpers_1.CreateToolResult)(callId, { ok: false, code: 'CONFIRMATION_REQUIRED', message: 'A user confirmation card has been shown. Do not repeat this edit. Wait for a new user message after confirmation or rejection.', confirmationId });
        }
        // 落库失败也必须释放锁（否则残留至租约过期，阻塞用户编辑与后续 Agent 编辑）。
        let saved;
        try {
            saved = await context.ports.resumeWrite.Save({ resume: { ...context.resumeSnapshot, content }, baseRevision });
        }
        finally {
            await context.ports.resumeWrite.ReleaseLock(args.resumeId, ownerId);
        }
        context.emit({ type: 'resume_updated', requestId: context.requestId, resumeId: args.resumeId, content, reason, revision: saved.revision });
        return (0, helpers_1.CreateToolResult)(callId, { ok: true, saved: true, resumeId: args.resumeId, revision: saved.revision });
    }
    /** 展示结构化澄清问题；运行循环在问题卡展示后停止，等待用户下一条真实消息。 */
    function AskUserQuestion(context, callId, args) {
        if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3)
            throw new Error('AskUserQuestion requires one to three questions.');
        const seen = new Set();
        const questions = args.questions.map((item) => {
            const record = item;
            const id = (0, helpers_1.RequireString)(record?.id, 'question.id', 100);
            if (seen.has(id))
                throw new Error('Question ids must be unique.');
            seen.add(id);
            const question = (0, helpers_1.RequireString)(record?.question, 'question.question', 500);
            if (!Array.isArray(record?.options) || record.options.length < 1 || record.options.length > 4)
                throw new Error('Each question requires one to four options.');
            const options = [...new Set(record.options.map((option) => (0, helpers_1.RequireString)(option, 'question.option', 200)).filter((option) => option !== '其他'))].slice(0, 3);
            return { id, question, options: [...options, '其他'] };
        });
        context.pendingQuestions.set(context.sessionId, questions);
        context.emit({ type: 'question_requested', requestId: context.requestId, sessionId: context.sessionId, questions });
        return (0, helpers_1.CreateToolResult)(callId, { ok: true, awaitingUser: true, message: 'The questions are shown to the user. Stop this turn and wait for the next user message.' });
    }
    /** 创建会话内任务，并同步任务卡所需的结构化事件。 */
    function CreateTask(context, callId, args) {
        const task = { id: `task-${(0, node_crypto_1.randomUUID)()}`, title: (0, helpers_1.RequireString)(args.title, 'title', 300), description: typeof args.description === 'string' ? args.description.slice(0, 2000) : '', status: 'in_progress' };
        context.tasks.set(task.id, task);
        context.emit({ type: 'task_created', sessionId: context.sessionId, task });
        context.persistSessionState();
        return (0, helpers_1.CreateToolResult)(callId, { ok: true, task });
    }
    /** 更新会话内任务，拒绝不存在的任务标识。 */
    function UpdateTask(context, callId, args) {
        const task = context.tasks.get(args.taskId);
        if (!task)
            throw new Error('Task not found in this session.');
        if (args.status && !['pending', 'in_progress', 'completed', 'blocked', 'cancelled'].includes(args.status))
            throw new Error('Task status is invalid.');
        if (typeof args.title === 'string')
            task.title = (0, helpers_1.RequireString)(args.title, 'title', 300);
        if (typeof args.description === 'string')
            task.description = args.description.slice(0, 2000);
        if (args.status)
            task.status = args.status;
        context.persistSessionState();
        context.emit({ type: 'task_updated', sessionId: context.sessionId, task });
        return (0, helpers_1.CreateToolResult)(callId, { ok: true, task });
    }
    return {
        packageName: '@offerget/agent-modules-defaults',
        name: 'offerget.agent-defaults',
        version: '0.1.0',
        sdkVersion: '0.1.0',
        slot: 'tools',
        capabilities: ['tools:12'],
        /** 返回内置 12 工具注册表。 */
        GetToolDefinitions() { return registry; },
        /** 统一执行管道：Schema 校验与一次修复、写工具幂等、按工具超时、结构化错误码。 */
        async ExecuteToolCall(call, context) {
            let args;
            try {
                args = JSON.parse(call.function.arguments || '{}');
            }
            catch {
                return (0, helpers_1.CreateToolResult)(call.id, { ok: false, code: 'INVALID_JSON', message: 'Tool arguments are invalid JSON. Please correct the call once.' });
            }
            const toolName = call.function.name;
            const validator = EnsureToolValidators().get(toolName);
            if (validator && !validator(args)) {
                const schema = registry.find((tool) => tool.definition.function.name === toolName)?.definition?.function?.parameters;
                const fixed = FixArguments(args, schema ?? {});
                if (JSON.stringify(fixed) !== JSON.stringify(args) && validator(fixed))
                    args = fixed;
                else
                    return (0, helpers_1.CreateToolResult)(call.id, { ok: false, code: 'INVALID_TOOL_ARGUMENTS', message: 'Tool arguments do not match the schema. Please correct the call once.' });
            }
            if (writeTools.has(toolName)) {
                const cached = executedToolCalls.get(`${context.sessionId}:${call.id}`);
                if (cached)
                    return (0, helpers_1.CreateToolResult)(call.id, cached);
            }
            const meta = registry.find((tool) => tool.definition.function.name === toolName);
            const timeoutMs = meta?.timeoutMs ?? 10000;
            try {
                const execution = (async () => {
                    switch (toolName) {
                        case 'Read': return await Read(context, call.id, args);
                        case 'Glob': return Glob(context, call.id, args);
                        case 'Grep': return await Grep(context, call.id, args);
                        case 'ReadProfile': return (0, helpers_1.CreateToolResult)(call.id, { ok: true, profiles: context.profileSnapshot });
                        case 'ReadResume': return (0, helpers_1.CreateToolResult)(call.id, { ok: true, resume: context.resumeSnapshot });
                        case 'CreateResume': return CreateResume(context, call.id, args);
                        case 'EditResume': return EditResume(context, call.id, args);
                        case 'AskUserQuestion': return AskUserQuestion(context, call.id, args);
                        case 'TaskCreate': return CreateTask(context, call.id, args);
                        case 'TaskUpdate': return UpdateTask(context, call.id, args);
                        case 'TaskList': return (0, helpers_1.CreateToolResult)(call.id, { ok: true, tasks: [...context.tasks.values()] });
                        case 'TaskGet': return (0, helpers_1.CreateToolResult)(call.id, { ok: true, task: context.tasks.get(args.taskId) ?? null });
                        default: return (0, helpers_1.CreateToolResult)(call.id, { ok: false, code: 'TOOL_NOT_ALLOWED', message: 'This tool is not available in the resume-copilot scenario.' });
                    }
                })();
                let timer;
                const timeout = new Promise((resolve) => {
                    timer = setTimeout(() => resolve((0, helpers_1.CreateToolResult)(call.id, { ok: false, code: 'TIMEOUT', message: 'Tool execution timed out.' })), timeoutMs);
                });
                const result = await Promise.race([execution, timeout]);
                clearTimeout(timer);
                if (writeTools.has(toolName))
                    CacheToolResult(context.sessionId, call.id, result);
                return result;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : 'Tool validation failed.';
                const isAuthorization = /outside|unavailable|not authorized|not accessible/i.test(message);
                return (0, helpers_1.CreateToolResult)(call.id, { ok: false, code: isAuthorization ? 'RESOURCE_NOT_AUTHORIZED' : 'VALIDATION_ERROR', message });
            }
        },
    };
}
