import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { ResumeDocumentInput } from '@avery/contracts';
import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import { Icon } from '../../../shared/components/Icon';
import '../../../styles/resume-pdf.css';

interface PreviewState { key: string; document?: PDFDocumentProxy; error?: string }

/** 三处预览共用同一个 PDF 管线；内容变化立即隐藏旧页，延迟请求并忽略迟到结果。 */
export function ResumePdfPreview({ resume }: { resume: ResumeDocumentInput }) {
  const key = useMemo(() => JSON.stringify({ name: resume.name, summary: resume.summary, content: resume.content, data: resume.data, templateId: resume.templateId }), [resume.name, resume.summary, resume.content, resume.data, resume.templateId]);
  const [state, SetState] = useState<PreviewState>({ key: '' });
  const [retry, SetRetry] = useState(0);
  const [zoom, SetZoom] = useState<number | 'fit'>('fit');
  const viewportRef = useRef<HTMLDivElement>(null);
  function ChangeZoom(direction: 1 | -1) {
    const current = zoom === 'fit' ? Math.min(1, ((viewportRef.current?.clientWidth ?? 818) - 24) / 794) : zoom;
    const stops = [.25, .5, .75, 1, 1.25, 1.5, 2];
    SetZoom(direction === 1 ? stops.find((value) => value > current + .01) ?? 2 : [...stops].reverse().find((value) => value < current - .01) ?? .25);
  }
  useEffect(() => {
    let disposed = false;
    let loaded: ReturnType<typeof import('../pdfRuntime')['LoadResumePdf']> | undefined;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const [{ base64 }, runtime] = await Promise.all([
            Unwrap(platformClient.workspace.PreviewResumePdf(JSON.parse(key) as ResumeDocumentInput)), import('../pdfRuntime'),
          ]);
          if (disposed) return;
          loaded = runtime.LoadResumePdf(base64);
          const document = await loaded.task.promise;
          if (!disposed) SetState({ key, document });
        } catch (error) {
          if (!disposed) SetState({ key, error: error instanceof Error ? error.message : 'PDF 预览生成失败' });
        }
      })();
    }, 500);
    return () => { disposed = true; window.clearTimeout(timer); void loaded?.Destroy().catch(() => undefined); };
  }, [key, retry]);
  const current = state.key === key ? state : undefined;
  const document = current?.document;
  return <section className="resume-pdf-preview" aria-label="简历 PDF 预览">
    <div className="resume-pdf-toolbar"><span>PDF 预览</span>{document && <div className="resume-pdf-zoom"><button className="icon-btn" type="button" aria-label="缩小 PDF" disabled={zoom === .25} onClick={() => ChangeZoom(-1)}><Icon name="window-minimize" size={12} /></button><button className="resume-pdf-fit" type="button" title="适应宽度" onClick={() => SetZoom('fit')}>{zoom === 'fit' ? '适宽' : `${Math.round(zoom * 100)}%`}</button><button className="icon-btn" type="button" aria-label="放大 PDF" disabled={zoom === 2} onClick={() => ChangeZoom(1)}><Icon name="plus" size={12} /></button></div>}<span className="resume-pdf-count" role="status">{document ? `共 ${document.numPages} 页` : current?.error ? '生成失败' : '正在生成…'}</span></div>
    {current?.error ? <div className="resume-pdf-status"><p role="alert">{current.error}</p><button className="ghost-btn" type="button" onClick={() => { SetState({ key: '' }); SetRetry((value) => value + 1); }}><Icon name="refresh" size={14} />重新生成</button></div>
      : !document ? <div className="resume-pdf-status" role="status"><Icon name="loading" className="spin" size={18} />正在生成 PDF 预览</div>
        : <div className="resume-pdf-viewport" ref={viewportRef} style={{ '--pdf-page-width': zoom === 'fit' ? '100%' : `${794 * zoom}px`, '--pdf-page-max-width': zoom === 'fit' ? '794px' : 'none' } as import('react').CSSProperties} tabIndex={0} aria-label={`简历 PDF，共 ${document.numPages} 页`}>{Array.from({ length: document.numPages }, (_, i) => <PdfPage key={`${document.fingerprints[0]}-${i}`} document={document} number={i + 1} />)}</div>}
  </section>;
}

/** 仅绘制接近可视区的页面，分辨率随容器与显示缩放更新；卸载时取消旧画布任务。 */
function PdfPage({ document, number }: { document: PDFDocumentProxy; number: number }) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, SetWidth] = useState(0);
  const [visible, SetVisible] = useState(false);
  const [error, SetError] = useState('');
  const [links, SetLinks] = useState<Array<{ href: string; left: number; top: number; width: number; height: number }>>([]);
  useEffect(() => {
    const element = root.current; if (!element) return;
    const resize = new ResizeObserver(() => SetWidth(Math.floor(element.clientWidth)));
    const intersection = new IntersectionObserver(([entry]) => SetVisible(entry.isIntersecting), { root: element.closest('.resume-pdf-viewport'), rootMargin: '160px' });
    SetWidth(Math.floor(element.clientWidth)); resize.observe(element); intersection.observe(element);
    return () => { resize.disconnect(); intersection.disconnect(); };
  }, []);
  useEffect(() => {
    if (!canvas.current) return;
    if (!visible || !width) { canvas.current.width = 0; canvas.current.height = 0; SetLinks([]); return; }
    let disposed = false;
    let render: RenderTask | undefined;
    const element = canvas.current;
    SetError('');
    SetLinks([]);
    void (async () => {
      try {
        const page = await document.getPage(number); if (disposed) return;
        const base = page.getViewport({ scale: 1 });
        const scale = width / base.width;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale });
        element.width = Math.ceil(viewport.width * ratio); element.height = Math.ceil(viewport.height * ratio);
        render = page.render({ canvas: element, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
        await render.promise; if (disposed) return;
        const annotations = await page.getAnnotations(); if (disposed) return;
        SetLinks(annotations.flatMap((annotation) => {
          if (annotation.subtype !== 'Link' || typeof annotation.url !== 'string' || !/^https?:\/\//i.test(annotation.url) || !Array.isArray(annotation.rect)) return [];
          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect);
          return [{ href: annotation.url, left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x1 - x2), height: Math.abs(y1 - y2) }];
        }));
      } catch (cause) { if (!disposed) SetError(cause instanceof Error ? cause.message : '页面渲染失败'); }
    })();
    return () => { disposed = true; render?.cancel(); };
  }, [document, number, visible, width]);
  return <figure className="resume-pdf-page"><div className="resume-pdf-sheet" ref={root}>
    <canvas ref={canvas} role="img" aria-label={`简历第 ${number} 页`} />
    {links.map((link, index) => <a key={index} className="resume-pdf-link" href={link.href} target="_blank" rel="noreferrer" aria-label={link.href} title={link.href} style={{ left: link.left, top: link.top, width: link.width, height: link.height }} />)}
    {error && <p className="resume-pdf-page-error" role="alert">{error}</p>}
  </div><figcaption>第 {number} / {document.numPages} 页</figcaption></figure>;
}
