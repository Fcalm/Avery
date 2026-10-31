import { AppUpdateStateSchema, type AppUpdateState, type ResultEnvelope } from '@avery/contracts';

function RequireUpdates() {
  if (!window.averyUpdates) throw new Error('请在 Avery 桌面客户端中检查更新。');
  return window.averyUpdates;
}
function ReadResult<T>(result: ResultEnvelope<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
export async function ReadAppUpdate(): Promise<AppUpdateState> {
  return AppUpdateStateSchema.parse(ReadResult(await RequireUpdates().GetState()));
}
export async function CheckAppUpdates(): Promise<AppUpdateState> {
  return AppUpdateStateSchema.parse(ReadResult(await RequireUpdates().Check()));
}
export async function DownloadAppUpdate(): Promise<AppUpdateState> {
  return AppUpdateStateSchema.parse(ReadResult(await RequireUpdates().Download()));
}
export async function InstallAppUpdate(): Promise<boolean> {
  return ReadResult(await RequireUpdates().Install());
}
export function SubscribeAppUpdates(listener: (state: AppUpdateState) => void): () => void {
  return RequireUpdates().OnStateChange(value => {
    const parsed = AppUpdateStateSchema.safeParse(value);
    if (parsed.success) listener(parsed.data);
  });
}
