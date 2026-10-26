export const deleteUserMessages = {
  'zh-CN': {
    usage: '用法：pnpm user:delete <邮箱> [--dry-run]\n删除不可撤销。运行前先停止 API 和后台任务。--dry-run 仅预览，不删除数据。',
    invalidArguments: '请提供一个合法邮箱，可选参数仅支持 --dry-run。',
    invalidAvatar: '头像路径不属于目标用户，已停止删除。',
    failed: '用户删除失败；已完成的步骤可能已生效。修复错误后可使用相同邮箱重试。',
    preview: '预览完成，未删除数据。',
    completed: '清理完成，可重新注册。全站发信额度保持不变。',
  },
  'en-US': {
    usage: 'Usage: pnpm user:delete <email> [--dry-run]\nDeletion is irreversible. Stop the API and background workers first. --dry-run previews without deleting data.',
    invalidArguments: 'Provide one valid email. The only optional flag is --dry-run.',
    invalidAvatar: 'The avatar path does not belong to the target user. Deletion stopped.',
    failed: 'User deletion failed; completed steps may already have taken effect. Fix the error and retry with the same email.',
    preview: 'Preview completed. No data was deleted.',
    completed: 'Cleanup completed. Registration can be tested again. The global email quota is unchanged.',
  },
};
