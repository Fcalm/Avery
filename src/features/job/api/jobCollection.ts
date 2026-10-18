import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobCollectionInput } from '@avery/contracts';
import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import { WORKSPACE_QUERY_KEY } from '../../workspace/api/workspaceData';

const TaskKey = ['workspace', 'job-collection-task'] as const;
const SourcesKey = ['workspace', 'recruitment-sources'] as const;

/** 岗位页即使关闭采集弹窗也继续读取在途任务；重新进入页面恢复后端最新任务。 */
export function useJobCollection(open: boolean) {
  const client = useQueryClient();
  const sources = useQuery({ queryKey: SourcesKey, queryFn: () => Unwrap(platformClient.workspace.ListRecruitmentSources()), enabled: open });
  const task = useQuery({
    queryKey: TaskKey, queryFn: () => Unwrap(platformClient.workspace.GetJobCollectionTask()),
    refetchInterval: (query) => query.state.data?.status === 'running' ? 1000 : false,
  });
  const observed = useRef('');
  useEffect(() => {
    const current = task.data;
    if (!current) return;
    const marker = `${current.taskId}:${current.collected}:${current.status}`;
    if (observed.current === marker) return;
    observed.current = marker;
    // 仅依据 Worker 已提交计数刷新岗位，绝不把采集临时数组塞进业务缓存。
    void client.invalidateQueries({ queryKey: ['workspace', 'job-query'] });
    void client.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY, exact: true });
    if (current.status !== 'running') void client.invalidateQueries({ queryKey: SourcesKey });
  }, [task.data, client]);
  const start = useMutation({
    mutationFn: (input: JobCollectionInput) => Unwrap(platformClient.workspace.StartJobCollection(input)),
    onSuccess: (result) => client.setQueryData(TaskKey, result),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => Unwrap(platformClient.workspace.CancelJobCollection(id)),
    onSuccess: (result) => client.setQueryData(TaskKey, result),
  });
  const setEnabled = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => Unwrap(platformClient.workspace.SetRecruitmentSourceEnabled(input.id, input.enabled)),
    onSuccess: () => client.invalidateQueries({ queryKey: SourcesKey }),
  });
  return { sources, task, start, cancel, setEnabled };
}
