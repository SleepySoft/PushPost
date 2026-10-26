(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = '';
  let view = 'overview';
  let role = '';
  const content = $('content');
  const message = $('message');

  function notify(text, error = false) {
    message.textContent = text || '';
    message.className = error ? 'error' : '';
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrf;
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/admin/auth/login') showLogin();
      throw new Error(data.error?.message || `请求失败 (${response.status})`);
    }
    return data;
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text ?? '');
    if (className) node.className = className;
    return node;
  }

  function table(headers, rows) {
    const tableNode = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headers.forEach((header) => headRow.append(element('th', header)));
    thead.append(headRow);
    tableNode.append(thead);
    const tbody = document.createElement('tbody');
    rows.forEach((cells) => {
      const row = document.createElement('tr');
      cells.forEach((cell) => {
        const td = element('td');
        if (cell instanceof Node) td.append(cell); else td.textContent = String(cell ?? '');
        row.append(td);
      });
      tbody.append(row);
    });
    tableNode.append(tbody);
    return tableNode;
  }

  function action(label, handler, danger = false) {
    const button = element('button', label, danger ? 'danger' : 'secondary');
    button.type = 'button';
    button.disabled = !['admin', 'publisher'].includes(role);
    button.addEventListener('click', () => Promise.resolve(handler()).catch((error) => notify(error.message, true)));
    return button;
  }

  async function refresh() {
    notify('');
    content.replaceChildren(element('p', '加载中…'));
    try {
      if (view === 'overview') await overview();
      if (view === 'articles') await articles();
      if (view === 'deployments') await deployments();
      if (view === 'tasks') await tasks();
      if (view === 'audit') await audit();
    } catch (error) {
      content.replaceChildren(element('p', error.message, 'error'));
    }
  }

  async function overview() {
    const data = await api('/api/admin/overview');
    const summary = element('div', undefined, 'summary');
    [['文章', data.articles], ['公开文章', data.visibleArticles], ['源 Commit', data.sourceCommit || '尚未同步'], ['当前部署', data.currentDeployment?.id || '无']].forEach(([label, value]) => {
      const card = element('div');
      card.append(element('span', label), element('strong', value));
      summary.append(card);
    });
    content.replaceChildren(summary, element('h2', '任务状态'), element('pre', JSON.stringify(data.taskStatuses, null, 2)));
  }

  async function articles() {
    const data = await api('/api/admin/articles');
    const rows = data.articles.map((article) => [article.title, article.category, article.status, article.visible ? '是' : '否', article.publishedAt || '立即', article.remotes.map((remote) => `${remote.targetAlias}: ${remote.remoteStatus}`).join('\n')]);
    content.replaceChildren(element('p', `源：${data.sourceCommit || '无'}`, 'muted'), table(['标题', '分类', '生命周期', '主站可见', '发布时间', '远端'], rows));
  }

  async function deployments() {
    const data = await api('/api/admin/deployments');
    const rows = data.deployments.map((deployment) => {
      const actions = element('div', undefined, 'actions');
      if (deployment.status === 'succeeded') actions.append(action('回滚到此版本', async () => {
        await api('/api/admin/rollback', { method: 'POST', body: JSON.stringify({ deploymentId: deployment.id }) });
        notify('已回滚'); await refresh();
      }));
      return [deployment.id, deployment.sourceCommit, deployment.status, deployment.createdAt, deployment.error || '', actions];
    });
    content.replaceChildren(table(['ID', 'Commit', '状态', '创建时间', '错误', '操作'], rows));
  }

  async function tasks() {
    const status = $('task-filter').value;
    const data = await api(`/api/admin/tasks${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    const rows = data.tasks.map((task) => {
      const actions = element('div', undefined, 'actions');
      if (['failed', 'manual_required', 'cancelled'].includes(task.status)) actions.append(action('重试', async () => {
        await api(`/api/admin/tasks/${task.id}/retry`, { method: 'POST', body: '{}' }); await refresh();
      }));
      if (['pending', 'failed', 'manual_required'].includes(task.status)) actions.append(action('取消', async () => {
        await api(`/api/admin/tasks/${task.id}/cancel`, { method: 'POST', body: '{}' }); await refresh();
      }, true));
      if (task.operation === 'export') {
        const download = element('a', '下载 ZIP'); download.href = `/api/admin/exports/${task.id}/download`; actions.append(download);
      }
      return [task.articleId, task.targetAlias, task.operation, task.status, task.attemptCount, task.lastError || '', actions];
    });
    content.replaceChildren(table(['文章', '目标', '操作', '状态', '尝试', '错误', '操作'], rows));
  }

  async function audit() {
    const data = await api('/api/admin/audit');
    content.replaceChildren(table(['时间', '动作', '实体', '详情'], data.audit.map((event) => [event.createdAt, event.action, `${event.entityType}/${event.entityId || ''}`, JSON.stringify(event.details)])));
  }

  function showLogin() {
    $('dashboard').hidden = true;
    $('login-panel').hidden = false;
    csrf = '';
  }

  async function showDashboard() {
    const me = await api('/api/admin/auth/me');
    csrf = me.csrfToken;
    role = me.user.role;
    $('login-panel').hidden = true;
    $('dashboard').hidden = false;
    $('sync').disabled = !['admin', 'publisher'].includes(role);
    await refresh();
  }

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault(); notify('');
    try {
      const data = await api('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
      csrf = data.csrfToken; role = data.user.role;
      $('password').value = '';
      await showDashboard();
    } catch (error) { notify(error.message, true); }
  });
  $('logout').addEventListener('click', async () => { await api('/api/admin/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined); showLogin(); });
  $('sync').addEventListener('click', async () => { $('sync').disabled = true; notify('正在同步和构建…'); try { await api('/api/admin/sync', { method: 'POST', body: '{}' }); notify('同步完成'); await refresh(); } catch (error) { notify(error.message, true); } finally { $('sync').disabled = !['admin', 'publisher'].includes(role); } });
  $('refresh').addEventListener('click', refresh);
  $('task-filter').addEventListener('change', refresh);
  document.querySelectorAll('nav button').forEach((button) => button.addEventListener('click', () => {
    view = button.dataset.view;
    $('task-filter-label').hidden = view !== 'tasks';
    refresh();
  }));
  showDashboard().catch(showLogin);
})();
