import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import type { Resume } from '../../../types/domain';
import type { ResumeRevisionDocumentDto } from '@avery/contracts';
import { useWorkspaceData } from '../../workspace/api/useWorkspaceData';
import { useWorkspaceMutation, type WorkspaceMutationHandlers } from '../../workspace/api/mutationHelper';

/** 简历业务集合；来自工作空间聚合缓存。 */
export function useResumes() {
  const { data } = useWorkspaceData();
  return data?.resumes ?? [];
}

/** 创建或更新简历；成功后按服务器 revision 写回并置顶。 */
export function useUpsertResume(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ resume: Resume; expectedRevision?: number }, { id: string; revision: number }>({
    mutationFn: ({ resume, expectedRevision }, options) => Unwrap(platformClient.workspace.UpsertResume(resume, expectedRevision, options)),
    applyServer: (data, vars, result) => {
      const next = { ...vars.resume, revision: result.revision };
      return { ...data, resumes: data.resumes.some((item) => item.id === next.id) ? data.resumes.map((item) => (item.id === next.id ? next : item)) : [next, ...data.resumes] };
    },
    conflictCode: 'REVISION_CONFLICT',
    ...handlers,
  });
}

/** 重命名简历；成功后写回服务器确认的 revision。 */
export function useRenameResume(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ id: string; name: string; expectedRevision?: number }, { id: string; name: string; revision: number }>({
    mutationFn: ({ id, name, expectedRevision }, options) => Unwrap(platformClient.workspace.RenameResume(id, name, expectedRevision, options)),
    applyServer: (data, vars, result) => ({
      ...data,
      resumes: data.resumes.map((item) => (item.id === vars.id ? { ...item, name: vars.name, updatedAt: Date.now(), revision: result.revision } : item)),
    }),
    conflictCode: 'REVISION_CONFLICT',
    ...handlers,
  });
}

/** 逻辑删除简历；成功后从缓存移除。 */
export function useDeleteResume(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ id: string }, { id: string }>({
    mutationFn: ({ id }, options) => Unwrap(platformClient.workspace.DeleteResume(id, options)),
    applyServer: (data, vars) => ({ ...data, resumes: data.resumes.filter((item) => item.id !== vars.id) }),
    ...handlers,
  });
}

/** 读取一份简历的版本历史；失败返回空列表。 */
export async function LoadResumeRevisions(resumeId: string) {
  const result = await platformClient.workspace.GetResumeRevisions(resumeId);
  return result.ok ? result.data : [];
}

/** 读取简历历史版本的只读正文。 */
export async function LoadResumeRevision(resumeId: string, revisionId: string): Promise<ResumeRevisionDocumentDto> {
  return Unwrap(await platformClient.workspace.GetResumeRevision(resumeId, revisionId));
}

/** 还原历史版本；服务端生成新的递增 revision，并同步替换简历聚合缓存。 */
export function useRestoreResumeRevision(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ resumeId: string; revisionId: string; expectedRevision?: number }, { id: string; revision: number; restoredFromRevision: number; resume: Resume }>({
    mutationFn: ({ resumeId, revisionId, expectedRevision }, options) => Unwrap(platformClient.workspace.RestoreResumeRevision(resumeId, revisionId, expectedRevision, options)),
    applyServer: (data, _vars, result) => ({
      ...data,
      resumes: data.resumes.map((item) => item.id === result.id ? result.resume : item),
    }),
    conflictCode: 'REVISION_CONFLICT',
    ...handlers,
  });
}

/** 删除历史版本；当前版本由后端保护，删除不会改变简历聚合缓存。 */
export function useDeleteResumeRevision(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ resumeId: string; revisionId: string }, { id: string }>({
    mutationFn: ({ resumeId, revisionId }, options) => Unwrap(platformClient.workspace.DeleteResumeRevision(resumeId, revisionId, options)),
    applyServer: (data) => data,
    ...handlers,
  });
}

/** 导出简历文件到工作空间 exports；失败抛统一业务错误。 */
export async function ExportResumeFile(resume: { name: string; summary: string; content: string }, format: 'html' | 'pdf' | 'docx' | 'png') {
  return Unwrap(await platformClient.workspace.ExportResume(resume, format));
}
