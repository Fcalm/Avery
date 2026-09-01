import type { EvalEvent, EvalProjectInput } from '@offerget/contracts';
import { platformClient, Unwrap } from '../../../shared/platform/platformClient';

export const ListEvalProjects = () => Unwrap(platformClient.evaluation.ListProjects());
export const CreateEvalProject = (input: EvalProjectInput) => Unwrap(platformClient.evaluation.CreateProject(input));
export const UpdateEvalProject = (id: string, input: EvalProjectInput, revision: number) => Unwrap(platformClient.evaluation.UpdateProject(id, input, revision));
export const DeleteEvalProject = (id: string) => Unwrap(platformClient.evaluation.DeleteProject(id));
export const ImportEvalDataset = (id: string, jsonl: string, rubric: string, revision: number) => Unwrap(platformClient.evaluation.ImportDataset(id, jsonl, rubric, revision));
export const ValidateEvalProject = (id: string) => Unwrap(platformClient.evaluation.ValidateProject(id));
export const PreviewEvalProject = (id: string) => Unwrap(platformClient.evaluation.PreviewProject(id));
export const StartEvalRun = (id: string) => Unwrap(platformClient.evaluation.StartRun(id));
export const CancelEvalRun = (id: string) => Unwrap(platformClient.evaluation.CancelRun(id));
export const ListEvalRuns = (projectId?: string) => Unwrap(platformClient.evaluation.ListRuns(projectId));
export const ReadEvalRun = (id: string) => Unwrap(platformClient.evaluation.ReadRun(id));
export const ReadEvalCaseResult = (id: string) => Unwrap(platformClient.evaluation.ReadCaseResult(id));
export const CompareEvalRuns = (left: string, right: string) => Unwrap(platformClient.evaluation.CompareRuns(left, right));
export const SubscribeEvalEvents = (listener: (event: EvalEvent) => void) => platformClient.evaluation.OnEvent(listener);
