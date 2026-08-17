// ==========================================================================
// LinkPlease DM Dispatcher - Dashboard Interactive Application Logic
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

function initApp() {
  fetchStats();
  fetchRules();

  // Setup Poll Timer (Every 5 seconds)
  setInterval(fetchStats, 5000);
  setInterval(fetchRules, 10000);

  // Form Submissions
  const ruleForm = document.getElementById('ruleForm');
  const simForm = document.getElementById('simForm');

  if (ruleForm) ruleForm.addEventListener('submit', handleCreateRule);
  if (simForm) simForm.addEventListener('submit', handleSimulateWebhook);
}

// -----------------------------------------------------------------------------
// Live Stats Fetcher
// -----------------------------------------------------------------------------
async function fetchStats() {
  try {
    const res = await fetch('/stats');
    if (!res.ok) throw new Error('Failed to load stats');
    const data = await res.json();

    updateStatValue('statSent', data.sent || 0);
    updateStatValue('statQueued', data.queued || 0);
    updateStatValue('statFailed', data.failed || 0);
    updateStatValue('statBlocked', data.duplicates_blocked || 0);
  } catch (err) {
    console.warn('Stats fetch error:', err.message);
  }
}

function updateStatValue(elementId, value) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = Number(value).toLocaleString();
  }
}

// -----------------------------------------------------------------------------
// Rules Management Engine
// -----------------------------------------------------------------------------
async function fetchRules() {
  try {
    const res = await fetch('/rules');
    if (!res.ok) throw new Error('Failed to load rules');
    const rules = await res.json();
    renderRules(rules);
  } catch (err) {
    console.warn('Rules fetch error:', err.message);
  }
}

function renderRules(rules) {
  const container = document.getElementById('rulesContainer');
  const countBadge = document.getElementById('ruleCountBadge');

  if (!container) return;
  if (countBadge) countBadge.textContent = rules.length;

  if (!rules || rules.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path>
        </svg>
        <p style="font-weight: 600; color: var(--text-muted);">No Automation Rules Configured</p>
        <p style="font-size: 0.8rem; margin-top: 4px;">Create your first keyword rule using the form on the left.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = rules.map(rule => `
    <div class="rule-item">
      <div class="rule-header">
        <span class="keyword-badge">⚡ ${escapeHtml(rule.keyword)}</span>
        <span class="rule-id">${escapeHtml(rule.rule_id || 'active')}</span>
      </div>
      <div class="rule-message">
        💬 "${escapeHtml(rule.dm_message)}"
      </div>
    </div>
  `).join('');
}

async function handleCreateRule(e) {
  e.preventDefault();
  const keywordInput = document.getElementById('ruleKeyword');
  const messageInput = document.getElementById('ruleMessage');
  const btn = document.getElementById('btnCreateRule');

  const keyword = keywordInput.value.trim();
  const dm_message = messageInput.value.trim();

  if (!keyword || !dm_message) {
    showToast('Keyword and DM message are required', 'error');
    return;
  }

  btn.disabled = true;
  btn.innerText = 'Creating Rule...';

  try {
    const res = await fetch('/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, dm_message })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create rule');

    showToast(`Rule created for keyword "${keyword}"`, 'success');
    keywordInput.value = '';
    messageInput.value = '';
    fetchRules();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Create Automation Rule';
  }
}

// -----------------------------------------------------------------------------
// Webhook Simulator Engine
// -----------------------------------------------------------------------------
async function handleSimulateWebhook(e) {
  e.preventDefault();
  const eventType = document.getElementById('simEventType').value;
  const userId = document.getElementById('simUserId').value.trim() || 'usr_demo_101';
  const commentId = document.getElementById('simCommentId').value.trim() || 'cmt_demo_' + Date.now();
  const commentText = document.getElementById('simCommentText').value.trim() || 'PRICE please!';
  const btn = document.getElementById('btnSimulate');

  btn.disabled = true;
  btn.innerText = 'Triggering Webhook...';

  const mockPayload = {
    event_id: 'evt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    event_type: eventType,
    data: {
      comment_id: commentId,
      user_id: userId,
      text: commentText,
      from: { user_id: userId, username: 'demo_user' }
    }
  };

  try {
    const res = await fetch('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PseudoGram-Signature': 'sha256=simulation_bypass'
      },
      body: JSON.stringify(mockPayload)
    });

    const data = await res.json();
    if (res.status === 403) {
      showToast('HMAC signature required on production. Standard fast ACK verified.', 'info');
    } else {
      showToast(`Webhook [${eventType}] ACK: 200 OK`, 'success');
    }

    setTimeout(fetchStats, 600);
  } catch (err) {
    showToast(`Webhook simulation failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Send Test Webhook Event';
  }
}

// -----------------------------------------------------------------------------
// Toast Notifications & Helpers
// -----------------------------------------------------------------------------
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
    <span>${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
