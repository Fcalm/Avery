import { describe, expect, it, vi } from 'vitest';
import { ParseAgentResumeData, ResumeDataToText } from '@avery/contracts';
import type { ResumeSnapshot, ToolContext } from '@avery/agent-sdk';
import { CreateToolsModule } from '../../../packages/agent-modules-defaults/src/tools';
import { CreateInteractionModule } from '../../../packages/agent-modules-defaults/src/interaction';
import type { PendingResumeEdit } from '../../../packages/agent-modules-defaults/src/helpers';
import { CreateToolContext } from './test-helpers';

function InputData() {
  return {
    personal: { name: '林小雨', email: 'lin@example.com', phone: '13800000000', github: '' },
    education: [{ school: '示例大学', degree: '本科', major: '工商管理', start: '2022-09', end: '2026-06' }],
    work: [], projects: [{ name: 'Avery', role: '负责人', start: '2026-01', end: '至今', descriptions: ['制作原型'] }],
    sections: [{ title: '核心能力', items: ['需求分析'] }],
  };
}
function Fixture(overrides: Partial<ToolContext> = {}) {
  const context = CreateToolContext(overrides);
  vi.mocked(context.ports.resumeWrite.AcquireLock).mockResolvedValue({ acquired: true, lock: { resumeId: 'r1', owner: 'agent', ownerId: 'test', acquiredAt: 1, leaseExpiresAt: 999999 } });
  vi.mocked(context.ports.resumeWrite.Save).mockResolvedValue({ id: 'r1', revision: 2 });
  if (context.boundResume) vi.mocked(context.ports.resumeRead.ReadCurrent).mockResolvedValue(context.boundResume);
  const tools = CreateToolsModule({ getConfig: vi.fn(), saveConfig: vi.fn(), getStoredSettings: vi.fn() });
  async function Call(name: string, args: object) {
    const result = await tools.ExecuteToolCall({ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }, context);
    return { ...result, payload: JSON.parse(result.content) };
  }
  return { context, Call, tools, save: vi.mocked(context.ports.resumeWrite.Save) };
}
function BoundResume(): ResumeSnapshot {
  const data = ParseAgentResumeData(InputData());
  return { id: 'r1', name: '当前简历', data, content: ResumeDataToText(data), templateId: 'compact', targetRoles: ['产品'], summary: '已有摘要', updatedAt: '', revision: 1 };
}

