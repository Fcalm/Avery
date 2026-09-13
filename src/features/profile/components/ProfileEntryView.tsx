import { useMemo } from 'react';
import { BuildProfilePlainText, ParseProfileSections } from '../profileView';
import type { ProfileItem } from '../../../types/domain';

/**
 * 档案条目的只读视图：正文按「[小节] + 字段：值」解析成原型的 kv 分节卡。
 * 侧栏（档案类型）与档案抽屉的阅读态共用；输入框只在编辑态出现，这里永不渲染表单。
 */
function ProfileEntryView({ item }: { item: ProfileItem }) {
  const sections = useMemo(() => ParseProfileSections(item.content), [item.content]);
  if (!sections.length) return <p className="profile-entry-none">这条档案还没有内容，点「编辑」补充字段。</p>;
  return <div className="profile-entry" aria-label={item.title}>
    {sections.map((section, sectionIndex) => <section className="sec" key={`${section.title}-${sectionIndex}`}>
      {section.title && <div className="sec-h">{section.title}</div>}
      <div className="kv">
        {section.fields.map((field, fieldIndex) => <div className="kv-r" key={`${field.label}-${fieldIndex}`}>
          <span>{field.label}</span>
          <b>{field.value || <em className="kv-none">未填写</em>}</b>
        </div>)}
      </div>
    </section>)}
  </div>;
}

/** 复制动作与视图共用同一份解析结果，保证复制内容与展示内容一致。 */
function GetProfileCopyText(item: ProfileItem): string {
  return BuildProfilePlainText(ParseProfileSections(item.content));
}

export { ProfileEntryView, GetProfileCopyText };
