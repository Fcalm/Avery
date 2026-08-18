import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import type { Resume } from '../../../types/domain';
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
    mutationFn: ({ resume, expectedRevision }) => Unwrap(platformClient.workspace.UpsertResume(resume, expectedRevision)),
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
    mutationFn: ({ id, name, expectedRevision }) => Unwrap(platformClient.workspace.RenameResume(id, name, expectedRevision)),
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
    mutationFn: ({ id }) => Unwrap(platformClient.workspace.DeleteResume(id)),
    applyServer: (data, vars) => ({ ...data, resumes: data.resumes.filter((item) => item.id !== vars.id) }),
    ...handlers,
  });
}

/** 读取一份简历的版本历史；失败返回空列表。 */
export async function LoadResumeRevisions(resumeId: string) {
  const result = await platformClient.workspace.GetResumeRevisions(resumeId);
  return result.ok ? result.data : [];
}

/** 标记或取消标记重要简历版本；失败抛统一业务错误。 */
export async function SetResumeRevisionPinned(revisionId: string, pinned: boolean) {
  return Unwrap(await platformClient.workspace.SetResumeRevisionPinned(revisionId, pinned));
}

/** 导出简历文件到工作空间 exports；失败抛统一业务错误。 */
export async function ExportResumeFile(resume: { name: string; summary: string; content: string }, format: 'pdf' | 'docx' | 'png') {
  return Unwrap(await platformClient.workspace.ExportResume(resume, format));
}
