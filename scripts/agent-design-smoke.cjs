'use strict';
/* Agent 设计关键纠正点冒烟验证：不依赖真实网络/数据库，使用内存桩。 */
const assert = require('node:assert/strict');
const { CreateDefaultModules } = require('@avery/agent-modules-defaults');
const { RunAgentLoop } = require('@avery/agent-core');
const { KeepRecentTurnGroups } = require('@avery/agent-sdk');

function CreateStubPorts() {
  const lockCalls = [];
  const resumeWrite = {
    async AcquireLock(input) {
      lockCalls.push(input);
      return { acquired: true, lock: { resumeId: input.resumeId, owner: input.owner, ownerId: input.ownerId, baseRevision: input.baseRevision, acquiredAt: Date.now(), leaseExpiresAt: Date.now() + 60000 } };
    },
    async ReleaseLock() {},
    async Save(input) { return { id: input.resume.id, revision: 1 }; },
  };
  const file = {
    async ReadAuthorizedFile() { return { content: '', truncated: false }; },
    ReadTextFile() { return { content: '', truncated: false }; },
    ListProjectFiles() { return []; },
    ResolveProjectPath(_root, p) { return p; },
    async ResolveAttachmentUri() { return null; },
    CreateGlobMatcher() { return { test: () => false }; },
  };
  const resumeRead = { async ReadCurrent() { return null; } };
  return {
    ports: {
      getConfig: async () => null,
      saveConfig: async () => {},
      getStoredSettings: async () => ({}),
      file,
      resumeRead,
      resumeWrite,
      observabilityStore: null,
    },
    lockCalls,
  };
}

function MakeToolContext(ports, overrides = {}) {
  return {
    sessionId: 'session-1',
    requestId: 'request-1',
    confirmationMode: '需要确认',
    resumeEditing: false,
    projectRoot: null,
    attachments: [],
    profileSnapshot: [],
    resumeSnapshot: null,
    resumeId: undefined,
    ports,
    tasks: new Map(),
    pendingEdits: new Map(),
    pendingQuestions: new Map(),
    emit() {},
    persistSessionState() {},
    ...overrides,
  };
}

