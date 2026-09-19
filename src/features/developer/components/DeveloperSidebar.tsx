import { useMemo, useRef, useState, type RefObject } from 'react';
import { useDeveloperConsole, type DeveloperView } from './DeveloperConsoleContext';
import { BucketDotClass, BucketOf, RunBuckets, RunStatusText } from './evaluationDisplay';
import { Icon, type IconName } from '../../../shared/components/Icon';

/** 开发者侧栏的次级视图导航；"评估"项的数字与原型一致展示评测总数。 */
const DeveloperNavItems: Array<{ key: DeveloperView; label: string; icon: IconName; count?: boolean }> = [
  { key: 'eval', label: '评估', icon: 'flask', count: true },
  { key: 'compare', label: '对比', icon: 'scales' },
  { key: 'logs', label: '运行日志', icon: 'logs' },
];

/**
 * 开发者页专属侧栏：结构与工作区侧栏同构（新建入口 + 视图导航 + 记录列表），
 * 但内容换成评测域——"评测记录"行的分组、状态点与元信息读取评测的最新一次运行。
 * 用户卡与"返回工作区"由 AppShell 渲染（账户菜单状态属于壳层）。
 */
function DeveloperSidebar({ navRef, indicatorRef }: { navRef: RefObject<HTMLElement | null>; indicatorRef: RefObject<HTMLDivElement | null> }) {
  const { projects, runs, selectedProjectId, SelectProject, view, SetView, search, SetSearch, OpenCreate } = useDeveloperConsole();
  const [searchOpen, SetSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => {
      const latest = runs.find((run) => run.projectId === project.id);
      const label = `${project.name} ${RunStatusText(latest?.status ?? '')}`;
      return label.toLowerCase().includes(query);
    });
  }, [projects, runs, search]);

  const groupedProjects = useMemo(() => RunBuckets.map((bucket) => ({
    ...bucket,
    items: filteredProjects.filter((project) => {
      const latest = runs.find((run) => run.projectId === project.id);
      return BucketOf(latest) === bucket.key;
    }),
  })).filter((bucket) => bucket.items.length), [filteredProjects, runs]);

  function ToggleSearch() {
    SetSearchOpen((open) => {
      if (!open) window.setTimeout(() => searchInputRef.current?.focus(), 120);
      else SetSearch('');
      return !open;
    });
  }

  return <>
    <button className="sb-new-chat" type="button" onClick={OpenCreate} title="新建评测">
      <Icon name="plus" size={15} />
      <span>新建评测</span>
      <span className="kbd">Ctrl K</span>
    </button>

    {/* 视图导航与工作区导航共用 nav/nav-ind 结构，滑动指示器由 AppShell 统一测量 */}
    <nav className="nav" ref={navRef} aria-label="开发者工具">
      <div className="nav-ind" ref={indicatorRef} aria-hidden="true" />
      {DeveloperNavItems.map((item) => <button key={item.key} type="button" className={`nav-item ${view === item.key ? 'is-active' : ''}`} aria-current={view === item.key ? 'page' : undefined} title={item.label} onClick={() => SetView(item.key)}>
        <Icon name={item.icon} size={17} />
        <span>{item.label}</span>
        {item.count && projects.length > 0 && <span className="count">{projects.length}</span>}
      </button>)}
    </nav>

    <div className="sb-scroll">
      <div className="sb-sec" aria-label="评测记录">
        <div className="sb-sec-h">
          <span>评测记录</span>
          <div className={`sb-search ${searchOpen ? 'open' : ''}`}>
            <input ref={searchInputRef} type="search" value={search} placeholder="搜索评测记录" aria-label="搜索评测记录" autoComplete="off" tabIndex={searchOpen ? 0 : -1} onChange={(event) => SetSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { SetSearchOpen(false); SetSearch(''); } }} />
            <button className="sb-search-btn" type="button" aria-expanded={searchOpen} aria-label="搜索评测记录" title="搜索评测记录" onClick={ToggleSearch}><Icon name="search" size={13} /></button>
          </div>
        </div>
        <div className="ti-list">
          {groupedProjects.map((bucket) => <div key={bucket.key}>
            <div className="ti-group">{bucket.label}</div>
            {bucket.items.map((project) => {
              const latest = runs.find((run) => run.projectId === project.id);
              const score = latest?.summary?.averageScore;
              return <button key={project.id} type="button" className={`thread-item ${selectedProjectId === project.id ? 'active' : ''}`} title={project.name} onClick={() => SelectProject(project.id)}>
                <span className={`ev-dot ${BucketDotClass[BucketOf(latest)]}`} aria-hidden="true" />
                <span className="ti-body">
                  <span className="ti-title">{project.name}</span>
                  <span className="ti-meta">{RunStatusText(latest?.status ?? '')} · {score == null ? '暂无得分' : `${score.toFixed(1)} 分`} · {project.datasetCaseCount} 题</span>
                </span>
              </button>;
            })}
          </div>)}
          {!groupedProjects.length && <div className="ti-empty">{search.trim() ? '没有匹配的评测记录。' : '还没有评测。'}</div>}
        </div>
      </div>
    </div>
  </>;
}

export { DeveloperSidebar };
