import { useCallback, useRef, useState, type SetStateAction } from 'react';

/** 值与异步 setter 都绑定会话；切换后旧回调只能修改原会话，不能清空当前会话的确认框。 */
export function useSessionValue<T>(sessionId: string | null, initialValue: T) {
  const initial = useRef(initialValue);
  const [values, setValues] = useState<Record<string, T>>({});
  const versions = useRef<Record<string, number>>({});
  const setForSession = useCallback((owner: string | null, update: SetStateAction<T>) => {
    const key = owner ?? '__draft__';
    versions.current[key] = (versions.current[key] ?? 0) + 1;
    setValues((current) => ({ ...current, [key]: typeof update === 'function'
      ? (update as (previous: T) => T)(current[key] ?? initial.current) : update }));
  }, []);
  const setValue = useCallback((update: SetStateAction<T>) => setForSession(sessionId, update), [sessionId, setForSession]);
  return [values[sessionId ?? '__draft__'] ?? initial.current, setValue, setForSession, versions] as const;
}
