/** 串行写入设置；一次写入失败不阻塞之后的重试，完成操作等待此前的草稿写入落盘。 */
export function CreateSettingsWriter<T>(write: (value: T) => Promise<unknown>) {
  let pending: Promise<unknown> = Promise.resolve();
  return (value: T): Promise<void> => {
    const next = pending.catch(() => undefined).then(() => write(value)).then(() => undefined);
    pending = next;
    return next;
  };
}
