/** 模型传输使用宿主网络栈；禁止共享登录 Cookie、缓存或跨地址重定向凭据。 */
export function CreateProviderFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    try {
      return await fetcher(input, { ...init, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    } catch (error) {
      // Chromium 网络错误常只有 net::ERR_* 文本；补稳定码供重试和脱敏 Trace 使用。
      const code = error instanceof Error ? /^net::(ERR_[A-Z0-9_]+)/.exec(error.message)?.[1] : undefined;
      if (!code) throw error;
      throw Object.assign(new Error('模型网络请求失败。', { cause: error }), { code });
    }
  };
}
