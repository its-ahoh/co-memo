// Apply before styles load to avoid flashing the wrong theme on reload.
try {
  const theme = localStorage.getItem('co-memo-theme');
  if (['light', 'dark', 'system'].includes(theme)) document.documentElement.dataset.theme = theme;
} catch {
  // System preference remains available when browser storage is disabled.
}
