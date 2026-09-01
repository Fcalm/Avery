import { z } from 'zod';

export const CronTaskScenarioSchema = z.enum(['default', 'application']);
export const CronTaskStateSchema = z.enum(['active', 'paused', 'completed', 'cancelled']);
export const CronRunStateSchema = z.enum(['running', 'completed', 'failed', 'missed', 'needsAttention']);
export const CronDayOfWeekSchema = z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);

const DateTime = z.string().datetime({ offset: true });
const TimeZone = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; } catch { return false; }
}, 'Invalid IANA time zone.');

export const CronScheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('once'), executeAt: DateTime, timeZone: TimeZone }).strict(),
  z.object({
    type: z.literal('daily'), startAt: DateTime, timeZone: TimeZone,
    intervalDays: z.number().int().min(1).max(365).default(1), occurrences: z.number().int().min(1).max(3650),
  }).strict(),
  z.object({
    type: z.literal('weekly'), startAt: DateTime, timeZone: TimeZone,
    daysOfWeek: z.array(CronDayOfWeekSchema).min(1).max(7).refine((days) => new Set(days).size === days.length, 'Duplicate weekdays are not allowed.'),
    intervalWeeks: z.number().int().min(1).max(52).default(1), occurrences: z.number().int().min(1).max(3650),
  }).strict(),
]);

export const CreateCronTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(20000),
  scenarioId: CronTaskScenarioSchema,
  schedule: CronScheduleSchema,
}).strict();

export const UpdateCronTaskSchema = z.object({
  cronTaskId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(20000).optional(),
  schedule: CronScheduleSchema.optional(),
  state: z.enum(['active', 'paused']).optional(),
}).strict().refine((value) => value.title !== undefined || value.message !== undefined || value.schedule !== undefined || value.state !== undefined, 'At least one update is required.');

export const ReadCronTaskSchema = z.object({
  cronTaskId: z.string().min(1).max(200).optional(),
  includeRuns: z.boolean().optional(),
}).strict();

export const DeleteCronTaskSchema = z.object({ cronTaskId: z.string().min(1).max(200) }).strict();

export type CronSchedule = z.infer<typeof CronScheduleSchema>;
export type CreateCronTaskInput = z.infer<typeof CreateCronTaskSchema>;
export type UpdateCronTaskInput = z.infer<typeof UpdateCronTaskSchema>;
export type CronTaskState = z.infer<typeof CronTaskStateSchema>;
export type CronRunState = z.infer<typeof CronRunStateSchema>;

export interface CronTaskDto {
  id: string;
  title: string;
  message: string;
  scenarioId: 'default' | 'application';
  resumeId?: string;
  schedule: CronSchedule;
  state: CronTaskState;
  consumedOccurrences: number;
  totalOccurrences: number;
  nextRunAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CronRunDto {
  id: string;
  cronTaskId: string;
  occurrence: number;
  scheduledAt: number;
  state: CronRunState;
  reason?: string;
  conversationId?: string;
  startedAt?: number;
  completedAt?: number;
}
