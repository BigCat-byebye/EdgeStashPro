const CSS_STYLES = `
<style>
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  :root {
    color-scheme: dark;
    --primary: #6366f1;
    --primary-dark: #4f46e5;
    --primary-light: #818cf8;
    --secondary: #8b5cf6;
    --accent: #06b6d4;
    --background: #0f172a;
    --surface: #1e293b;
    --surface-light: #334155;
    --text: #f8fafc;
    --text-muted: #94a3b8;
    --success: #10b981;
    --warning: #f59e0b;
    --error: #ef4444;
    --gradient: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #06b6d4 100%);
  }

  :root[data-theme="light"] {
    color-scheme: light;
    --primary: #4f46e5;
    --primary-dark: #4338ca;
    --primary-light: #6366f1;
    --secondary: #7c3aed;
    --accent: #0891b2;
    --background: #f1f5f9;
    --surface: #ffffff;
    --surface-light: #e2e8f0;
    --text: #0f172a;
    --text-muted: #64748b;
    --success: #059669;
    --warning: #d97706;
    --error: #dc2626;
    --gradient: linear-gradient(135deg, #4f46e5 0%, #7c3aed 50%, #0891b2 100%);
  }

  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--background);
    color: var(--text);
    min-height: 100vh;
    line-height: 1.6;
  }

  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 20px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    text-decoration: none;
  }

  .btn-primary {
    background: var(--gradient);
    color: white;
  }

  .btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 20px rgba(99, 102, 241, 0.3);
  }

  .btn-secondary {
    background: var(--surface-light);
    color: var(--text);
  }

  .btn-secondary:hover {
    background: var(--surface);
  }

  .btn-danger {
    background: var(--error);
    color: white;
  }

  .btn-danger:hover {
    background: #dc2626;
  }

  .btn-sm {
    padding: 6px 12px;
    font-size: 12px;
  }

  .icon-btn {
    width: 34px;
    height: 34px;
    padding: 0;
    flex: 0 0 34px;
    border-radius: 50%;
  }

  .icon-btn.btn-secondary:hover {
    background: var(--primary);
    color: white;
    transform: scale(1.1);
  }

  .icon-btn.btn-danger:hover {
    transform: scale(1.1);
  }

  .theme-toggle {
    width: 38px;
    height: 38px;
    padding: 0;
    flex: 0 0 38px;
    font-size: 18px;
  }

  .theme-toggle-floating {
    position: fixed;
    top: 18px;
    right: 18px;
    z-index: 50;
  }

  .action-icon {
    display: block;
    width: 16px;
    height: 16px;
    pointer-events: none;
  }

  /* Forms */
  .form-group {
    margin-bottom: 20px;
  }

  .form-label {
    display: block;
    margin-bottom: 8px;
    font-weight: 500;
    color: var(--text-muted);
  }

  .form-input {
    width: 100%;
    padding: 12px 16px;
    background: var(--surface);
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    color: var(--text);
    font-size: 14px;
    transition: all 0.2s ease;
  }

  .form-input:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
  }

  .form-select {
    width: 100%;
    padding: 12px 16px;
    background: var(--surface);
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    color: var(--text);
    font-size: 14px;
    cursor: pointer;
  }

  /* Cards */
  .card {
    background: var(--surface);
    border-radius: 16px;
    padding: 24px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  .card-title {
    font-size: 18px;
    font-weight: 600;
  }

  /* Tables */
  .table-container {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th, td {
    padding: 12px 16px;
    text-align: left;
    border-bottom: 1px solid var(--surface-light);
  }

  th {
    font-weight: 600;
    color: var(--text-muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  tr:hover {
    background: var(--surface-light);
  }

  /* Modal */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    opacity: 0;
    visibility: hidden;
    transition: all 0.3s ease;
  }

  .modal-overlay.active {
    opacity: 1;
    visibility: visible;
  }

  .modal {
    background: var(--surface);
    border-radius: 16px;
    padding: 24px;
    width: 90%;
    max-width: 500px;
    transform: scale(0.9);
    transition: all 0.3s ease;
    max-height: 90vh;
    overflow-y: auto;
  }

  .modal-wide {
    max-width: 820px;
  }

  .modal-overlay.active .modal {
    transform: scale(1);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  .modal-title {
    font-size: 20px;
    font-weight: 600;
  }

  .modal-close {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 24px;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }

  .modal-close:hover {
    color: var(--text);
  }

  /* Preview Modal - Full Screen */
  .preview-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.95);
    display: flex;
    flex-direction: column;
    z-index: 2000;
    opacity: 0;
    visibility: hidden;
    transition: all 0.3s ease;
  }

  .preview-overlay.active {
    opacity: 1;
    visibility: visible;
  }

  .preview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: nowrap;
    gap: 16px;
    padding: 16px 24px;
    background: var(--surface);
    border-bottom: 1px solid var(--surface-light);
  }

  .preview-filename {
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
    text-align: center;
  }

  .preview-actions {
    display: flex;
    gap: 12px;
    align-items: center;
    flex: 0 0 auto;
  }

  .reader-tools {
    display: none;
    align-items: center;
    gap: 6px;
    position: relative;
  }

  .reader-tools.active {
    display: flex;
  }

  .reader-font-size {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 34px;
    flex: 0 0 32px;
    color: var(--text-muted);
    text-align: center;
    font-size: 13px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  .reader-tool-btn {
    padding: 7px 10px;
  }

  .bookmark-panel {
    position: fixed;
    top: 76px;
    left: 50%;
    right: auto;
    transform: translateX(-50%);
    width: min(520px, calc(100vw - 24px));
    max-height: min(460px, 65vh);
    overflow: auto;
    padding: 12px;
    border: 1px solid var(--surface-light);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: 0 18px 45px rgba(0, 0, 0, 0.28);
    z-index: 5;
  }

  .bookmark-panel[hidden] {
    display: none;
  }

  .txt-search-panel {
    position: fixed;
    top: 76px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    width: min(600px, calc(100vw - 24px));
    max-height: min(560px, 72vh);
    overflow: hidden;
    padding: 0;
    border: 1px solid var(--surface-light);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: 0 18px 45px rgba(0, 0, 0, 0.28);
    z-index: 6;
    animation: txt-search-panel-in 180ms ease-out;
  }

  .txt-search-panel[hidden] {
    display: none;
  }

  @keyframes txt-search-panel-in {
    from { opacity: 0; transform: translate(-50%, -8px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }

  .txt-search-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px 12px;
    border-bottom: 1px solid var(--surface-light);
  }

  .txt-search-title {
    color: var(--text);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.4;
  }

  .txt-search-description {
    margin-top: 2px;
    color: var(--text-muted);
    font-size: 12px;
    line-height: 1.4;
  }

  .txt-search-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    flex: 0 0 36px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--text-muted);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    transition: background 160ms ease, color 160ms ease, border-color 160ms ease;
  }

  .txt-search-close:hover,
  .txt-search-close:focus-visible {
    border-color: var(--surface-light);
    background: var(--background);
    color: var(--text);
    outline: none;
  }

  .txt-search-row {
    display: flex;
    gap: 8px;
    padding: 12px 16px 0;
  }

  .txt-search-row .form-input {
    min-width: 0;
    flex: 1;
    margin: 0;
  }

  .txt-search-status {
    min-height: 22px;
    padding: 8px 16px 6px;
    color: var(--text-muted);
    font-size: 12px;
  }

  .txt-search-results {
    display: grid;
    gap: 8px;
    min-height: 0;
    overflow: auto;
    padding: 0 12px 12px;
    overscroll-behavior: contain;
  }

  .txt-search-result {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
    padding: 12px;
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    background: var(--background);
    font-size: 14px;
    line-height: 1.6;
    cursor: pointer;
    user-select: none;
    transition: border-color 160ms ease, background 160ms ease;
  }

  .txt-search-snippet {
    min-width: 0;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .txt-search-result:hover,
  .txt-search-result:focus-visible {
    border-color: var(--primary-light);
    background: color-mix(in srgb, var(--primary) 7%, var(--background));
    outline: none;
  }

  .txt-search-result mark {
    padding: 0 2px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--warning) 40%, transparent);
    color: inherit;
  }

  .txt-search-meta {
    margin-top: 3px;
    color: var(--text-muted);
    font-size: 11px;
  }

  .txt-search-highlight {
    padding: 0 2px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--warning) 70%, #fff 10%);
    color: inherit;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--warning) 24%, transparent);
  }

  .txt-search-jump {
    min-width: 64px;
    min-height: 36px;
  }

  .txt-reader-jump-overlay {
    position: absolute;
    inset: 0;
    z-index: 4;
    display: grid;
    place-items: center;
    padding: 24px;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    backdrop-filter: blur(6px);
    animation: txt-reader-overlay-in 180ms ease-out;
  }

  .txt-reader-jump-card {
    display: grid;
    justify-items: center;
    gap: 12px;
    max-width: 320px;
    padding: 20px 24px;
    border: 1px solid var(--surface-light);
    border-radius: 12px;
    background: var(--surface);
    color: var(--text);
    text-align: center;
    box-shadow: 0 18px 45px rgba(0, 0, 0, 0.2);
  }

  .txt-reader-jump-spinner {
    width: 34px;
    height: 34px;
    border: 3px solid var(--surface-light);
    border-top-color: var(--primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .txt-reader-jump-message {
    font-size: 14px;
    font-weight: 600;
  }

  .txt-reader-jump-hint {
    color: var(--text-muted);
    font-size: 12px;
  }

  @keyframes txt-reader-overlay-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .txt-search-more {
    width: 100%;
    margin-top: 10px;
  }

  .txt-reader-chunk {
    display: block;
    min-height: 1.85em;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .txt-reader-chunk.search-target {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
    border-radius: 4px;
  }

  .bookmark-add {
    width: 100%;
    margin-bottom: 10px;
  }

  .bookmark-empty {
    padding: 20px 8px;
    color: var(--text-muted);
    text-align: center;
  }

  .bookmark-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 30px;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-top: 1px solid var(--surface-light);
  }

  .bookmark-jump {
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }

  .bookmark-meta {
    color: var(--primary-light);
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
  }

  .bookmark-snippet {
    min-width: 0;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 30px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bookmark-delete {
    width: 30px;
    height: 30px;
    padding: 0;
  }

  .preview-icon-btn {
    display: none;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    transition: all 0.2s ease;
    flex-shrink: 0;
    font-size: 16px;
    line-height: 1;
    padding: 0;
  }

  .preview-icon-btn.preview-close {
    background: var(--surface-light);
    color: var(--text);
  }

  .preview-icon-btn.preview-close:hover {
    background: var(--surface);
    transform: scale(1.05);
  }

  .preview-icon-btn.preview-download {
    background: var(--gradient);
    color: white;
  }

  .preview-icon-btn.preview-download:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 14px rgba(99, 102, 241, 0.3);
  }

  .preview-content {
    flex: 1;
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .preview-content.reader-mode {
    position: relative;
    align-items: stretch;
    justify-content: flex-start;
    padding: 0;
  }

  .preview-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  .preview-text {
    width: 100%;
    height: 100%;
    background: var(--surface);
    border-radius: 8px;
    padding: 20px;
    overflow: auto;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    font-size: 14px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .preview-reader {
    width: 100%;
    height: 100%;
    overflow: auto;
    background: var(--surface);
    color: var(--text);
    padding: 28px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 18px;
    line-height: 1.85;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .preview-pdf {
    width: 100%;
    height: 100%;
    border: none;
    border-radius: 8px;
  }

  .preview-video, .preview-audio {
    max-width: 100%;
    max-height: 100%;
  }

  .preview-markdown {
    width: 100%;
    max-width: 900px;
    height: 100%;
    background: var(--surface);
    border-radius: 8px;
    padding: 40px;
    overflow: auto;
    line-height: 1.8;
  }

  .preview-markdown h1, .preview-markdown h2, .preview-markdown h3 {
    margin-top: 24px;
    margin-bottom: 16px;
    color: var(--text);
  }

  .preview-markdown p {
    margin-bottom: 16px;
  }

  .preview-markdown code {
    background: var(--background);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: 'Monaco', 'Menlo', monospace;
  }

  .preview-markdown pre {
    background: var(--background);
    padding: 16px;
    border-radius: 8px;
    overflow-x: auto;
    margin-bottom: 16px;
  }

  .preview-markdown pre code {
    background: none;
    padding: 0;
  }

  .preview-markdown blockquote {
    border-left: 4px solid var(--primary);
    padding-left: 16px;
    margin: 16px 0;
    color: var(--text-muted);
  }

  .preview-markdown ul, .preview-markdown ol {
    margin-bottom: 16px;
    padding-left: 24px;
  }

  .preview-markdown li {
    margin-bottom: 8px;
  }

  .preview-markdown a {
    color: var(--primary);
  }

  .preview-markdown img {
    max-width: 100%;
    border-radius: 8px;
  }

  .preview-markdown table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 16px;
  }

  .preview-markdown th, .preview-markdown td {
    border: 1px solid var(--surface-light);
    padding: 8px 12px;
  }

  .preview-office {
    width: 100%;
    height: 100%;
    background: white;
    border-radius: 8px;
  }

  .preview-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    color: var(--text-muted);
  }

  .preview-error {
    text-align: center;
    color: var(--error);
  }

  /* Toast */
  .toast-container {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 3000;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .toast {
    padding: 16px 20px;
    border-radius: 8px;
    color: white;
    font-weight: 500;
    animation: slideIn 0.3s ease;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 300px;
  }

  .toast-success {
    background: var(--success);
  }

  .toast-error {
    background: var(--error);
  }

  .toast-info {
    background: var(--primary);
  }

  .toast-warning {
    background: var(--warning);
  }

  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  /* Header */
  .header {
    background: var(--surface);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--surface-light);
  }

  .logo {
    font-size: 24px;
    font-weight: 700;
    background: var(--gradient);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .header-actions {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .header-actions > button {
    margin: 0;
  }

  .task-chip {
    display: none;
    align-items: center;
    gap: 8px;
    max-width: 260px;
    padding: 8px 10px;
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    background: var(--background);
    color: var(--text);
    font-size: 13px;
    line-height: 1.2;
    cursor: pointer;
    white-space: nowrap;
  }

  .task-chip.active {
    display: inline-flex;
  }

  .task-chip-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .task-panel-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .task-panel-empty {
    color: var(--text-muted);
    padding: 14px 0;
    text-align: center;
  }

  .task-row {
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    padding: 12px;
    background: var(--background);
  }

  .task-row-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
    font-size: 14px;
  }

  .task-row-title {
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-row-status {
    color: var(--text-muted);
    flex: 0 0 auto;
  }

  .task-row-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }

  .task-icon-btn {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--surface-light);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
  }

  .task-icon-btn:hover {
    color: var(--text);
    border-color: var(--primary);
  }

  .task-icon-btn.danger:hover {
    color: var(--error);
    border-color: var(--error);
  }

  .task-icon-btn svg {
    width: 15px;
    height: 15px;
  }

  .task-progress {
    height: 6px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-light);
  }

  .task-progress-fill {
    width: 0;
    height: 100%;
    background: var(--primary);
    transition: width 0.2s ease;
  }

  .task-row-meta {
    margin-top: 8px;
    color: var(--text-muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .task-fly-icon {
    position: fixed;
    z-index: 4000;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--primary);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    box-shadow: 0 10px 24px rgba(99, 102, 241, 0.35);
    font-size: 14px;
    font-weight: 700;
  }

  /* Breadcrumb */
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px 0;
    flex-wrap: wrap;
  }

  .breadcrumb-item {
    color: var(--text-muted);
    text-decoration: none;
    transition: color 0.2s;
  }

  .breadcrumb-item:hover {
    color: var(--primary);
  }

  .breadcrumb-item.active {
    color: var(--text);
  }

  .breadcrumb-separator {
    color: var(--text-muted);
  }

  /* File List */
  .file-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 16px;
  }

  .file-item {
    background: var(--surface);
    border-radius: 12px;
    padding: 16px;
    cursor: pointer;
    transition: all 0.2s ease;
    border: 1px solid transparent;
    position: relative;
  }

  .file-item:hover {
    border-color: var(--primary);
    transform: translateY(-2px);
  }

  .file-item.selected {
    border-color: var(--primary);
    box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25);
  }

  .file-select {
    position: absolute;
    top: 10px;
    left: 10px;
    width: 18px;
    height: 18px;
    accent-color: var(--primary);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .file-item:hover .file-select,
  .file-select:checked {
    opacity: 1;
  }

  .file-icon {
    font-size: 48px;
    margin-bottom: 12px;
    text-align: center;
  }

  .file-name {
    font-weight: 500;
    text-align: center;
    line-height: 1.35;
    min-height: 2.7em;
    overflow: hidden;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    margin-bottom: 4px;
  }

  .file-meta {
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
  }

  .tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: center;
    margin-top: 8px;
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 12px;
    line-height: 1.3;
    color: white;
    overflow: hidden;
  }

  .tag-chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag-chip button {
    width: 16px;
    height: 16px;
    border: none;
    border-radius: 50%;
    padding: 0;
    line-height: 1;
    cursor: pointer;
    background: rgba(255, 255, 255, 0.22);
    color: white;
  }

  .tag-editor-list {
    justify-content: flex-start;
    min-height: 30px;
    margin: 0 0 12px;
  }

  .file-actions {
    display: flex;
    gap: 6px;
    margin-top: 12px;
    justify-content: center;
    flex-wrap: wrap;
    max-width: 100%;
    opacity: 0;
    max-height: 0;
    overflow: hidden;
    margin-top: 0;
    transition: opacity 0.2s ease, max-height 0.25s ease, margin-top 0.25s ease;
  }

  .file-item:hover .file-actions {
    opacity: 1;
    max-height: 80px;
    margin-top: 12px;
  }
  .file-list {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .file-list-header,
  .file-row {
    display: grid;
    grid-template-columns: 34px minmax(220px, 1fr) 100px 120px 170px 110px minmax(170px, auto);
    align-items: center;
    column-gap: 12px;
  }

  .file-list-header {
    min-height: 38px;
    padding: 0 12px;
    border-bottom: 1px solid var(--surface-light);
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .file-row {
    min-height: 56px;
    padding: 9px 12px;
    border: 0;
    border-bottom: 1px solid var(--surface-light);
    border-radius: 0;
    background: transparent;
    transform: none;
    transition: background 0.15s ease, box-shadow 0.15s ease;
  }

  .file-row:last-child {
    border-bottom: 0;
  }

  .file-row:hover {
    border-color: var(--surface-light);
    background: color-mix(in srgb, var(--surface-light) 45%, transparent);
    transform: none;
  }

  .file-row.selected {
    box-shadow: inset 3px 0 0 var(--primary);
    background: color-mix(in srgb, var(--primary) 8%, transparent);
  }

  .file-row .file-select {
    position: static;
    width: 17px;
    height: 17px;
    opacity: 1;
  }

  .file-row-name {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }

  .file-row-icon {
    flex: 0 0 26px;
    font-size: 22px;
    line-height: 1;
    text-align: center;
  }

  .file-row .file-name {
    min-height: 0;
    margin: 0;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
  }

  .file-row .tag-list {
    flex: 0 1 auto;
    margin: 0;
    flex-wrap: nowrap;
    overflow: hidden;
  }

  .file-row .tag-chip {
    max-width: 90px;
  }

  .file-row-type,
  .file-row-size,
  .file-row-modified {
    min-width: 0;
    overflow: hidden;
    color: var(--text-muted);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-row-status {
    font-size: 13px;
    white-space: nowrap;
  }

  .file-row-status.is-ready {
    color: #15803d;
  }

  .file-row-status.is-syncing {
    color: #2563eb;
  }

  .file-row-status.is-error {
    color: #dc2626;
  }

  .file-list .file-row .file-actions {
    justify-content: flex-start;
    opacity: 1;
    max-height: none;
    margin: 0;
    overflow: visible;
    transition: none;
  }
  .file-row-submeta {
    display: none;
  }

  /* Stats Cards */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 20px;
    margin-bottom: 30px;
  }

  .stat-card {
    background: var(--surface);
    border-radius: 16px;
    padding: 24px;
    text-align: center;
  }

  .stat-value {
    font-size: 36px;
    font-weight: 700;
    background: var(--gradient);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .stat-label {
    color: var(--text-muted);
    font-size: 14px;
    margin-top: 8px;
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 4px;
    background: var(--surface);
    padding: 4px;
    border-radius: 12px;
    margin-bottom: 24px;
  }

  .tab {
    flex: 1;
    padding: 12px 20px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 8px;
    transition: all 0.2s ease;
  }

  .tab.active {
    background: var(--primary);
    color: white;
  }

  .tab:hover:not(.active) {
    color: var(--text);
  }

  .tab-content {
    display: none;
  }

  .tab-content.active {
    display: block;
  }

  /* Badge */
  .badge {
    display: inline-block;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
  }

  .badge-success {
    background: rgba(16, 185, 129, 0.2);
    color: var(--success);
  }

  .badge-warning {
    background: rgba(245, 158, 11, 0.2);
    color: var(--warning);
  }

  .badge-error {
    background: rgba(239, 68, 68, 0.2);
    color: var(--error);
  }

  .badge-info {
    background: rgba(99, 102, 241, 0.2);
    color: var(--primary);
  }

  /* Login Page */
  .login-container {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--background);
    padding: 20px;
  }

  .login-card {
    background: var(--surface);
    border-radius: 24px;
    padding: 40px;
    width: 100%;
    max-width: 420px;
    box-shadow: 0 25px 50px rgba(0, 0, 0, 0.25);
  }

  .login-header {
    text-align: center;
    margin-bottom: 32px;
  }

  .login-logo {
    font-size: 32px;
    font-weight: 700;
    background: var(--gradient);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 8px;
  }

  .login-subtitle {
    color: var(--text-muted);
  }

  .login-tabs {
    display: flex;
    gap: 4px;
    background: var(--background);
    padding: 4px;
    border-radius: 12px;
    margin-bottom: 24px;
  }

  .login-tab {
    flex: 1;
    padding: 12px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 8px;
    transition: all 0.2s ease;
  }

  .login-tab.active {
    background: var(--primary);
    color: white;
  }

  /* Share Page */
  .share-container {
    min-height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    background: var(--background);
    padding: 20px;
  }

  .share-card {
    background: var(--surface);
    border-radius: 12px;
    padding: 28px;
    width: 100%;
    max-width: 960px;
  }

  .share-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
  }

  .share-title {
    min-width: 0;
  }

  .share-icon {
    font-size: 36px;
    margin-bottom: 8px;
  }

  .share-filename {
    font-size: 20px;
    font-weight: 600;
    margin-bottom: 8px;
    word-break: break-all;
  }

  .share-filesize {
    color: var(--text-muted);
    font-size: 14px;
  }

  .share-state-notice {
    margin: 0 0 16px;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--warning) 55%, transparent);
    border-radius: 8px;
    color: var(--warning);
    font-size: 13px;
  }

  .share-browser {
    display: none;
  }

  .share-browser.active {
    display: block;
  }

  .share-browser .file-item {
    cursor: pointer;
  }

  .share-browser .file-actions,
  .share-browser .file-select {
    display: none;
  }

  .share-expired {
    color: var(--error);
    font-size: 18px;
    text-align: center;
  }

  /* Empty State */
  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-muted);
  }

  .empty-icon {
    font-size: 64px;
    margin-bottom: 16px;
    opacity: 0.5;
  }

  /* Responsive */
  @media (max-width: 768px) {
    .header {
      flex-direction: row;
      gap: 8px;
      padding: 12px 16px;
    }

    .header-actions {
      gap: 6px;
    }

    .header-actions .btn {
      padding: 6px 10px;
      font-size: 12px;
    }

    .task-chip {
      max-width: 150px;
      padding: 6px 8px;
      font-size: 12px;
    }

    .logo {
      font-size: 18px;
    }

    .container {
      padding: 16px;
    }

    .toolbar .btn {
      padding: 8px 12px;
      font-size: 13px;
    }

    .file-grid {
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 12px;
    }

    .stats-grid {
      grid-template-columns: 1fr;
    }

    .tabs {
      flex-direction: column;
    }

    .file-actions {
      opacity: 1;
      max-height: none;
      margin-top: 10px;
    }

    .file-select {
      opacity: 1;
    }

    .preview-header {
      flex-direction: row;
      gap: 6px;
      padding: 10px 8px;
    }

    .preview-filename {
      text-align: left;
      font-size: 13px;
    }

    .preview-actions > .btn {
      display: none;
    }

    .preview-actions .reader-tools .reader-tool-btn,
    .preview-actions .reader-tools .bookmark-add,
    .preview-actions .reader-tools .bookmark-delete {
      display: inline-flex;
    }

    .reader-tools {
      gap: 2px;
    }

    .reader-tool-btn {
      min-width: 30px;
      height: 30px;
      padding: 0 6px;
      font-size: 12px;
    }

    .reader-font-size {
      width: 26px;
      height: 30px;
      flex-basis: 26px;
      font-size: 12px;
    }

    .bookmark-panel,
    .txt-search-panel {
      top: auto;
      bottom: 0;
      left: 0;
      right: 0;
      transform: none;
      width: 100%;
      max-height: min(620px, 78dvh);
      border-radius: 16px 16px 0 0;
      animation: reader-sheet-in 220ms ease-out;
    }

    .bookmark-panel {
      padding-bottom: calc(12px + env(safe-area-inset-bottom));
    }

    .txt-search-panel {
      padding-bottom: env(safe-area-inset-bottom);
    }

    .preview-icon-btn {
      display: inline-flex;
      width: 30px;
      height: 30px;
      font-size: 13px;
    }

    .preview-actions {
      gap: 3px;
      max-width: 100%;
      overflow-x: auto;
      scrollbar-width: none;
    }

    .preview-actions::-webkit-scrollbar {
      display: none;
    }

    @keyframes reader-sheet-in {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }
  }

  @media (max-width: 480px) {
    .preview-header {
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      padding: 8px;
    }

    .preview-filename {
      width: 100%;
      text-align: center;
    }

    .preview-actions {
      width: 100%;
      justify-content: center;
    }

    .reader-tool-btn,
    .preview-icon-btn {
      width: 44px;
      min-width: 44px;
      height: 44px;
      padding: 0;
      font-size: 14px;
    }

    .reader-font-size {
      width: 28px;
      height: 44px;
      flex-basis: 28px;
    }

    .txt-search-header {
      padding: 12px 16px;
    }

    .txt-search-close {
      width: 44px;
      height: 44px;
      flex-basis: 44px;
    }

    .txt-search-result {
      grid-template-columns: 1fr;
    }

    .txt-search-jump {
      width: 100%;
      min-height: 44px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .txt-search-panel,
    .txt-reader-jump-overlay,
    .txt-reader-jump-spinner {
      animation: none;
    }
  }

  /* Loading Spinner */
  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--surface-light);
    border-top-color: var(--primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .loading-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(15, 23, 42, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3000;
  }

  /* Context Menu */
  .context-menu {
    position: fixed;
    background: var(--surface);
    border-radius: 8px;
    padding: 8px 0;
    min-width: 160px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
    z-index: 1500;
    display: none;
  }

  .context-menu.active {
    display: block;
  }

  .context-menu-item {
    padding: 10px 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 10px;
    transition: background 0.2s;
  }

  .context-menu-item:hover {
    background: var(--surface-light);
  }

  .context-menu-item.danger {
    color: var(--error);
  }

  /* Toolbar */
  .toolbar {
    display: flex;
    gap: 12px;
    margin-bottom: 20px;
    flex-wrap: wrap;
  }

  .view-toolbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px 16px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .view-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    width: max-content;
    max-width: 100%;
    min-width: 0;
    flex-wrap: wrap;
  }

  .view-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    width: max-content;
    max-width: 100%;
    height: 36px;
    margin: 0;
    padding: 3px;
    background: var(--surface);
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    box-sizing: border-box;
    flex: 0 0 auto;
  }

  .view-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    height: 100%;
    padding: 6px 10px;
    margin: 0;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    white-space: nowrap;
  }

  .view-tab.active {
    background: var(--primary);
    color: white;
  }

  .display-mode-toggle {
    display: flex;
    align-items: center;
    gap: 3px;
    flex: 0 0 auto;
    width: max-content;
    max-width: 100%;
    height: 36px;
    margin: 0;
    padding: 3px;
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    background: var(--surface);
  }

  .display-mode-btn {
    width: auto;
    min-width: 54px;
    flex: 0 0 auto;
    height: 100%;
    padding: 6px 10px;
    margin: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
  }

  .display-mode-btn.active {
    background: var(--primary);
    color: white;
  }

  .search-tools {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1 1 460px;
    width: min(100%, 560px);
    max-width: 560px;
    min-width: 260px;
  }

  .search-tools .form-input {
    flex: 1 1 auto;
    min-width: 150px;
    height: 36px;
    padding: 6px 10px;
    margin: 0;
    font-size: 13px;
  }

  .search-tools .form-select {
    width: 96px;
    height: 36px;
    padding: 6px 28px 6px 10px;
    margin: 0;
    font-size: 13px;
  }

  .search-tools .tag-filter {
    display: flex;
    align-items: flex-start;
    position: relative;
    width: 150px;
    height: 36px;
    line-height: 1;
  }

  .tag-filter-trigger {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    width: 100%;
    height: 36px;
    padding: 6px 28px 6px 10px;
    margin: 0;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    vertical-align: top;
  }

  .tag-filter-trigger #tagFilterLabel {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: middle;
    color: var(--text-muted);
  }

  .tag-filter-trigger.has-selection #tagFilterLabel {
    color: var(--text);
  }

  .tag-filter-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 50;
    width: 240px;
    max-width: 80vw;
    background: var(--surface);
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.32);
    overflow: hidden;
  }

  .tag-filter-menu-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--surface-light);
    font-size: 12px;
    color: var(--text-muted);
  }

  .tag-filter-clear {
    background: transparent;
    border: none;
    color: var(--primary-light);
    cursor: pointer;
    font-size: 12px;
    padding: 2px 4px;
  }

  .tag-filter-clear:hover {
    color: var(--primary);
  }

  .tag-filter-list {
    max-height: 240px;
    overflow-y: auto;
    padding: 4px 0;
  }

  .tag-filter-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
    user-select: none;
  }

  .tag-filter-item:hover {
    background: var(--surface-light);
  }

  .tag-filter-item input[type="checkbox"] {
    margin: 0;
    accent-color: var(--primary);
    cursor: pointer;
  }

  .tag-filter-item .tag-filter-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag-filter-item .tag-filter-count {
    color: var(--text-muted);
    font-size: 12px;
  }

  .tag-filter-empty {
    padding: 16px 12px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .search-tools .btn {
    height: 34px;
    padding: 6px 10px;
    margin: 0;
    font-size: 13px;
    white-space: nowrap;
  }

  .section-title {
    margin: 0 0 16px;
    color: var(--text-muted);
    font-size: 14px;
    font-weight: 500;
  }

  .qr-panel {
    display: flex;
    justify-content: center;
    margin: 14px 0 18px;
  }

  #shareQrCanvas {
    width: 180px;
    height: 180px;
    padding: 10px;
    background: white;
    border-radius: 8px;
  }

  .batch-toolbar {
    display: none;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
    padding: 12px;
    background: var(--surface);
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    flex-wrap: wrap;
  }

  .batch-toolbar.active {
    display: flex;
  }

  .batch-count {
    color: var(--text-muted);
    margin-right: auto;
    font-size: 14px;
  }

  .folder-search-results {
    display: none;
    margin-top: 8px;
    max-height: 220px;
    overflow: auto;
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    background: var(--background);
  }

  .folder-search-results.active {
    display: block;
  }

  .folder-search-item {
    width: 100%;
    padding: 10px 12px;
    border: none;
    border-bottom: 1px solid var(--surface-light);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    text-align: left;
    font-size: 14px;
  }

  .folder-search-item:last-child {
    border-bottom: none;
  }

  .folder-search-item:hover {
    background: var(--surface-light);
  }

  .folder-search-empty {
    padding: 10px 12px;
    color: var(--text-muted);
    font-size: 14px;
  }

  .resource-picker-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 130px;
    gap: 10px;
    margin-bottom: 12px;
  }

  .resource-list,
  .permission-list {
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    overflow: hidden;
    background: var(--background);
  }

  .resource-list {
    max-height: 280px;
    overflow-y: auto;
  }

  .resource-row,
  .permission-row {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--surface-light);
  }

  .permission-row {
    grid-template-columns: minmax(0, 1fr) 150px 34px;
  }

  .resource-row:last-child,
  .permission-row:last-child {
    border-bottom: none;
  }

  .resource-main,
  .permission-main {
    min-width: 0;
  }

  .resource-name,
  .permission-path {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .resource-path,
  .permission-summary {
    color: var(--text-muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .permission-empty {
    padding: 14px 12px;
    color: var(--text-muted);
    font-size: 14px;
  }

  .permission-checks {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px 12px;
    margin-top: 10px;
  }

  .permission-checks label {
    color: var(--text-muted);
    font-size: 13px;
    white-space: nowrap;
  }

  .permission-checks input {
    margin-right: 6px;
  }

  /* Upload Area */
  .upload-area {
    border: 2px dashed var(--surface-light);
    border-radius: 12px;
    padding: 40px;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .upload-area:hover, .upload-area.dragover {
    border-color: var(--primary);
    background: rgba(99, 102, 241, 0.1);
  }
  .upload-area input {
    display: none;
  }

  @media (max-width: 768px) {
    .view-toolbar {
      align-items: stretch;
      flex-direction: column;
      gap: 8px;
    }

    .view-controls {
      width: 100%;
      justify-content: space-between;
      flex-wrap: wrap;
    }

    .view-tabs {
      width: max-content;
      max-width: 100%;
      overflow-x: auto;
      scrollbar-width: none;
    }

    .view-tabs::-webkit-scrollbar {
      display: none;
    }

    .view-tab {
      flex: 0 0 auto;
      min-width: 72px;
      padding-inline: 14px;
    }

    .search-tools {
      width: 100%;
      max-width: none;
      min-width: 0;
      flex: 1 1 auto;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 92px;
      gap: 6px;
    }

    .search-tools .form-select {
      width: 100%;
    }

    .search-tools .tag-filter {
      width: 100%;
      grid-column: 1 / -1;
    }

    .search-tools .btn {
      width: 100%;
      padding: 6px 8px;
    }
    .display-mode-toggle {
      align-self: flex-end;
    }

    .file-list-header {
      display: none;
    }

    .file-row {
      grid-template-columns: 28px minmax(0, 1fr) auto;
      grid-template-areas:
        "select name actions"
        "select name actions";
      column-gap: 8px;
      min-height: 54px;
      padding: 8px 4px;
    }

    .file-row > .file-select {
      grid-area: select;
    }

    .file-row-name {
      grid-area: name;
      flex-wrap: wrap;
      align-content: center;
      gap: 6px;
    }

    .file-row .file-name {
      max-width: calc(100% - 34px);
    }

    .file-row-submeta {
      display: block;
      flex-basis: 100%;
      padding-left: 32px;
      color: var(--text-muted);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-row-type,
    .file-row-size,
    .file-row-modified,
    .file-row-status {
      display: none;
    }

    .file-row > .file-actions {
      grid-area: actions;
      flex-direction: column;
      align-items: stretch;
      gap: 3px;
    }

  }
  .storage-switcher {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 13px;
    white-space: nowrap;
  }

  .storage-switcher .form-select {
    width: min(220px, 32vw);
    min-width: 140px;
    height: 36px;
    margin: 0;
    padding-block: 4px;
  }

  .field-hint {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-left: 4px;
    border-radius: 50%;
    background: rgba(128, 128, 128, 0.25);
    color: inherit;
    font-size: 11px;
    line-height: 1;
    cursor: help;
    user-select: none;
  }
  .storage-sync-status {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    margin: -2px 0 10px;
    color: #2563eb;
    font-size: 13px;
  }

  .storage-sync-status.is-error {
    color: #dc2626;
  }

  .storage-table {
    min-width: 0;
  }

  .storage-table th:last-child,
  .storage-table td:last-child {
    width: 1%;
  }

  .storage-table td.actions {
    display: table-cell;
    vertical-align: middle;
    white-space: nowrap;
  }

  .storage-table td.actions .btn + .btn {
    margin-left: 6px;
  }

  .storage-table td.actions .btn {
    white-space: nowrap;
  }
  .storage-table td:nth-child(3),
  .storage-table td:nth-child(4) {
    white-space: nowrap;
  }

  @media (max-width: 640px) {
    .header {
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
    }

    .logo {
      align-self: flex-start;
    }

    .header-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      gap: 6px;
    }

    .storage-switcher {
      flex: 1 1 220px;
      width: auto;
      min-width: 0;
    }

    .storage-switcher .form-select {
      flex: 1 1 auto;
      width: auto;
      min-width: 0;
    }

    .header-actions > .btn {
      flex: 0 0 auto;
      white-space: nowrap;
    }

    .header-actions .theme-toggle {
      flex: 0 0 38px;
    }
    .storage-table,
    .storage-table tbody {
      display: block;
      width: 100%;
    }

    .storage-table thead {
      display: none;
    }

    .storage-table tr {
      display: block;
      padding: 10px 0;
      border-bottom: 1px solid var(--surface-light);
    }

    .storage-table tr:last-child {
      border-bottom: 0;
    }

    .storage-table td,
    .storage-table td.actions {
      display: grid;
      grid-template-columns: 76px minmax(0, 1fr);
      gap: 8px;
      width: 100%;
      box-sizing: border-box;
      padding: 6px 0;
      border-bottom: 0;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .storage-table td::before {
      content: attr(data-label);
      color: var(--text-muted);
      font-size: 12px;
    }

    .storage-table td.actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding-top: 10px;
    }

    .storage-table td.actions::before {
      content: attr(data-label);
      flex: 0 0 100%;
      color: var(--text-muted);
      font-size: 12px;
    }

    .storage-table td.actions .btn {
      flex: 0 0 auto;
      margin: 0;
    }
    .storage-table td.actions .btn + .btn {
      margin-left: 0;
    }
  }
</style>
`;
export { CSS_STYLES };
