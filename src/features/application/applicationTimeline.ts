/** 投递流程记录（时间线）的前端会话存储。
 *  只存内存：应用重启即清空，下次查看时按投递数据重新播种“提交申请”一条。
 *  阶段迁移本身已由后端 MoveApplicationStatus 写入 application_events 事件表；
 *  之后若需要跨会话的完整历史，只需补一个按 application_id 回放事件的读取接口，
 *  无需任何表结构或迁移变更——这是“暂不持久化”方案的退路。 */

export interface ApplicationTimelineEntry {
  /** 展示用短日期（M/D）。 */
  d: string;
  /** 事件描述，例如“通过 BOSS直聘 提交申请”。 */
  t: string;
}

const timelines = new Map<string, ApplicationTimelineEntry[]>();

function TodayLabel(): string {
  const now = new Date();
  return `${now.getMonth() + 1}/${now.getDate()}`;
}

/** 读取某投递的时间线；首次访问时用 seed（由投递与岗位数据推导）初始化。 */
export function GetApplicationTimeline(id: string, seed: ApplicationTimelineEntry[]): ApplicationTimelineEntry[] {
  let entries = timelines.get(id);
  if (!entries) {
    entries = [...seed];
    timelines.set(id, entries);
  }
  return entries;
}

/** 追加一条事件；若该投递的时间线尚未初始化（例如先拖拽后打开抽屉），先播种再追加。 */
export function AppendApplicationTimeline(id: string, seed: ApplicationTimelineEntry[], text: string): void {
  let entries = timelines.get(id);
  if (!entries) {
    entries = [...seed];
    timelines.set(id, entries);
  }
  entries.push({ d: TodayLabel(), t: text });
}
