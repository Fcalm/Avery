import { useQuery } from '@tanstack/react-query';
import { platformClient, Unwrap } from '../../shared/platform/platformClient';
import { LoadResumeRevision } from '../resume/api/resumeQueries';
import type { Resume } from '../../types/domain';

/** 资料侧栏统一读取简历版本；入口只决定选中哪一份，不改变读取、编辑和下载能力。 */
export function useSidePanelResume(resume: Resume | null, revision: number | undefined) {
  const query = useQuery({
    queryKey: ['side-panel-resume', resume?.id, resume?.revision, revision ?? 'current'],
    enabled: !!resume,
    queryFn: async () => {
      if (!resume) throw new Error('简历已删除或不可用');
      const versions = await Unwrap(platformClient.workspace.GetResumeRevisions(resume.id));
      if (revision === undefined || revision === resume.revision) return { document: resume, versions };
      const version = versions.find((item) => item.revision === revision);
      if (!version) throw new Error('此历史版本已被清理，请选择当前版本。');
      const historical = await LoadResumeRevision(resume.id, version.id);
      return { document: historical.document, versions };
    },
  });
  // 当前版本直接使用工作空间事实源，保存后立即跟随新 revision；历史版本必须等待精确读取。
  const document = revision === undefined || revision === resume?.revision ? resume : query.data?.document ?? null;
  return { document, versions: query.data?.versions ?? [], loading: !!resume && query.isPending,
    error: query.error instanceof Error ? query.error.message : '', Reload: query.refetch };
}
