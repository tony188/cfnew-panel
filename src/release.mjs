export const PANEL_VERSION = '2026.10.17.2';

export function coreRelease(config) {
  const coreVersion = typeof config.coreVersion === 'string' ? config.coreVersion : '';
  return {
    panelVersion: PANEL_VERSION,
    coreVersion,
    needsUpdate: coreVersion !== PANEL_VERSION,
    changes: [
      'Free CPU 保护保留在内核里，管理页不再提供开关；默认关闭。',
      '需要改限额时直接改 KV 或 Worker 变量，更新配套内核后生效。',
    ],
    workerUrl: 'https://raw.githubusercontent.com/tony188/cfnew-panel/main/worker/_worker.js',
    repoUrl: 'https://github.com/tony188/cfnew-panel/tree/main/worker',
  };
}
