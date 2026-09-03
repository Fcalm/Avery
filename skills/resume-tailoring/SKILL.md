---
name: resume-tailoring
description: Tailor a resume to a target role using the user's confirmed experience. Use when the user asks to optimize, rewrite, or assess a resume against a job description.
metadata:
  avery:
    scenarios:
      - default
---

# Resume tailoring

用于根据目标岗位优化用户简历。先读取当前简历、档案和目标岗位要求，再确定需要调整的条目。

## 工作流程

1. 区分用户确认的事实、合理表达优化和缺失的硬事实。
2. 优先调整与目标岗位直接相关的经历、技能顺序和措辞，不凭空增加公司、证书、学校或任职经历。
3. 只有检测到需要补充公司或证书等硬事实时，才允许在合理范围生成候选文本，并在对应条目末尾添加【待确认】。
4. 在正式写入包含【待确认】的内容前，使用文本列出待确认项，请用户确认或修改。
5. 用户明确要求保存后，再调用场景允许的简历写工具；工具回执是保存成功的唯一证据。

需要最终复核时，按需加载 `references/review-checklist.md`。
