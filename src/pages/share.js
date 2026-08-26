import { CSS_STYLES } from './styles.js';
import { THEME_BOOTSTRAP, THEME_TOGGLE_BUTTON } from './theme.js';

const FIXED_SHARE_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>文件分享 - EdgeStashPro</title>
  ${THEME_BOOTSTRAP}
  ${CSS_STYLES}
</head>
<body>
  <div class="theme-toggle-floating">${THEME_TOGGLE_BUTTON}</div>
  <div class="share-container">
    <div class="share-card">
      <div id="loadingState">
        <div class="spinner" style="margin: 0 auto 20px;"></div>
        <div>加载中...</div>
      </div>

      <div id="expiredState" style="display: none;">
        <div class="share-expired">分享链接已过期或不存在</div>
        <p style="color: var(--text-muted); margin-top: 16px;">请联系分享者获取新的链接</p>
      </div>

      <div id="shareContent" style="display: none;">
        <div class="share-header">
          <div class="share-title">
            <div class="share-icon">📁</div>
            <div class="share-filename" id="fileName"></div>
            <div class="share-filesize" id="fileSize"></div>
          </div>
        </div>
        <div id="shareStateNotice" class="share-state-notice" hidden></div>
        <div id="passwordForm" style="display: none;">
          <div class="form-group">
            <label class="form-label" for="sharePassword">请输入分享密码</label>
            <input type="password" id="sharePassword" class="form-input" placeholder="输入密码" onkeydown="handlePasswordKey(event)">
          </div>
          <button type="button" class="btn btn-primary" style="width: 100%;" onclick="unlockShare()">进入分享</button>
        </div>
        <div class="share-browser" id="shareBrowser">
          <div class="breadcrumb" id="shareBreadcrumb"></div>
          <div id="shareFileList" class="file-grid"></div>
          <div id="shareEmptyState" class="empty-state" style="display: none;">
            <div class="empty-icon">📂</div>
            <div>此文件夹为空</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>

  <script>
    let shareId = '';
    let requiresPassword = false;
    let sharePassword = '';
    let currentPath = '/';

    async function loadShareInfo() {
      const parts = window.location.pathname.split('/').filter(Boolean);
      shareId = parts[1] || '';
      if (!shareId) {
        showExpired();
        return;
      }

      try {
        const response = await fetch('/api/share/' + encodeURIComponent(shareId));
        const data = await response.json();
        if (!data.success) {
          showExpired();
          return;
        }
        document.getElementById('loadingState').style.display = 'none';
        document.getElementById('shareContent').style.display = 'block';
        document.getElementById('fileName').textContent = data.fileName;
        document.getElementById('fileSize').textContent = data.itemCount > 1 ? data.itemCount + ' 个项目' : data.fileSizeFormatted;
        updateShareStateNotice(data.state);
        requiresPassword = !!data.requiresPassword;
        document.getElementById('passwordForm').style.display = requiresPassword ? 'block' : 'none';
        if (!requiresPassword) {
          await loadShareDirectory('/');
        }
      } catch {
        showExpired();
      }
    }

    function showExpired() {
      document.getElementById('loadingState').style.display = 'none';
      document.getElementById('expiredState').style.display = 'block';
    }

    function updateShareStateNotice(state) {
      const notice = document.getElementById('shareStateNotice');
      if (!notice) return;
      notice.hidden = state !== 'partial';
      notice.textContent = state === 'partial' ? '部分分享项目已失效，当前仅显示仍然存在的项目。' : '';
    }

    function handlePasswordKey(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        unlockShare();
      }
    }

    async function unlockShare() {
      sharePassword = document.getElementById('sharePassword') ? document.getElementById('sharePassword').value : '';
      if (requiresPassword && !sharePassword) {
        showToast('请输入分享密码', 'error');
        return;
      }

      await loadShareDirectory('/');
    }

    async function loadShareDirectory(path) {
      try {
        const response = await fetch('/api/share/' + encodeURIComponent(shareId) + '/list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: path || '/', password: sharePassword })
        });
        const data = await response.json();
        if (!data.success) {
          showToast(data.message || '加载失败', 'error');
          return;
        }

        currentPath = data.currentPath || path || '/';
        updateShareStateNotice(data.state);
        document.getElementById('passwordForm').style.display = 'none';
        document.getElementById('shareBrowser').classList.add('active');
        renderBreadcrumb();
        renderFiles(data.folders || [], data.files || []);
      } catch (error) {
        showToast('加载失败: ' + error.message, 'error');
      }
    }

    function renderBreadcrumb() {
      const breadcrumb = document.getElementById('shareBreadcrumb');
      breadcrumb.replaceChildren();

      const root = document.createElement('a');
      root.href = '#';
      root.className = 'breadcrumb-item';
      root.textContent = '分享根目录';
      root.addEventListener('click', function (event) {
        event.preventDefault();
        loadShareDirectory('/');
      });
      breadcrumb.appendChild(root);

      let path = '';
      currentPath.split('/').filter(Boolean).forEach(function (part, index, parts) {
        const separator = document.createElement('span');
        separator.className = 'breadcrumb-separator';
        separator.textContent = '/';
        breadcrumb.appendChild(separator);

        path += '/' + part;
        if (index === parts.length - 1) {
          const active = document.createElement('span');
          active.className = 'breadcrumb-item active';
          active.textContent = part;
          breadcrumb.appendChild(active);
        } else {
          const link = document.createElement('a');
          link.href = '#';
          link.className = 'breadcrumb-item';
          link.textContent = part;
          const targetPath = path;
          link.addEventListener('click', function (event) {
            event.preventDefault();
            loadShareDirectory(targetPath);
          });
          breadcrumb.appendChild(link);
        }
      });
    }

    function renderFiles(folders, files) {
      const fileList = document.getElementById('shareFileList');
      const emptyState = document.getElementById('shareEmptyState');
      fileList.replaceChildren();

      if (folders.length === 0 && files.length === 0) {
        emptyState.style.display = 'block';
        return;
      }

      emptyState.style.display = 'none';
      folders.forEach(function (folder) {
        fileList.appendChild(createShareFileCard({
          name: folder.name,
          path: folder.path,
          isFolder: true,
          typeLabel: '📁',
          meta: '文件夹'
        }));
      });

      files.forEach(function (file) {
        fileList.appendChild(createShareFileCard({
          name: file.name,
          path: file.path,
          isFolder: false,
          typeLabel: getFileIcon(file.name),
          meta: file.sizeFormatted || ''
        }));
      });
    }

    function createShareFileCard(item) {
      const card = document.createElement('div');
      card.className = 'file-item';
      card.addEventListener('click', function () {
        if (item.isFolder) {
          loadShareDirectory(item.path);
        } else {
          downloadFile(item.path);
        }
      });

      const icon = document.createElement('div');
      icon.className = 'file-icon';
      icon.textContent = item.typeLabel;
      card.appendChild(icon);

      const name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = item.name;
      name.title = item.name;
      card.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'file-meta';
      meta.textContent = item.meta;
      card.appendChild(meta);
      return card;
    }

    function getFileIcon(filename) {
      const ext = filename.split('.').pop().toLowerCase();
      if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return '🖼️';
      if (ext === 'pdf') return '📕';
      if (['mp4', 'webm', 'ogg'].includes(ext)) return '🎬';
      if (['mp3', 'wav', 'flac', 'm4a'].includes(ext)) return '🎵';
      if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
      if (['doc', 'docx'].includes(ext)) return '📝';
      if (['xls', 'xlsx'].includes(ext)) return '📊';
      return '📄';
    }

    async function downloadFile(path) {
      if (requiresPassword && !sharePassword) {
        showToast('请输入分享密码', 'error');
        return;
      }

      try {
        const response = await fetch('/api/share/' + encodeURIComponent(shareId) + '/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: path, password: sharePassword })
        });
        if (!response.ok) {
          const data = await response.json();
          showToast(data.message || '下载失败', 'error');
          return;
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = getFilenameFromDisposition(response.headers.get('Content-Disposition'));
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('下载开始', 'success');
      } catch (error) {
        showToast('下载失败: ' + error.message, 'error');
      }
    }

    function getFilenameFromDisposition(header) {
      if (!header) return 'download';
      const utf8Match = header.match(/filename\\*=UTF-8''([^;\\n]+)/i);
      if (utf8Match) {
        try {
          return decodeURIComponent(utf8Match[1]);
        } catch {
          return utf8Match[1];
        }
      }
      const fallbackMatch = header.match(/filename=["']?([^"';\\n]+)/i);
      return fallbackMatch ? fallbackMatch[1] : 'download';
    }

    function showToast(message, type) {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + (type || 'info');
      toast.textContent = message;
      container.appendChild(toast);
      window.setTimeout(function () {
        toast.remove();
      }, 3000);
    }

    loadShareInfo();
  </script>
</body>
</html>
`;
export { FIXED_SHARE_PAGE };
