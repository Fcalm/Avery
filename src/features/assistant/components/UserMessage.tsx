import type { ChatMessageDto } from '@avery/contracts';
import { CjkTextIcon, Icon } from '../../../shared/components/Icon';
import { MarkdownText } from '../../../shared/components/MarkdownText';

/** 已发送的技能和附件仅展示消息自身快照，不读取当前输入框选择，也不把标签混入正文。 */
export function UserMessage({ message }: { message: ChatMessageDto }) {
  return <div className="user-message-bubble">
    {!!message.attachments?.length && <div className="user-message-attachments" aria-label="消息附件">
      {message.attachments.map((attachment, index) => <span className="user-message-attachment" key={`${attachment.path}:${index}`} title={attachment.name}>
        <Icon name="paperclip" size={12} /><span>{attachment.name}</span>
      </span>)}
    </div>}
    <MarkdownText content={message.content} leading={message.skill && <span className="user-message-skill" title={`技能：${message.skill.label}（/${message.skill.id}）`}>
      <CjkTextIcon name="codesandbox-logo" size={14} /><span>/{message.skill.id}</span>
    </span>} />
  </div>;
}
