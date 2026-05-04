export function getTheme(): 'dark' | 'light' {
  return (localStorage.getItem('ae_miner_theme') as 'dark' | 'light') || 'dark';
}

export function setTheme(theme: 'dark' | 'light') {
  localStorage.setItem('ae_miner_theme', theme);
  document.documentElement.classList.toggle('light', theme === 'light');
}

export function initTheme() {
  const theme = getTheme();
  document.documentElement.classList.toggle('light', theme === 'light');
}