describe('Agent 结构化简历创建与编辑', () => {
  it('创建定义要求 data；Markdown 调用不得静默创建旧版简历', async () => {
    const { tools, Call, save } = Fixture();
    const schema = tools.GetToolDefinitions('application').find((tool) => tool.definition.function.name === 'CreateResume')!.definition.function.parameters;
    expect(schema.required).toEqual(['name', 'data', 'reason']);
    const result = await Call('CreateResume', { name: '简历', content: '# 旧版正文', reason: '创建' });
    expect(result.payload).toMatchObject({ ok: false, code: 'INVALID_TOOL_ARGUMENTS' });
    expect(save).not.toHaveBeenCalled();
  });
  it('完全信任时直接保存新版数据及派生正文，可进入结构化编辑器', async () => {
    const { Call, save } = Fixture();
    const input = InputData();
    const result = await Call('CreateResume', { name: '产品简历', data: input, reason: '用户要求新建' });
    expect(result.payload).toMatchObject({ ok: true, saved: true });
    const saved = save.mock.calls[0][0].resume;
    expect(saved).toMatchObject({ data: { ...input, mode: 'structured', version: 1 }, templateId: 'classic' });
    expect(saved.content).toBe(ResumeDataToText(saved.data!));
    expect(saved.data).not.toHaveProperty('legacyContent');
  });
  it('缺少必填事实时明确要求补问，不获取锁也不保存', async () => {
    const { Call, context, save } = Fixture();
    const input = InputData(); input.personal.email = '';
    const result = await Call('CreateResume', { name: '产品简历', data: input, reason: '创建' });
    expect(result.payload).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', message: expect.stringContaining('personal.email') });
    expect(result.payload.message).toContain('不要编造');
    expect(save).not.toHaveBeenCalled(); expect(context.ports.resumeWrite.AcquireLock).not.toHaveBeenCalled();
  });
  it('等待确认的提案序列化恢复后仍完整保存结构化数据', async () => {
    const { Call, context, save } = Fixture({ confirmationMode: 'always_confirm' });
    const input = InputData();
    const result = await Call('CreateResume', { name: '产品简历', data: input, reason: '创建' });
    expect(result.disposition).toBe('wait_confirmation');
    expect(save).not.toHaveBeenCalled(); expect(context.ports.resumeWrite.AcquireLock).not.toHaveBeenCalled();
    context.pendingEdits = new Map(JSON.parse(JSON.stringify([...context.pendingEdits])) as Array<[string, unknown]>);
    await CreateInteractionModule().ConfirmResumeEdit(result.payload.confirmationId, true, context);
    expect(save.mock.calls[0][0].resume).toMatchObject({ data: { ...input, mode: 'structured' }, templateId: 'classic' });
  });
  it('拒绝确认不会写入，含待确认成果的草稿不会提前保存', async () => {
    const { Call, context, save } = Fixture({ confirmationMode: 'always_confirm' });
    const result = await Call('CreateResume', { name: '简历', data: InputData(), reason: '创建' });
    await CreateInteractionModule().ConfirmResumeEdit(result.payload.confirmationId, false, context);
    expect(save).not.toHaveBeenCalled();
    const another = Fixture(); const input = InputData(); input.projects[0].descriptions = ['提升效率 50%【待确认】'];
    const draft = await another.Call('CreateResume', { name: '简历', data: input, reason: '创建' });
    expect(draft.disposition).toBe('wait_user_input'); expect(another.save).not.toHaveBeenCalled();
    expect((another.context.pendingEdits.get(draft.payload.draftId) as PendingResumeEdit).data?.mode).toBe('structured');
  });
  it.each(['fully_trusted', 'always_confirm'] as const)('%s 编辑后保持模板和未改字段，保存不降级', async (confirmationMode) => {
    const bound = BoundResume(); bound.data!.legacyContent = '尚未整理的旧栏目'; bound.content = ResumeDataToText(bound.data!);
    const { Call, save, context } = Fixture({ boundResume: bound, confirmationMode });
    const input = InputData(); input.projects[0].descriptions = ['制作高保真原型'];
    const result = await Call('UpdateResume', { resumeId: bound.id, data: input, reason: '只修改一条描述' });
    if (confirmationMode === 'always_confirm') await CreateInteractionModule().ConfirmResumeEdit(result.payload.confirmationId, true, context);
    const saved = save.mock.calls[0][0];
    expect(saved).toMatchObject({ baseRevision: 1, resume: { id: bound.id, templateId: 'compact', targetRoles: ['产品'], summary: '已有摘要', data: { mode: 'structured', education: bound.data!.education, legacyContent: '尚未整理的旧栏目' } } });
    expect(saved.resume.data!.projects[0].descriptions).toEqual(['制作高保真原型']);
    expect(saved.resume.content).toBe(ResumeDataToText(saved.resume.data!));
  });
  it('新版简历拒绝仅正文更新；旧版简历可明确转为新版', async () => {
    const { Call, save } = Fixture({ boundResume: BoundResume() });
    const result = await Call('UpdateResume', { resumeId: 'r1', content: '仅正文', reason: '修改' });
    expect(result.payload).toMatchObject({ ok: false, message: expect.stringContaining('structured data') });
    expect(save).not.toHaveBeenCalled();
    const legacy = Fixture({ boundResume: { id: 'r1', name: '旧简历', content: '旧正文', updatedAt: '', revision: 1 } });
    const converted = await legacy.Call('UpdateResume', { resumeId: 'r1', data: InputData(), reason: '用户要求整理成新版' });
    expect(converted.payload.ok).toBe(true);
    expect(legacy.save.mock.calls[0][0].resume.data?.mode).toBe('structured');
  });
  it('超过组数/条数和同时传两种正文格式不会进入写入流程', async () => {
    const input = InputData();
    const { Call, save } = Fixture({ boundResume: BoundResume() });
    for (const invalid of [{ ...input, education: Array.from({ length: 4 }, () => input.education[0]) }, { ...input, projects: [{ ...input.projects[0], descriptions: Array(6).fill('描述') }] }]) {
      expect((await Call('CreateResume', { name: '简历', data: invalid, reason: '创建' })).payload.code).toBe('INVALID_TOOL_ARGUMENTS');
    }
    expect((await Call('UpdateResume', { resumeId: 'r1', data: input, content: '正文', reason: '修改' })).payload.code).toBe('INVALID_TOOL_ARGUMENTS');
    expect(save).not.toHaveBeenCalled();
  });
  it('确认提案数据或正文被改动时不得应用另一个版本', async () => {
    const { Call, context, save } = Fixture({ confirmationMode: 'always_confirm' });
    const result = await Call('CreateResume', { name: '简历', data: InputData(), reason: '创建' });
    const pending = context.pendingEdits.get(result.payload.confirmationId) as PendingResumeEdit;
    pending.data!.personal.name = '被替换的姓名'; pending.content = ResumeDataToText(pending.data!);
    await expect(CreateInteractionModule().ConfirmResumeEdit(result.payload.confirmationId, true, context)).rejects.toThrow('提案已变更');
    expect(save).not.toHaveBeenCalled();
  });
});
