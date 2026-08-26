import { CSS_STYLES } from './styles.js';
import { THEME_BOOTSTRAP, THEME_TOGGLE_BUTTON } from './theme.js';

const FIXED_INDEX_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EdgeStashPro - 云盘</title>
  ${THEME_BOOTSTRAP}
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
  ${CSS_STYLES}
</head>
<body>
  <div class="header">
    <div class="logo">EdgeStashPro</div>
    <div class="header-actions">
      <label class="storage-switcher" for="storageSelector">
        <span>存储</span>
        <select id="storageSelector" class="form-select" onchange="handleStorageChange()"></select>
      </label>
      ${THEME_TOGGLE_BUTTON}
      <button type="button" class="task-chip" id="taskChip" onclick="openTaskPanel()">
        <span class="task-chip-text" id="taskChipText"></span>
      </button>
      <button type="button" class="btn btn-secondary" onclick="refreshCurrentDirectory()">刷新</button>
      <button type="button" class="btn btn-secondary" onclick="window.location.href='/admin.html'">管理后台</button>
      <button type="button" class="btn btn-secondary" onclick="logout()">退出登录</button>
    </div>
  </div>

  <div class="container">
    <div class="breadcrumb" id="breadcrumb"></div>

    <div class="toolbar">
      <button type="button" class="btn btn-primary" onclick="showNewFolderModal()">📁 新建文件夹</button>
      <button type="button" class="btn btn-primary" onclick="setTaskOrigin(this);document.getElementById('fileInput').click()">📤 上传文件</button>
      <button type="button" class="btn btn-primary" onclick="setTaskOrigin(this);document.getElementById('folderInput').click()">📁 上传文件夹</button>
      <input type="file" id="fileInput" multiple style="display: none;" onchange="handleFileUpload(event)">
      <input type="file" id="folderInput" webkitdirectory directory multiple style="display: none;" onchange="handleFolderUpload(event)">
    </div>

    <div class="view-toolbar">
      <div class="view-controls">
        <div class="view-tabs">
          <button type="button" class="view-tab active" data-view="files" onclick="switchMainView('files')">文件</button>
          <button type="button" class="view-tab" data-view="favorites" onclick="switchMainView('favorites')">收藏</button>
          <button type="button" class="view-tab" data-view="recent" onclick="switchMainView('recent')">最近</button>
        </div>
        <div class="display-mode-toggle" role="group" aria-label="显示方式">
          <button type="button" class="display-mode-btn" data-display-mode="list" onclick="setDisplayMode('list')" aria-label="列表视图">列表</button>
          <button type="button" class="display-mode-btn" data-display-mode="grid" onclick="setDisplayMode('grid')" aria-label="网格视图">网格</button>
        </div>
      </div>
      <div class="search-tools">
        <input type="search" id="globalSearchInput" class="form-input" placeholder="搜索名称或路径" oninput="handleSearchInput()" onkeydown="handleSearchKey(event)">
        <select id="globalSearchType" class="form-select" onchange="handleSearchTypeChange()">
          <option value="all">全部</option>
          <option value="files">文件</option>
          <option value="folders">文件夹</option>
        </select>
        <div class="tag-filter" id="tagFilterWrap">
          <button type="button" id="tagFilterTrigger" class="form-select tag-filter-trigger" onclick="toggleTagFilterMenu(event)" title="按标签筛选" aria-haspopup="listbox" aria-expanded="false">
            <span id="tagFilterLabel">标签</span>
          </button>
          <div id="tagFilterMenu" class="tag-filter-menu" hidden>
            <div class="tag-filter-menu-head">
              <span>按标签筛选</span>
              <button type="button" class="tag-filter-clear" onclick="clearTagFilters()">清除</button>
            </div>
            <div id="tagFilterList" class="tag-filter-list"></div>
            <div id="tagFilterEmpty" class="tag-filter-empty" hidden>暂无标签</div>
          </div>
        </div>
      </div>
    </div>

    <div class="section-title" id="viewTitle">当前目录</div>
    <div id="storageSyncStatus" class="storage-sync-status" hidden role="status" aria-live="polite"></div>

    <div class="batch-toolbar" id="batchToolbar">
      <label class="batch-count">
        <input type="checkbox" id="selectAllCheckbox" onchange="toggleSelectAll(this.checked)">
        已选择 <span id="selectedCount">0</span> 项
      </label>
      <button type="button" class="btn btn-sm btn-secondary" onclick="setTaskOrigin(this);showBatchTargetModal('copy')">复制</button>
      <button type="button" class="btn btn-sm btn-secondary" onclick="setTaskOrigin(this);showBatchTargetModal('move')">移动</button>
      <button type="button" class="btn btn-sm btn-secondary" onclick="setTaskOrigin(this);batchDownload()">下载</button>
      <button type="button" class="btn btn-sm btn-secondary" onclick="batchShare()">分享</button>
      <button type="button" class="btn btn-sm btn-danger" onclick="batchDelete()">删除</button>
    </div>

    <div class="card">
      <div id="fileList" class="file-grid"></div>
      <div id="emptyState" class="empty-state" style="display: none;">
        <div class="empty-icon">📂</div>
        <div>此文件夹为空</div>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="newFolderModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">新建文件夹</div>
        <button type="button" class="modal-close" onclick="closeModal('newFolderModal')">&times;</button>
      </div>
      <form onsubmit="createFolder(event)">
        <div class="form-group">
          <label class="form-label" for="folderName">文件夹名称</label>
          <input type="text" id="folderName" class="form-input" placeholder="请输入文件夹名称" required>
        </div>
        <button type="submit" class="btn btn-primary" style="width: 100%;">创建</button>
      </form>
    </div>
  </div>

  <div class="modal-overlay" id="renameModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">重命名</div>
        <button type="button" class="modal-close" onclick="closeModal('renameModal')">&times;</button>
      </div>
      <form onsubmit="renameFile(event)">
        <div class="form-group">
          <label class="form-label" for="newFileName">新名称</label>
          <input type="text" id="newFileName" class="form-input" required>
        </div>
        <input type="hidden" id="renameFilePath">
        <button type="submit" class="btn btn-primary" style="width: 100%;">确认</button>
      </form>
    </div>
  </div>

  <div class="modal-overlay" id="shareModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">创建分享链接</div>
        <button type="button" class="modal-close" onclick="closeModal('shareModal')">&times;</button>
      </div>
      <form onsubmit="createShare(event)">
        <div class="form-group">
          <label class="form-label" for="sharePassword">分享密码（留空则无密码）</label>
          <input type="text" id="sharePassword" class="form-input" placeholder="可选">
        </div>
        <div class="form-group">
          <label class="form-label" for="shareExpiry">有效期</label>
          <select id="shareExpiry" class="form-select">
            <option value="1h">1小时</option>
            <option value="1d" selected>1天</option>
            <option value="1m">1个月</option>
            <option value="permanent">永久有效</option>
          </select>
        </div>
        <input type="hidden" id="shareFilePath">
        <input type="hidden" id="shareItems">
        <button type="submit" class="btn btn-primary" style="width: 100%;">创建分享链接</button>
      </form>
    </div>
  </div>

  <div class="modal-overlay" id="shareResultModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">分享链接已创建</div>
        <button type="button" class="modal-close" onclick="closeModal('shareResultModal')">&times;</button>
      </div>
      <div class="form-group">
        <label class="form-label" for="shareResultUrl">分享链接</label>
        <input type="text" id="shareResultUrl" class="form-input" readonly>
      </div>
      <div class="qr-panel">
        <canvas id="shareQrCanvas" width="180" height="180" aria-label="分享二维码"></canvas>
      </div>
      <button type="button" class="btn btn-primary" style="width: 100%;" onclick="copyShareLink()">复制链接</button>
    </div>
  </div>

  <div class="modal-overlay" id="batchTargetModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title" id="batchTargetTitle">批量操作</div>
        <button type="button" class="modal-close" onclick="closeModal('batchTargetModal')">&times;</button>
      </div>
      <form onsubmit="submitBatchTarget(event)">
        <div class="form-group">
          <label class="form-label" for="batchFolderSearch">搜索文件夹</label>
          <input type="text" id="batchFolderSearch" class="form-input" placeholder="输入文件夹名称或路径">
          <div class="folder-search-results" id="batchFolderSearchResults"></div>
        </div>
        <div class="form-group">
          <label class="form-label" for="batchDestinationPath">目标文件夹路径</label>
          <input type="text" id="batchDestinationPath" class="form-input" placeholder="/ 或 /文件夹/子文件夹" required>
        </div>
        <input type="hidden" id="batchOperation">
        <button type="submit" class="btn btn-primary" style="width: 100%;">确认</button>
      </form>
    </div>
  </div>

  <div class="modal-overlay" id="taskPanelModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">任务状态</div>
        <button type="button" class="modal-close" onclick="closeModal('taskPanelModal')">&times;</button>
      </div>
      <div class="task-panel-list" id="taskPanelList"></div>
    </div>
  </div>

  <div class="modal-overlay" id="tagModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">编辑标签</div>
        <button type="button" class="modal-close" onclick="closeModal('tagModal')">&times;</button>
      </div>
      <form onsubmit="saveTags(event)">
        <div class="form-group">
          <label class="form-label" id="tagItemName"></label>
          <div class="tag-list tag-editor-list" id="tagEditorList"></div>
          <input type="text" id="tagInput" class="form-input" maxlength="20" placeholder="输入标签后回车">
        </div>
        <input type="hidden" id="tagItemPath">
        <input type="hidden" id="tagItemType">
        <button type="submit" class="btn btn-primary" style="width: 100%;">保存</button>
      </form>
    </div>
  </div>

  <div class="preview-overlay" id="previewOverlay">
    <div class="preview-header">
      <div class="preview-filename" id="previewFilename"></div>
      <div class="preview-actions">
        <div class="reader-tools" id="readerTools">
          <button type="button" class="btn btn-secondary reader-tool-btn" onclick="adjustReaderFontSize(-2)" aria-label="缩小字体">A−</button>
          <span class="reader-font-size" id="readerFontSize">18</span>
          <button type="button" class="btn btn-secondary reader-tool-btn" onclick="adjustReaderFontSize(2)" aria-label="放大字体">A+</button>
          <button type="button" class="btn btn-secondary reader-tool-btn" id="bookmarkToggleBtn" onclick="toggleBookmarkPanel(event)" title="书签" aria-label="打开书签">🔖</button>
          <button type="button" class="btn btn-secondary reader-tool-btn" id="txtSearchToggleBtn" onclick="toggleTxtSearchPanel(event)" title="在本文件中搜索" aria-label="在本文件中搜索">🔎</button>
          <div class="bookmark-panel" id="bookmarkPanel" hidden onclick="event.stopPropagation()">
            <button type="button" class="btn btn-primary bookmark-add" onclick="addCurrentBookmark()">添加当前位置</button>
            <div id="bookmarkList"></div>
          </div>
          <div class="txt-search-panel" id="txtSearchPanel" hidden onclick="event.stopPropagation()">
            <div class="txt-search-header">
              <div>
                <div class="txt-search-title">正文搜索</div>
                <div class="txt-search-description">搜索当前小说，点击结果可直接定位</div>
              </div>
              <button type="button" class="txt-search-close" onclick="document.getElementById('txtSearchPanel').hidden = true" aria-label="关闭正文搜索">×</button>
            </div>
            <div class="txt-search-row">
              <input type="search" id="txtSearchInput" class="form-input" placeholder="区分大小写搜索本文件" autocomplete="off" oninput="scheduleTxtSearch()" onkeydown="handleTxtSearchKey(event)">
              <button type="button" class="btn btn-secondary" onclick="clearTxtSearch()">清除</button>
            </div>
            <div class="txt-search-status" id="txtSearchStatus"></div>
            <div class="txt-search-results" id="txtSearchResults"></div>
            <button type="button" class="btn btn-secondary txt-search-more" id="txtSearchMore" onclick="loadMoreTxtSearch()" hidden>下一页</button>
          </div>
        </div>
        <button type="button" class="btn btn-primary" id="previewDownloadBtn">下载</button>
        <button type="button" class="btn btn-secondary" onclick="closePreview()">关闭</button>
        <button type="button" class="preview-icon-btn preview-download" onclick="document.getElementById('previewDownloadBtn').click()">⬇</button>
        <button type="button" class="preview-icon-btn preview-close" onclick="closePreview()">✕</button>
      </div>
    </div>
    <div class="preview-content" id="previewContent"></div>
  </div>

  <div class="toast-container" id="toastContainer"></div>
  <div class="loading-overlay" id="loadingOverlay" style="display: none;"><div class="spinner"></div><div id="loadingMsg" style="color:#fff;margin-top:12px;font-size:14px;"></div></div>

  <script>
    let currentPath = '/';
    let currentView = 'files';
    let currentUserRole = null;
    let currentUserCacheScope = '';
    let currentStorageId = '';
    const DISPLAY_MODE_STORAGE_KEY = 'edgestash:file-display-mode:v1';
    let displayMode = localStorage.getItem(DISPLAY_MODE_STORAGE_KEY) === 'grid' ? 'grid' : 'list';
    let lastDirectoryItems = null;
    let lastRenderedItems = null;
    let lastRenderedEmptyMessage = '暂无项目';
    let availableStorages = [];
    let currentReader = null;
    let readerSaveTimer = null;
    let readerBookmarks = [];
    let txtSearchTimer = null;
    let txtSearchAbortController = null;
    const READER_FONT_SIZE_KEY = 'edgestash:reader-font-size:v1';
    const TXT_CACHE_DB_NAME = 'edgestash-txt-cache-v1';
    const TXT_CACHE_STORE_NAME = 'chunks';
    const TXT_CACHE_MAX_BOOK_CHUNKS = 12;
    const TXT_CACHE_MAX_TOTAL_CHUNKS = 96;
    let txtCacheDbPromise = null;
    const selectedItems = new Map();
    const favoritePaths = new Set();
    const directoryCache = new Map();
    let fileLoadAbortController = null;
    let storageSyncMonitorTimer = null;
    let storageSyncMonitorToken = 0;
    let currentSyncState = null;
    let fileLoadRequestId = 0;
    let folderSearchTimer = null;
    let folderSearchRequestId = 0;
    let globalSearchTimer = null;
    let globalSearchRequestId = 0;
    let globalSearchAbortController = null;
    let tagOptionsLoaded = false;
    let editingTagItem = null;
    let editingTags = [];
    const taskStore = new Map();
    const runningTaskLoops = new Set();
    const uploadQueue = [];
    const activeUploadXhrs = new Map();
    const canceledLocalTasks = new Set();
    const deletedLocalTasks = new Set();
    let activeUploadCount = 0;
    let taskPollTimer = null;
    let lastTaskOriginElement = null;
    let batchTaskOriginElement = null;
    const TASK_DONE_TOAST_KEY = 'edgestash:task-terminal-toasts:v1';
    const TASK_ACTION_ICONS = {
      stop: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>',
      delete: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>'
    };
    const ACTION_ICONS = {
      download: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
      share: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6l6.8-4.2"/><path d="M8.6 13.4l6.8 4.2"/></svg>',
      rename: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
      tag: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/></svg>',
      delete: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
      favorite: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2.8 5.7 6.3.9-4.5 4.4 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.5-4.4 6.3-.9Z"/></svg>',
      favoriteOn: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2.8 5.7 6.3.9-4.5 4.4 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.5-4.4 6.3-.9Z"/></svg>'
    };
    const nativeFetch = window.fetch.bind(window);

    function storageApiUrl(value) {
      if (!currentStorageId || typeof value !== 'string') return value;
      let url;
      try {
        url = new URL(value, window.location.origin);
      } catch {
        return value;
      }
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return value;
      if (url.pathname === '/api/storages' || url.pathname === '/api/auth/check'
        || url.pathname === '/api/login' || url.pathname === '/api/logout') return value;
      if (!url.searchParams.has('storageId')) url.searchParams.set('storageId', currentStorageId);
      return value.startsWith('http://') || value.startsWith('https://')
        ? url.toString()
        : url.pathname + url.search + url.hash;
    }

    window.fetch = function (input, init) {
      return nativeFetch(storageApiUrl(input), init);
    };

    function directoryCacheKey(path) {
      return currentStorageId + '\\n' + normalizeClientPath(path);
    }

    function activeStorageKey() {
      return 'edgestash:active-storage:' + currentUserCacheScope;
    }

    function encodePathForUrl(path) {
      if (!path || path === '/') return '/';
      return path.split('/').map(function (part, index) {
        if (index === 0 && part === '') return '';
        return encodeURIComponent(part);
      }).join('/');
    }

    function apiFileUrl(prefix, path) {
      return storageApiUrl(prefix + encodePathForUrl(path));
    }

    function normalizeClientPath(path) {
      const parts = String(path || '').split('/').filter(Boolean);
      return parts.length ? '/' + parts.join('/') : '/';
    }
    function setStorageSyncStatus(sync, fallbackStatus) {
      currentSyncState = sync || (fallbackStatus ? { status: fallbackStatus } : null);
      const element = document.getElementById('storageSyncStatus');
      if (!element) return;
      const status = currentSyncState?.status || '';
      if (status === 'queued' || status === 'running' || status === 'never') {
        element.hidden = false;
        element.classList.toggle('is-error', false);
        element.textContent = status === 'queued'
          ? '正在等待同步存储结构…'
          : '正在同步存储结构到 D1…';
        return;
      }
      if (status === 'failed') {
        element.hidden = false;
        element.classList.toggle('is-error', true);
        element.textContent = '存储结构同步失败：' + String(sync?.errorMessage || '请点击刷新重试');
        return;
      }
      element.hidden = true;
      element.classList.remove('is-error');
      element.textContent = '';
    }

    function stopStorageSyncMonitor() {
      storageSyncMonitorToken += 1;
      if (storageSyncMonitorTimer) {
        window.clearTimeout(storageSyncMonitorTimer);
        storageSyncMonitorTimer = null;
      }
    }

    function monitorStorageSync(path) {
      stopStorageSyncMonitor();
      const monitorToken = storageSyncMonitorToken;
      const monitoredPath = normalizeClientPath(path || currentPath);
      const monitoredStorageId = currentStorageId;
      setStorageSyncStatus({ status: 'queued' });

      async function poll() {
        if (monitorToken !== storageSyncMonitorToken
          || monitoredStorageId !== currentStorageId) return;
        try {
          const response = await fetch('/api/sync/status', { cache: 'no-store' });
          const data = await response.json().catch(function () { return {}; });
          if (!response.ok || !data.success) throw new Error(data.message || '读取同步状态失败');
          const sync = data.sync;
          setStorageSyncStatus(sync);
          if (!sync || ['queued', 'running'].includes(sync.status)) {
            storageSyncMonitorTimer = window.setTimeout(poll, 2000);
            return;
          }
          if (sync.status === 'failed') {
            showToast(sync.errorMessage || '存储结构同步失败', 'error');
            return;
          }
          if (sync.status === 'succeeded' && normalizeClientPath(currentPath) === monitoredPath) {
            directoryCache.delete(directoryCacheKey(monitoredPath));
            await loadFavoritePaths();
            await loadFiles({ background: true });
            showToast('存储结构已同步', 'success');
          }
        } catch (error) {
          if (monitorToken !== storageSyncMonitorToken) return;
          storageSyncMonitorTimer = window.setTimeout(poll, 5000);
        }
      }

      storageSyncMonitorTimer = window.setTimeout(poll, 500);
    }


    function parentClientPath(path) {
      const normalized = normalizeClientPath(path);
      if (normalized === '/') return '/';
      const index = normalized.lastIndexOf('/');
      return index <= 0 ? '/' : normalized.slice(0, index);
    }

    function setTaskOrigin(element) {
      if (element && element.getBoundingClientRect) {
        lastTaskOriginElement = element;
      }
    }

    function getDoneTaskToastSet() {
      try {
        return new Set(JSON.parse(localStorage.getItem(TASK_DONE_TOAST_KEY) || '[]'));
      } catch {
        return new Set();
      }
    }

    function saveDoneTaskToastSet(set) {
      try {
        localStorage.setItem(TASK_DONE_TOAST_KEY, JSON.stringify(Array.from(set).slice(-200)));
      } catch (error) {
        console.warn('Task toast state save failed:', error);
      }
    }

    function mergeTask(task, options) {
      if (!task || !task.id) return;
      if (deletedLocalTasks.has(task.id)) return;
      const previous = taskStore.get(task.id);
      if (previous && (previous.updatedAt || 0) > (task.updatedAt || 0)) return;
      taskStore.set(task.id, task);
      maybeNotifyTaskTerminal(task, previous, options && options.forceToast);
      updateTaskUi();
      if (task.status === 'queued' || task.status === 'running') {
        kickTaskMonitor();
      }
      if ((task.type === 'copy' || task.type === 'move' || task.type === 'delete') && (task.status === 'queued' || task.status === 'running')) {
        runCopyMoveTaskLoop(task.id);
      }
    }

    function maybeNotifyTaskTerminal(task, previous, forceToast) {
      if (!['succeeded', 'failed', 'canceled'].includes(task.status)) return;
      const key = task.id + ':' + task.status;
      const shown = getDoneTaskToastSet();
      const becameTerminal = forceToast || (previous && previous.status !== task.status);
      if (!becameTerminal || shown.has(key)) return;
      shown.add(key);
      saveDoneTaskToastSet(shown);
      const verb = task.type === 'upload' ? '上传' : task.type === 'download' || task.type === 'batch_download' ? '下载' : task.type === 'move' ? '移动' : task.type === 'delete' ? '删除' : '复制';
      if (task.status === 'succeeded') {
        showToast(verb + (task.result && task.result.nativeDownload ? '已开始: ' : '完成: ') + task.title, 'success');
      } else if (task.status === 'failed') {
        showToast(verb + '失败: ' + (task.errorMessage || task.title), 'error');
      }
    }

    async function createTask(payload, originElement) {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.message || '创建任务失败');
      mergeTask(data.task);
      animateTaskCreated(originElement || lastTaskOriginElement || document.activeElement);
      return data.task;
    }

    function animateTaskCreated(originElement) {
      const chip = document.getElementById('taskChip');
      if (!chip || !originElement || !originElement.getBoundingClientRect) return;
      const from = originElement.getBoundingClientRect();
      const to = chip.getBoundingClientRect();
      if (!from.width || !from.height || !to.width || !to.height) return;

      const fly = document.createElement('div');
      fly.className = 'task-fly-icon';
      fly.textContent = '+';
      fly.style.left = (from.left + from.width / 2 - 15) + 'px';
      fly.style.top = (from.top + from.height / 2 - 15) + 'px';
      document.body.appendChild(fly);
      if (!fly.animate) {
        window.setTimeout(function () { fly.remove(); }, 300);
        return;
      }

      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      fly.animate([
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(0.25)', opacity: 0 }
      ], {
        duration: 520,
        easing: 'cubic-bezier(.2,.8,.2,1)'
      }).addEventListener('finish', function () {
        fly.remove();
      });
    }

    async function patchTaskProgress(taskId, payload, forceToast) {
      const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/progress', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.message || '更新任务失败');
      mergeTask(data.task, { forceToast: forceToast });
      return data.task;
    }

    async function loadTasks(activeOnly) {
      try {
        const response = await fetch('/api/tasks?limit=50' + (activeOnly ? '&active=1' : ''));
        const data = await response.json();
        if (!data.success) return;
        (data.tasks || []).forEach(function (task) {
          mergeTask(task);
        });
        updateTaskUi();
      } catch (error) {
        console.warn('Task load failed:', error);
      }
    }

    async function cancelTask(taskId) {
      abortLocalTask(taskId);
      try {
        const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/cancel', { method: 'POST' });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '停止失败');
        mergeTask(data.task, { forceToast: true });
        showToast('任务已停止', 'info');
      } catch (error) {
        showToast('停止任务失败: ' + error.message, 'error');
      }
    }

    async function deleteTask(taskId) {
      abortLocalTask(taskId);
      try {
        const response = await fetch('/api/tasks/' + encodeURIComponent(taskId), { method: 'DELETE' });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '删除失败');
        deletedLocalTasks.add(taskId);
        taskStore.delete(taskId);
        updateTaskUi();
        showToast('任务已删除', 'success');
      } catch (error) {
        showToast('删除任务失败: ' + error.message, 'error');
      }
    }

    function abortLocalTask(taskId) {
      canceledLocalTasks.add(taskId);
      const xhr = activeUploadXhrs.get(taskId);
      if (xhr) {
        xhr.abort();
        activeUploadXhrs.delete(taskId);
      }
    }

    function hasActiveTaskInStore() {
      for (const task of taskStore.values()) {
        if (task.status === 'queued' || task.status === 'running') return true;
      }
      return false;
    }

    let taskPollDelay = 5000;

    function startTaskMonitor() {
      if (taskPollTimer) {
        clearTimeout(taskPollTimer);
        taskPollTimer = null;
      }
      const poll = async function () {
        await loadTasks(false);
        // Poll fast while something is running; back off to 30s when idle so an
        // idle tab stops hammering the tasks endpoint every 5 seconds.
        taskPollDelay = hasActiveTaskInStore() ? 5000 : 30000;
        taskPollTimer = window.setTimeout(poll, taskPollDelay);
      };
      poll();
    }

    // Called when a new active task appears so we switch back to fast polling
    // without waiting out a long idle back-off.
    function kickTaskMonitor() {
      if (taskPollDelay <= 5000) return;
      startTaskMonitor();
    }

    function taskProgressPercent(task) {
      if (task.totalBytes > 0) return Math.max(0, Math.min(100, Math.round((task.processedBytes / task.totalBytes) * 100)));
      if (task.totalItems > 0) return Math.max(0, Math.min(100, Math.round((task.processedItems / task.totalItems) * 100)));
      return task.status === 'succeeded' ? 100 : 0;
    }

    function estimateRemaining(task) {
      if (!task.totalBytes || !task.processedBytes || !task.createdAt) return '';
      const elapsed = Math.max(1, Date.now() - task.createdAt);
      const speed = task.processedBytes / elapsed;
      if (!speed) return '';
      const remainingMs = (task.totalBytes - task.processedBytes) / speed;
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '';
      return ' · 剩余 ' + formatDuration(remainingMs);
    }

    function formatDuration(ms) {
      const seconds = Math.max(1, Math.round(ms / 1000));
      if (seconds < 60) return seconds + '秒';
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return minutes + '分钟';
      return Math.round(minutes / 60) + '小时';
    }

    function taskTypeLabel(type) {
      return { upload: '上传', download: '下载', batch_download: '批量下载', copy: '复制', move: '移动', delete: '删除' }[type] || '任务';
    }

    function taskStatusLabel(task) {
      if ((task.type === 'download' || task.type === 'batch_download') && task.result && task.result.nativeDownload) return '已开始';
      if (task.status === 'succeeded') return '已完成';
      if (task.status === 'failed') return '失败';
      if (task.status === 'canceled') return '已取消';
      if (task.type === 'download' || task.type === 'batch_download') return task.status === 'running' ? '处理中' : '排队中';
      if (task.totalBytes > 0) return taskProgressPercent(task) + '%' + estimateRemaining(task);
      if (task.totalItems > 0) return '已处理 ' + task.processedItems + '/' + task.totalItems;
      return task.status === 'running' ? '处理中' : '排队中';
    }

    function startNativeDownload(url) {
      const frame = document.createElement('iframe');
      frame.style.display = 'none';
      frame.src = storageApiUrl(url);
      document.body.appendChild(frame);
      window.setTimeout(function () {
        frame.remove();
      }, 60000);
    }

    function updateTaskUi() {
      const chip = document.getElementById('taskChip');
      const text = document.getElementById('taskChipText');
      if (!chip || !text) return;
      const tasks = Array.from(taskStore.values()).sort(function (a, b) {
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      const activeTasks = tasks.filter(function (task) {
        return task.status === 'queued' || task.status === 'running';
      });
      if (activeTasks.length === 0) {
        chip.classList.remove('active');
      } else {
        chip.classList.add('active');
        if (activeTasks.length > 1) {
          text.textContent = activeTasks.length + ' 个任务进行中';
        } else {
          const task = activeTasks[0];
          text.textContent = taskTypeLabel(task.type) + ' ' + taskStatusLabel(task);
        }
      }
      renderTaskPanel();
    }

    function openTaskPanel() {
      renderTaskPanel();
      document.getElementById('taskPanelModal').classList.add('active');
      loadTasks(false);
    }

    function renderTaskPanel() {
      const list = document.getElementById('taskPanelList');
      if (!list) return;
      const tasks = Array.from(taskStore.values()).sort(function (a, b) {
        return (b.createdAt || 0) - (a.createdAt || 0);
      }).slice(0, 50);
      list.replaceChildren();
      if (tasks.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'task-panel-empty';
        empty.textContent = '暂无任务';
        list.appendChild(empty);
        return;
      }
      tasks.forEach(function (task) {
        const row = document.createElement('div');
        row.className = 'task-row';
        const head = document.createElement('div');
        head.className = 'task-row-head';
        const title = document.createElement('div');
        title.className = 'task-row-title';
        title.textContent = task.title || taskTypeLabel(task.type);
        const status = document.createElement('div');
        status.className = 'task-row-status';
        status.textContent = taskStatusLabel(task);
        const actions = document.createElement('div');
        actions.className = 'task-row-actions';
        if (task.status === 'queued' || task.status === 'running') {
          actions.appendChild(createTaskIconButton('stop', '停止任务', function () {
            cancelTask(task.id);
          }));
        }
        actions.appendChild(createTaskIconButton('delete', '删除任务', function () {
          deleteTask(task.id);
        }, 'danger'));
        head.appendChild(title);
        head.appendChild(status);
        head.appendChild(actions);
        row.appendChild(head);

        const progress = document.createElement('div');
        progress.className = 'task-progress';
        const fill = document.createElement('div');
        fill.className = 'task-progress-fill';
        fill.style.width = taskProgressPercent(task) + '%';
        progress.appendChild(fill);
        row.appendChild(progress);

        if (task.errorMessage || task.sourcePath || task.destinationPath) {
          const meta = document.createElement('div');
          meta.className = 'task-row-meta';
          meta.textContent = task.errorMessage || [task.sourcePath, task.destinationPath].filter(Boolean).join(' -> ');
          row.appendChild(meta);
        }
        list.appendChild(row);
      });
    }

    function createTaskIconButton(iconKey, label, handler, extraClass) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'task-icon-btn' + (extraClass ? ' ' + extraClass : '');
      button.title = label;
      button.setAttribute('aria-label', label);
      button.innerHTML = TASK_ACTION_ICONS[iconKey] || label;
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        handler();
      });
      return button;
    }

    async function runCopyMoveTaskLoop(taskId) {
      if (runningTaskLoops.has(taskId)) return;
      runningTaskLoops.add(taskId);
      try {
        while (true) {
          const task = taskStore.get(taskId);
          if (!task || !['queued', 'running'].includes(task.status)) break;
          const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/run?limit=5&storageId=' + encodeURIComponent(task.storageId || currentStorageId), { method: 'POST' });
          const data = await response.json();
          if (!data.success) throw new Error(data.message || '任务执行失败');
          mergeTask(data.task);
          if (data.done || !['queued', 'running'].includes(data.task.status)) {
            await loadFiles();
            break;
          }
          await new Promise(function (resolve) { window.setTimeout(resolve, 300); });
        }
      } catch (error) {
        showToast('任务执行失败: ' + error.message, 'error');
      } finally {
        runningTaskLoops.delete(taskId);
      }
    }

    function applyDirectoryListing(data) {
      currentPath = data.currentPath || currentPath;
      clearSelection(false);
      renderBreadcrumb();
      document.getElementById('viewTitle').textContent = '当前目录';
      renderFiles(data.folders || [], data.files || []);
    }

    async function loadStorageOptions() {
      const authResponse = await fetch('/api/auth/check');
      const authData = await authResponse.json().catch(function () { return {}; });
      if (!authData.authenticated) {
        window.location.href = '/login.html';
        return false;
      }
      currentUserRole = authData.role || null;
      currentUserCacheScope = authData.role === 'admin' ? 'admin' : 'user:' + String(authData.email || '');

      const response = await fetch('/api/storages');
      const data = await response.json().catch(function () { return {}; });
      if (!response.ok || !data.success) throw new Error(data.message || '读取存储列表失败');
      availableStorages = data.storages || [];
      const select = document.getElementById('storageSelector');
      select.replaceChildren();
      if (availableStorages.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = currentUserRole === 'admin' ? '请先配置存储' : '暂无可访问存储';
        select.appendChild(option);
        select.disabled = true;
        currentStorageId = '';
        return true;
      }
      select.disabled = false;
      availableStorages.forEach(function (storage) {
        const option = document.createElement('option');
        option.value = storage.id;
        option.textContent = storage.name + (storage.isDefault ? '（默认）' : '');
        select.appendChild(option);
      });
      const saved = localStorage.getItem(activeStorageKey());
      const selected = availableStorages.find(function (storage) { return storage.id === currentStorageId; })
        || availableStorages.find(function (storage) { return storage.id === saved; })
        || availableStorages.find(function (storage) { return storage.isDefault; })
        || availableStorages[0];
      currentStorageId = selected.id;
      select.value = currentStorageId;
      localStorage.setItem(activeStorageKey(), currentStorageId);
      return true;
    }

    async function handleStorageChange() {
      const nextStorageId = document.getElementById('storageSelector').value;
      if (!nextStorageId || nextStorageId === currentStorageId) return;
      stopStorageSyncMonitor();
      currentStorageId = nextStorageId;
      localStorage.setItem(activeStorageKey(), currentStorageId);
      if (fileLoadAbortController) fileLoadAbortController.abort();
      if (globalSearchAbortController) globalSearchAbortController.abort();
      if (txtSearchAbortController) txtSearchAbortController.abort();
      fileLoadRequestId++;
      globalSearchRequestId++;
      folderSearchRequestId++;
      closePreview();
      currentPath = '/';
      currentView = 'files';
      selectedItems.clear();
      favoritePaths.clear();
      favoritePathsLoaded = false;
      tagOptionsLoaded = false;
      directoryCache.clear();
      applyTagOptions([]);
      await loadBootstrap({ reuseStorage: true });
    }

    async function loadBootstrap(options) {
      const settings = options || {};
      showLoading(true);
      try {
        if (!settings.reuseStorage && !(await loadStorageOptions())) return false;
        const response = await fetch('/api/bootstrap');
        const data = await response.json().catch(function () {
          return { success: false, message: '初始化接口返回异常' };
        });
        if (response.status === 401 || !data.authenticated) {
          window.location.href = '/login.html';
          return false;
        }
        if (!data.success) throw new Error(data.message || '初始化失败');
        currentUserRole = data.role || currentUserRole;
        currentUserCacheScope = data.role === 'admin' ? 'admin' : 'user:' + String(data.email || '');
        favoritePaths.clear();
        (data.favorites || []).forEach(function (item) { favoritePaths.add(item.path); });
        favoritePathsLoaded = true;
        applyTagOptions(data.tags || []);
        const listing = data.listing || { success: true, currentPath: '/', folders: [], files: [] };
        directoryCache.set(directoryCacheKey(listing.currentPath || '/'), listing);
        currentView = 'files';
        updateViewTabs();
        applyDirectoryListing(listing);
        const initialSync = data.sync
          || (data.storage?.lastSyncStatus === 'never' ? { status: 'queued' } : null);
        setStorageSyncStatus(initialSync, data.storage?.lastSyncStatus);
        if (initialSync && ['queued', 'running'].includes(initialSync.status)) {
          monitorStorageSync(currentPath);
        }
        if (data.setupRequired && currentUserRole === 'admin') {
          showToast('请到管理后台配置开发存储', 'info');
        }
        return true;
      } catch (error) {
        showToast('初始化失败: ' + error.message, 'error');
        return false;
      } finally {
        showLoading(false);
      }
    }

    async function loadFiles(options) {
      const settings = options || {};
      const searchRequestId = settings.searchRequestId;
      if (searchRequestId && searchRequestId !== globalSearchRequestId) return;
      const requestedPath = normalizeClientPath(currentPath);
      const cached = directoryCache.get(directoryCacheKey(requestedPath));
      const requestId = ++fileLoadRequestId;
      currentView = 'files';
      updateViewTabs();
      if (fileLoadAbortController) fileLoadAbortController.abort();
      fileLoadAbortController = new AbortController();
      if (cached) applyDirectoryListing(cached);
      if (!cached && !settings.background) showLoading(true);
      try {
        const favoritesPromise = loadFavoritePaths();
        const response = await fetch(apiFileUrl('/api/files', requestedPath), {
          signal: fileLoadAbortController.signal
        });
        const data = await response.json().catch(function () {
          return { success: false, message: '文件列表接口返回异常' };
        });
        if (!data.success) {
          if (response.status === 401) {
            window.location.href = '/login.html';
            return;
          }
          throw new Error(data.message || '加载失败');
        }
        await favoritesPromise;
        if (requestId !== fileLoadRequestId || requestedPath !== normalizeClientPath(currentPath)) return;
        if (searchRequestId && searchRequestId !== globalSearchRequestId) return;
        directoryCache.set(directoryCacheKey(requestedPath), data);
        applyDirectoryListing(data);
        setStorageSyncStatus(data.sync);
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        showToast('加载文件失败: ' + error.message, 'error');
      } finally {
        if (requestId === fileLoadRequestId) showLoading(false);
      }
    }

    function isBatchSelectionView() {
      return ['files', 'search', 'favorites', 'recent'].includes(currentView);
    }

    function updateViewTabs() {
      document.querySelectorAll('.view-tab').forEach(function (tab) {
        tab.classList.toggle('active', tab.dataset.view === currentView);
      });
      document.getElementById('batchToolbar').classList.toggle('active', isBatchSelectionView() && selectedItems.size > 0);
    }

    async function switchMainView(view) {
      if (view === 'files') {
        await loadFiles();
        return;
      }
      currentView = view;
      updateViewTabs();
      clearSelection(false);
      if (view === 'favorites') {
        await loadFavoritesView();
      } else if (view === 'recent') {
        await loadRecentView();
      }
    }

    let favoritePathsLoaded = false;
    let favoritePathsInFlight = null;

    // Favorites are fetched once and then kept in sync locally (toggleFavorite
    // updates the set in place). Pass force=true to refetch from the server.
    async function loadFavoritePaths(force) {
      if (favoritePathsLoaded && !force) return;
      if (favoritePathsInFlight) return favoritePathsInFlight;
      favoritePathsInFlight = (async function () {
        try {
          const response = await fetch('/api/favorites?limit=500');
          const data = await response.json();
          favoritePaths.clear();
          if (data.success) {
            (data.favorites || []).forEach(function (item) {
              favoritePaths.add(item.path);
            });
            favoritePathsLoaded = true;
          }
        } catch (error) {
          console.warn('Favorites load failed:', error);
        } finally {
          favoritePathsInFlight = null;
        }
      })();
      return favoritePathsInFlight;
    }

    const selectedTagFilters = new Set();

    function applyTagOptions(tags) {
      const list = document.getElementById('tagFilterList');
      const empty = document.getElementById('tagFilterEmpty');
      if (!list) return;
      const options = Array.isArray(tags) ? tags : [];
      const validTags = new Set(options.map(function (item) { return item.tag; }));
      Array.from(selectedTagFilters).forEach(function (tag) {
        if (!validTags.has(tag)) selectedTagFilters.delete(tag);
      });
      list.replaceChildren();
      options.forEach(function (item) {
        const label = document.createElement('label');
        label.className = 'tag-filter-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = item.tag;
        checkbox.checked = selectedTagFilters.has(item.tag);
        checkbox.addEventListener('change', function () {
          if (checkbox.checked) selectedTagFilters.add(item.tag);
          else selectedTagFilters.delete(item.tag);
          updateTagFilterLabel();
          handleTagFilterChange();
        });
        const name = document.createElement('span');
        name.className = 'tag-filter-name';
        name.textContent = item.tag;
        const count = document.createElement('span');
        count.className = 'tag-filter-count';
        count.textContent = item.count;
        label.appendChild(checkbox);
        label.appendChild(name);
        label.appendChild(count);
        list.appendChild(label);
      });
      if (empty) empty.hidden = options.length > 0;
      list.hidden = options.length === 0;
      updateTagFilterLabel();
      tagOptionsLoaded = true;
    }

    async function loadTagOptions(force) {
      if (tagOptionsLoaded && !force) return;
      try {
        const response = await fetch('/api/tags/list');
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '读取标签失败');
        applyTagOptions(data.tags || []);
      } catch (error) {
        console.warn('Tag options load failed:', error);
      }
    }

    function updateTagFilterLabel() {
      const trigger = document.getElementById('tagFilterTrigger');
      const label = document.getElementById('tagFilterLabel');
      if (!trigger || !label) return;
      const count = selectedTagFilters.size;
      if (count === 0) {
        label.textContent = '标签';
        trigger.classList.remove('has-selection');
      } else if (count === 1) {
        label.textContent = Array.from(selectedTagFilters)[0];
        trigger.classList.add('has-selection');
      } else {
        label.textContent = '已选 ' + count + ' 个标签';
        trigger.classList.add('has-selection');
      }
    }

    function toggleTagFilterMenu(event) {
      if (event) event.stopPropagation();
      const menu = document.getElementById('tagFilterMenu');
      const trigger = document.getElementById('tagFilterTrigger');
      if (!menu || !trigger) return;
      const willOpen = menu.hidden;
      menu.hidden = !willOpen;
      trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    }

    function closeTagFilterMenu() {
      const menu = document.getElementById('tagFilterMenu');
      const trigger = document.getElementById('tagFilterTrigger');
      if (menu && !menu.hidden) menu.hidden = true;
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    }

    function clearTagFilters() {
      if (selectedTagFilters.size === 0) return;
      selectedTagFilters.clear();
      const list = document.getElementById('tagFilterList');
      if (list) {
        list.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
          cb.checked = false;
        });
      }
      updateTagFilterLabel();
      handleTagFilterChange();
    }

    document.addEventListener('click', function (event) {
      const wrap = document.getElementById('tagFilterWrap');
      if (!wrap) return;
      if (!wrap.contains(event.target)) closeTagFilterMenu();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeTagFilterMenu();
    });

    function getSelectedTagFilters() {
      return Array.from(selectedTagFilters).filter(Boolean);
    }

    async function loadFavoritesView() {
      showLoading(true);
      try {
        const response = await fetch('/api/favorites?limit=500');
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '加载失败');
        favoritePaths.clear();
        (data.favorites || []).forEach(function (item) {
          favoritePaths.add(item.path);
        });
        favoritePathsLoaded = true;
        document.getElementById('viewTitle').textContent = '收藏';
        renderItemList(data.favorites || [], '暂无收藏');
      } catch (error) {
        showToast('加载收藏失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    async function loadRecentView() {
      showLoading(true);
      try {
        await loadFavoritePaths();
        const response = await fetch('/api/recent?limit=100');
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '加载失败');
        document.getElementById('viewTitle').textContent = '最近访问';
        renderItemList(data.recent || [], '暂无最近访问');
      } catch (error) {
        showToast('加载最近访问失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function handleSearchKey(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (globalSearchTimer) {
          clearTimeout(globalSearchTimer);
          globalSearchTimer = null;
        }
        runSearch(false);
      }
    }

    function handleSearchInput() {
      scheduleGlobalSearch(250);
    }

    function handleSearchTypeChange() {
      scheduleGlobalSearch(100);
    }

    function handleTagFilterChange() {
      scheduleGlobalSearch(100);
    }

    function scheduleGlobalSearch(delay) {
      if (globalSearchTimer) {
        clearTimeout(globalSearchTimer);
        globalSearchTimer = null;
      }

      const q = document.getElementById('globalSearchInput').value.trim();
      const tags = getSelectedTagFilters();
      if (!q && tags.length === 0) {
        if (globalSearchAbortController) globalSearchAbortController.abort();
        const requestId = ++globalSearchRequestId;
        loadFiles({ searchRequestId: requestId });
        return;
      }

      globalSearchTimer = window.setTimeout(function () {
        globalSearchTimer = null;
        runSearch(false);
      }, delay);
    }

    async function runSearch(refresh) {
      const q = document.getElementById('globalSearchInput').value.trim();
      const tags = getSelectedTagFilters();
      if (globalSearchAbortController) globalSearchAbortController.abort();
      globalSearchAbortController = new AbortController();
      if (!q && tags.length === 0) {
        const requestId = ++globalSearchRequestId;
        await loadFiles({ searchRequestId: requestId });
        return;
      }

      const requestId = ++globalSearchRequestId;
      currentView = 'search';
      updateViewTabs();
      clearSelection(false);
      if (refresh) showLoading(true);
      try {
        await loadFavoritePaths();
        const type = document.getElementById('globalSearchType').value;
        const params = new URLSearchParams({
          q: q,
          type: type,
          limit: '200',
          refresh: refresh ? '1' : '0'
        });
        tags.forEach(function (tag) { params.append('tag', tag); });
        const response = await fetch('/api/search?' + params.toString(), {
          signal: globalSearchAbortController.signal
        });
        const data = await response.json();
        if (requestId !== globalSearchRequestId) return;
        if (!data.success) throw new Error(data.message || '搜索失败');
        document.getElementById('viewTitle').textContent = refresh ? '搜索结果（索引已刷新）' : '搜索结果';
        renderItemList(data.items || [], '没有匹配的项目');
        if (data.refresh) {
          showToast('索引已刷新，共 ' + data.refresh.count + ' 项', 'success');
        }
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        if (requestId !== globalSearchRequestId) return;
        showToast('搜索失败: ' + error.message, 'error');
      } finally {
        if (refresh) showLoading(false);
      }
    }

    async function refreshCurrentDirectory() {
      currentView = 'files';
      updateViewTabs();
      try {
        const cacheResp = await fetch('/api/cache/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: currentPath })
        });
        const data = await cacheResp.json().catch(function () { return {}; });
        if (!cacheResp.ok || !data.success) throw new Error(data.message || '目录刷新失败');
        setStorageSyncStatus(data.sync || { status: 'queued' });
        monitorStorageSync(currentPath);
        showToast('同步任务已排队，后台刷新中', 'info');
      } catch (error) {
        showToast('刷新失败: ' + error.message, 'error');
      }
    }

    function renderBreadcrumb() {
      const breadcrumb = document.getElementById('breadcrumb');
      breadcrumb.replaceChildren();

      const root = document.createElement('a');
      root.href = '#';
      root.className = 'breadcrumb-item';
      root.textContent = '根目录';
      root.addEventListener('click', function (event) {
        event.preventDefault();
        navigateTo('/');
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
            navigateTo(targetPath);
          });
          breadcrumb.appendChild(link);
        }
      });
    }

    function updateDisplayModeControls() {
      document.querySelectorAll('.display-mode-btn').forEach(function (button) {
        const active = button.dataset.displayMode === displayMode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      const fileList = document.getElementById('fileList');
      if (fileList) {
        fileList.classList.toggle('file-list', displayMode === 'list');
        fileList.classList.toggle('file-grid', displayMode === 'grid');
      }
    }

    function setDisplayMode(mode) {
      if (!['list', 'grid'].includes(mode) || mode === displayMode) {
        updateDisplayModeControls();
        return;
      }
      displayMode = mode;
      localStorage.setItem(DISPLAY_MODE_STORAGE_KEY, mode);
      updateDisplayModeControls();
      if (lastDirectoryItems) {
        renderFiles(lastDirectoryItems.folders, lastDirectoryItems.files);
      } else if (lastRenderedItems) {
        renderItemList(lastRenderedItems, lastRenderedEmptyMessage);
      } else {
        loadFiles({ background: true });
      }
    }

    function prepareFileListContainer() {
      const fileList = document.getElementById('fileList');
      fileList.replaceChildren();
      updateDisplayModeControls();
      if (displayMode === 'list') fileList.appendChild(createListHeader());
      return fileList;
    }

    function createListHeader() {
      const header = document.createElement('div');
      header.className = 'file-list-header';
      header.setAttribute('role', 'row');
      [
        '',
        '名称',
        '类型',
        '大小',
        '修改时间',
        '状态',
        '操作'
      ].forEach(function (label, index) {
        const cell = document.createElement('div');
        cell.className = index === 0 ? 'file-list-select-head' : '';
        cell.textContent = label;
        header.appendChild(cell);
      });
      return header;
    }

    function toRenderableItem(item, isFolder) {
      return {
        name: item.name,
        path: item.path,
        itemType: isFolder ? 'folder' : 'file',
        typeLabel: isFolder ? '📁' : getFileIcon(item.name),
        meta: isFolder ? '文件夹' : (item.sizeFormatted || ''),
        sizeFormatted: item.sizeFormatted || '',
        previewType: item.previewType || '',
        isFolder,
        tags: item.tags || [],
        size: Number(item.size || 0),
        lastModified: item.lastModified || null,
        syncStatus: item.syncStatus || item.sync_status || 'ready'
      };
    }

    function renderFiles(folders, files) {
      const normalizedFolders = Array.isArray(folders) ? folders : [];
      const normalizedFiles = Array.isArray(files) ? files : [];
      lastDirectoryItems = { folders: normalizedFolders, files: normalizedFiles };
      lastRenderedItems = null;
      const fileList = prepareFileListContainer();
      const emptyState = document.getElementById('emptyState');

      if (normalizedFolders.length === 0 && normalizedFiles.length === 0) {
        if (displayMode === 'list') fileList.replaceChildren();
        emptyState.style.display = 'block';
        emptyState.querySelector('div:last-child').textContent =
          currentUserRole === 'user' && currentPath === '/'
            ? '暂无可访问资源，请联系管理员授权'
            : '此文件夹为空';
        return;
      }

      emptyState.style.display = 'none';
      normalizedFolders.forEach(function (folder) {
        const item = toRenderableItem(folder, true);
        fileList.appendChild(displayMode === 'list' ? createFileRow(item) : createFileCard(item));
      });
      normalizedFiles.forEach(function (file) {
        const item = toRenderableItem(file, false);
        fileList.appendChild(displayMode === 'list' ? createFileRow(item) : createFileCard(item));
      });
    }

    function renderItemList(items, emptyMessage) {
      const normalizedItems = Array.isArray(items) ? items : [];
      lastDirectoryItems = null;
      lastRenderedItems = normalizedItems;
      lastRenderedEmptyMessage = emptyMessage || '暂无项目';
      const fileList = prepareFileListContainer();
      const emptyState = document.getElementById('emptyState');

      if (normalizedItems.length === 0) {
        if (displayMode === 'list') fileList.replaceChildren();
        emptyState.style.display = 'block';
        emptyState.querySelector('div:last-child').textContent = lastRenderedEmptyMessage;
        return;
      }

      emptyState.style.display = 'none';
      normalizedItems.forEach(function (item) {
        const isFolder = item.itemType === 'folder' || item.item_type === 'folder' || item.isFolder;
        const renderable = toRenderableItem(item, isFolder);
        fileList.appendChild(displayMode === 'list' ? createFileRow(renderable) : createFileCard(renderable));
      });
    }

    function getFileTypeLabel(item) {
      if (item.isFolder) return '文件夹';
      const name = String(item.name || '');
      const dot = name.lastIndexOf('.');
      if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toUpperCase().slice(0, 10);
      return '文件';
    }

    function getDisplaySize(item) {
      return item.isFolder ? '—' : (item.sizeFormatted || '0 B');
    }

    function formatDisplayTime(value) {
      if (!value) return '—';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '—';
      return date.toLocaleString([], {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    }
    function getDisplayStatusClass(status) {
      if (status === '同步中') return 'is-syncing';
      if (status === '同步失败' || status === '已失效') return 'is-error';
      return 'is-ready';
    }

    function getDisplayStatus(item) {
      if (item.syncStatus === 'stale') return '待刷新';
      if (currentSyncState?.status === 'queued' || currentSyncState?.status === 'running') return '同步中';
      if (currentSyncState?.status === 'failed') return '同步失败';
      return '已同步';
    }

    function bindFileItemInteractions(element, item) {
      element.dataset.path = item.path;
      if (selectedItems.has(item.path)) element.classList.add('selected');
      element.addEventListener('dblclick', function () {
        if (item.isFolder) navigateTo(item.path);
        else handleFileClick(item.path, item.previewType, item.name);
      });
      element.addEventListener('click', function () {
        if (item.isFolder && window.matchMedia('(max-width: 768px)').matches) {
          navigateTo(item.path);
        }
      });

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'file-select';
      checkbox.checked = selectedItems.has(item.path);
      checkbox.setAttribute('aria-label', '选择 ' + item.name);
      checkbox.addEventListener('click', function (event) {
        event.stopPropagation();
      });
      checkbox.addEventListener('change', function () {
        toggleItemSelection(item, checkbox.checked, element);
      });
      element.appendChild(checkbox);
    }

    function createItemActions(item) {
      const actions = document.createElement('div');
      actions.className = 'file-actions';
      actions.appendChild(createActionButton(
        favoritePaths.has(item.path) ? 'favoriteOn' : 'favorite',
        favoritePaths.has(item.path) ? '取消收藏' : '收藏',
        favoritePaths.has(item.path) ? 'btn-primary' : 'btn-secondary',
        function (button) { toggleFavorite(item, button); }
      ));
      actions.appendChild(createActionButton('tag', '编辑标签', 'btn-secondary', function () {
        showTagModal(item);
      }));
      if (!item.isFolder) {
        actions.appendChild(createActionButton('rename', '重命名', 'btn-secondary', function () {
          showRenameModal(item.path, item.name);
        }));
      }
      return actions;
    }

    function createFileCard(item) {
      const card = document.createElement('div');
      card.className = 'file-item';
      bindFileItemInteractions(card, item);

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
      if (item.previewType) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-info';
        badge.textContent = ' 可预览';
        meta.appendChild(badge);
      }
      card.appendChild(meta);

      if (item.tags && item.tags.length > 0) {
        card.appendChild(renderTagChips(item.tags, false));
      }
      card.appendChild(createItemActions(item));
      return card;
    }

    function createFileRow(item) {
      const row = document.createElement('div');
      row.className = 'file-item file-row';
      row.setAttribute('role', 'row');
      bindFileItemInteractions(row, item);

      const nameCell = document.createElement('div');
      nameCell.className = 'file-row-name';
      const icon = document.createElement('span');
      icon.className = 'file-row-icon';
      icon.textContent = item.typeLabel;
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = item.name;
      name.title = item.name;
      nameCell.append(icon, name);
      if (item.tags && item.tags.length > 0) nameCell.appendChild(renderTagChips(item.tags, false));
      const submeta = document.createElement('span');
      submeta.className = 'file-row-submeta';
      submeta.textContent = [getFileTypeLabel(item), getDisplaySize(item), getDisplayStatus(item)]
        .filter(Boolean).join(' · ');
      nameCell.appendChild(submeta);

      const typeCell = document.createElement('div');
      typeCell.className = 'file-row-type';
      typeCell.textContent = getFileTypeLabel(item);
      const sizeCell = document.createElement('div');
      sizeCell.className = 'file-row-size';
      sizeCell.textContent = getDisplaySize(item);
      const modifiedCell = document.createElement('div');
      modifiedCell.className = 'file-row-modified';
      modifiedCell.textContent = formatDisplayTime(item.lastModified);
      const statusCell = document.createElement('div');
      const status = getDisplayStatus(item);
      statusCell.className = 'file-row-status ' + getDisplayStatusClass(status);
      statusCell.textContent = status;
      statusCell.setAttribute('role', 'cell');

      row.append(nameCell, typeCell, sizeCell, modifiedCell, statusCell, createItemActions(item));
      return row;
    }




    function createActionButton(actionKey, label, className, handler) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm icon-btn ' + className;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.innerHTML = ACTION_ICONS[actionKey] || label;
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        setTaskOrigin(button);
        handler(button);
      });
      return button;
    }

    function tagColor(tag) {
      const palette = ['#2563eb', '#047857', '#b45309', '#be123c', '#6d28d9', '#0f766e', '#4338ca', '#a21caf'];
      let hash = 0;
      for (let index = 0; index < tag.length; index++) {
        hash = ((hash << 5) - hash + tag.charCodeAt(index)) | 0;
      }
      return palette[Math.abs(hash) % palette.length];
    }

    function renderTagChips(tags, removable) {
      const list = document.createElement('div');
      list.className = 'tag-list' + (removable ? ' tag-editor-list' : '');
      (tags || []).forEach(function (tag) {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.style.background = tagColor(tag);
        const text = document.createElement('span');
        text.textContent = tag;
        chip.appendChild(text);
        if (removable) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = 'x';
          remove.setAttribute('aria-label', '移除标签 ' + tag);
          remove.addEventListener('click', function () {
            editingTags = editingTags.filter(function (item) { return item !== tag; });
            renderTagEditor();
          });
          chip.appendChild(remove);
        }
        list.appendChild(chip);
      });
      return list;
    }

    function showTagModal(item) {
      editingTagItem = item;
      editingTags = normalizeClientTags(item.tags || []);
      document.getElementById('tagItemName').textContent = item.name;
      document.getElementById('tagItemPath').value = item.path;
      document.getElementById('tagItemType').value = item.isFolder ? 'folder' : 'file';
      document.getElementById('tagInput').value = '';
      renderTagEditor();
      document.getElementById('tagModal').classList.add('active');
      window.setTimeout(function () {
        document.getElementById('tagInput').focus();
      }, 0);
    }

    function renderTagEditor() {
      const list = document.getElementById('tagEditorList');
      list.replaceChildren();
      const chips = renderTagChips(editingTags, true);
      Array.from(chips.children).forEach(function (chip) {
        list.appendChild(chip);
      });
    }

    function normalizeClientTags(tags) {
      const seen = new Set();
      const normalized = [];
      (tags || []).forEach(function (raw) {
        const tag = String(raw || '').trim();
        if (tag && tag.length <= 20 && !seen.has(tag)) {
          seen.add(tag);
          normalized.push(tag);
        }
      });
      return normalized.sort(function (a, b) { return a.localeCompare(b, 'zh-Hans-CN'); });
    }

    function addTagFromInput() {
      const input = document.getElementById('tagInput');
      const tag = input.value.trim();
      if (!tag) return;
      if (tag.length > 20) {
        showToast('单个标签不能超过 20 个字符', 'warning');
        return;
      }
      if (editingTags.length >= 20 && !editingTags.includes(tag)) {
        showToast('每个项目最多 20 个标签', 'warning');
        return;
      }
      editingTags = normalizeClientTags(editingTags.concat(tag));
      input.value = '';
      renderTagEditor();
    }

    async function saveTags(event) {
      event.preventDefault();
      addTagFromInput();
      const path = document.getElementById('tagItemPath').value;
      const itemType = document.getElementById('tagItemType').value;
      try {
        const response = await fetch('/api/tags?path=' + encodeURIComponent(path), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: editingTags, itemType: itemType })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '保存失败');
        closeModal('tagModal');
        const savedTags = data.tags || [];
        if (editingTagItem) editingTagItem.tags = savedTags;
        const cached = directoryCache.get(directoryCacheKey(currentPath));
        if (cached) {
          (cached.folders || []).concat(cached.files || []).forEach(function (item) {
            if (item.path === path) item.tags = savedTags;
          });
        }
        document.querySelectorAll('.file-item').forEach(function (card) {
          if (card.dataset.path !== path) return;
          Array.from(card.children).forEach(function (child) {
            if (child.classList && child.classList.contains('tag-list')) child.remove();
          });
          if (savedTags.length > 0) {
            const actions = card.querySelector('.file-actions');
            card.insertBefore(renderTagChips(savedTags, false), actions || null);
          }
        });
        loadTagOptions(true);
        showToast('标签已保存', 'success');
      } catch (error) {
        showToast('保存标签失败: ' + error.message, 'error');
      }
    }

    document.addEventListener('keydown', function (event) {
      if (event.target && event.target.id === 'tagInput' && event.key === 'Enter') {
        event.preventDefault();
        addTagFromInput();
      }
    });

    function paintFavoriteButton(button, active) {
      if (!button) return;
      button.innerHTML = active ? ACTION_ICONS.favoriteOn : ACTION_ICONS.favorite;
      button.title = active ? '取消收藏' : '收藏';
      button.setAttribute('aria-label', button.title);
      button.classList.toggle('btn-primary', active);
      button.classList.toggle('btn-secondary', !active);
    }

    async function toggleFavorite(item, button) {
      const isFavorite = favoritePaths.has(item.path);
      if (isFavorite) favoritePaths.delete(item.path);
      else favoritePaths.add(item.path);
      paintFavoriteButton(button, !isFavorite);
      if (button) button.disabled = true;
      try {
        const response = await fetch('/api/favorites', {
          method: isFavorite ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: item.path,
            name: item.name,
            itemType: item.isFolder ? 'folder' : 'file',
            sizeFormatted: item.sizeFormatted || item.meta || '',
            previewType: item.previewType || ''
          })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '操作失败');
        if (isFavorite) {
          showToast('已取消收藏', 'success');
          if (currentView === 'favorites' && button) button.closest('.file-item')?.remove();
        } else {
          showToast('已收藏', 'success');
        }
      } catch (error) {
        if (isFavorite) favoritePaths.add(item.path);
        else favoritePaths.delete(item.path);
        paintFavoriteButton(button, isFavorite);
        showToast('收藏操作失败: ' + error.message, 'error');
      } finally {
        if (button) button.disabled = false;
      }
    }

    function toggleItemSelection(item, checked, card) {
      if (checked) {
        selectedItems.set(item.path, {
          path: item.path,
          name: item.name,
          isFolder: !!item.isFolder
        });
      } else {
        selectedItems.delete(item.path);
      }
      if (card) {
        card.classList.toggle('selected', checked);
      }
      updateBatchToolbar();
    }

    function toggleSelectAll(checked) {
      document.querySelectorAll('.file-select').forEach(function (checkbox) {
        checkbox.checked = checked;
        checkbox.dispatchEvent(new Event('change'));
      });
    }

    function clearSelection(updateOnly) {
      selectedItems.clear();
      document.querySelectorAll('.file-select').forEach(function (checkbox) {
        checkbox.checked = false;
        const card = checkbox.closest('.file-item');
        if (card) card.classList.remove('selected');
      });
      if (updateOnly !== false) {
        updateBatchToolbar();
      } else {
        const toolbar = document.getElementById('batchToolbar');
        const selectedCount = document.getElementById('selectedCount');
        const selectAll = document.getElementById('selectAllCheckbox');
        if (toolbar) toolbar.classList.remove('active');
        if (selectedCount) selectedCount.textContent = '0';
        if (selectAll) {
          selectAll.checked = false;
          selectAll.indeterminate = false;
        }
      }
    }

    function updateBatchToolbar() {
      const count = selectedItems.size;
      const toolbar = document.getElementById('batchToolbar');
      const selectedCount = document.getElementById('selectedCount');
      const selectAll = document.getElementById('selectAllCheckbox');
      const total = document.querySelectorAll('.file-select').length;

      toolbar.classList.toggle('active', isBatchSelectionView() && count > 0);
      selectedCount.textContent = String(count);
      selectAll.checked = total > 0 && count === total;
      selectAll.indeterminate = count > 0 && count < total;
    }

    function getSelectedItems() {
      return Array.from(selectedItems.values());
    }

    function getFileIcon(filename) {
      const ext = (filename.split('.').pop() || '').toLowerCase();
      const icons = {
        pdf: '📕',
        doc: '📘',
        docx: '📘',
        xls: '📗',
        xlsx: '📗',
        ppt: '📙',
        pptx: '📙',
        jpg: '🖼️',
        jpeg: '🖼️',
        png: '🖼️',
        gif: '🖼️',
        svg: '🖼️',
        webp: '🖼️',
        mp3: '🎵',
        wav: '🎵',
        flac: '🎵',
        m4a: '🎵',
        mp4: '🎬',
        webm: '🎬',
        zip: '📦',
        rar: '📦',
        '7z': '📦',
        tar: '📦',
        gz: '📦',
        txt: '📄',
        md: '📝',
        json: '📋',
        js: '📜',
        ts: '📜',
        css: '🎨',
        html: '🌐'
      };
      return icons[ext] || '📄';
    }

    function navigateTo(path) {
      currentPath = path || '/';
      loadFiles();
    }

    function handleFileClick(path, previewType, filename, options) {
      if (previewType) {
        previewFile(path, previewType, filename, options);
      } else {
        downloadFile(path);
      }
    }

    // marked/mammoth are only needed for .md/.docx previews, so they are loaded
    // on demand instead of blocking the initial page render.
    const previewLibraryLoading = {};
    function loadPreviewLibrary(name) {
      if (window[name]) return Promise.resolve();
      if (previewLibraryLoading[name]) return previewLibraryLoading[name];
      const sources = {
        marked: { src: 'https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js', integrity: 'sha384-948ahk4ZmxYVYOc+rxN1H2gM1EJ2Duhp7uHtZ4WSLkV4Vtx5MUqnV+l7u9B+jFv+' },
        mammoth: { src: 'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js', integrity: 'sha384-nFoSjZIoH3CCp8W639jJyQkuPHinJ2NHe7on1xvlUA7SuGfJAfvMldrsoAVm6ECz' }
      };
      const config = sources[name];
      if (!config) return Promise.reject(new Error('未知预览组件: ' + name));
      previewLibraryLoading[name] = new Promise(function (resolve, reject) {
        const script = document.createElement('script');
        script.src = config.src;
        script.integrity = config.integrity;
        script.crossOrigin = 'anonymous';
        script.onload = function () { resolve(); };
        script.onerror = function () {
          delete previewLibraryLoading[name];
          reject(new Error(name + ' 预览组件加载失败'));
        };
        document.head.appendChild(script);
      });
      return previewLibraryLoading[name];
    }

    function openTxtCacheDb() {
      if (!window.indexedDB) return Promise.resolve(null);
      if (txtCacheDbPromise) return txtCacheDbPromise;
      txtCacheDbPromise = new Promise(function (resolve) {
        const request = indexedDB.open(TXT_CACHE_DB_NAME, 1);
        request.onupgradeneeded = function () {
          const db = request.result;
          if (!db.objectStoreNames.contains(TXT_CACHE_STORE_NAME)) {
            const store = db.createObjectStore(TXT_CACHE_STORE_NAME, { keyPath: 'id' });
            store.createIndex('path', 'path', { unique: false });
            store.createIndex('lastAccess', 'lastAccess', { unique: false });
          }
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () {
          console.warn('TXT cache unavailable:', request.error);
          resolve(null);
        };
      });
      return txtCacheDbPromise;
    }

    function txtCacheRecordId(path, etag, byteStart) {
      return currentUserCacheScope + '\\n' + currentStorageId + '\\n' + path + '\\n' + etag + '\\n' + String(byteStart);
    }

    async function listTxtCachedChunks(path) {
      const db = await openTxtCacheDb();
      if (!db) return [];
      return new Promise(function (resolve) {
        const transaction = db.transaction(TXT_CACHE_STORE_NAME, 'readonly');
        const request = transaction.objectStore(TXT_CACHE_STORE_NAME).index('path').getAll(path);
        request.onsuccess = function () {
          resolve((request.result || []).filter(function (record) {
            return record.scope === currentUserCacheScope && record.storageId === currentStorageId;
          }));
        };
        request.onerror = function () { resolve([]); };
      });
    }

    async function getTxtCachedWindow(path) {
      const records = await listTxtCachedChunks(path);
      if (records.length === 0) return { etag: '', records: [], byStart: new Map() };
      records.sort(function (a, b) { return Number(b.lastAccess || 0) - Number(a.lastAccess || 0); });
      const etag = records[0].etag || '';
      const current = records.filter(function (record) { return record.etag === etag; });
      return {
        etag,
        records: current,
        byStart: new Map(current.map(function (record) { return [Number(record.byteStart), record]; }))
      };
    }

    async function getTxtCachedChunk(path, etag, byteStart) {
      const db = await openTxtCacheDb();
      if (!db || !etag) return null;
      return new Promise(function (resolve) {
        const transaction = db.transaction(TXT_CACHE_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(TXT_CACHE_STORE_NAME);
        const request = store.get(txtCacheRecordId(path, etag, byteStart));
        request.onsuccess = function () {
          const record = request.result || null;
          if (record) {
            record.lastAccess = Date.now();
            store.put(record);
          }
          resolve(record);
        };
        request.onerror = function () { resolve(null); };
      });
    }

    async function pruneTxtCache(db, path, etag) {
      const all = await new Promise(function (resolve) {
        const transaction = db.transaction(TXT_CACHE_STORE_NAME, 'readonly');
        const request = transaction.objectStore(TXT_CACHE_STORE_NAME).getAll();
        request.onsuccess = function () { resolve(request.result || []); };
        request.onerror = function () { resolve([]); };
      });
      const scoped = all.filter(function (record) {
        return record.scope === currentUserCacheScope && record.storageId === currentStorageId;
      });
      const stale = scoped.filter(function (record) { return record.path === path && record.etag !== etag; });
      const sameBook = scoped.filter(function (record) { return record.path === path && record.etag === etag; })
        .sort(function (a, b) { return Number(b.lastAccess || 0) - Number(a.lastAccess || 0); });
      const newest = scoped.slice().sort(function (a, b) { return Number(b.lastAccess || 0) - Number(a.lastAccess || 0); });
      const removeIds = new Set(stale.map(function (record) { return record.id; }));
      sameBook.slice(TXT_CACHE_MAX_BOOK_CHUNKS).forEach(function (record) { removeIds.add(record.id); });
      newest.slice(TXT_CACHE_MAX_TOTAL_CHUNKS).forEach(function (record) { removeIds.add(record.id); });
      if (removeIds.size === 0) return;
      await new Promise(function (resolve) {
        const transaction = db.transaction(TXT_CACHE_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(TXT_CACHE_STORE_NAME);
        removeIds.forEach(function (id) { store.delete(id); });
        transaction.oncomplete = resolve;
        transaction.onerror = resolve;
      });
    }

    async function putTxtCachedChunk(state, chunk) {
      if (!state || !state.meta || !state.meta.etag || !chunk || !chunk.text) return;
      const db = await openTxtCacheDb();
      if (!db) return;
      const record = {
        id: txtCacheRecordId(state.path, state.meta.etag, chunk.byteStart),
        scope: currentUserCacheScope,
        storageId: currentStorageId,
        path: state.path,
        etag: state.meta.etag,
        encoding: state.meta.encoding,
        byteStart: Number(chunk.byteStart),
        byteEnd: Number(chunk.byteEnd),
        charStart: Number(chunk.charStart),
        charEnd: Number(chunk.charEnd),
        text: chunk.text,
        lastAccess: Date.now()
      };
      await new Promise(function (resolve) {
        const transaction = db.transaction(TXT_CACHE_STORE_NAME, 'readwrite');
        transaction.objectStore(TXT_CACHE_STORE_NAME).put(record);
        transaction.oncomplete = resolve;
        transaction.onerror = resolve;
      });
      await pruneTxtCache(db, state.path, state.meta.etag);
    }

    async function previewFile(path, previewType, filename, options) {
      const overlay = document.getElementById('previewOverlay');
      const content = document.getElementById('previewContent');
      const filenameEl = document.getElementById('previewFilename');
      const downloadBtn = document.getElementById('previewDownloadBtn');
      const readerTools = document.getElementById('readerTools');

      stopReaderProgressTracking();
      content.classList.remove('reader-mode');
      readerTools.classList.remove('active');
      document.getElementById('bookmarkPanel').hidden = true;
      filenameEl.textContent = filename;
      downloadBtn.onclick = function () {
        downloadFile(path);
      };
      content.innerHTML = '<div class="preview-loading"><div class="spinner"></div><div>加载中...</div></div>';
      overlay.classList.add('active');

      const previewUrl = apiFileUrl('/api/preview', path);
      try {
        if (previewType === 'image') {
          const img = document.createElement('img');
          img.className = 'preview-image';
          img.src = previewUrl;
          img.alt = filename;
          content.replaceChildren(img);
        } else if (previewType === 'pdf') {
          const iframe = document.createElement('iframe');
          iframe.className = 'preview-pdf';
          iframe.src = previewUrl + '#toolbar=1';
          content.replaceChildren(iframe);
        } else if (previewType === 'video') {
          const video = document.createElement('video');
          video.className = 'preview-video';
          video.controls = true;
          video.autoplay = true;
          video.src = previewUrl;
          content.replaceChildren(video);
        } else if (previewType === 'audio') {
          const audio = document.createElement('audio');
          audio.className = 'preview-audio';
          audio.controls = true;
          audio.autoplay = true;
          audio.src = previewUrl;
          content.replaceChildren(audio);
        } else if (previewType === 'word') {
          await loadPreviewLibrary('mammoth');
          if (!window.mammoth) throw new Error('文档预览组件加载失败');
          const response = await fetch(previewUrl);
          if (!response.ok) throw new Error('文件读取失败');
          const buffer = await response.arrayBuffer();
          const result = await window.mammoth.convertToHtml({ arrayBuffer: buffer });
          const wrapper = document.createElement('div');
          wrapper.className = 'preview-markdown';
          wrapper.innerHTML = sanitizePreviewHtml(result.value);
          content.replaceChildren(wrapper);
        } else if (previewType === 'text') {
          const ext = (filename.split('.').pop() || '').toLowerCase();
          if (ext === 'txt') {
            await renderTxtReader(content, path, options && options.txtJump);
          } else {
            const response = await fetch(previewUrl);
            if (!response.ok) throw new Error('文件读取失败');
            const buffer = await response.arrayBuffer();
            const text = decodeTextBuffer(buffer);
            if (ext === 'md') {
            await loadPreviewLibrary('marked');
            const wrapper = document.createElement('div');
            wrapper.className = 'preview-markdown';
            wrapper.innerHTML = window.marked
              ? sanitizePreviewHtml(window.marked.parse(text))
              : sanitizePreviewHtml(text);
            content.replaceChildren(wrapper);
            } else {
              const pre = document.createElement('pre');
              pre.className = 'preview-text';
              if (ext === 'json') {
                try {
                  pre.textContent = JSON.stringify(JSON.parse(text), null, 2);
                } catch {
                  pre.textContent = text;
                }
              } else {
                pre.textContent = text;
              }
              content.replaceChildren(pre);
            }
          }
        } else {
          showPreviewError('不支持预览此文件类型');
        }
      } catch (error) {
        showPreviewError('预览加载失败: ' + error.message);
      }
    }

    async function renderTxtReader(content, path, jump) {
      content.classList.add('reader-mode');
      document.getElementById('readerTools').classList.add('active');
      document.getElementById('txtSearchPanel').hidden = true;
      document.getElementById('txtSearchInput').value = '';
      document.getElementById('txtSearchResults').replaceChildren();
      document.getElementById('txtSearchStatus').textContent = '';
      document.getElementById('txtSearchMore').hidden = true;

      const cachedWindow = await getTxtCachedWindow(path);
      const openParams = new URLSearchParams({ path: path });
      if (cachedWindow.etag && cachedWindow.records.length > 0) {
        openParams.set('cachedEtag', cachedWindow.etag);
        if (cachedWindow.records[0].encoding) {
          openParams.set('cachedEncoding', cachedWindow.records[0].encoding);
        }
        openParams.set('cached', cachedWindow.records
          .slice(0, 16)
          .map(function (record) { return String(record.byteStart); })
          .join(','));
      }
      if (jump && Number.isFinite(Number(jump.chunkByteOffset))) {
        openParams.set('byteOffset', String(Math.floor(Number(jump.chunkByteOffset))));
      }
      if (jump && Number.isFinite(Number(jump.chunkCharOffset))) {
        openParams.set('charOffset', String(Math.floor(Number(jump.chunkCharOffset))));
      }
      const openResponse = await fetch('/api/txt/open?' + openParams.toString(), { cache: 'no-store' });
      const openData = await openResponse.json().catch(function () { return {}; });
      if (!openResponse.ok || !openData.success) throw new Error(openData.message || 'TXT 打开失败');
      const meta = openData.meta;
      const savedProgress = jump ? null : openData.progress;

      const reader = document.createElement('div');
      reader.className = 'preview-reader';
      reader.style.fontSize = getReaderFontSize() + 'px';
      reader.tabIndex = 0;
      content.replaceChildren(reader);

      const responseChunks = Array.isArray(openData.chunks) ? openData.chunks : [];
      const usableChunks = [];
      responseChunks.forEach(function (chunk) {
        let record = null;
        if (chunk.cached && cachedWindow.etag === meta.etag) {
          record = cachedWindow.byStart.get(Number(chunk.byteStart)) || null;
        }
        const text = record ? record.text : chunk.text;
        if (typeof text !== 'string') return;
        const charStart = Number.isFinite(Number(chunk.charStart))
          ? Number(chunk.charStart)
          : Number(record && record.charStart || 0);
        usableChunks.push({
          byteStart: Number(chunk.byteStart),
          byteEnd: Number(chunk.byteEnd || (record && record.byteEnd) || chunk.byteStart),
          charStart,
          charEnd: chunk.charEnd !== null && chunk.charEnd !== undefined && Number.isFinite(Number(chunk.charEnd))
            ? Number(chunk.charEnd)
            : charStart + text.length,
          text
        });
      });
      const firstChunk = usableChunks[0] || null;
      const lastChunk = usableChunks[usableChunks.length - 1] || null;
      const state = {
        path,
        meta,
        reader,
        chunks: [],
        nextByteOffset: lastChunk
          ? Number(lastChunk.byteEnd)
          : Number(openData.target && openData.target.byteOffset || meta.byteOffset || 0),
        decodedChars: firstChunk
          ? Number(firstChunk.charStart)
          : Number(openData.target && openData.target.charOffset || 0),
        decoder: createTxtReaderDecoder(meta),
        decoderRemainder: new Uint8Array(),
        loadInFlight: null,
        done: false,
        saveInFlight: null,
        saveQueued: false,
        saveQueuedForce: false,
        pendingProgressSnapshot: null,
        progressRevision: Number(openData.progress && openData.progress.revision || 0),
        lastSavedPosition: null,
        lastSavedAt: 0,
        retryTimer: null,
        positioning: false,
        searchCursor: null,
        searchQuery: '',
        searchResults: [],
        index: meta.index || null,
        indexBuildInFlight: false
      };
      currentReader = state;
      updateReaderFontSizeLabel();

      usableChunks.forEach(function (chunk) {
        appendTxtReaderChunk(
          state,
          chunk.byteStart,
          chunk.byteEnd,
          chunk.text,
          chunk.charStart,
          chunk.charEnd
        );
      });
      if (lastChunk) {
        state.nextByteOffset = Number(lastChunk.byteEnd);
        state.decodedChars = Number(lastChunk.charEnd);
        state.done = state.nextByteOffset >= Number(meta.size || 0);
      }

      reader.addEventListener('scroll', function () {
        if (state.positioning) return;
        scheduleReaderProgressSave(state);
        if (reader.scrollTop + reader.clientHeight >= reader.scrollHeight - 480) {
          loadTxtReaderChunk(state);
        }
      }, { passive: true });

      const directPositionMessage = jump
        ? '正在打开搜索位置…'
        : savedProgress
          ? '正在恢复上次阅读位置…'
          : '';
      if (directPositionMessage) setTxtReaderLoading(state, true, directPositionMessage);
      try {
        if (state.chunks.length === 0) await loadTxtReaderChunk(state);
        if (jump && Number.isFinite(Number(jump.charOffset))) {
          state.searchQuery = typeof jump.query === 'string' ? jump.query : '';
          await waitForReaderLayout();
          let jumped = await highlightTxtSearchMatch(state, Number(jump.charOffset), Number(jump.matchLength || 0));
          if (!jumped) jumped = await scrollReaderToCharOffset(state, Number(jump.charOffset));
          if (!jumped) showToast('无法跳转到搜索位置', 'error');
          else await saveReaderProgress(state, true);
        } else {
          await restoreReaderProgress(state, savedProgress);
        }
      } finally {
        if (directPositionMessage) setTxtReaderLoading(state, false);
      }
      scheduleTxtReaderPrefetch(state, 2);
      await loadReaderBookmarks(state);
    }

    function createTxtReaderDecoder(meta) {
      return meta.encoding === 'utf-16be' ? null : new TextDecoder(meta.encoding || 'utf-8');
    }

    function decodeIncrementalTxtBytes(state, bytes, flush) {
      if (state.meta.encoding === 'utf-16be') {
        state.decoderRemainder = concatClientBytes(state.decoderRemainder, bytes);
        const completeLength = state.decoderRemainder.length - (state.decoderRemainder.length % 2);
        const complete = state.decoderRemainder.slice(0, completeLength);
        state.decoderRemainder = state.decoderRemainder.slice(completeLength);
        let text = decodeUtf16Be(complete);
        if (flush && state.decoderRemainder.length > 0) {
          text += '\ufffd';
          state.decoderRemainder = new Uint8Array();
        }
        return text;
      }
      return state.decoder.decode(bytes, { stream: !flush });
    }

    function concatClientBytes(first, second) {
      const result = new Uint8Array(first.length + second.length);
      result.set(first, 0);
      result.set(second, first.length);
      return result;
    }

    function scheduleTxtReaderPrefetch(state, count) {
      const run = function () {
        prefetchTxtReaderCache(state, count).catch(function (error) {
          console.warn('TXT nearby prefetch failed:', error);
        });
      };
      if (window.requestIdleCallback) {
        window.requestIdleCallback(run, { timeout: 1600 });
      } else {
        window.setTimeout(run, 350);
      }
    }

    async function prefetchTxtReaderCache(state, count) {
      let byteStart = Number(state.nextByteOffset || 0);
      let charStart = Number(state.decodedChars || 0);
      const decoderState = {
        meta: state.meta,
        decoder: createTxtReaderDecoder(state.meta),
        decoderRemainder: new Uint8Array()
      };
      for (let index = 0; index < count && byteStart < Number(state.meta.size || 0); index++) {
        if (currentReader !== state) return;
        const cached = await getTxtCachedChunk(state.path, state.meta.etag, byteStart);
        if (cached
          && Number(cached.charStart) === charStart
          && Number(cached.byteEnd) > byteStart) {
          byteStart = Number(cached.byteEnd);
          charStart = Number(cached.charEnd);
          continue;
        }
        const length = Math.min(Number(state.meta.chunkSize || 128 * 1024), Number(state.meta.size || 0) - byteStart);
        const response = await fetch('/api/txt/chunk?path=' + encodeURIComponent(state.path)
          + '&offset=' + encodeURIComponent(byteStart)
          + '&length=' + encodeURIComponent(length), {
          headers: { 'If-Match': state.meta.etag }
        });
        if (!response.ok) return;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length === 0 || currentReader !== state) return;
        let text = decodeIncrementalTxtBytes(decoderState, bytes, false);
        if (byteStart + bytes.length >= Number(state.meta.size || 0)) {
          text += decodeIncrementalTxtBytes(decoderState, new Uint8Array(), true);
        }
        const chunk = {
          byteStart,
          byteEnd: byteStart + bytes.length,
          charStart,
          charEnd: charStart + text.length,
          text
        };
        await putTxtCachedChunk(state, chunk);
        byteStart = chunk.byteEnd;
        charStart = chunk.charEnd;
      }
    }

    function appendTxtReaderChunk(state, byteStart, byteEnd, text, explicitCharStart, explicitCharEnd) {
      if (!text) return;
      const charStart = Number.isFinite(Number(explicitCharStart))
        ? Number(explicitCharStart)
        : state.decodedChars;
      const charEnd = explicitCharEnd !== null && explicitCharEnd !== undefined && Number.isFinite(Number(explicitCharEnd))
        ? Number(explicitCharEnd)
        : charStart + text.length;
      const element = document.createElement('span');
      element.className = 'txt-reader-chunk';
      element.textContent = text;
      state.reader.appendChild(element);
      const chunk = {
        byteStart,
        byteEnd,
        charStart,
        charEnd,
        text,
        element
      };
      state.chunks.push(chunk);
      state.decodedChars = charEnd;
      void putTxtCachedChunk(state, chunk).catch(function (error) {
        console.warn('TXT cache write failed:', error);
      });
    }

    async function loadTxtReaderChunk(state) {
      if (currentReader !== state || state.done || state.loadInFlight) return state.loadInFlight;
      if (state.nextByteOffset >= Number(state.meta.size || 0)) {
        state.done = true;
        return null;
      }

      state.loadInFlight = (async function () {
        const start = state.nextByteOffset;
        const cached = await getTxtCachedChunk(state.path, state.meta.etag, start);
        if (cached
          && typeof cached.text === 'string'
          && Number(cached.charStart) === Number(state.decodedChars)
          && Number(cached.byteEnd) > start) {
          state.nextByteOffset = Number(cached.byteEnd);
          appendTxtReaderChunk(
            state,
            start,
            state.nextByteOffset,
            cached.text,
            Number(cached.charStart),
            Number(cached.charEnd)
          );
          if (state.nextByteOffset >= Number(state.meta.size || 0)) state.done = true;
          return cached.text;
        }
        const length = Math.min(Number(state.meta.chunkSize || 128 * 1024), Number(state.meta.size || 0) - start);
        const response = await fetch('/api/txt/chunk?path=' + encodeURIComponent(state.path)
          + '&offset=' + encodeURIComponent(start)
          + '&length=' + encodeURIComponent(length), {
          headers: { 'If-Match': state.meta.etag }
        });
        if (!response.ok) throw new Error(response.status === 412 ? '文件已变化，请重新加载' : 'TXT 分片读取失败');

        const reader = response.body && response.body.getReader();
        if (!reader) throw new Error('TXT 分片响应为空');
        let bytesRead = 0;
        let decoded = '';
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            const bytes = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
            bytesRead += bytes.length;
            decoded += decodeIncrementalTxtBytes(state, bytes, false);
          }
        } finally {
          reader.releaseLock();
        }

        state.nextByteOffset = start + bytesRead;
        appendTxtReaderChunk(state, start, state.nextByteOffset, decoded);
        if (bytesRead === 0 || state.nextByteOffset >= Number(state.meta.size || 0)) {
          const tail = decodeIncrementalTxtBytes(state, new Uint8Array(), true);
          appendTxtReaderChunk(state, state.nextByteOffset, state.nextByteOffset, tail);
          state.done = true;
        }
        return decoded;
      })();

      try {
        return await state.loadInFlight;
      } finally {
        state.loadInFlight = null;
      }
    }

    async function ensureTxtByteLoaded(state, byteOffset) {
      const target = Math.max(Number(state.meta.byteOffset || 0), Math.floor(Number(byteOffset) || 0));
      while (!state.done && state.nextByteOffset <= target) {
        await loadTxtReaderChunk(state);
      }
      return state.done || state.nextByteOffset > target;
    }

    function findTxtChunkByByte(state, byteOffset) {
      const offset = Math.max(0, Math.floor(Number(byteOffset) || 0));
      const direct = state.chunks.find(function (chunk) {
        return offset >= chunk.byteStart && offset < chunk.byteEnd;
      });
      if (direct) return direct;
      const last = state.chunks[state.chunks.length - 1];
      return last && offset === last.byteEnd ? last : null;
    }

    function findTxtChunkByChar(state, charOffset) {
      const offset = Math.max(0, Math.floor(Number(charOffset) || 0));
      const direct = state.chunks.find(function (chunk) {
        return offset >= chunk.charStart && offset < chunk.charEnd;
      });
      if (direct) return direct;
      const last = state.chunks[state.chunks.length - 1];
      return last && offset === last.charEnd ? last : null;
    }

    // The TXT reader is itself a scroll container inside previewContent, which
    // is also scrollable. Child-scrolling APIs can choose the outer
    // preview container (notably in WebKit/mobile browsers), leaving the
    // reader's own scroll position unchanged. Always move the reader's own
    // scrollTop for search results, bookmarks, and restored positions.
    function scrollTxtReaderElementIntoView(state, element, anchorRatio) {
      if (!state || !state.reader || !element) return false;
      const reader = state.reader;
      const ratio = Number.isFinite(Number(anchorRatio))
        ? Math.max(0, Math.min(1, Number(anchorRatio)))
        : 0;
      const withinElement = Math.floor(Number(element.offsetHeight || 0) * ratio);
      const targetTop = Math.max(0, element.offsetTop + withinElement - Math.floor(reader.clientHeight * 0.28));
      reader.scrollTop = targetTop;
      return true;
    }

    async function scrollReaderToByteOffset(state, byteOffset, anchorRatio) {
      if (!Number.isFinite(byteOffset)) return false;
      await ensureTxtByteLoaded(state, byteOffset);
      const chunk = findTxtChunkByByte(state, Math.floor(byteOffset));
      if (!chunk) return false;
      const ratio = Number.isFinite(Number(anchorRatio))
        ? Number(anchorRatio)
        : chunk.byteEnd > chunk.byteStart
          ? (Number(byteOffset) - chunk.byteStart) / (chunk.byteEnd - chunk.byteStart)
          : 0;
      return scrollTxtReaderElementIntoView(state, chunk.element, ratio);
    }

    async function restoreReaderProgress(state, saved) {
      if (!saved || (saved.sourceEtag && saved.sourceEtag !== state.meta.etag)) return;
      await waitForReaderLayout();
      state.positioning = true;
      try {
        if (Number.isFinite(Number(saved.anchorCharOffset))) {
          const restored = await scrollReaderToCharOffset(state, Number(saved.anchorCharOffset));
          if (!restored && Number.isFinite(Number(saved.anchorByteOffset))) {
            await scrollReaderToByteOffset(state, Number(saved.anchorByteOffset));
          }
        } else if (Number.isFinite(Number(saved.byteOffset))) {
          await scrollReaderToByteOffset(state, Number(saved.byteOffset), Number(saved.anchorRatio || 0));
        } else {
          scrollReaderToProgress(state, saved.progress);
        }
      } finally {
        state.positioning = false;
      }
    }

    function waitForReaderLayout() {
      return new Promise(function (resolve) {
        requestAnimationFrame(function () {
          requestAnimationFrame(resolve);
        });
      });
    }

    async function scrollReaderToCharOffset(state, charOffset) {
      if (!Number.isFinite(charOffset)) return false;
      const target = Math.max(0, Math.floor(charOffset));
      const chunk = findTxtChunkByChar(state, target);
      if (!chunk && !state.done) {
        while (!state.done && state.decodedChars <= target) await loadTxtReaderChunk(state);
      }
      const resolvedChunk = findTxtChunkByChar(state, target);
      if (!resolvedChunk) return false;
      const ratio = resolvedChunk.charEnd > resolvedChunk.charStart
        ? (target - resolvedChunk.charStart) / (resolvedChunk.charEnd - resolvedChunk.charStart)
        : 0;
      return scrollTxtReaderElementIntoView(state, resolvedChunk.element, ratio);
    }

    function scrollReaderToProgress(state, progress) {
      const safeProgress = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
      const maxScrollTop = Math.max(0, state.reader.scrollHeight - state.reader.clientHeight);
      state.reader.scrollTop = maxScrollTop * safeProgress;
    }

    function getVisibleTxtChunk(state) {
      if (state.chunks.length === 0) return null;
      const readerRect = state.reader.getBoundingClientRect();
      const targetTop = readerRect.top + 32;
      return state.chunks.find(function (chunk) {
        const rect = chunk.element.getBoundingClientRect();
        return rect.bottom >= targetTop;
      }) || state.chunks[state.chunks.length - 1];
    }

    function getReaderAnchorPosition(state) {
      const chunk = getVisibleTxtChunk(state);
      if (!chunk) return null;
      const readerRect = state.reader.getBoundingClientRect();
      const chunkRect = chunk.element.getBoundingClientRect();
      const targetTop = readerRect.top + Math.min(96, Math.max(24, state.reader.clientHeight * 0.22));
      const anchorRatio = chunkRect.height > 0
        ? Math.max(0, Math.min(1, (targetTop - chunkRect.top) / chunkRect.height))
        : 0;
      const estimatedByteOffset = chunk.byteStart
        + Math.floor((chunk.byteEnd - chunk.byteStart) * anchorRatio);
      const estimatedCharOffset = chunk.charStart
        + Math.floor((chunk.charEnd - chunk.charStart) * anchorRatio);
      return { chunk, anchorRatio, estimatedByteOffset, estimatedCharOffset };
    }

    function getReaderByteOffset(state) {
      const position = getReaderAnchorPosition(state);
      return position ? position.chunk.byteStart : Number(state.meta.byteOffset || 0);
    }

    function getReaderCharOffset(state) {
      const position = getReaderAnchorPosition(state);
      return position ? position.chunk.charStart : 0;
    }

    function getReaderSnippet(state) {
      const position = getReaderAnchorPosition(state);
      if (!position) return '';
      const localStart = Math.max(0, position.estimatedCharOffset - position.chunk.charStart);
      return position.chunk.text.slice(localStart, localStart + 160);
    }

    function scheduleReaderProgressSave(state) {
      if (currentReader !== state) return;
      if (readerSaveTimer) clearTimeout(readerSaveTimer);
      readerSaveTimer = setTimeout(function () {
        readerSaveTimer = null;
        saveReaderProgress(state);
      }, 1800);
    }

    function stopReaderProgressTracking() {
      if (readerSaveTimer) {
        clearTimeout(readerSaveTimer);
        readerSaveTimer = null;
      }
      if (txtSearchAbortController) {
        txtSearchAbortController.abort();
        txtSearchAbortController = null;
      }
      if (txtSearchTimer) {
        clearTimeout(txtSearchTimer);
        txtSearchTimer = null;
      }
      const searchPanel = document.getElementById('txtSearchPanel');
      if (searchPanel) searchPanel.hidden = true;

      const state = currentReader;
      currentReader = null;
      if (state) saveReaderProgress(state, true);
    }

    function buildReaderProgressSnapshot(state) {
      const position = getReaderAnchorPosition(state);
      if (!position) return null;
      const byteOffset = position.chunk.byteStart;
      const charOffset = position.chunk.charStart;
      const anchorRatio = position.anchorRatio;
      const progress = Number(state.meta.size || 0) > 0
        ? Math.max(0, Math.min(1, position.estimatedByteOffset / Number(state.meta.size)))
        : 0;
      return {
        positionKey: byteOffset + ':' + Math.round(anchorRatio * 10000),
        payload: {
          path: state.path,
          charOffset,
          byteOffset,
          anchorCharOffset: position.estimatedCharOffset,
          anchorByteOffset: position.estimatedByteOffset,
          anchorRatio,
          baseRevision: state.progressRevision,
          sourceEtag: state.meta.etag,
          progress,
          scrollTop: state.reader.scrollTop,
          scrollHeight: state.reader.scrollHeight
        }
      };
    }

    async function saveReaderProgress(state, force, suppliedSnapshot) {
      const snapshot = suppliedSnapshot || buildReaderProgressSnapshot(state);
      if (!snapshot) return;
      const waitMs = 1100 - (Date.now() - state.lastSavedAt);
      if (!force && waitMs > 0) {
        state.pendingProgressSnapshot = snapshot;
        if (!state.retryTimer) {
          state.retryTimer = window.setTimeout(function () {
            state.retryTimer = null;
            const pending = state.pendingProgressSnapshot;
            state.pendingProgressSnapshot = null;
            saveReaderProgress(state, false, pending);
          }, waitMs);
        }
        return;
      }
      if (state.saveInFlight) {
        state.saveQueued = true;
        state.saveQueuedForce = state.saveQueuedForce || !!force;
        state.pendingProgressSnapshot = snapshot;
        return state.saveInFlight;
      }

      try {
        if (!force && snapshot.positionKey === state.lastSavedPosition) return;

        snapshot.payload.baseRevision = state.progressRevision;
        state.saveInFlight = fetch('/api/reader/progress', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snapshot.payload),
          keepalive: true
        });
        let response = await state.saveInFlight;
        let data = await response.json().catch(function () { return {}; });
        if (response.status === 409 && data.code === 'READER_PROGRESS_CONFLICT' && data.progress) {
          state.progressRevision = Number(data.progress.revision || state.progressRevision || 0);
          if (force) {
            snapshot.payload.baseRevision = state.progressRevision;
            state.saveInFlight = fetch('/api/reader/progress', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(snapshot.payload),
              keepalive: true
            });
            response = await state.saveInFlight;
            data = await response.json().catch(function () { return {}; });
          }
        }
        if (!response.ok) throw new Error(data.message || 'HTTP ' + response.status);
        if (data.progress) state.progressRevision = Number(data.progress.revision || state.progressRevision || 0);
        state.lastSavedPosition = snapshot.positionKey;
        state.lastSavedAt = Date.now();
      } catch (error) {
        console.warn('Reader progress save failed:', error);
      } finally {
        state.saveInFlight = null;
        if (state.saveQueued) {
          state.saveQueued = false;
          const queuedForce = state.saveQueuedForce;
          const pending = state.pendingProgressSnapshot;
          state.saveQueuedForce = false;
          state.pendingProgressSnapshot = null;
          window.setTimeout(function () { saveReaderProgress(state, queuedForce, pending); }, queuedForce ? 0 : 1100);
        }
      }
    }

    function getReaderFontSize() {
      try {
        const saved = Number(localStorage.getItem(READER_FONT_SIZE_KEY));
        if (Number.isFinite(saved)) return Math.max(12, Math.min(32, saved));
      } catch {}
      return 18;
    }

    function updateReaderFontSizeLabel() {
      document.getElementById('readerFontSize').textContent = String(getReaderFontSize());
    }

    async function adjustReaderFontSize(delta) {
      if (!currentReader) return;
      const state = currentReader;
      const position = getReaderAnchorPosition(state);
      const next = Math.max(12, Math.min(32, getReaderFontSize() + delta));
      try { localStorage.setItem(READER_FONT_SIZE_KEY, String(next)); } catch {}
      state.reader.style.fontSize = next + 'px';
      updateReaderFontSizeLabel();
      await waitForReaderLayout();
      if (position) await scrollReaderToByteOffset(state, position.chunk.byteStart, position.anchorRatio);
      scheduleReaderProgressSave(state);
    }

    function toggleBookmarkPanel(event) {
      if (event) event.stopPropagation();
      const panel = document.getElementById('bookmarkPanel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) document.getElementById('txtSearchPanel').hidden = true;
    }

    async function loadReaderBookmarks(state) {
      try {
        const response = await fetch('/api/reader/bookmarks?path=' + encodeURIComponent(state.path));
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '读取书签失败');
        if (currentReader !== state) return;
        readerBookmarks = data.bookmarks || [];
        renderReaderBookmarks();
      } catch {
        readerBookmarks = [];
        renderReaderBookmarks('书签加载失败');
      }
    }

    function renderReaderBookmarks(message) {
      const list = document.getElementById('bookmarkList');
      list.replaceChildren();
      if (message || readerBookmarks.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'bookmark-empty';
        empty.textContent = message || '还没有书签';
        list.appendChild(empty);
        return;
      }

      readerBookmarks.forEach(function (bookmark) {
        const item = document.createElement('div');
        item.className = 'bookmark-item';
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'bookmark-jump';
        jump.addEventListener('click', function () { jumpToReaderBookmark(bookmark); });
        const meta = document.createElement('div');
        meta.className = 'bookmark-meta';
        meta.textContent = Math.round((bookmark.progress || 0) * 100) + '%';
        const snippet = document.createElement('div');
        snippet.className = 'bookmark-snippet';
        snippet.textContent = bookmark.snippet || '无文字摘要';
        jump.append(meta, snippet);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-danger bookmark-delete';
        remove.textContent = '×';
        remove.setAttribute('aria-label', '删除书签');
        remove.addEventListener('click', function () { deleteReaderBookmark(bookmark.id); });
        item.append(jump, remove);
        list.appendChild(item);
      });
    }

    async function addCurrentBookmark() {
      if (!currentReader) return;
      const state = currentReader;
      const position = getReaderAnchorPosition(state);
      if (!position) return;
      const byteOffset = position.chunk.byteStart;
      const charOffset = position.chunk.charStart;
      const anchorRatio = position.anchorRatio;
      const progress = Number(state.meta.size || 0) > 0
        ? Math.max(0, Math.min(1, position.estimatedByteOffset / Number(state.meta.size)))
        : 0;
      const snippet = getReaderSnippet(state);
      try {
        const response = await fetch('/api/reader/bookmarks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: state.path, charOffset, byteOffset, anchorRatio, sourceEtag: state.meta.etag, progress, snippet })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '添加书签失败');
        readerBookmarks.unshift(data.bookmark);
        renderReaderBookmarks();
        showToast('书签已添加', 'success');
      } catch (error) {
        showToast(error.message, 'error');
      }
    }

    async function jumpToReaderBookmark(bookmark) {
      if (!currentReader) return;
      const state = currentReader;
      document.getElementById('bookmarkPanel').hidden = true;
      setTxtReaderLoading(state, true, '正在打开书签位置…');
      try {
        let jumped = false;
        if (Number.isFinite(Number(bookmark.byteOffset)) && Number.isFinite(Number(bookmark.charOffset))) {
          jumped = await resetReaderToIndexedWindow(state, {
            chunkByteOffset: Number(bookmark.byteOffset),
            chunkCharOffset: Number(bookmark.charOffset)
          });
          if (jumped) {
            const chunk = findTxtChunkByByte(state, Number(bookmark.byteOffset));
            let anchorRatio = bookmark.anchorRatio === null || bookmark.anchorRatio === undefined
              ? NaN
              : Number(bookmark.anchorRatio);
            if (!Number.isFinite(anchorRatio) && chunk && chunk.byteEnd > chunk.byteStart) {
              const estimatedByteOffset = Number(bookmark.progress || 0) * Number(state.meta.size || 0);
              anchorRatio = (estimatedByteOffset - chunk.byteStart) / (chunk.byteEnd - chunk.byteStart);
            }
            jumped = await scrollReaderToByteOffset(
              state,
              Number(bookmark.byteOffset),
              Number.isFinite(anchorRatio) ? Math.max(0, Math.min(1, anchorRatio)) : 0
            );
          }
        }
        if (!jumped) jumped = await scrollReaderToCharOffset(state, bookmark.charOffset);
        if (!jumped) scrollReaderToProgress(state, bookmark.progress);
        state.reader.focus();
        await saveReaderProgress(state, true);
      } catch (error) {
        showToast('书签跳转失败: ' + (error.message || '无法定位书签'), 'error');
      } finally {
        setTxtReaderLoading(state, false);
      }
    }

    async function deleteReaderBookmark(bookmarkId) {
      try {
        const response = await fetch('/api/reader/bookmarks/' + encodeURIComponent(bookmarkId), { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '删除书签失败');
        readerBookmarks = readerBookmarks.filter(function (bookmark) { return bookmark.id !== bookmarkId; });
        renderReaderBookmarks();
      } catch (error) {
        showToast(error.message, 'error');
      }
    }

    function toggleTxtSearchPanel(event) {
      if (event) event.stopPropagation();
      const panel = document.getElementById('txtSearchPanel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        document.getElementById('bookmarkPanel').hidden = true;
        document.getElementById('txtSearchInput').focus();
      }
    }

    async function ensureTxtIndex(state, controller) {
      if (!state || !state.meta) return false;
      const existing = state.index || state.meta.index;
      if (existing && existing.status === 'unavailable') return true;
      if (existing && existing.status === 'ready') return true;

      state.indexBuildInFlight = true;
      try {
        while (true) {
          if (controller.signal.aborted || currentReader !== state) return false;
          const response = await fetch('/api/txt/index?path=' + encodeURIComponent(state.path), {
            method: 'POST',
            cache: 'no-store',
            signal: controller.signal
          });
          const data = await response.json().catch(function () { return {}; });
          if (controller.signal.aborted || currentReader !== state) return false;
          if (!response.ok || !data.success) {
            throw new Error(data.message || 'TXT 正文索引建立失败');
          }

          if (data.index) {
            state.index = data.index;
            state.meta.index = data.index;
          }
          const index = data.index || state.index || {};
          const progress = Number.isFinite(Number(index.progress))
            ? Math.max(0, Math.min(100, Number(index.progress) * 100))
            : 0;
          document.getElementById('txtSearchStatus').textContent = index.status === 'ready'
            ? '正文索引已就绪，正在搜索…'
            : '正在建立正文索引… ' + progress.toFixed(progress >= 10 ? 0 : 1) + '%';
          if (data.done || index.status === 'ready') return true;
        }
      } finally {
        state.indexBuildInFlight = false;
      }
    }

    function handleTxtSearchKey(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        scheduleTxtSearch(0);
      } else if (event.key === 'Escape') {
        document.getElementById('txtSearchPanel').hidden = true;
      }
    }

    function clearTxtSearch() {
      const input = document.getElementById('txtSearchInput');
      input.value = '';
      if (txtSearchTimer) clearTimeout(txtSearchTimer);
      if (txtSearchAbortController) txtSearchAbortController.abort();
      txtSearchAbortController = null;
      if (currentReader) {
        clearTxtSearchHighlight(currentReader);
        currentReader.searchCursor = null;
        currentReader.searchQuery = '';
        currentReader.searchResults = [];
      }
      document.getElementById('txtSearchResults').replaceChildren();
      document.getElementById('txtSearchStatus').textContent = '';
      document.getElementById('txtSearchMore').hidden = true;
    }

    function scheduleTxtSearch(delay) {
      if (txtSearchTimer) clearTimeout(txtSearchTimer);
      if (txtSearchAbortController) txtSearchAbortController.abort();
      txtSearchAbortController = null;
      const query = document.getElementById('txtSearchInput').value;
      const wait = Number.isFinite(delay) ? delay : 280;
      txtSearchTimer = window.setTimeout(function () {
        txtSearchTimer = null;
        runTxtSearch(true, query);
      }, wait);
    }

    async function runTxtSearch(reset, queryOverride) {
      const state = currentReader;
      if (!state) return;
      const query = queryOverride === undefined
        ? document.getElementById('txtSearchInput').value
        : queryOverride;
      if (!query) {
        clearTxtSearch();
        return;
      }
      if (reset) {
        clearTxtSearchHighlight(state);
        state.searchCursor = null;
        state.searchQuery = query;
        state.searchResults = [];
        document.getElementById('txtSearchResults').replaceChildren();
      }
      if (state.searchQuery !== query) return;

      const controller = new AbortController();
      txtSearchAbortController = controller;
      let cursor = state.searchCursor;
      try {
        const indexReady = await ensureTxtIndex(state, controller);
        if (!indexReady || controller.signal.aborted || currentReader !== state || state.searchQuery !== query) return;
        do {
          const params = new URLSearchParams({
            path: state.path,
            q: query,
            limit: '50'
          });
          if (cursor) params.set('cursor', cursor);
          document.getElementById('txtSearchStatus').textContent = '正在搜索正文…';
          const response = await fetch('/api/txt/search?' + params.toString(), { signal: controller.signal });
          const data = await response.json();
          if (controller.signal.aborted || currentReader !== state || state.searchQuery !== query) return;
          if (!response.ok || !data.success) throw new Error(data.message || 'TXT 搜索失败');
          state.searchResults = state.searchResults.concat(data.results || []);
          cursor = data.nextCursor || null;
          state.searchCursor = cursor;
          renderTxtSearchResults(state);
        } while (cursor);
        document.getElementById('txtSearchStatus').textContent = state.searchResults.length
          ? '全文搜索完成，找到 ' + state.searchResults.length + ' 条'
          : '全文搜索完成，没有匹配项';
        document.getElementById('txtSearchMore').hidden = true;
      } catch (error) {
        if (error.name === 'AbortError') return;
        if (currentReader === state) document.getElementById('txtSearchStatus').textContent = error.message;
      } finally {
        if (txtSearchAbortController === controller) txtSearchAbortController = null;
      }
    }

    function loadMoreTxtSearch() {
      if (!currentReader || !currentReader.searchCursor) return;
      runTxtSearch(false, currentReader.searchQuery);
    }

    function renderTxtSearchResults(state) {
      const results = document.getElementById('txtSearchResults');
      results.replaceChildren();
      state.searchResults.forEach(function (result) {
        const row = document.createElement('div');
        row.className = 'txt-search-result';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', '跳转到正文匹配位置');
        const snippet = document.createElement('div');
        snippet.className = 'txt-search-snippet';
        const before = document.createElement('span');
        before.textContent = result.snippetBefore || '';
        const match = document.createElement('mark');
        match.textContent = result.match || state.searchQuery;
        const after = document.createElement('span');
        after.textContent = result.snippetAfter || '';
        const snippetBody = document.createElement('div');
        snippetBody.append(before, match, after);
        const meta = document.createElement('div');
        meta.className = 'txt-search-meta';
        if (Number.isFinite(Number(result.progressPercent))) {
          meta.textContent = '约 ' + Number(result.progressPercent).toFixed(2).replace(/\.00$/, '') + '%';
        } else if (Number.isFinite(Number(result.byteOffset))) {
          meta.textContent = '文件位置约 ' + Number(result.byteOffset).toLocaleString() + ' 字节';
        }
        snippet.append(snippetBody, meta);
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'btn btn-secondary txt-search-jump';
        jump.textContent = '跳转';
        function activateResult() {
          jumpToTxtSearchResult(state, result);
        }
        row.addEventListener('click', activateResult);
        row.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activateResult();
          }
        });
        jump.addEventListener('click', function (event) {
          event.stopPropagation();
          activateResult();
        });
        row.append(snippet, jump);
        results.appendChild(row);
      });
    }

    function clearTxtSearchHighlight(state) {
      if (!state || !state.chunks) return;
      state.chunks.forEach(function (chunk) {
        chunk.element.classList.remove('search-target');
        if (chunk.element.querySelector('.txt-search-highlight')) {
          chunk.element.replaceChildren(document.createTextNode(chunk.text));
        }
      });
    }

    async function highlightTxtSearchMatch(state, charOffset, matchLength) {
      const start = Math.max(0, Math.floor(Number(charOffset) || 0));
      const length = Math.max(1, Math.floor(Number(matchLength) || state.searchQuery.length || 1));
      const end = start + length;
      if (!Number.isFinite(end)) return false;
      if (!await scrollReaderToCharOffset(state, start)) return false;
      if (!await scrollReaderToCharOffset(state, end - 1)) return false;

      clearTxtSearchHighlight(state);
      let firstMark = null;
      state.chunks.forEach(function (chunk) {
        const overlapStart = Math.max(start, chunk.charStart);
        const overlapEnd = Math.min(end, chunk.charEnd);
        if (overlapStart >= overlapEnd) return;

        const localStart = overlapStart - chunk.charStart;
        const localEnd = overlapEnd - chunk.charStart;
        const fragment = document.createDocumentFragment();
        if (localStart > 0) fragment.appendChild(document.createTextNode(chunk.text.slice(0, localStart)));
        const mark = document.createElement('mark');
        mark.className = 'txt-search-highlight';
        mark.textContent = chunk.text.slice(localStart, localEnd);
        fragment.appendChild(mark);
        if (localEnd < chunk.text.length) fragment.appendChild(document.createTextNode(chunk.text.slice(localEnd)));
        chunk.element.replaceChildren(fragment);
        chunk.element.classList.add('search-target');
        if (!firstMark) firstMark = mark;
      });

      if (!firstMark) return false;
      return scrollTxtReaderElementIntoView(state, firstMark);
    }

    function setTxtReaderLoading(state, visible, message) {
      if (!state || !state.reader) return;
      const container = state.reader.parentElement;
      if (!container) return;
      let indicator = container.querySelector('.txt-reader-jump-overlay');
      if (!visible) {
        if (indicator) indicator.remove();
        state.reader.removeAttribute('aria-busy');
        return;
      }
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'txt-reader-jump-overlay';
        indicator.setAttribute('role', 'status');
        indicator.setAttribute('aria-live', 'polite');
        const card = document.createElement('div');
        card.className = 'txt-reader-jump-card';
        const spinner = document.createElement('div');
        spinner.className = 'txt-reader-jump-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        const label = document.createElement('div');
        label.className = 'txt-reader-jump-message';
        const hint = document.createElement('div');
        hint.className = 'txt-reader-jump-hint';
        hint.textContent = '将直接加载目标章节附近的正文';
        card.append(spinner, label, hint);
        indicator.appendChild(card);
        container.appendChild(indicator);
      }
      const label = indicator.querySelector('.txt-reader-jump-message');
      if (label) label.textContent = message || '正在加载…';
      state.reader.setAttribute('aria-busy', 'true');
    }

    async function resetReaderToIndexedWindow(state, result) {
      const byteOffset = Number(result && result.chunkByteOffset);
      const charOffset = Number(result && result.chunkCharOffset);
      if (!Number.isFinite(byteOffset)
        || byteOffset < Number(state.meta.byteOffset || 0)
        || byteOffset >= Number(state.meta.size || 0)
        || !Number.isFinite(charOffset)
        || charOffset < 0) return false;

      state.positioning = true;
      try {
        if (state.loadInFlight) await state.loadInFlight;
        state.reader.replaceChildren();
        state.chunks = [];
        state.nextByteOffset = Math.floor(byteOffset);
        state.decodedChars = Math.floor(charOffset);
        state.decoder = createTxtReaderDecoder(state.meta);
        state.decoderRemainder = new Uint8Array();
        state.done = false;
        await loadTxtReaderChunk(state);
        await waitForReaderLayout();
        return state.chunks.length > 0;
      } finally {
        state.positioning = false;
      }
    }

    async function jumpToTxtSearchResult(state, result) {
      if (currentReader !== state) return;
      document.getElementById('txtSearchPanel').hidden = true;
      setTxtReaderLoading(state, true, '正在跳转到搜索位置…');
      document.getElementById('txtSearchStatus').textContent = '正在跳转到搜索位置…';
      let completed = false;
      try {
        clearTxtSearchHighlight(state);
        await resetReaderToIndexedWindow(state, result);
        let jumped = false;
        if (Number.isFinite(Number(result.charOffset))) {
          jumped = await highlightTxtSearchMatch(state, Number(result.charOffset), Number(result.matchLength || state.searchQuery.length));
        }
        if (!jumped && Number.isFinite(Number(result.byteOffset))) {
          jumped = await scrollReaderToByteOffset(state, Number(result.byteOffset));
          const chunk = findTxtChunkByByte(state, Number(result.byteOffset));
          if (chunk) {
            chunk.element.classList.add('search-target');
            window.setTimeout(function () {
              chunk.element.classList.remove('search-target');
            }, 1800);
          }
        }
        if (!jumped) throw new Error('无法定位这条搜索结果');
        state.reader.focus();
        await saveReaderProgress(state, true);
        completed = true;
      } catch (error) {
        if (currentReader === state) {
          document.getElementById('txtSearchStatus').textContent = error.message || '跳转失败';
          showToast('跳转失败: ' + (error.message || '无法定位搜索位置'), 'error');
        }
      } finally {
        setTxtReaderLoading(state, false);
        if (completed && currentReader === state) {
          const progress = Number.isFinite(Number(result.progressPercent))
            ? '（约 ' + Number(result.progressPercent).toFixed(2).replace(/\.00$/, '') + '%）'
            : '';
          document.getElementById('txtSearchStatus').textContent = '已跳转到匹配位置' + progress;
        }
      }
    }

    function decodeTextBuffer(buffer) {
      const bytes = new Uint8Array(buffer);
      if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return decodeBytes(bytes.subarray(3), 'utf-8');
      }
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return decodeBytes(bytes.subarray(2), 'utf-16le');
      }
      if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return decodeUtf16Be(bytes.subarray(2));
      }

      const utf8Text = tryDecodeBytes(bytes, 'utf-8', { fatal: true });
      if (utf8Text !== null) return utf8Text;

      for (const label of ['gb18030', 'gbk']) {
        const decoded = tryDecodeBytes(bytes, label);
        if (decoded !== null) return decoded;
      }

      return decodeBytes(bytes, 'utf-8');
    }

    function tryDecodeBytes(bytes, label, options) {
      try {
        return new TextDecoder(label, options || {}).decode(bytes);
      } catch {
        return null;
      }
    }

    function decodeBytes(bytes, label) {
      const decoded = tryDecodeBytes(bytes, label);
      return decoded !== null ? decoded : latin1Fallback(bytes);
    }

    function latin1Fallback(bytes) {
      const chunkSize = 8192;
      let text = '';
      for (let index = 0; index < bytes.length; index += chunkSize) {
        text += String.fromCharCode.apply(null, Array.from(bytes.subarray(index, index + chunkSize)));
      }
      return text;
    }

    function decodeUtf16Be(bytes) {
      const chars = [];
      for (let index = 0; index + 1 < bytes.length; index += 2) {
        chars.push(String.fromCharCode((bytes[index] << 8) | bytes[index + 1]));
      }
      return chars.join('');
    }

    function sanitizePreviewHtml(html) {
      const template = document.createElement('template');
      template.innerHTML = html || '';
      const blockedTags = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base']);

      function cleanElement(element) {
        const tagName = element.tagName.toLowerCase();
        if (blockedTags.has(tagName)) {
          element.remove();
          return;
        }

        Array.from(element.attributes).forEach(function (attr) {
          const name = attr.name.toLowerCase();
          const value = attr.value.trim();

          if (name.startsWith('on') || name === 'srcdoc' || name === 'style') {
            element.removeAttribute(attr.name);
            return;
          }

          if (['href', 'src', 'xlink:href'].includes(name) && !isSafePreviewUrl(value, tagName, name)) {
            element.removeAttribute(attr.name);
          }
        });

        Array.from(element.children).forEach(cleanElement);
      }

      Array.from(template.content.children).forEach(cleanElement);
      return template.innerHTML;
    }

    function isSafePreviewUrl(value, tagName, attrName) {
      if (!value || value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
        return true;
      }

      let url;
      try {
        url = new URL(value, window.location.origin);
      } catch {
        return false;
      }

      if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return true;
      return tagName === 'img' && attrName === 'src' && url.protocol === 'data:' && /^data:image\\/(?:png|jpe?g|gif|webp);/i.test(value);
    }

    function showPreviewError(message) {
      const content = document.getElementById('previewContent');
      const error = document.createElement('div');
      error.className = 'preview-error';
      error.textContent = message;
      content.replaceChildren(error);
    }

    function closePreview() {
      stopReaderProgressTracking();
      document.getElementById('previewOverlay').classList.remove('active');
      document.getElementById('readerTools').classList.remove('active');
      document.getElementById('bookmarkPanel').hidden = true;
      const content = document.getElementById('previewContent');
      content.classList.remove('reader-mode');
      content.replaceChildren();
      readerBookmarks = [];
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closePreview();
    });

    document.addEventListener('click', function () {
      document.getElementById('bookmarkPanel').hidden = true;
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && currentReader) {
        saveReaderProgress(currentReader, true);
      }
    });

    async function handleFileUpload(event) {
      const files = Array.from(event.target.files || []);
      if (files.length === 0) return;

      const origin = lastTaskOriginElement;
      for (const file of files) {
        try {
          const task = await createTask({
            type: 'upload',
            title: '上传 ' + file.name,
            name: file.name,
            destinationPath: currentPath,
            totalBytes: file.size || 0
          }, origin);
          enqueueUpload(task, file, currentPath);
        } catch (error) {
          showToast('创建上传任务失败: ' + error.message, 'error');
        }
      }
      event.target.value = '';
      processUploadQueue();
    }

    async function handleFolderUpload(event) {
      const files = Array.from(event.target.files || []);
      if (files.length === 0) {
        showToast('所选文件夹为空，无法上传', 'warning');
        event.target.value = '';
        return;
      }

      const origin = lastTaskOriginElement;
      const folderPaths = new Set();
      files.forEach(function (file) {
        const relativePath = file.webkitRelativePath || file.name;
        const parts = relativePath.split('/').filter(Boolean);
        for (let index = 0; index < parts.length - 1; index++) {
          folderPaths.add(normalizeClientPath(currentPath + '/' + parts.slice(0, index + 1).join('/')));
        }
      });

      for (const folderPath of Array.from(folderPaths).sort(function (a, b) { return a.length - b.length; })) {
        try {
          await fetch('/api/folders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: folderPath })
          });
        } catch (error) {
          console.warn('Folder pre-create failed:', folderPath, error);
        }
      }

      for (const file of files) {
        const relativePath = file.webkitRelativePath || file.name;
        const targetFilePath = normalizeClientPath(currentPath + '/' + relativePath);
        const targetParentPath = parentClientPath(targetFilePath);
        try {
          const task = await createTask({
            type: 'upload',
            title: '上传 ' + relativePath,
            name: file.name,
            destinationPath: targetParentPath,
            totalBytes: file.size || 0
          }, origin);
          enqueueUpload(task, file, targetParentPath);
        } catch (error) {
          showToast('创建上传任务失败: ' + error.message, 'error');
        }
      }
      event.target.value = '';
      processUploadQueue();
    }

    function enqueueUpload(task, file, path) {
      uploadQueue.push({ task: task, file: file, path: path });
    }

    function processUploadQueue() {
      while (activeUploadCount < 2 && uploadQueue.length > 0) {
        const item = uploadQueue.shift();
        const latest = taskStore.get(item.task.id);
        if (latest && latest.status === 'canceled') continue;
        activeUploadCount++;
        uploadFileWithProgress(item.task, item.file, item.path).finally(function () {
          activeUploadCount--;
          processUploadQueue();
        });
      }
    }

    function uploadFileWithProgress(task, file, path) {
      return new Promise(function (resolve) {
        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        let lastUpdate = 0;
        formData.append('file', file);
        xhr.open('POST', apiFileUrl('/api/files', path));
        activeUploadXhrs.set(task.id, xhr);
        xhr.upload.onprogress = function (event) {
          if (!event.lengthComputable) return;
          const now = Date.now();
          if (now - lastUpdate < 800 && event.loaded < event.total) return;
          lastUpdate = now;
          patchTaskProgress(task.id, {
            status: 'running',
            processedBytes: event.loaded,
            totalBytes: event.total
          }).catch(function () {});
        };
        xhr.onload = async function () {
          activeUploadXhrs.delete(task.id);
          if (canceledLocalTasks.has(task.id) || !taskStore.has(task.id)) {
            resolve();
            return;
          }
          try {
            const data = JSON.parse(xhr.responseText || '{}');
            if (xhr.status >= 200 && xhr.status < 300 && data.success) {
              await patchTaskProgress(task.id, {
                status: 'succeeded',
                processedBytes: file.size || task.totalBytes || 0,
                totalBytes: file.size || task.totalBytes || 0,
                result: { path: data.path }
              }, true);
              if (path === currentPath || path.startsWith(currentPath === '/' ? '/' : currentPath + '/')) await loadFiles();
            } else {
              throw new Error(data.message || xhr.statusText || '上传失败');
            }
          } catch (error) {
            await patchTaskProgress(task.id, {
              status: 'failed',
              errorMessage: error.message
            }, true).catch(function () {});
          }
          resolve();
        };
        xhr.onerror = async function () {
          activeUploadXhrs.delete(task.id);
          await patchTaskProgress(task.id, {
            status: 'failed',
            errorMessage: '网络连接失败'
          }, true).catch(function () {});
          resolve();
        };
        xhr.onabort = function () {
          activeUploadXhrs.delete(task.id);
          resolve();
        };
        xhr.send(formData);
      });
    }

    function showNewFolderModal() {
      document.getElementById('folderName').value = '';
      document.getElementById('newFolderModal').classList.add('active');
    }

    async function createFolder(event) {
      event.preventDefault();
      const name = document.getElementById('folderName').value.trim();
      if (!name) {
        showToast('请输入文件夹名称', 'error');
        return;
      }

      closeModal('newFolderModal');
      try {
        let folderPath = currentPath;
        if (!folderPath.endsWith('/')) folderPath += '/';
        folderPath += name;
        const response = await fetch('/api/folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: folderPath })
        });
        const data = await response.json();
        if (data.success) {
          const cached = directoryCache.get(directoryCacheKey(currentPath));
          if (cached && !(cached.folders || []).some(function (item) { return item.path === data.path; })) {
            cached.folders = (cached.folders || []).concat({ name: name, path: data.path, tags: [] });
            cached.folders.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); });
            applyDirectoryListing(cached);
          }
          showToast('文件夹创建成功', 'success');
          loadFiles({ background: true });
        } else {
          showToast('创建失败: ' + (data.message || '未知错误'), 'error');
        }
      } catch (error) {
        showToast('创建失败: ' + error.message, 'error');
      }
    }

    function showRenameModal(path, currentName) {
      document.getElementById('renameFilePath').value = path;
      document.getElementById('newFileName').value = currentName;
      document.getElementById('renameModal').classList.add('active');
    }

    async function renameFile(event) {
      event.preventDefault();
      const path = document.getElementById('renameFilePath').value;
      const newName = document.getElementById('newFileName').value.trim();
      if (!newName) {
        showToast('请输入新名称', 'error');
        return;
      }

      closeModal('renameModal');
      try {
        const response = await fetch(apiFileUrl('/api/files', path), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newName })
        });
        const data = await response.json();
        if (data.success) {
          const cached = directoryCache.get(directoryCacheKey(currentPath));
          if (cached) {
            const item = (cached.files || []).find(function (entry) { return entry.path === path; });
            if (item) {
              item.path = data.newPath || parentClientPath(path) + (parentClientPath(path) === '/' ? '' : '/') + newName;
              item.name = newName;
            }
            applyDirectoryListing(cached);
          }
          favoritePaths.delete(path);
          if (data.task) {
            mergeTask(data.task);
            if (!runningTaskLoops.has(data.task.id)) runCopyMoveTaskLoop(data.task.id);
            showToast('重命名任务已创建', 'info');
          } else {
            showToast('重命名成功', 'success');
          }
          loadFiles({ background: true });
        } else {
          showToast('重命名失败: ' + (data.message || '未知错误'), 'error');
        }
      } catch (error) {
        showToast('重命名失败: ' + error.message, 'error');
      }
    }

    function initializeBatchFolderSearch() {
      const input = document.getElementById('batchFolderSearch');
      if (!input) return;

      input.addEventListener('input', function () {
        if (folderSearchTimer) clearTimeout(folderSearchTimer);
        folderSearchTimer = window.setTimeout(function () {
          searchBatchFolders(input.value);
        }, 300);
      });

      input.addEventListener('focus', function () {
        searchBatchFolders(input.value);
      });
    }

    function clearBatchFolderSearchResults() {
      const results = document.getElementById('batchFolderSearchResults');
      if (!results) return;
      results.classList.remove('active');
      results.replaceChildren();
    }

    async function searchBatchFolders(query) {
      const results = document.getElementById('batchFolderSearchResults');
      if (!results) return;

      const requestId = ++folderSearchRequestId;
      results.classList.add('active');
      results.replaceChildren(createFolderSearchMessage('搜索中...'));

      try {
        const response = await fetch('/api/folders/search?q=' + encodeURIComponent(query || '') + '&limit=50');
        const data = await response.json();
        if (requestId !== folderSearchRequestId) return;
        results.replaceChildren();

        if (!data.success) {
          results.appendChild(createFolderSearchMessage(data.message || '搜索失败'));
          return;
        }

        if (!data.folders || data.folders.length === 0) {
          results.appendChild(createFolderSearchMessage('没有匹配的文件夹'));
          return;
        }

        data.folders.forEach(function (folder) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'folder-search-item';
          button.textContent = folder.path;
          button.addEventListener('click', function () {
            document.getElementById('batchDestinationPath').value = folder.path;
            document.getElementById('batchFolderSearch').value = folder.path;
            clearBatchFolderSearchResults();
          });
          results.appendChild(button);
        });

        if (data.truncated) {
          results.appendChild(createFolderSearchMessage('仅显示前 50 条结果，请输入更精确的关键词'));
        }
      } catch (error) {
        if (requestId !== folderSearchRequestId) return;
        results.replaceChildren(createFolderSearchMessage('搜索失败: ' + error.message));
      }
    }

    function createFolderSearchMessage(message) {
      const div = document.createElement('div');
      div.className = 'folder-search-empty';
      div.textContent = message;
      return div;
    }

    function showBatchTargetModal(operation) {
      const items = getSelectedItems();
      if (items.length === 0) {
        showToast('请先选择文件或文件夹', 'error');
        return;
      }

      batchTaskOriginElement = lastTaskOriginElement;
      document.getElementById('batchOperation').value = operation;
      document.getElementById('batchDestinationPath').value = currentView === 'files' ? currentPath : '/';
      document.getElementById('batchFolderSearch').value = '';
      clearBatchFolderSearchResults();
      document.getElementById('batchTargetTitle').textContent = operation === 'copy' ? '复制到' : '移动到';
      document.getElementById('batchTargetModal').classList.add('active');
      searchBatchFolders('');
    }

    async function submitBatchTarget(event) {
      event.preventDefault();
      const operation = document.getElementById('batchOperation').value;
      const destinationPath = document.getElementById('batchDestinationPath').value.trim() || '/';
      closeModal('batchTargetModal');
      await runBatchOperation(operation, destinationPath);
    }

    async function batchDelete() {
      const items = getSelectedItems();
      if (items.length === 0) {
        showToast('请先选择文件或文件夹', 'error');
        return;
      }

      if (!window.confirm('确定要删除选中的 ' + items.length + ' 项吗？此操作不可恢复。')) return;
      batchTaskOriginElement = lastTaskOriginElement;
      await runBatchOperation('delete', '/');
    }

    async function batchDownload() {
      const items = getSelectedItems();
      if (items.length === 0) {
        showToast('请先选择文件或文件夹', 'error');
        return;
      }

      let task = null;
      try {
        task = await createTask({
          type: 'batch_download',
          title: '批量下载 ' + items.length + ' 项',
          items: items
        }, lastTaskOriginElement);
        startNativeDownload('/api/tasks/' + encodeURIComponent(task.id) + '/download');
        await patchTaskProgress(task.id, {
          status: 'succeeded',
          processedItems: items.length,
          totalItems: items.length,
          result: {
            nativeDownload: true,
            items: items.map(function (item) {
              return {
                path: item.path,
                name: item.name || ''
              };
            })
          }
        }, true);
      } catch (error) {
        if (task) {
          await patchTaskProgress(task.id, { status: 'failed', errorMessage: error.message }, true).catch(function () {});
        } else {
          showToast('批量下载失败: ' + error.message, 'error');
        }
      }
    }

    async function runBatchOperation(operation, destinationPath) {
      const items = getSelectedItems();
      if (items.length === 0) return;

      if (operation === 'copy' || operation === 'move' || operation === 'delete') {
        try {
          const verb = operation === 'move' ? '移动' : operation === 'delete' ? '删除' : '复制';
          const task = await createTask({
            type: operation,
            title: verb + ' ' + items.length + ' 项',
            destinationPath: destinationPath,
            items: items
          }, batchTaskOriginElement || lastTaskOriginElement);
          clearSelection();
          showToast(verb + '任务已开始', 'info');
          runCopyMoveTaskLoop(task.id);
        } catch (error) {
          showToast('创建批量任务失败: ' + error.message, 'error');
        } finally {
          batchTaskOriginElement = null;
        }
        return;
      }

      showLoading(true);
      try {
        const response = await fetch('/api/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operation: operation,
            destinationPath: destinationPath,
            items: items
          })
        });
        const data = await response.json();
        if (data.success) {
          const failed = Array.isArray(data.errors) ? data.errors.length : 0;
          showToast(failed > 0 ? '部分项目操作失败，已完成其余项目' : '批量操作成功', failed > 0 ? 'info' : 'success');
          if (failed > 0 && data.errors[0]) {
            showToast(data.errors[0].path + ': ' + data.errors[0].message, 'error');
          }
          clearSelection();
          await loadFiles();
        } else {
          const detail = data.errors && data.errors[0] ? data.errors[0].message : (data.message || '未知错误');
          showToast('批量操作失败: ' + detail, 'error');
        }
      } catch (error) {
        showToast('批量操作失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    async function downloadFile(path, originElement) {
      let task = null;
      try {
        task = await createTask({
          type: 'download',
          title: '下载 ' + (path.split('/').pop() || '文件'),
          path: path
        }, originElement || lastTaskOriginElement);
        startNativeDownload('/api/tasks/' + encodeURIComponent(task.id) + '/download');
        await patchTaskProgress(task.id, {
          status: 'succeeded',
          processedBytes: task.totalBytes || 0,
          totalBytes: task.totalBytes || 0,
          result: { nativeDownload: true }
        }, true);
      } catch (error) {
        if (task && (canceledLocalTasks.has(task.id) || !taskStore.has(task.id))) return;
        if (task) {
          await patchTaskProgress(task.id, { status: 'failed', errorMessage: error.message }, true).catch(function () {});
        } else {
          showToast('下载失败: ' + error.message, 'error');
        }
      }
    }

    function showShareModal(items) {
      const shareItems = Array.isArray(items) ? items : [{ path: items }];
      document.getElementById('shareFilePath').value = shareItems[0]?.path || '';
      document.getElementById('shareItems').value = JSON.stringify(shareItems.map(function (item) {
        return {
          path: item.path,
          name: item.name || '',
          itemType: item.isFolder ? 'folder' : 'file'
        };
      }));
      document.getElementById('sharePassword').value = '';
      document.getElementById('shareExpiry').value = '1d';
      document.getElementById('shareModal').classList.add('active');
    }

    function batchShare() {
      const items = getSelectedItems();
      if (items.length === 0) {
        showToast('请选择要分享的文件或文件夹', 'error');
        return;
      }
      showShareModal(items);
    }

    async function createShare(event) {
      event.preventDefault();
      const filePath = document.getElementById('shareFilePath').value;
      const shareItemsValue = document.getElementById('shareItems').value;
      const password = document.getElementById('sharePassword').value;
      const expiresIn = document.getElementById('shareExpiry').value;
      let items = [];

      try {
        items = shareItemsValue ? JSON.parse(shareItemsValue) : [];
      } catch {
        items = [];
      }

      showLoading(true);
      closeModal('shareModal');
      try {
        const payload = {
          password: password,
          expiresIn: expiresIn
        };
        if (items.length > 0) {
          payload.items = items;
        } else {
          payload.filePath = filePath;
        }

        const response = await fetch('/api/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (data.success) {
          const fullUrl = window.location.origin + data.shareUrl;
          document.getElementById('shareResultUrl').value = fullUrl;
          renderShareQr(fullUrl);
          document.getElementById('shareResultModal').classList.add('active');
        } else {
          showToast('创建分享链接失败: ' + (data.message || '未知错误'), 'error');
        }
      } catch (error) {
        showToast('创建分享链接失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function copyShareLink() {
      const input = document.getElementById('shareResultUrl');
      input.select();
      const text = input.value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          showToast('链接已复制', 'success');
        }).catch(function () {
          document.execCommand('copy');
          showToast('链接已复制', 'success');
        });
      } else {
        document.execCommand('copy');
        showToast('链接已复制', 'success');
      }
    }

    function renderShareQr(text) {
      const canvas = document.getElementById('shareQrCanvas');
      if (!canvas) return;
      try {
        const qr = createQrMatrix(text);
        const ctx = canvas.getContext('2d');
        const quiet = 4;
        const scale = Math.max(1, Math.floor(canvas.width / (qr.size + quiet * 2)));
        const imageSize = (qr.size + quiet * 2) * scale;
        const offset = Math.floor((canvas.width - imageSize) / 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000000';
        for (let y = 0; y < qr.size; y++) {
          for (let x = 0; x < qr.size; x++) {
            if (qr.matrix[y][x]) {
              ctx.fillRect(offset + (x + quiet) * scale, offset + (y + quiet) * scale, scale, scale);
            }
          }
        }
      } catch {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#111111';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('链接过长', canvas.width / 2, canvas.height / 2);
      }
    }

    function createQrMatrix(text) {
      const version = 6;
      const size = 17 + version * 4;
      const dataCodewords = 136;
      const blockCount = 2;
      const blockDataCodewords = 68;
      const eccCodewords = 18;
      const bytes = Array.from(new TextEncoder().encode(text));
      const bits = [];

      function pushBits(value, length) {
        for (let i = length - 1; i >= 0; i--) {
          bits.push((value >>> i) & 1);
        }
      }

      if (bytes.length > dataCodewords - 3) {
        throw new Error('QR payload too long');
      }

      pushBits(4, 4);
      pushBits(bytes.length, 8);
      bytes.forEach(function (byte) {
        pushBits(byte, 8);
      });

      const capacityBits = dataCodewords * 8;
      for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
      while (bits.length % 8 !== 0) bits.push(0);

      const data = [];
      for (let i = 0; i < bits.length; i += 8) {
        let value = 0;
        for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
        data.push(value);
      }
      for (let pad = 0xec; data.length < dataCodewords; pad ^= 0xec ^ 0x11) {
        data.push(pad);
      }

      const blocks = [];
      for (let block = 0; block < blockCount; block++) {
        const blockData = data.slice(block * blockDataCodewords, (block + 1) * blockDataCodewords);
        blocks.push({ data: blockData, ecc: reedSolomonCompute(blockData, eccCodewords) });
      }

      const codewords = [];
      for (let i = 0; i < blockDataCodewords; i++) {
        for (let block = 0; block < blockCount; block++) codewords.push(blocks[block].data[i]);
      }
      for (let i = 0; i < eccCodewords; i++) {
        for (let block = 0; block < blockCount; block++) codewords.push(blocks[block].ecc[i]);
      }

      const matrix = Array.from({ length: size }, function () { return Array(size).fill(false); });
      const isFunction = Array.from({ length: size }, function () { return Array(size).fill(false); });

      function setModule(x, y, dark, func) {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        matrix[y][x] = !!dark;
        if (func) isFunction[y][x] = true;
      }

      function drawFinder(cx, cy) {
        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            setModule(cx + dx, cy + dy, dist !== 2 && dist <= 3, true);
          }
        }
      }

      function drawAlignment(cx, cy) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            setModule(cx + dx, cy + dy, dist === 2 || dist === 0, true);
          }
        }
      }

      function drawFormat(mask) {
        const bits = getFormatBits(1, mask);
        for (let i = 0; i <= 5; i++) setModule(8, i, ((bits >>> i) & 1) !== 0, true);
        setModule(8, 7, ((bits >>> 6) & 1) !== 0, true);
        setModule(8, 8, ((bits >>> 7) & 1) !== 0, true);
        setModule(7, 8, ((bits >>> 8) & 1) !== 0, true);
        for (let i = 9; i < 15; i++) setModule(14 - i, 8, ((bits >>> i) & 1) !== 0, true);
        for (let i = 0; i < 8; i++) setModule(size - 1 - i, 8, ((bits >>> i) & 1) !== 0, true);
        for (let i = 8; i < 15; i++) setModule(8, size - 15 + i, ((bits >>> i) & 1) !== 0, true);
        setModule(8, size - 8, true, true);
      }

      drawFinder(3, 3);
      drawFinder(size - 4, 3);
      drawFinder(3, size - 4);
      for (let i = 8; i < size - 8; i++) {
        setModule(6, i, i % 2 === 0, true);
        setModule(i, 6, i % 2 === 0, true);
      }
      drawAlignment(34, 34);
      drawFormat(0);

      let bitIndex = 0;
      let upward = true;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right--;
        for (let vertical = 0; vertical < size; vertical++) {
          const y = upward ? size - 1 - vertical : vertical;
          for (let j = 0; j < 2; j++) {
            const x = right - j;
            if (isFunction[y][x]) continue;
            let dark = false;
            if (bitIndex < codewords.length * 8) {
              dark = ((codewords[Math.floor(bitIndex / 8)] >>> (7 - (bitIndex % 8))) & 1) !== 0;
            }
            bitIndex++;
            if ((x + y) % 2 === 0) dark = !dark;
            setModule(x, y, dark, false);
          }
        }
        upward = !upward;
      }
      drawFormat(0);
      return { size: size, matrix: matrix };
    }

    function getFormatBits(ecl, mask) {
      let data = (ecl << 3) | mask;
      let bits = data << 10;
      for (let i = 14; i >= 10; i--) {
        if (((bits >>> i) & 1) !== 0) {
          bits ^= 0x537 << (i - 10);
        }
      }
      return ((data << 10) | bits) ^ 0x5412;
    }

    function reedSolomonCompute(data, degree) {
      const divisor = Array(degree).fill(0);
      divisor[degree - 1] = 1;
      let root = 1;
      for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
          divisor[j] = gfMultiply(divisor[j], root);
          if (j + 1 < degree) divisor[j] ^= divisor[j + 1];
        }
        root = gfMultiply(root, 2);
      }

      const result = Array(degree).fill(0);
      data.forEach(function (byte) {
        const factor = byte ^ result.shift();
        result.push(0);
        for (let i = 0; i < degree; i++) {
          result[i] ^= gfMultiply(divisor[i], factor);
        }
      });
      return result;
    }

    function gfMultiply(x, y) {
      let z = 0;
      for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        if (((y >>> i) & 1) !== 0) z ^= x;
      }
      return z & 0xff;
    }

    async function logout() {
      try {
        await fetch('/api/logout', { method: 'POST' });
      } finally {
        window.location.href = '/login.html';
      }
    }

    function closeModal(id) {
      document.getElementById(id).classList.remove('active');
    }

    function showLoading(show) {
      document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none';
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

    function installClientErrorHandlers() {
      window.addEventListener('error', function (event) {
        const message = event && event.message ? event.message : '页面脚本错误';
        console.error('Client script error:', event.error || message);
        showToast('页面脚本错误: ' + message, 'error');
      });
      window.addEventListener('unhandledrejection', function (event) {
        const reason = event && event.reason;
        const message = reason && reason.message ? reason.message : String(reason || '未处理的异步错误');
        console.error('Unhandled promise rejection:', reason || message);
        showToast('页面请求错误: ' + message, 'error');
      });
    }

    installClientErrorHandlers();
    async function initializeApp() {
      initializeBatchFolderSearch();
      const ready = await loadBootstrap();
      if (!ready) return;
      startTaskMonitor();
    }

    initializeApp();
  </script>
</body>
</html>
`;
export { FIXED_INDEX_PAGE };
