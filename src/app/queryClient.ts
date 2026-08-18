import { QueryClient } from '@tanstack/react-query';

/** 全局 QueryClient：后端事实源统一缓存，避免窗口聚焦等非必要刷新。 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
