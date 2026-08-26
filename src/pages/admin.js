import { CSS_STYLES } from './styles.js';
import { THEME_BOOTSTRAP, THEME_TOGGLE_BUTTON } from './theme.js';

const FIXED_ADMIN_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>管理后台 - EdgeStashPro</title>
  ${THEME_BOOTSTRAP}
  ${CSS_STYLES}
</head>
<body>
  <div class="header">
    <div class="logo">EdgeStashPro 管理后台</div>
    <div class="header-actions">
      <label class="storage-switcher" for="adminStorageSelector">
        <span>存储</span>
        <select id="adminStorageSelector" class="form-select" onchange="handleAdminStorageChange()"></select>
      </label>
      ${THEME_TOGGLE_BUTTON}
      <button type="button" class="btn btn-secondary" onclick="window.location.href='/'">返回云盘</button>
      <button type="button" class="btn btn-secondary" onclick="logout()">退出登录</button>
    </div>
  </div>

  <div class="container">
    <div class="tabs">
      <button type="button" class="tab active" onclick="switchTab('stats', event)">统计数据</button>
      <button type="button" class="tab" onclick="switchTab('shares', event)">分享链接</button>
      <button type="button" class="tab" onclick="switchTab('users', event)">授权用户</button>
      <button type="button" class="tab" onclick="switchTab('storages', event)">存储</button>
    </div>

    <div id="statsTab" class="tab-content active">
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value" id="totalShares">0</div><div class="stat-label">总分享链接数</div></div>
        <div class="stat-card"><div class="stat-value" id="totalViews">0</div><div class="stat-label">总浏览次数</div></div>
        <div class="stat-card"><div class="stat-value" id="totalDownloads">0</div><div class="stat-label">总下载次数</div></div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">小说全文索引（.txt）</div>
        </div>
        <p style="margin: 0 0 12px; opacity: 0.75; font-size: 14px;">
          为网盘中的 .txt 小说建立正文索引，建立后即可使用全文搜索并跳转到对应段落。新上传的 .txt 文件会自动在后台建立索引；此按钮用于批量处理存量文件。
        </p>
        <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
          <button type="button" class="btn btn-primary" id="rebuildTxtIndexBtn" onclick="rebuildTxtIndexes(false)">重建全部小说索引</button>
          <label style="font-size: 14px; display: inline-flex; align-items: center; gap: 6px;">
            <input type="checkbox" id="rebuildTxtForce"> 强制重建（忽略已有索引）
          </label>
        </div>
        <div id="rebuildTxtProgress" style="display: none; margin-top: 12px;">
          <progress id="rebuildTxtProgressBar" value="0" max="100" style="width: 100%;"></progress>
          <div id="rebuildTxtProgressText" style="font-size: 13px; opacity: 0.75; margin-top: 6px;"></div>
        </div>
      </div>
    </div>

    <div id="sharesTab" class="tab-content">
      <div class="card">
        <div class="card-header"><div class="card-title">分享链接管理</div></div>
        <div class="table-container">
          <table>
            <thead><tr><th>文件名</th><th>分享ID</th><th>密码保护</th><th>浏览次数</th><th>下载次数</th><th>状态</th><th>操作</th></tr></thead>
            <tbody id="sharesTable"></tbody>
          </table>
        </div>
      </div>
    </div>

    <div id="usersTab" class="tab-content">
      <div class="card">
        <div class="card-header">
          <div class="card-title">授权用户管理</div>
          <button type="button" class="btn btn-primary" onclick="showAddUserModal()">添加用户</button>
        </div>
        <div class="table-container">
          <table>
            <thead><tr><th>邮箱</th><th>角色</th><th>授权资源</th><th>创建时间</th><th>操作</th></tr></thead>
            <tbody id="usersTable"></tbody>
          </table>
        </div>
      </div>
    </div>
    <div id="storagesTab" class="tab-content">
      <div class="card">
        <div class="card-header">
          <div class="card-title">S3 兼容存储</div>
          <button type="button" class="btn btn-primary" onclick="showStorageModal()">添加存储</button>
        </div>
        <div class="table-container">
          <table class="storage-table">

            <thead><tr><th>名称</th><th>Bucket</th><th>状态</th><th>最后刷新时间</th><th>操作</th></tr></thead>
            <tbody id="storagesTable"></tbody>
          </table>
        </div>
      </div>
    </div>

  </div>

  <div class="modal-overlay" id="addUserModal">
    <div class="modal modal-wide">
      <div class="modal-header">
        <div class="modal-title" id="userModalTitle">添加授权用户</div>
        <button type="button" class="modal-close" onclick="closeModal('addUserModal')">&times;</button>
      </div>
      <form onsubmit="addUser(event)">
        <div class="form-group">
          <label class="form-label" for="newUserEmail">邮箱</label>
          <input type="email" id="newUserEmail" class="form-input" placeholder="请输入邮箱" required>
        </div>
        <div class="form-group" id="newUserPasswordGroup">
          <label class="form-label" for="newUserPassword">密码</label>
          <input type="text" id="newUserPassword" class="form-input" placeholder="请输入密码" required>
        </div>
        <div class="form-group">
          <label class="form-label" for="resourceSearchInput">授权文件或目录</label>
          <div class="resource-picker-toolbar">
            <input type="search" id="resourceSearchInput" class="form-input" placeholder="搜索文件或目录">
            <select id="resourceTypeFilter" class="form-select">
              <option value="all">全部</option>
              <option value="folder">文件夹</option>
              <option value="file">文件</option>
            </select>
          </div>
          <div class="resource-list" id="resourceSearchResults"></div>
        </div>
        <div class="form-group">
          <label class="form-label">已选资源权限</label>
          <div class="permission-list" id="selectedPermissionList"></div>
        </div>
        <button type="submit" class="btn btn-primary" id="userModalSubmit" style="width: 100%;">添加用户</button>
      </form>
    </div>
  </div>

  <div class="modal-overlay" id="storageModal">
    <div class="modal modal-wide">
      <div class="modal-header">
        <div class="modal-title" id="storageModalTitle">添加 S3 存储</div>
        <button type="button" class="modal-close" onclick="closeModal('storageModal')">&times;</button>
      </div>
      <form onsubmit="saveStorage(event)">
        <input type="hidden" id="storageId">
        <div class="form-group">
          <label class="form-label" for="storageName">名称</label>
          <input id="storageName" class="form-input" maxlength="80" placeholder="例如 阿里云OSS" required>
        </div>
        <div class="form-group">
          <label class="form-label" for="storageProvider">存储类型</label>
          <select id="storageProvider" class="form-select" onchange="applyProviderPreset()">
            <option value="custom">其他 S3 兼容</option>
            <option value="aliyun">阿里云 OSS</option>
            <option value="tencent">腾讯云 COS</option>
            <option value="r2">Cloudflare R2</option>
            <option value="aws">AWS S3</option>
            <option value="minio">MinIO / 自建</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="storageEndpoint">S3 Endpoint</label>
          <input id="storageEndpoint" class="form-input" type="url" placeholder="https://cos.ap-nanjing.myqcloud.com" required>
        </div>
        <div class="resource-picker-toolbar">
          <div class="form-group" style="flex:1">
            <label class="form-label" for="storageRegion">Region</label>
            <input id="storageRegion" class="form-input" placeholder="例如 ap-nanjing / oss-cn-hongkong / auto" required>
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label" for="storageBucket">Bucket</label>
            <input id="storageBucket" class="form-input" placeholder="例如 backupdata-1256711880" required>
          </div>
        </div>
        <div class="resource-picker-toolbar">
          <div class="form-group" style="flex:1">
            <label class="form-label" for="storageAddressingStyle">寻址方式</label>
            <select id="storageAddressingStyle" class="form-select"><option value="path">Path style</option><option value="virtual">Virtual host style</option></select>
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label" for="storageSyncInterval">自动同步
              <span class="field-hint" tabindex="0" aria-label="自动同步说明" title="定时把 Bucket 中的文件和目录结构同步到 D1 目录索引，供浏览、搜索、权限和分享使用。选择「仅手工」时，只能通过列表中的「同步」按钮或页面刷新触发。">?</span>
            </label>
            <select id="storageSyncInterval" class="form-select">
              <option value="0">仅手工</option><option value="15">15 分钟</option><option value="60">1 小时</option>
              <option value="360">6 小时</option><option value="1440" selected>24 小时</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="storageAccessKeyId">Access Key ID（SecretId）</label>
          <input id="storageAccessKeyId" class="form-input" autocomplete="off" placeholder="例如 AKID... / LTAI...">
        </div>
        <div class="form-group">
          <label class="form-label" for="storageSecretAccessKey">Secret Access Key（SecretKey）</label>
          <input id="storageSecretAccessKey" class="form-input" type="password" autocomplete="new-password" placeholder="请输入密钥">
        </div>
        <div class="form-group">
          <label class="form-label" for="storageSessionToken">Session Token（可选）</label>
          <input id="storageSessionToken" class="form-input" type="password" autocomplete="new-password" placeholder="仅临时凭证需要填写">
        </div>
        <label style="display:inline-flex;gap:8px;align-items:center;margin-bottom:16px">
          <input type="checkbox" id="storageEnabled" checked> 启用
        </label>
        <div style="display:flex;gap:10px">
          <button type="button" class="btn btn-secondary" onclick="testStorageForm()">测试连接</button>
          <button type="submit" class="btn btn-primary" style="flex:1">保存</button>
        </div>
      </form>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>
  <div class="loading-overlay" id="loadingOverlay" style="display: none;"><div class="spinner"></div></div>

  <script>
    const selectedPermissions = new Map();
    let resourceSearchTimer = null;
    let resourceSearchRequestId = 0;
    let editingUserEmail = '';
    let currentStorageId = '';
    let availableStorages = [];
    let managedStorages = [];

    const nativeFetch = window.fetch.bind(window);

    function adminStorageApiUrl(value) {
      if (!currentStorageId || typeof value !== 'string') return value;
      let url;
      try { url = new URL(value, window.location.origin); } catch { return value; }
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return value;
      if (url.pathname === '/api/storages' || url.pathname === '/api/auth/check'
        || url.pathname === '/api/logout' || url.pathname.startsWith('/api/admin/storages')) return value;
      if (!url.searchParams.has('storageId')) url.searchParams.set('storageId', currentStorageId);
      return value.startsWith('http://') || value.startsWith('https://')
        ? url.toString()
        : url.pathname + url.search + url.hash;
    }

    window.fetch = function (input, init) {
      return nativeFetch(adminStorageApiUrl(input), init);
    };

    const permissionPresetFlags = {
      readonly: { view: true, preview: true, download: true, upload: false, modify: false, delete: false, share: false },
      uploader: { view: true, preview: true, download: true, upload: true, modify: false, delete: false, share: false },
      editor: { view: true, preview: true, download: true, upload: true, modify: true, delete: false, share: false },
      manager: { view: true, preview: true, download: true, upload: true, modify: true, delete: true, share: true },
      custom: { view: true, preview: true, download: true, upload: false, modify: false, delete: false, share: false }
    };
    const permissionLabels = {
      view: '查看',
      preview: '预览',
      download: '下载',
      upload: '上传',
      modify: '修改',
      delete: '删除',
      share: '分享'
    };

    async function checkAdminAuth() {
      try {
        const response = await fetch('/api/auth/check');
        const data = await response.json();
        if (!data.authenticated || data.role !== 'admin') {
          window.location.href = '/login.html';
          return false;
        }
        return true;
      } catch {
        window.location.href = '/login.html';
        return false;
      }
    }

    function switchTab(tab, event) {
      document.querySelectorAll('.tab').forEach(function (item) {
        item.classList.remove('active');
      });
      document.querySelectorAll('.tab-content').forEach(function (item) {
        item.classList.remove('active');
      });
      event.target.classList.add('active');
      document.getElementById(tab + 'Tab').classList.add('active');
      if (tab === 'stats') loadStats();
      if (tab === 'shares') loadShares();
      if (tab === 'users') loadUsers();
      if (tab === 'storages') loadStorages();
    }

    async function loadStats() {
      try {
        const response = await fetch('/api/admin/stats');
        const data = await response.json();
        if (data.success) {
          document.getElementById('totalShares').textContent = data.totalShares;
          document.getElementById('totalViews').textContent = data.totalViews;
          document.getElementById('totalDownloads').textContent = data.totalDownloads;
        }
      } catch (error) {
        showToast('加载统计数据失败: ' + error.message, 'error');
      }
    }

    let rebuildTxtRunning = false;

    async function rebuildTxtIndexes(forceOverride) {
      if (rebuildTxtRunning) return;
      const force = forceOverride || document.getElementById('rebuildTxtForce').checked;
      const button = document.getElementById('rebuildTxtIndexBtn');
      const progressBox = document.getElementById('rebuildTxtProgress');
      const progressBar = document.getElementById('rebuildTxtProgressBar');
      const progressText = document.getElementById('rebuildTxtProgressText');

      rebuildTxtRunning = true;
      button.disabled = true;
      progressBox.style.display = 'block';
      progressBar.value = 0;
      progressText.textContent = '正在准备…';

      let cursor = '';
      let processed = 0;
      let indexed = 0;
      let skipped = 0;
      let missing = 0;
      let failed = 0;
      let total = 0;

      try {
        for (;;) {
          const response = await fetch('/api/admin/txt/rebuild', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force, cursor, batch: 5 })
          });
          const data = await response.json();
          if (!data.success) throw new Error(data.message || '重建失败');

          total = data.total || 0;
          processed += data.batch || 0;
          indexed += data.indexed || 0;
          skipped += data.skipped || 0;
          missing += data.missing || 0;
          failed += (data.details || []).filter(item => item.status === 'error').length;
          cursor = data.cursor || cursor;

          const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 100;
          progressBar.value = percent;
          progressText.textContent = '进度 ' + percent + '%（已处理 ' + processed + '/' + total
            + '，新建 ' + indexed + '，跳过 ' + skipped + (missing ? '，缺失 ' + missing : '') + (failed ? '，失败 ' + failed : '') + '）';

          if (data.done) break;
        }
        progressText.textContent = '完成：共 ' + total + ' 本，新建索引 ' + indexed + '，跳过 ' + skipped
          + (missing ? '，已删除 ' + missing : '') + (failed ? '，失败 ' + failed : '') + '。';
        showToast('小说索引重建完成', 'success');
      } catch (error) {
        progressText.textContent = '重建中断：' + error.message;
        showToast('重建小说索引失败: ' + error.message, 'error');
      } finally {
        rebuildTxtRunning = false;
        button.disabled = false;
      }
    }

    async function loadShares() {
      showLoading(true);
      try {
        const response = await fetch('/api/admin/shares');
        const data = await response.json();
        const tbody = document.getElementById('sharesTable');
        tbody.replaceChildren();
        if (!data.success) throw new Error(data.message || '加载失败');
        if (data.shares.length === 0) {
          appendEmptyRow(tbody, 7, '暂无分享链接');
          return;
        }
        data.shares.forEach(function (share) {
          const tr = document.createElement('tr');
          appendCell(tr, share.fileName);
          appendCell(tr, share.shareId);
          appendCell(tr, share.passwordHash ? '是' : '否');
          appendCell(tr, String(share.viewCount || 0));
          appendCell(tr, String(share.downloadCount || 0));
          appendCell(tr, share.isExpired ? '已过期' : '有效');
          const actions = document.createElement('td');
          actions.appendChild(createSmallButton('复制链接', 'btn-secondary', function () {
            copyShareLink(share.shareId);
          }));
          actions.appendChild(createSmallButton('删除', 'btn-danger', function () {
            deleteShare(share.shareId);
          }));
          tr.appendChild(actions);
          tbody.appendChild(tr);
        });
      } catch (error) {
        showToast('加载分享列表失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    async function loadUsers() {
      showLoading(true);
      try {
        const response = await fetch('/api/admin/users');
        const data = await response.json();
        const tbody = document.getElementById('usersTable');
        tbody.replaceChildren();
        if (!data.success) throw new Error(data.message || '加载失败');
        if (data.users.length === 0) {
          appendEmptyRow(tbody, 5, '暂无授权用户');
          return;
        }
        data.users.forEach(function (user) {
          const tr = document.createElement('tr');
          appendCell(tr, user.email);
          appendCell(tr, user.role === 'admin' ? '管理员' : '普通用户');
          const permissionText = user.permissionCount
            ? user.permissionCount + ' 个资源' + ((user.permissions || []).length ? '：' + user.permissions.map(function (item) {
              return item.path + '（' + item.summary + '）';
            }).join('；') : '')
            : '未授权';
          appendCell(tr, permissionText);
          appendCell(tr, user.createdAt ? new Date(user.createdAt).toLocaleString() : '-');
          const actions = document.createElement('td');
          actions.appendChild(createSmallButton('编辑授权', 'btn-secondary', function () {
            showEditUserModal(user.email);
          }));
          actions.appendChild(createSmallButton('撤销授权', 'btn-danger', function () {
            deleteUser(user.email);
          }));
          tr.appendChild(actions);
          tbody.appendChild(tr);
        });
      } catch (error) {
        showToast('加载用户列表失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function appendCell(tr, value) {
      const td = document.createElement('td');
      td.textContent = value == null ? '' : value;
      tr.appendChild(td);
    }

    function appendEmptyRow(tbody, colspan, message) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = colspan;
      td.style.textAlign = 'center';
      td.style.color = 'var(--text-muted)';
      td.textContent = message;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    function createSmallButton(label, className, handler) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm ' + className;
      button.textContent = label;
      button.addEventListener('click', handler);
      return button;
    }

    function showAddUserModal() {
      editingUserEmail = '';
      document.getElementById('userModalTitle').textContent = '添加授权用户';
      document.getElementById('userModalSubmit').textContent = '添加用户';
      document.getElementById('newUserEmail').value = '';
      document.getElementById('newUserEmail').disabled = false;
      document.getElementById('newUserPassword').value = '';
      document.getElementById('newUserPassword').required = true;
      document.getElementById('newUserPasswordGroup').style.display = 'block';
      document.getElementById('resourceSearchInput').value = '';
      document.getElementById('resourceTypeFilter').value = 'all';
      selectedPermissions.clear();
      renderSelectedPermissions();
      document.getElementById('addUserModal').classList.add('active');
      searchResources('');
    }

    async function showEditUserModal(email) {
      editingUserEmail = email;
      document.getElementById('userModalTitle').textContent = '编辑用户授权';
      document.getElementById('userModalSubmit').textContent = '保存授权';
      document.getElementById('newUserEmail').value = email;
      document.getElementById('newUserEmail').disabled = true;
      document.getElementById('newUserPassword').value = '';
      document.getElementById('newUserPassword').required = false;
      document.getElementById('newUserPasswordGroup').style.display = 'none';
      document.getElementById('resourceSearchInput').value = '';
      document.getElementById('resourceTypeFilter').value = 'all';
      selectedPermissions.clear();
      renderSelectedPermissions();
      document.getElementById('addUserModal').classList.add('active');
      searchResources('');

      showLoading(true);
      try {
        const response = await fetch('/api/admin/users/' + encodeURIComponent(email) + '/permissions');
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '加载失败');
        (data.permissions || []).forEach(function (permission) {
          selectedPermissions.set(permission.path, {
            path: permission.path,
            name: permission.name || permission.path,
            itemType: permission.itemType,
            preset: 'custom',
            permissions: permission.permissions || { ...permissionPresetFlags.readonly }
          });
        });
        renderSelectedPermissions();
        searchResources('');
      } catch (error) {
        closeModal('addUserModal');
        showToast('加载用户授权失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    async function addUser(event) {
      event.preventDefault();
      const email = document.getElementById('newUserEmail').value.trim();
      const password = document.getElementById('newUserPassword').value;
      const permissions = Array.from(selectedPermissions.values()).map(function (item) {
        return {
          path: item.path,
          itemType: item.itemType,
          preset: item.preset,
          permissions: item.permissions
        };
      });
      if (permissions.length === 0) {
        showToast('请至少选择一个授权文件或目录', 'error');
        return;
      }
      showLoading(true);
      closeModal('addUserModal');
      try {
        const url = editingUserEmail
          ? '/api/admin/users/' + encodeURIComponent(editingUserEmail) + '/permissions'
          : '/api/admin/users';
        const response = await fetch(url, {
          method: editingUserEmail ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editingUserEmail
            ? { permissions: permissions }
            : { email: email, password: password, permissions: permissions })
        });
        const data = await response.json();
        if (data.success) {
          showToast(editingUserEmail ? '用户授权已更新' : '用户添加成功', 'success');
          editingUserEmail = '';
          loadUsers();
        } else {
          showToast((editingUserEmail ? '保存失败: ' : '添加失败: ') + (data.message || '未知错误'), 'error');
        }
      } catch (error) {
        showToast((editingUserEmail ? '保存失败: ' : '添加失败: ') + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function initializeResourcePicker() {
      const input = document.getElementById('resourceSearchInput');
      const type = document.getElementById('resourceTypeFilter');
      if (!input || !type) return;

      input.addEventListener('input', function () {
        if (resourceSearchTimer) clearTimeout(resourceSearchTimer);
        resourceSearchTimer = window.setTimeout(function () {
          searchResources(input.value);
        }, 250);
      });

      type.addEventListener('change', function () {
        searchResources(input.value);
      });
    }

    async function searchResources(query) {
      const results = document.getElementById('resourceSearchResults');
      if (!results) return;
      const requestId = ++resourceSearchRequestId;
      const type = document.getElementById('resourceTypeFilter').value;
      results.replaceChildren(createResourceMessage('搜索中...'));

      try {
        const response = await fetch('/api/admin/resources/search?q=' + encodeURIComponent(query || '') + '&type=' + encodeURIComponent(type) + '&limit=80');
        const data = await response.json();
        if (requestId !== resourceSearchRequestId) return;
        results.replaceChildren();
        if (!data.success) {
          results.appendChild(createResourceMessage(data.message || '搜索失败'));
          return;
        }
        if (!data.items || data.items.length === 0) {
          results.appendChild(createResourceMessage('没有匹配的资源'));
          return;
        }
        data.items.forEach(function (item) {
          results.appendChild(createResourceRow(item));
        });
      } catch (error) {
        if (requestId !== resourceSearchRequestId) return;
        results.replaceChildren(createResourceMessage('搜索失败: ' + error.message));
      }
    }

    function createResourceMessage(message) {
      const div = document.createElement('div');
      div.className = 'permission-empty';
      div.textContent = message;
      return div;
    }

    function createResourceRow(item) {
      const normalized = normalizeClientItem(item);
      const row = document.createElement('label');
      row.className = 'resource-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedPermissions.has(normalized.path);
      checkbox.addEventListener('change', function () {
        if (checkbox.checked) {
          addSelectedPermission(normalized);
        } else {
          selectedPermissions.delete(normalized.path);
          renderSelectedPermissions();
        }
      });

      const main = document.createElement('div');
      main.className = 'resource-main';
      const name = document.createElement('div');
      name.className = 'resource-name';
      name.textContent = (normalized.itemType === 'folder' ? '文件夹 ' : '文件 ') + normalized.name;
      const path = document.createElement('div');
      path.className = 'resource-path';
      path.textContent = normalized.path;
      main.appendChild(name);
      main.appendChild(path);

      const badge = document.createElement('span');
      badge.className = 'badge badge-info';
      badge.textContent = normalized.itemType === 'folder' ? '目录' : '文件';

      row.appendChild(checkbox);
      row.appendChild(main);
      row.appendChild(badge);
      return row;
    }

    function normalizeClientItem(item) {
      const isFolder = item.itemType === 'folder' || item.item_type === 'folder' || item.isFolder;
      return {
        path: item.path || '/',
        name: item.name || (item.path === '/' ? '根目录' : item.path),
        itemType: isFolder ? 'folder' : 'file'
      };
    }

    function addSelectedPermission(item) {
      if (!selectedPermissions.has(item.path)) {
        selectedPermissions.set(item.path, {
          path: item.path,
          name: item.name,
          itemType: item.itemType,
          preset: 'readonly',
          permissions: { ...permissionPresetFlags.readonly }
        });
      }
      renderSelectedPermissions();
    }

    function renderSelectedPermissions() {
      const list = document.getElementById('selectedPermissionList');
      if (!list) return;
      list.replaceChildren();
      if (selectedPermissions.size === 0) {
        list.appendChild(createResourceMessage('尚未选择授权资源'));
        return;
      }

      selectedPermissions.forEach(function (item) {
        const row = document.createElement('div');
        row.className = 'permission-row';

        const main = document.createElement('div');
        main.className = 'permission-main';
        const path = document.createElement('div');
        path.className = 'permission-path';
        path.textContent = item.path;
        const summary = document.createElement('div');
        summary.className = 'permission-summary';
        summary.textContent = (item.itemType === 'folder' ? '目录' : '文件') + ' · ' + summarizeClientPermissions(item.permissions);
        main.appendChild(path);
        main.appendChild(summary);

        const select = document.createElement('select');
        select.className = 'form-select';
        [
          ['readonly', '只读'],
          ['uploader', '可上传'],
          ['editor', '可编辑'],
          ['manager', '完全管理'],
          ['custom', '自定义']
        ].forEach(function (option) {
          const el = document.createElement('option');
          el.value = option[0];
          el.textContent = option[1];
          select.appendChild(el);
        });
        select.value = item.preset;
        select.addEventListener('change', function () {
          item.preset = select.value;
          if (select.value !== 'custom') {
            item.permissions = { ...permissionPresetFlags[select.value] };
          }
          renderSelectedPermissions();
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-sm btn-danger icon-btn';
        remove.textContent = '×';
        remove.addEventListener('click', function () {
          selectedPermissions.delete(item.path);
          renderSelectedPermissions();
          searchResources(document.getElementById('resourceSearchInput').value);
        });

        row.appendChild(main);
        row.appendChild(select);
        row.appendChild(remove);

        if (item.preset === 'custom') {
          row.appendChild(createPermissionChecks(item));
        }

        list.appendChild(row);
      });
    }

    function createPermissionChecks(item) {
      const checks = document.createElement('div');
      checks.className = 'permission-checks';
      Object.keys(permissionLabels).forEach(function (key) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!item.permissions[key];
        input.addEventListener('change', function () {
          item.permissions[key] = input.checked;
          if (['preview', 'download', 'upload', 'modify', 'delete', 'share'].includes(key) && input.checked) {
            item.permissions.view = true;
          }
          if (key === 'view' && !input.checked && ['preview', 'download', 'upload', 'modify', 'delete', 'share'].some(function (name) {
            return item.permissions[name];
          })) {
            item.permissions.view = true;
          }
          renderSelectedPermissions();
        });
        label.appendChild(input);
        label.appendChild(document.createTextNode(permissionLabels[key]));
        checks.appendChild(label);
      });
      return checks;
    }

    function summarizeClientPermissions(permissions) {
      return Object.keys(permissionLabels).filter(function (key) {
        return !!permissions[key];
      }).map(function (key) {
        return permissionLabels[key];
      }).join('、') || '无权限';
    }

    async function deleteUser(email) {
      if (!window.confirm('确定要撤销该用户的授权吗？')) return;
      showLoading(true);
      try {
        const response = await fetch('/api/admin/users/' + encodeURIComponent(email), { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
          showToast('用户已删除', 'success');
          loadUsers();
        } else {
          showToast('删除失败: ' + (data.message || '未知错误'), 'error');
        }
      } catch (error) {
        showToast('删除失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    async function deleteShare(shareId) {
      if (!window.confirm('确定要删除该分享链接吗？')) return;
      showLoading(true);
      try {
        const response = await fetch('/api/admin/shares/' + encodeURIComponent(shareId), { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
          showToast('分享链接已删除', 'success');
          loadShares();
        } else {
          showToast('删除失败: ' + (data.message || '未知错误'), 'error');
        }
      } catch (error) {
        showToast('删除失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function copyShareLink(shareId) {
      const url = window.location.origin + '/s/' + shareId;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          showToast('链接已复制', 'success');
        }).catch(function () {
          showToast('复制失败', 'error');
        });
      } else {
        showToast(url, 'info');
      }
    }

    async function loadAdminStorageOptions() {
      const response = await fetch('/api/storages');
      const data = await response.json().catch(function () { return {}; });
      if (!response.ok || !data.success) throw new Error(data.message || '读取存储列表失败');
      availableStorages = data.storages || [];
      const select = document.getElementById('adminStorageSelector');
      select.replaceChildren();
      if (availableStorages.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '请先配置存储';
        select.appendChild(option);
        select.disabled = true;
        currentStorageId = '';
        return;
      }
      select.disabled = false;
      availableStorages.forEach(function (storage) {
        const option = document.createElement('option');
        option.value = storage.id;
        option.textContent = storage.name + (storage.isDefault ? '（默认）' : '');
        select.appendChild(option);
      });
      const saved = localStorage.getItem('edgestash:active-storage:admin');
      const selected = availableStorages.find(function (storage) { return storage.id === currentStorageId; })
        || availableStorages.find(function (storage) { return storage.id === saved; })
        || availableStorages.find(function (storage) { return storage.isDefault; })
        || availableStorages[0];
      currentStorageId = selected.id;
      select.value = currentStorageId;
      localStorage.setItem('edgestash:active-storage:admin', currentStorageId);
    }

    async function handleAdminStorageChange() {
      const next = document.getElementById('adminStorageSelector').value;
      if (!next || next === currentStorageId) return;
      currentStorageId = next;
      localStorage.setItem('edgestash:active-storage:admin', currentStorageId);
      selectedPermissions.clear();
      await Promise.all([loadStats(), loadShares(), loadUsers()]);
    }

    function storageActionButton(label, handler, danger, hidden) {
      if (hidden) return null;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ' + (danger ? 'btn-danger' : 'btn-secondary');
      button.textContent = label;
      button.addEventListener('click', handler);
      return button;
    }
    function storageStatusLabel(storage) {
      if (!storage.enabled) return '已停用';
      const labels = {
        queued: '排队中',
        running: '同步中',
        succeeded: '已同步',
        failed: '同步失败',
        canceled: '已取消',
        setup_required: '待配置',
        error: '配置错误'
      };
      return labels[storage.lastSyncStatus] || storage.lastSyncStatus || '未同步';
    }

    function storageSyncTimeLabel(value) {
      if (!value) return '从未';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '从未';
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(date);
    }


    async function loadStorages() {
      try {
        const response = await fetch('/api/admin/storages');
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '读取存储失败');
        managedStorages = data.storages || [];
        const table = document.getElementById('storagesTable');
        table.replaceChildren();
        managedStorages.filter(function (storage) { return !storage.deletedAt; }).forEach(function (storage) {
          const row = document.createElement('tr');
          const name = document.createElement('td');
          name.dataset.label = '名称';
          name.textContent = storage.name + (storage.isDefault ? '（默认）' : '');
          const bucket = document.createElement('td');
          bucket.dataset.label = 'Bucket';
          bucket.textContent = storage.bucket;
          const status = document.createElement('td');
          status.dataset.label = '状态';
          status.textContent = storageStatusLabel(storage);
          if (storage.lastSyncError) status.title = storage.lastSyncError;
          const lastSync = document.createElement('td');
          lastSync.dataset.label = '最后刷新时间';
          lastSync.textContent = storageSyncTimeLabel(storage.lastSyncAt);
          const actions = document.createElement('td');
          actions.className = 'actions';
          actions.dataset.label = '操作';
          const actionButtons = [
            storageActionButton('编辑', function () { showStorageModal(storage.id); }),
            storageActionButton('手动同步', function () { syncStorage(storage.id); }),
            storageActionButton(storage.enabled ? '停用' : '启用', function () { toggleStorage(storage); }),
            storageActionButton('设为默认', function () { setDefaultStorage(storage); }, false, storage.isDefault),
            storageActionButton('删除', function () { deleteStorage(storage); }, true)
          ].filter(function (button) { return button; });
          actionButtons.forEach(function (button) { actions.appendChild(button); });
          row.append(name, bucket, status, lastSync, actions);
          table.appendChild(row);
        });
      } catch (error) {
        showToast('加载存储失败: ' + error.message, 'error');
      }
    }

    const PROVIDER_PRESETS = {
      aliyun: {
        endpoint: 'https://oss-<region>.aliyuncs.com',
        region: 'oss-cn-hongkong',
        addressingStyle: 'virtual',
        addressingLocked: true,
        endpointHint: 'https://oss-cn-hongkong.aliyuncs.com',
        regionHint: 'oss-cn-hongkong（华东等地域同理，如 oss-cn-shanghai）',
        keyHint: 'LTAI...（AccessKey ID）'
      },
      tencent: {
        endpoint: 'https://cos.<region>.myqcloud.com',
        region: 'ap-nanjing',
        addressingStyle: 'virtual',
        addressingLocked: true,
        endpointHint: 'https://cos.ap-nanjing.myqcloud.com（不带 bucket 前缀）',
        regionHint: 'ap-nanjing（如 ap-shanghai / ap-guangzhou）',
        keyHint: 'AKID...（SecretId）'
      },
      r2: {
        endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com',
        region: 'auto',
        addressingStyle: 'path',
        addressingLocked: false,
        endpointHint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com',
        regionHint: 'auto',
        keyHint: 'R2 API Token 的 Access Key ID'
      },
      aws: {
        endpoint: 'https://s3.<region>.amazonaws.com',
        region: 'us-east-1',
        addressingStyle: 'virtual',
        addressingLocked: true,
        endpointHint: 'https://s3.us-east-1.amazonaws.com',
        regionHint: 'us-east-1（如 ap-northeast-1）',
        keyHint: 'AWS Access Key ID'
      },
      minio: {
        endpoint: 'https://minio.example.com',
        region: 'us-east-1',
        addressingStyle: 'path',
        addressingLocked: false,
        endpointHint: 'https://minio.example.com',
        regionHint: 'us-east-1 或自定义',
        keyHint: 'MinIO Access Key'
      },
      custom: {
        endpoint: 'https://s3.example.com',
        region: 'auto',
        addressingStyle: 'path',
        addressingLocked: false,
        endpointHint: 'https://s3.example.com',
        regionHint: 'auto 或厂商要求的 Region',
        keyHint: 'Access Key ID'
      }
    };

    function applyProviderPreset() {
      const provider = document.getElementById('storageProvider').value;
      const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
      document.getElementById('storageEndpoint').placeholder = preset.endpointHint;
      document.getElementById('storageRegion').placeholder = preset.regionHint;
      document.getElementById('storageAccessKeyId').placeholder = preset.keyHint;
      const style = document.getElementById('storageAddressingStyle');
      style.disabled = !!preset.addressingLocked;
      if (preset.addressingStyle) style.value = preset.addressingStyle;
    }

    function detectProviderFromEndpoint(endpoint) {
      const value = String(endpoint || '');
      if (value.includes('.aliyuncs.com')) return 'aliyun';
      if (value.includes('.myqcloud.com')) return 'tencent';
      if (value.includes('.r2.cloudflarestorage.com')) return 'r2';
      if (value.includes('.amazonaws.com') || value.includes('.aws.amazon.com')) return 'aws';
      return 'custom';
    }

    function showStorageModal(storageId) {
      const storage = managedStorages.find(function (item) { return item.id === storageId; }) || null;
      document.getElementById('storageModalTitle').textContent = storage ? '编辑 S3 存储' : '添加 S3 存储';
      document.getElementById('storageId').value = storage ? storage.id : '';
      document.getElementById('storageName').value = storage ? storage.name : '';
      const provider = storage ? detectProviderFromEndpoint(storage.endpoint) : 'custom';
      document.getElementById('storageProvider').value = provider;
      document.getElementById('storageEndpoint').value = storage ? storage.endpoint : '';
      document.getElementById('storageRegion').value = storage ? storage.region : 'auto';
      document.getElementById('storageBucket').value = storage ? storage.bucket : '';
      document.getElementById('storageAddressingStyle').value = storage ? storage.addressingStyle : 'path';
      document.getElementById('storageSyncInterval').value = String(storage ? storage.syncIntervalMinutes : 1440);
      document.getElementById('storageAccessKeyId').value = '';
      document.getElementById('storageSecretAccessKey').value = '';
      document.getElementById('storageSessionToken').value = '';
      document.getElementById('storageEnabled').checked = storage ? storage.enabled : true;
      const identityLocked = !!(storage && storage.lastSyncAt);
      ['storageEndpoint', 'storageRegion', 'storageBucket', 'storageAddressingStyle'].forEach(function (id) {
        document.getElementById(id).disabled = identityLocked;
      });
      document.getElementById('storageAccessKeyId').required = !storage;
      document.getElementById('storageSecretAccessKey').required = !storage;
      applyProviderPreset();
      document.getElementById('storageModal').classList.add('active');
    }

    function storageFormPayload() {
      const payload = {
        id: document.getElementById('storageId').value || undefined,
        name: document.getElementById('storageName').value.trim(),
        endpoint: document.getElementById('storageEndpoint').value.trim(),
        region: document.getElementById('storageRegion').value.trim(),
        bucket: document.getElementById('storageBucket').value.trim(),
        addressingStyle: document.getElementById('storageAddressingStyle').value,
        syncIntervalMinutes: Number(document.getElementById('storageSyncInterval').value),
        enabled: document.getElementById('storageEnabled').checked
      };
      const accessKeyId = document.getElementById('storageAccessKeyId').value.trim();
      const secretAccessKey = document.getElementById('storageSecretAccessKey').value;
      const sessionToken = document.getElementById('storageSessionToken').value;
      if (accessKeyId || secretAccessKey || sessionToken) {
        payload.accessKeyId = accessKeyId;
        payload.secretAccessKey = secretAccessKey;
        payload.sessionToken = sessionToken;
      }
      return payload;
    }

    async function testStorageForm() {
      showLoading(true);
      try {
        const response = await fetch('/api/admin/storages/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(storageFormPayload())
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '连接测试失败');
        showToast('S3 连接测试成功', 'success');
      } catch (error) {
        showToast(error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    async function saveStorage(event) {
      event.preventDefault();
      const payload = storageFormPayload();
      const id = payload.id;
      showLoading(true);
      try {
        const response = await fetch(id ? '/api/admin/storages/' + encodeURIComponent(id) : '/api/admin/storages', {
          method: id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '保存存储失败');
        closeModal('storageModal');
        await loadStorages();
        await loadAdminStorageOptions();
        showToast('存储已保存', 'success');
      } catch (error) {
        showToast(error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    async function syncStorage(storageId) {
      try {
        const response = await fetch('/api/admin/storages/' + encodeURIComponent(storageId) + '/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '同步任务创建失败');
        showToast('同步任务已排队', 'info');
        for (let attempt = 0; attempt < 180; attempt++) {
          await new Promise(function (resolve) { window.setTimeout(resolve, 1000); });
          const statusResponse = await fetch('/api/admin/storages/' + encodeURIComponent(storageId) + '/sync');
          const statusData = await statusResponse.json();
          if (!statusResponse.ok || !statusData.success) throw new Error(statusData.message || '读取同步状态失败');
          if (!statusData.sync || ['queued', 'running'].includes(statusData.sync.status)) continue;
          await loadStorages();
          if (statusData.sync.status === 'failed') throw new Error(statusData.sync.errorMessage || '同步失败');
          showToast('同步完成', 'success');
          return;
        }
        throw new Error('同步仍在进行');
      } catch (error) {
        showToast(error.message, 'error');
      }
    }

    async function toggleStorage(storage) {
      try {
        const response = await fetch('/api/admin/storages/' + encodeURIComponent(storage.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !storage.enabled })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '更新状态失败');
        await loadStorages();
        await loadAdminStorageOptions();
      } catch (error) {
        showToast(error.message, 'error');
      }
    }

    async function setDefaultStorage(storage) {
      try {
        const response = await fetch('/api/admin/storages/' + encodeURIComponent(storage.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isDefault: true })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '设置默认失败');
        await loadStorages();
        await loadAdminStorageOptions();
        showToast('已将「' + storage.name + '」设为默认存储', 'success');
      } catch (error) {
        showToast(error.message, 'error');
      }
    }

    async function deleteStorage(storage) {
      const confirmationName = window.prompt('输入存储名称以确认删除：' + storage.name);
      if (confirmationName === null) return;
      try {
        const response = await fetch('/api/admin/storages/' + encodeURIComponent(storage.id), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmationName: confirmationName })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '删除存储失败');
        await loadStorages();
        await loadAdminStorageOptions();
        showToast('存储已删除', 'success');
      } catch (error) {
        showToast(error.message, 'error');
      }
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

    async function initializeAdmin() {
      if (!(await checkAdminAuth())) return;
      initializeResourcePicker();
      await loadAdminStorageOptions();
      await loadStorages();
      if (currentStorageId) await loadStats();
    }

    initializeAdmin();
  </script>
</body>
</html>
`;
export { FIXED_ADMIN_PAGE };
