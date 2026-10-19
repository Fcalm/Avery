import { open, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { ConversationPresentation, ConversationResource, ConversationResourceView, ResumeDto, ResumeRevisionDto, WorkspaceViewModel, ProfileItemDto } from '@avery/contracts';

interface ResourcePorts {
  workspacePath: string;
  presentations: (sessionId: string) => Promise<ConversationPresentation[]>;
  workspace: () => Promise<WorkspaceViewModel>;
  profiles: () => Promise<{ items: ProfileItemDto[] }>;
  revisions: (resumeId: string) => Promise<ResumeRevisionDto[]>;
  revision: (resumeId: string, revisionId: string) => Promise<{ document: ResumeDto }>;
}

/** 只读取该会话已经落库的资源引用；输入只用于匹配，文件名与版本以宿主记录为准。 */
export async function ReadConversationResource(sessionId: string, input: ConversationResource, ports: ResourcePorts): Promise<ConversationResourceView> {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || !input || typeof input.id !== 'string') throw new Error('无效的产物引用');
  const snapshots = await ports.presentations(sessionId);
  const authorized = snapshots.flatMap((snapshot) => snapshot.parts.flatMap((part) => part.type === 'resource' ? [part.resource] : []))
    .find((ref) => ref.kind === input.kind && ref.id === input.id);
  if (!authorized) throw new Error('该产物不属于当前会话，或原会话已被删除');
  if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 1)) throw new Error('无效的产物版本');
  // 同一授权简历可查看保留版本；所有版本均按服务端版本表读取，禁止缺失时悄悄换成当前版。
  const resource = authorized.kind === 'resume' ? { ...authorized, revision: input.revision } : authorized;
  if (resource.kind === 'file') {
    const match = /^asset:\/\/resume\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(resource.id);
    const name = resource.fileName;
    if (!match || !name || path.basename(name) !== name || name.includes('/') || name.includes('\\')) throw new Error('无效的导出文件引用');
    const extension = path.extname(name).toLowerCase();
    if (extension !== '.pdf' && extension !== '.png') throw new Error('不支持的产物文件格式');
    let bytes: Buffer;
    try {
      const exportRoot = await realpath(path.join(ports.workspacePath, 'exports', 'agent-resume-files'));
      const directory = await realpath(path.join(exportRoot, match[1]));
      const physicalPath = await realpath(path.join(directory, name));
      if (path.dirname(directory) !== exportRoot || path.dirname(physicalPath) !== directory) throw new Error('产物文件路径已变化，无法读取');
      const handle = await open(physicalPath, 'r');
      try {
        // 先检查句柄对应文件，避免大文件完整进入内存后才发现超限。
        const metadata = await handle.stat();
        if (!metadata.isFile() || !metadata.size || metadata.size > 25 * 1024 * 1024) throw new Error('产物文件格式或大小不合法');
        bytes = await handle.readFile();
      } finally { await handle.close(); }
    } catch (error) {
      // 系统 I/O 错误包含物理路径，页面只显示可操作的提示，原始原因保留在 cause。
      if (error instanceof Error && 'code' in error) throw new Error('导出文件无法读取，可能已被移动、删除或无法访问，请重新导出。', { cause: error });
      throw error;
    }
    const pdf = extension === '.pdf' && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
    const png = extension === '.png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if ((!pdf && !png) || !bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('产物文件格式或大小不合法');
    return { resource, format: 'file', mimeType: pdf ? 'application/pdf' : 'image/png', base64: bytes.toString('base64') };
  }
  if (resource.kind === 'profile') {
    const item = (await ports.profiles()).items.find((entry) => entry.id === resource.id);
    if (!item) throw new Error('档案已删除或不可用');
    return { resource, format: 'markdown', content: item.content };
  }
  const workspace = await ports.workspace();
  if (resource.kind === 'resume') {
    let document = workspace.resumes.find((item) => item.id === resource.id);
    if (!document) throw new Error('简历已删除或不可用');
    const versions = await ports.revisions(resource.id);
    if (resource.revision !== undefined && document.revision !== resource.revision) {
      const version = versions.find((item) => item.revision === resource.revision);
      if (!version) throw new Error('此历史版本已被清理；请从资料栏查看当前简历');
      document = (await ports.revision(resource.id, version.id)).document;
    }
    return { resource, format: 'resume', document, versions };
  }
  if (resource.kind === 'job') {
    const item = workspace.jobs.find((entry) => entry.id === resource.id);
    if (!item) throw new Error('岗位已删除或过期');
    return { resource, format: 'markdown', content: ['# ' + item.title, item.company + ' · ' + item.city + (item.salary ? ' · ' + item.salary : ''), item.jd].join('\n\n') };
  }
  const item = workspace.applications.find((entry) => entry.id === resource.id);
  if (!item) throw new Error('投递记录已删除或不可用');
  const job = workspace.jobs.find((entry) => entry.id === item.jobId);
  return { resource, format: 'markdown', content: ['# ' + (job?.title ?? '投递记录'), '当前状态：' + item.status, item.appliedAt ? '投递日期：' + item.appliedAt : '', item.note].filter(Boolean).join('\n\n') };
}
