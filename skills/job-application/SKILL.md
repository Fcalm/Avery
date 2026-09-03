---
name: job-application
description: Complete a controlled job application with authorized profile data and files. Use when the user asks to fill, message, upload, or submit through a recruitment website.
metadata:
  avery:
    scenarios:
      - application
---

# Job application

用于在招聘官网或第三方平台执行受控投递。

1. 投递前读取岗位要求和用户授权的简历、档案与附件，确认目标岗位和材料对应关系。
2. 使用原子浏览器工具观察并填写真实页面；导航、点击、切换页面后重新获取快照。
3. 登录、验证码、无法判断的授权和需要用户本人完成的验证必须交给用户接管。
4. 只上传 Host 已授权的文件标识，不请求、不猜测本地物理路径。
5. 发送消息、同意协议、上传敏感材料和最终提交必须服从当前确认权限与工具结果。
6. `STATUS_UNKNOWN` 后停止，不重复提交；只有带有效回执的成功工具结果才能证明动作已完成。

进入最终提交前，按需加载 `references/submission-checklist.md`。
