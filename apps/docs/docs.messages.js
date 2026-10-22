const messages = {
  'zh-CN': {
    title: 'Popular · 架构文档',
    heading: '架构与调用链',
    description: '浏览项目架构、API 调用链及交互图表。',
    projects: '文档项目',
    empty: '暂无文档项目。请在 .archify 的项目目录中添加 index.html 后重新构建。',
    language: '语言',
  },
  'en-US': {
    title: 'Popular · Architecture docs',
    heading: 'Architecture & call chains',
    description: 'Explore project architecture, API call chains and interactive diagrams.',
    projects: 'Documentation projects',
    empty: 'No documentation projects yet. Add index.html to a project directory in .archify, then rebuild.',
    language: 'Language',
  },
};
const select = document.querySelector('select');
const initial = new URLSearchParams(location.search).get('lang');
select.value = Object.hasOwn(messages, initial) ? initial : navigator.language.startsWith('zh') ? 'zh-CN' : 'en-US';
function render() {
  const locale = select.value;
  document.documentElement.lang = locale;
  document.title = messages[locale].title;
  for (const node of document.querySelectorAll('[data-message]')) node.textContent = messages[locale][node.dataset.message];
  select.setAttribute('aria-label', messages[locale].language);
  document.querySelector('[data-message="empty"]').hidden = Boolean(document.querySelector('.project'));
}
select.addEventListener('change', () => {
  const url = new URL(location.href);
  url.searchParams.set('lang', select.value);
  history.replaceState(null, '', url);
  render();
});
render();
