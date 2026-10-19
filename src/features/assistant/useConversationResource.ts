import { useEffect, useState } from 'react';
import type { ConversationResource, ConversationResourceView } from '@avery/contracts';
import { ReadConversationResource } from './api/agentQueries';

export interface ConversationResourceSelection { sessionId: string; resource: ConversationResource }

/** 手动选择和消息定位的资料共用同一 Markdown 下载实现，文件名不包含路径字符。 */
export function DownloadMarkdown(content: string, title: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = title.replace(/[\\/:*?"<>|]/g, '_') + '.md';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 只负责产物读取与临时文件生命周期，展示统一由已有资料侧栏承担。 */
export function useConversationResource(selection: ConversationResourceSelection | null) {
  const [loaded, setLoaded] = useState<{ selection: ConversationResourceSelection; view: ConversationResourceView | null; error: string; fileUrl: string } | null>(null);
  const current = loaded?.selection === selection ? loaded : null;
  useEffect(() => {
    if (!selection) return;
    let active = true, url = '';
    void ReadConversationResource(selection.sessionId, selection.resource).then((view) => {
      if (!active) return;
      if (view.format === 'file') {
        const bytes = Uint8Array.from(atob(view.base64), (character) => character.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: view.mimeType }));
      }
      setLoaded({ selection, view, error: '', fileUrl: url });
    }).catch((error: unknown) => {
      if (active) setLoaded({ selection, view: null, error: error instanceof Error ? error.message : '产物读取失败', fileUrl: '' });
    });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [selection]);

  function Download() {
    const view = current?.view;
    if (!view) return;
    if (view.format !== 'file') {
      DownloadMarkdown(view.format === 'resume' ? view.document.content : view.content, view.resource.title);
      return;
    }
    const link = document.createElement('a');
    link.href = current.fileUrl;
    link.download = view.resource.fileName || view.resource.title.replace(/[\\/:*?"<>|]/g, '_');
    link.click();
  }

  return { view: current?.view ?? null, error: current?.error ?? '', fileUrl: current?.fileUrl ?? '', Download };
}
