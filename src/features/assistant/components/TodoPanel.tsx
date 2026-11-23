import type { AgentStreamEvent } from '@avery/contracts';
import { Icon } from '../../../shared/components/Icon';

type Todo = NonNullable<AgentStreamEvent['task']>;

function GetTodoPresentation(status: Todo['status']) {
  if (status === 'cancelled' || status === 'deleted') return { className: 'is-deleted', symbol: '×', label: '已删除' };
  if (status === 'completed' || status === 'done') return { className: 'is-completed', symbol: null, label: '已完成' };
  if (status === 'inProgress' || status === 'in_progress') return { className: 'is-in-progress', symbol: '●', label: '进行中' };
  return { className: 'is-pending', symbol: '○', label: '待办' };
}

export function TodoPanel({ todos }: { todos: readonly Todo[] }) {
  const items = todos.map(todo => ({ todo, ...GetTodoPresentation(todo.status) }));
  const current = items.find(item => item.className === 'is-in-progress')
    ?? items.find(item => item.className === 'is-pending')
    ?? items.at(-1);
  if (!current) return null;

  return <div className="task-dock todo-dock">
    <div className="task-summary todo-summary" role="group" aria-label="当前待办" tabIndex={0}>
      <Icon name="calendar-check" size={16} />
      <span className="task-summary-copy">{current.todo.title}</span>
    </div>
    <div className="task-card" role="region" aria-label="Todo 列表">
      <div className="task-card-heading">Todo · {items.length} 项</div>
      <div className="task-list" tabIndex={0} role="list" aria-label="任务">
        {items.map(({ todo, className, symbol, label }) => <div key={todo.id} className={`task-list-item ${className}`} role="listitem">
          <span className={`task-status-icon ${className}`} aria-hidden="true">
            {symbol ?? <Icon name="check-circle" size={16} />}
          </span>
          <span className="task-list-title">{todo.title}</span>
          <span className="task-list-status">{label}</span>
        </div>)}
      </div>
    </div>
  </div>;
}