async function main() {
  const stub = CreateStubPorts();
  const modules = CreateDefaultModules(stub.ports);
  const names = modules.tools.GetToolDefinitions().map((tool) => tool.definition.function.name);

  // 1. 工具白名单按设计更名，旧名不再暴露给新模型。
  assert(names.includes('UpdateResume'), 'UpdateResume should be registered');
  assert(!names.includes('EditResume'), 'EditResume should be removed from new registry');
  assert(names.includes('CreateTodo'), 'CreateTodo should be registered');
  assert(!names.includes('TaskCreate'), 'TaskCreate should be removed from new registry');
  assert(names.includes('ReadTodo') && names.includes('UpdateTodo'), 'Todo tools should be registered');
  assert(names.includes('SearchJobs') && names.includes('ReadUrl'), 'Job discovery tools should be registered');

  // 2. AskUserQuestion 返回统一 wait_user_input disposition。
  {
    const context = MakeToolContext(stub.ports);
    const result = await modules.tools.ExecuteToolCall({
      id: 'call-question', type: 'function', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ questions: [{ id: 'q1', question: '目标岗位？', options: ['后端'] }] }) },
    }, context);
    assert.equal(result.disposition, 'wait_user_input');
    assert.equal(context.pendingQuestions.size, 1);
  }

  // 3. 简历创建在确认模式下不持锁，只冻结提案。
  {
    const context = MakeToolContext(stub.ports, { confirmationMode: '需要确认' });
    const result = await modules.tools.ExecuteToolCall({
      id: 'call-create', type: 'function', function: { name: 'CreateResume', arguments: JSON.stringify({ name: '新简历', content: '内容', reason: '用户要求' }) },
    }, context);
    assert.equal(result.disposition, 'wait_confirmation');
    assert.equal(stub.lockCalls.length, 0, 'proposal must not acquire the resume lock');
    assert.equal(context.pendingEdits.size, 1);
  }

  // 4. 简历创建在无需确认模式下执行写入并产生 receipt。
  {
    const before = stub.lockCalls.length;
    const context = MakeToolContext(stub.ports, { confirmationMode: '无需确认' });
    const result = await modules.tools.ExecuteToolCall({
      id: 'call-create-auto', type: 'function', function: { name: 'CreateResume', arguments: JSON.stringify({ name: '新简历', content: '内容', reason: '用户要求' }) },
    }, context);
    assert.equal(result.ok ?? true, true);
    assert.equal(result.disposition, 'continue');
    assert.ok(result.receipt, 'write tool should return a receipt');
    assert.equal(stub.lockCalls.length, before + 1, 'auto-save should acquire the resume lock once');
  }

  // 5. TurnGroup 保留完整工具链，不按条数硬切。
  {
    const history = [
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'ReadResume', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: '{}' },
      { role: 'user', content: '第二轮' },
      { role: 'assistant', content: '完成' },
    ];
    const recent = KeepRecentTurnGroups(history, 1);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].role, 'user');
    assert.equal(recent[0].content, '第二轮');
    assert.equal(recent[1].role, 'assistant');
    assert.equal(recent[1].content, '完成');
  }

  // 6. Kernel 在 AskUserQuestion 后停止，不再请求第二次模型输出。
  {
    const events = [];
    let streamCalls = 0;
    const fakeProvider = {
      async StreamCompletion() {
        streamCalls += 1;
        if (streamCalls > 1) throw new Error('Kernel continued after waiting disposition');
        return {
          content: '',
          toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ questions: [{ id: 'q1', question: '需要确认？', options: ['是'] }] }) } }],
        };
      },
      async CreateSummary() { return { content: 'summary' }; },
      EstimateTokens() { return 1; },
      GetRuntimeLimits() { return { contextLimit: 64000, threshold: 80 }; },
      SystemPrompt() { return ''; },
    };
    const fakeModules = {
      modelProvider: fakeProvider,
      compaction: {
        ShouldCompact() { return false; },
        SplitRecentTurns(history) { return { earlier: [], recent: history }; },
        DropOldestTurns(history) { return history; },
      },
      tools: {
        async ExecuteToolCall() {
          return { role: 'tool', tool_call_id: 'tc1', content: JSON.stringify({ ok: true, awaitingUser: true }), disposition: 'wait_user_input' };
        },
      },
      observability: {
        RecordLog() {},
        AppendTraceEvent() {},
        FinishTrace() {},
      },
    };
    const result = await RunAgentLoop({
      requestId: 'req-kernel',
      sessionId: 'session-kernel',
      model: 'model',
      systemContext: '',
      requestHistory: [],
      userContent: '你好',
      histories: new Map(),
      toolArray: [{
        definition: { type: 'function', function: { name: 'AskUserQuestion', description: '', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
        timeoutMs: 1000,
        isConcurrencySafe: false,
        sideEffect: 'none',
        resourceKeys: () => ['run:interaction'],
      }],
      modules: fakeModules,
      toolContext: {},
      emit: (event) => events.push(event),
      signal: new AbortController().signal,
      maxTurns: 3,
      contextLimit: 64000,
      thresholdPercent: 80,
      createId: () => 'id',
    });
    assert.equal(streamCalls, 1, 'kernel must stop after waiting disposition');
    assert.equal(result.outcome, 'waiting_user_input');
    assert.equal(result.disposition, 'waiting_user_input');
    assert(events.some((event) => event.type === 'waiting_user_input'), 'kernel should emit waiting_user_input event');
  }

  // 7. 资源键调度：只读并行，写屏障单独执行。
  {
    const events = [];
    const active = { count: 0, max: 0, writeAlone: true, order: [] };
    let streamCalls = 0;
    const fakeProvider = {
      async StreamCompletion() {
        streamCalls += 1;
        if (streamCalls === 1) {
          return {
            content: '',
            toolCalls: [
              { id: 'r1', type: 'function', function: { name: 'ReadResume', arguments: '{}' } },
              { id: 'r2', type: 'function', function: { name: 'ReadProfile', arguments: '{}' } },
              { id: 'w1', type: 'function', function: { name: 'UpdateResume', arguments: JSON.stringify({ resumeId: 'res-1', content: 'x', reason: 'r' }) } },
              { id: 'r3', type: 'function', function: { name: 'ReadTodo', arguments: '{}' } },
            ],
          };
        }
        return { content: '完成', toolCalls: [] };
      },
      async CreateSummary() { return { content: 'summary' }; },
      EstimateTokens() { return 1; },
      GetRuntimeLimits() { return { contextLimit: 64000, threshold: 80 }; },
      SystemPrompt() { return ''; },
    };
    const fakeModules = {
      modelProvider: fakeProvider,
      compaction: {
        ShouldCompact() { return false; },
        SplitRecentTurns(history) { return { earlier: [], recent: history }; },
        DropOldestTurns(history) { return history; },
      },
      tools: {
        async ExecuteToolCall(call) {
          active.count += 1;
          active.max = Math.max(active.max, active.count);
          if (call.function.name === 'UpdateResume') {
            await new Promise((resolve) => setTimeout(resolve, 20));
            active.writeAlone = active.writeAlone && active.count === 1;
            active.order.push('write');
          } else {
            await new Promise((resolve) => setTimeout(resolve, 5));
            active.order.push(call.function.name);
          }
          active.count -= 1;
          return { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true }), disposition: 'continue' };
        },
      },
      observability: {
        RecordLog() {},
        AppendTraceEvent() {},
        FinishTrace() {},
      },
    };
    const toolArray = [
      { definition: { type: 'function', function: { name: 'ReadResume', description: '', parameters: { type: 'object', properties: {}, additionalProperties: false } } }, timeoutMs: 1000, isConcurrencySafe: true, sideEffect: 'none', resourceKeys: () => ['resume'] },
      { definition: { type: 'function', function: { name: 'ReadProfile', description: '', parameters: { type: 'object', properties: {}, additionalProperties: false } } }, timeoutMs: 1000, isConcurrencySafe: true, sideEffect: 'none', resourceKeys: () => ['profile'] },
      { definition: { type: 'function', function: { name: 'UpdateResume', description: '', parameters: { type: 'object', properties: {}, additionalProperties: false } } }, timeoutMs: 1000, isConcurrencySafe: false, sideEffect: 'local_write', resourceKeys: () => ['resume'] },
      { definition: { type: 'function', function: { name: 'ReadTodo', description: '', parameters: { type: 'object', properties: {}, additionalProperties: false } } }, timeoutMs: 1000, isConcurrencySafe: true, sideEffect: 'none', resourceKeys: () => ['run:todos'] },
    ];
    const result = await RunAgentLoop({
      requestId: 'req-sched',
      sessionId: 'session-sched',
      model: 'model',
      systemContext: '',
      requestHistory: [],
      userContent: '调度',
      histories: new Map(),
      toolArray,
      modules: fakeModules,
      toolContext: {},
      emit: (event) => events.push(event),
      signal: new AbortController().signal,
      maxTurns: 3,
      contextLimit: 64000,
      thresholdPercent: 80,
      createId: () => 'id',
    });
    assert.equal(result.outcome, 'completed');
    assert(active.max >= 2, 'read-only tools without resource conflicts should run in parallel');
    assert(active.writeAlone, 'write tool must run alone (barrier)');
    assert(active.order.indexOf('write') > active.order.indexOf('ReadResume'), 'write should happen after the first read batch');
    assert(active.order.indexOf('ReadTodo') > active.order.indexOf('write'), 'reads after a write barrier should run in a later phase');
  }

  // 8. Prompt 编译结果稳定且 Provider 不再拥有业务 Prompt 所有权（编译指令可注入）。
  {
    const { BuildDefaultCompiledInstructions, CompilePrompt, BuildDefaultPromptFragments } = require('@avery/agent-modules-defaults');
    const first = BuildDefaultCompiledInstructions('tools-v1');
    const second = CompilePrompt(BuildDefaultPromptFragments(), 'default', 'tools-v1');
    assert.equal(first.manifest.compiledHash, second.manifest.compiledHash);
    assert(first.compiled.includes('runtime/invariants'));
    assert(first.manifest.scenarioId, 'default');
    assert(first.layers.length > 0);
  }

  console.log('agent-design-smoke: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
