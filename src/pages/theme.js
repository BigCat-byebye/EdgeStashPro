const THEME_BOOTSTRAP = `
  <script>
    (function () {
      const key = 'edgestash:theme:v1';
      let saved = null;
      try { saved = localStorage.getItem(key); } catch {}
      const preferred = saved === 'light' || saved === 'dark'
        ? saved
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      document.documentElement.dataset.theme = preferred;

      window.toggleTheme = function () {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem(key, next); } catch {}
        updateThemeButtons();
      };

      function updateThemeButtons() {
        const dark = document.documentElement.dataset.theme === 'dark';
        document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
          button.textContent = dark ? '☀️' : '🌙';
          button.title = dark ? '切换到日间模式' : '切换到夜间模式';
          button.setAttribute('aria-label', button.title);
        });
      }

      document.addEventListener('DOMContentLoaded', updateThemeButtons);
    })();
  </script>`;
const THEME_TOGGLE_BUTTON = `<button type="button" class="btn btn-secondary theme-toggle" data-theme-toggle onclick="toggleTheme()" aria-label="切换颜色主题"></button>`;
export { THEME_BOOTSTRAP, THEME_TOGGLE_BUTTON };
