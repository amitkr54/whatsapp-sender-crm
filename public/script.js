const socket = io();
let currentChatPhone = null;

// --- Machine ID Auth ---
function getMachineId() {
    let id = localStorage.getItem('machine_id');
    if (!id) {
        // Generate stable ID from browser fingerprint
        const fp = [
            navigator.userAgent,
            screen.width + 'x' + screen.height,
            screen.colorDepth,
            Intl.DateTimeFormat().resolvedOptions().timeZone,
            navigator.language,
            navigator.hardwareConcurrency
        ].join('|');
        // Simple hash
        let hash = 0;
        for (let i = 0; i < fp.length; i++) {
            const chr = fp.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        id = 'machine_' + Math.abs(hash).toString(36) + '_' + Date.now().toString(36);
        localStorage.setItem('machine_id', id);
    }
    return id;
}
const machineId = getMachineId();

const _origFetch = window.fetch;
window.fetch = function(url, opts = {}) {
    opts.headers = opts.headers || {};
    if (opts.headers instanceof Headers) {
        opts.headers.set('X-Machine-Id', machineId);
    } else {
        opts.headers['X-Machine-Id'] = machineId;
    }
    return _origFetch.call(this, url, opts).then(res => {
        if (res.status === 401 && !url.includes('/api/login')) {
            showToast && showToast('Session expired. Please log in again.', 'error');
            setTimeout(() => { window.location.href = '/login.html'; }, 2000);
        }
        return res;
    });
};

// Clear browser autofill from search input
window.addEventListener('load', () => {
    const searchInput = document.getElementById('chat-search-input');
    if (searchInput) searchInput.value = '';
    filterReportByStatus('all');
});

// Button ripple tracking for gradient highlight effect
document.addEventListener('mousemove', (e) => {
    const btn = e.target.closest('.btn');
    if (btn) {
        const rect = btn.getBoundingClientRect();
        btn.style.setProperty('--x', `${((e.clientX - rect.left) / rect.width) * 100}%`);
        btn.style.setProperty('--y', `${((e.clientY - rect.top) / rect.height) * 100}%`);
    }
});

// Toast Notification
function showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const icons = { success: 'check-circle', error: 'alert-circle', info: 'info' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<i data-lucide="${icons[type] || 'info'}" style="width:16px; height:16px; vertical-align:middle; margin-right:8px; flex-shrink:0;"></i>${message}`;
    toast.style.display = 'flex';
    toast.style.alignItems = 'center';
    container.appendChild(toast);
    if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [toast] });
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}

// Navigation
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        if (!tab) return;
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const tabEl = document.getElementById(`tab-${tab}`);
        if (tabEl) tabEl.classList.add('active');
        const tabNames = { inbox: 'Inbox', contacts: 'Contacts', campaign: 'Campaign', templates: 'Templates', dashboard: 'Dashboard', accounts: 'Settings', notifications: 'System Alerts', reports: 'Reports' };
        const header = document.querySelector('header h1');
        if (header) header.innerText = tabNames[tab] || tab.charAt(0).toUpperCase() + tab.slice(1);
        if (tab === 'notifications') loadNotifications();
        if (tab === 'templates') loadAllTemplates();
        if (tab === 'reports') loadReports();
        if (tab === 'campaign') loadQueueStatus();
    });
});

// Settings & Setup
async function loadSettings() {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    const grid = document.getElementById('account-grid');
    if (settings.phoneNumberId && settings.accessToken) {
        const tokenMasked = settings.accessToken.substring(0, 12) + '••••••••••••••••••';
        grid.innerHTML = `
            <div class="account-card">
                <div class="account-header"><strong>🟢 ${settings.label || 'Default'}</strong><span class="status-badge status-ready">Active</span></div>
                <div style="font-size: 12px; color: var(--text-dim); display: flex; flex-direction: column; gap: 4px; margin-top: 8px;">
                    <span><strong>Phone ID:</strong> ${settings.phoneNumberId}</span>
                    <span><strong>WABA ID:</strong> ${settings.wabaId || 'N/A'}</span>
                    <span style="color: var(--accent);"><strong>Token:</strong> ${tokenMasked}</span>
                </div>
            </div>`;
        document.getElementById('active-accounts-count').innerText = '1';
    } else {
        grid.innerHTML = `<div class="account-card" style="border: 2px dashed var(--border); text-align:center; color:var(--text-dim); padding:30px;">
            <i data-lucide="alert-circle" style="width:28px; margin-bottom:10px; color:#f59e0b;"></i><br>
            No credentials saved yet. Click <strong>Edit Credentials</strong> above to set up your Meta API.
        </div>`;
        lucide.createIcons();
        document.getElementById('active-accounts-count').innerText = '0';
    }
}

function showAddAccountModal() {
    // Pre-fill modal with currently saved values
    fetch('/api/settings').then(r => r.json()).then(s => {
        document.getElementById('acc-label').value = s.label || '';
        document.getElementById('acc-phone-id').value = s.phoneNumberId || '';
        document.getElementById('acc-waba-id').value = s.wabaId || '';
        document.getElementById('acc-token').value = s.accessToken || '';
    });
    document.getElementById('add-account-modal').classList.add('active');
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    const content = modal.querySelector('.modal-content');
    if (content) {
        content.style.animation = 'modalPop 0.2s ease reverse forwards';
    }
    setTimeout(() => {
        modal.classList.remove('active');
        if (content) content.style.animation = '';
    }, 180);
}

async function saveAPIAccount() {
    const settings = {
        label: document.getElementById('acc-label').value.trim() || 'Default',
        phoneNumberId: document.getElementById('acc-phone-id').value.trim(),
        wabaId: document.getElementById('acc-waba-id').value.trim(),
        accessToken: document.getElementById('acc-token').value.trim(),
        verifyToken: 'whatsapp123'
    };
    if (!settings.phoneNumberId || !settings.accessToken) {
        return showToast('Phone Number ID and Access Token are required!', 'error');
    }
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    showToast('✅ Credentials saved successfully!', 'success');
    closeModal('add-account-modal');
    loadSettings();
}

function toggleTokenVisibility() {
    const input = document.getElementById('acc-token');
    const icon = document.getElementById('toggle-token-icon');
    if (input.type === 'password') {
        input.type = 'text';
        icon.setAttribute('data-lucide', 'eye-off');
    } else {
        input.type = 'password';
        icon.setAttribute('data-lucide', 'eye');
    }
    lucide.createIcons();
}

async function loadWebhookUrl() {
    const res = await fetch('/api/webhook-url');
    const data = await res.json();
    const display = document.getElementById('webhook-url-display');
    if (display) { display.innerText = data.url; display.dataset.url = data.url; }
}

function copyWebhookUrl() {
    navigator.clipboard.writeText(document.getElementById('webhook-url-display').dataset.url);
    showToast('Copied to clipboard!', 'success');
}

// Template Syncing
window.globalSyncedTemplates = [];

function onCampaignTemplateChange() {
    const select = document.getElementById('template-name');
    const selectedName = select.value;

    const previewWrap = document.getElementById('campaign-template-preview');
    const emptyState  = document.getElementById('campaign-no-template');
    const mediaGroup  = document.getElementById('campaign-header-media-group');
    const varGroup    = document.getElementById('campaign-variable-group');
    const varInputs   = document.getElementById('campaign-variable-inputs');

    // Reset
    document.getElementById('campaign-header-file').value = '';
    document.getElementById('campaign-header-url').value = '';
    document.getElementById('selected-media-id').value = '';
    document.getElementById('media-auto-use-badge').classList.add('hidden');
    switchMediaTab('library');
    document.getElementById('camp-prev-header').innerHTML = '';
    document.getElementById('camp-prev-body').innerHTML = '';
    document.getElementById('camp-prev-footer').innerHTML = '';
    document.getElementById('camp-prev-buttons').innerHTML = '';
    varInputs.innerHTML = '';
    mediaGroup.classList.add('hidden');
    varGroup.classList.add('hidden');

    // Load media library whenever the media section is about to show
    loadMediaLibrary();

    if (!selectedName || !window.globalSyncedTemplates?.length) {
        previewWrap.classList.add('hidden');
        emptyState.classList.remove('hidden');
        return;
    }

    const t = window.globalSyncedTemplates.find(x => x.name === selectedName);
    if (!t) {
        previewWrap.classList.add('hidden');
        emptyState.classList.remove('hidden');
        return;
    }

    // Auto-set language code
    document.getElementById('template-lang').value = t.language || 'en';

    previewWrap.classList.remove('hidden');
    emptyState.classList.add('hidden');

    // --- Render Preview ---
    t.components?.forEach(comp => {
        if (comp.type === 'HEADER') {
            const headerEl = document.getElementById('camp-prev-header');
            if (comp.format === 'TEXT') {
                headerEl.innerHTML = `<div style="font-weight:700; font-size:15px; color:#e9edef; margin-bottom:4px;">${comp.text || ''}</div>`;
            } else {
                // Check for example media
                let mediaUrl = comp.example?.header_handle?.[0] || comp.example?.header_url?.[0] || null;
                if (comp.format === 'IMAGE' && mediaUrl) {
                    headerEl.innerHTML = `<img src="${mediaUrl}" style="width:100%; border-radius:6px; margin-bottom:6px; max-height:160px; object-fit:cover;">`;
                } else if (comp.format === 'VIDEO' && mediaUrl) {
                    headerEl.innerHTML = `<video src="${mediaUrl}" controls style="width:100%; border-radius:6px; margin-bottom:6px; max-height:160px;"></video>`;
                } else {
                    const icon = comp.format === 'VIDEO' ? '🎬' : comp.format === 'DOCUMENT' ? '📄' : '🖼️';
                    headerEl.innerHTML = `<div style="background:rgba(167,139,250,0.1); border:1px dashed rgba(167,139,250,0.3); padding:14px; border-radius:6px; text-align:center; color:#a78bfa; font-size:12px; margin-bottom:6px;">${icon} ${comp.format} — will be uploaded below</div>`;
                }
                // Show media upload section
                const typeLabel = document.getElementById('campaign-header-media-type');
                typeLabel.innerText = comp.format.charAt(0) + comp.format.slice(1).toLowerCase();
                const fileInput = document.getElementById('campaign-header-file');
                if (comp.format === 'IMAGE') fileInput.accept = 'image/*';
                else if (comp.format === 'VIDEO') fileInput.accept = 'video/*';
                else fileInput.accept = '.pdf,.doc,.docx,.xls,.xlsx';
                mediaGroup.classList.remove('hidden');

                // Auto-fill header URL from template example media
                const autoUseBadge = document.getElementById('media-auto-use-badge');
                if (mediaUrl) {
                    document.getElementById('campaign-header-url').value = mediaUrl;
                    autoUseBadge.classList.remove('hidden');
                } else {
                    document.getElementById('campaign-header-url').value = '';
                    autoUseBadge.classList.add('hidden');
                }
            }
        }

        if (comp.type === 'BODY') {
            const bodyText = comp.text || '';
            document.getElementById('camp-prev-body').innerHTML = renderWhatsAppFormatting(bodyText);

            // Detect variables {{1}}, {{2}} etc.
            const vars = [...new Set((bodyText.match(/\{\{(\d+)\}\}/g) || []))].sort();
            if (vars.length > 0) {
                varGroup.classList.remove('hidden');
                varInputs.innerHTML = '';
                vars.forEach((v, i) => {
                    const num = v.replace(/[{}]/g, '');
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex; align-items:center; gap:10px;';
                    row.innerHTML = `
                        <span style="min-width:30px; font-size:12px; color:var(--accent); font-weight:700;">{{${num}}}</span>
                        <span style="font-size:12px; color:var(--text-dim);">→</span>
                        <input type="text" data-var="${num}" placeholder="CSV column name, e.g. Name" style="flex:1; font-size:12px; padding:7px 10px;" oninput="updateCampaignMapping()">
                    `;
                    varInputs.appendChild(row);
                });
                updateCampaignMapping();
            }
        }

        if (comp.type === 'FOOTER') {
            document.getElementById('camp-prev-footer').innerText = comp.text || '';
        }

        if (comp.type === 'BUTTONS') {
            const btnsEl = document.getElementById('camp-prev-buttons');
            comp.buttons?.forEach(btn => {
                const b = document.createElement('div');
                b.style.cssText = 'background:#202c33; padding:8px; text-align:center; border-radius:6px; color:#00a884; font-size:12px; cursor:default;';
                b.innerText = btn.text;
                btnsEl.appendChild(b);
            });
        }
    });

    lucide.createIcons();
}

function updateCampaignMapping() {
    const inputs = document.querySelectorAll('#campaign-variable-inputs input[data-var]');
    const mappingObj = {};
    inputs.forEach((inp, idx) => {
        if (inp.value.trim()) mappingObj[idx] = inp.value.trim();
    });
    document.getElementById('template-mapping').value = JSON.stringify(mappingObj);
}



async function loadCampaignTemplates() {
    try {
        const res = await fetch('/api/templates/sync');
        const data = await res.json();
        if (data.error) return;
        
        window.globalSyncedTemplates = data.templates || [];
        
        const select = document.getElementById('template-name');
        if (!select) return;
        select.innerHTML = '<option value="">-- Select a template --</option>';
        
        const inboxSelect = document.getElementById('inbox-template-select');
        if (inboxSelect) inboxSelect.innerHTML = '<option value="">-- Select a template --</option>';
        
        data.templates.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.name;
            opt.innerText = `${t.name} (${t.language})`;
            select.appendChild(opt.cloneNode(true));
            if (inboxSelect) inboxSelect.appendChild(opt);
        });
        
        onCampaignTemplateChange();
    } catch(e) {
        console.error('Failed to pre-load campaign templates:', e);
    }
}

async function syncTemplates() {
    showToast('Syncing templates from Meta...', 'info');
    try {
        const res = await fetch('/api/templates/sync');
        const data = await res.json();
        if (data.error) throw new Error(data.error.error?.message || data.error);
        
        window.globalSyncedTemplates = data.templates || [];
        
        const select = document.getElementById('template-name');
        const inboxSelect = document.getElementById('inbox-template-select');
        select.innerHTML = '<option value="">-- Select a template --</option>'; 
        if (inboxSelect) inboxSelect.innerHTML = '<option value="">-- Select a template --</option>';
        
        data.templates.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.name;
            opt.innerText = `${t.name} (${t.language})`;
            select.appendChild(opt.cloneNode(true));
            if (inboxSelect) inboxSelect.appendChild(opt);
        });
        showToast(`Synced ${data.templates.length} templates successfully!`, 'success');
        onCampaignTemplateChange();
    } catch (e) {
        showToast('Sync failed: ' + e.message, 'error');
    }
}

// --- Templates Management ---
let globalMetaTemplates = [];

async function loadAllTemplates() {
    const grid = document.getElementById('templates-grid');
    if (!grid) return;
    grid.innerHTML = '<div style="text-align:center; grid-column: 1/-1; padding: 40px; color: var(--text-dim);">Loading templates...</div>';
    try {
        const res = await fetch('/api/templates/all');
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        
        globalMetaTemplates = data.templates || [];
        grid.innerHTML = '';
        if (globalMetaTemplates.length === 0) {
            grid.innerHTML = '<div style="text-align:center; grid-column: 1/-1; padding: 40px; color: var(--text-dim);">No templates found. Create one above!</div>';
            return;
        }
        
        globalMetaTemplates.forEach(t => {
            let statusColor = 'var(--text-dim)';
            let statusBg = 'rgba(255,255,255,0.05)';
            if (t.status === 'APPROVED') { statusColor = 'var(--success)'; statusBg = 'rgba(16, 185, 129, 0.1)'; }
            else if (t.status === 'REJECTED') { statusColor = 'var(--error)'; statusBg = 'rgba(239, 68, 68, 0.1)'; }
            else if (t.status === 'PENDING') { statusColor = 'var(--warning)'; statusBg = 'rgba(245, 158, 11, 0.1)'; }
            
            const card = document.createElement('div');
            card.className = 'card';
            card.style.cssText = "display: flex; flex-direction: column; gap: 12px; padding: 15px;";
            
            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                    <div style="font-weight: 600; font-size: 15px; color: var(--text-main);">${t.name}</div>
                    <span style="background: ${statusBg}; color: ${statusColor}; padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase;">${t.status}</span>
                </div>
                <div style="font-size: 12px; color: var(--text-dim); display: flex; gap: 10px;">
                    <span style="display: flex; align-items: center; gap: 4px;"><i data-lucide="tag" style="width: 12px; height: 12px;"></i> ${t.category}</span>
                    <span style="display: flex; align-items: center; gap: 4px;"><i data-lucide="globe" style="width: 12px; height: 12px;"></i> ${t.language}</span>
                </div>
                <div style="margin-top: auto; display: flex; gap: 10px; padding-top: 15px; border-top: 1px solid var(--border);">
                    <button class="btn btn-outline btn-sm" onclick="previewTemplate('${t.name}')" style="flex: 1; justify-content: center;"><i data-lucide="eye" style="width: 14px;"></i> View Mockup</button>
                    ${t.status === 'APPROVED' ? `<button class="btn btn-primary btn-sm" onclick="document.querySelector('[data-tab=\\'campaign\\']').click()" style="flex: 1; justify-content: center;"><i data-lucide="send" style="width: 14px;"></i> Use</button>` : ''}
                </div>
            `;
            grid.appendChild(card);
        });
        lucide.createIcons();
    } catch(e) {
        grid.innerHTML = `<div style="text-align:center; color: var(--error); grid-column: 1/-1;">Error: ${e.message}</div>`;
    }
}

function previewTemplate(templateName) {
    const t = globalMetaTemplates.find(x => x.name === templateName);
    if (!t || !t.components) return showToast('Template data not found', 'error');

    document.getElementById('preview-header').innerHTML = '';
    document.getElementById('preview-body').innerHTML = '';
    document.getElementById('preview-footer').innerHTML = '';
    const btnsContainer = document.getElementById('preview-buttons');
    btnsContainer.innerHTML = '';

    t.components.forEach(comp => {
        if (comp.type === 'HEADER') {
            if (comp.format === 'TEXT') {
                document.getElementById('preview-header').innerText = comp.text || '';
            } else {
                let mediaUrl = null;
                if (comp.example && comp.example.header_handle && comp.example.header_handle.length > 0) {
                    mediaUrl = comp.example.header_handle[0];
                } else if (comp.example && comp.example.header_url && comp.example.header_url.length > 0) {
                    mediaUrl = comp.example.header_url[0];
                }

                if (comp.format === 'IMAGE' && mediaUrl) {
                    document.getElementById('preview-header').innerHTML = `<img src="${mediaUrl}" style="width: 100%; border-radius: 6px; margin-bottom: 5px; object-fit: cover; max-height: 200px;" alt="Header Image">`;
                } else if (comp.format === 'VIDEO' && mediaUrl) {
                    document.getElementById('preview-header').innerHTML = `<video src="${mediaUrl}" controls style="width: 100%; border-radius: 6px; margin-bottom: 5px; max-height: 200px;"></video>`;
                } else {
                    const icon = comp.format === 'VIDEO' ? '🎬 Video' : comp.format === 'DOCUMENT' ? '📄 Document' : '📷 Image';
                    document.getElementById('preview-header').innerHTML = `<div style="background: rgba(0,0,0,0.2); padding: 20px; text-align: center; border-radius: 6px; color: var(--text-dim); margin-bottom: 5px;">${icon} Placeholder</div>`;
                }
            }
        }
        if (comp.type === 'BODY') {
            document.getElementById('preview-body').innerHTML = renderWhatsAppFormatting(comp.text || '');
        }
        if (comp.type === 'FOOTER') {
            document.getElementById('preview-footer').innerText = comp.text || '';
        }
        if (comp.type === 'BUTTONS') {
            comp.buttons.forEach(btn => {
                const btnDiv = document.createElement('div');
                btnDiv.style.cssText = "background-color: #202c33; padding: 10px; text-align: center; border-radius: 8px; color: #00a884; font-size: 14px; cursor: pointer; box-shadow: 0 1px 0.5px rgba(11, 20, 26, 0.13); display: flex; justify-content: center; align-items: center; gap: 8px;";
                let icon = '';
                if (btn.type === 'URL') icon = '<i data-lucide="external-link" style="width:16px;"></i>';
                if (btn.type === 'PHONE_NUMBER') icon = '<i data-lucide="phone" style="width:16px;"></i>';
                if (btn.type === 'QUICK_REPLY') icon = '<i data-lucide="corner-up-left" style="width:16px;"></i>';
                btnDiv.innerHTML = `${icon} ${btn.text}`;
                btnsContainer.appendChild(btnDiv);
            });
        }
    });

    document.getElementById('preview-template-modal').classList.add('active');
    lucide.createIcons();
}

let tplHeaderMediaPreviewUrl = null;

function showCreateTemplateModal() {
    document.getElementById('tpl-name').value = '';
    document.getElementById('tpl-category').value = 'MARKETING';
    document.getElementById('tpl-language').value = 'en_US';
    document.getElementById('tpl-header-type').value = 'NONE';
    document.getElementById('tpl-header-text').value = '';
    document.getElementById('tpl-body').value = '';
    document.getElementById('tpl-footer').value = '';
    document.getElementById('tpl-buttons-container').innerHTML = '';
    document.getElementById('tpl-header-media-file').value = '';
    tplHeaderMediaPreviewUrl = null;
    resetHeaderMediaPreview();
    toggleHeaderInputs();
    updateLivePreview();
    document.getElementById('create-template-modal').classList.add('active');
    lucide.createIcons();
}

function toggleHeaderInputs() {
    const type = document.getElementById('tpl-header-type').value;
    const textInput = document.getElementById('tpl-header-text');
    const mediaArea = document.getElementById('tpl-header-media-area');
    
    textInput.classList.add('hidden');
    mediaArea.classList.add('hidden');
    
    if (type === 'TEXT') {
        textInput.classList.remove('hidden');
    } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(type)) {
        mediaArea.classList.remove('hidden');
        const fileInput = document.getElementById('tpl-header-media-file');
        if (type === 'IMAGE') fileInput.accept = 'image/*';
        else if (type === 'VIDEO') fileInput.accept = 'video/*';
        else fileInput.accept = '.pdf,.doc,.docx,.xls,.xlsx';
    }
}

function resetHeaderMediaPreview() {
    const preview = document.getElementById('tpl-header-media-preview');
    preview.innerHTML = `
        <i data-lucide="upload-cloud" style="width: 28px; color: var(--text-dim);"></i>
        <span style="font-size: 12px; color: var(--text-dim);">Click to browse file</span>
    `;
    preview.style.height = '140px';
}

function handleHeaderMediaSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    const preview = document.getElementById('tpl-header-media-preview');
    const headerType = document.getElementById('tpl-header-type').value;
    
    if (headerType === 'IMAGE' && file.type.startsWith('image/')) {
        const url = URL.createObjectURL(file);
        tplHeaderMediaPreviewUrl = url;
        preview.innerHTML = `<img src="${url}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 8px;">`;
        preview.style.height = '160px';
    } else if (headerType === 'VIDEO' && file.type.startsWith('video/')) {
        const url = URL.createObjectURL(file);
        tplHeaderMediaPreviewUrl = null;
        preview.innerHTML = `<video src="${url}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 8px;" controls></video>`;
        preview.style.height = '160px';
    } else {
        tplHeaderMediaPreviewUrl = null;
        preview.innerHTML = `
            <i data-lucide="file-check" style="width: 28px; color: var(--accent);"></i>
            <span style="font-size: 12px; color: var(--text-main); font-weight: 500;">${file.name}</span>
        `;
    }
    updateLivePreview();
    lucide.createIcons();
}

function insertFormat(marker) {
    const textarea = document.getElementById('tpl-body');
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const selected = text.substring(start, end);
    
    if (selected) {
        textarea.value = text.substring(0, start) + marker + selected + marker + text.substring(end);
        textarea.selectionStart = start;
        textarea.selectionEnd = end + marker.length * 2;
    } else {
        textarea.value = text.substring(0, start) + marker + marker + text.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + marker.length;
    }
    textarea.focus();
    updateLivePreview();
}

function switchMediaTab(tab) {
    const libTab = document.getElementById('media-tab-library');
    const uploadTab = document.getElementById('media-tab-upload');
    const libBtn = document.getElementById('tab-library-btn');
    const uploadBtn = document.getElementById('tab-upload-btn');

    if (tab === 'library') {
        libTab.style.display = 'block';
        uploadTab.style.display = 'none';
        libBtn.style.background = 'rgba(167, 139, 250, 0.25)';
        libBtn.style.border = '1px solid #a78bfa';
        libBtn.style.color = '#a78bfa';
        uploadBtn.style.background = 'rgba(255, 255, 255, 0.05)';
        uploadBtn.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        uploadBtn.style.color = 'var(--text-dim)';
    } else {
        libTab.style.display = 'none';
        uploadTab.style.display = 'block';
        uploadBtn.style.background = 'rgba(167, 139, 250, 0.25)';
        uploadBtn.style.border = '1px solid #a78bfa';
        uploadBtn.style.color = '#a78bfa';
        libBtn.style.background = 'rgba(255, 255, 255, 0.05)';
        libBtn.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        libBtn.style.color = 'var(--text-dim)';
    }
}

async function loadMediaLibrary() {
    const grid = document.getElementById('media-library-grid');
    if (!grid) return;

    try {
        const res = await fetch('/api/media-library');
        const list = await res.json();
        
        if (list.length === 0) {
            grid.innerHTML = '<div style="text-align:center; color:var(--text-dim); font-size:12px; padding:20px;">No saved media yet. Upload an image in the next tab to save it here.</div>';
            return;
        }

        const selectedInput = document.getElementById('selected-media-id');
        
        // Auto-select the first item if nothing is selected
        if (!selectedInput.value && list.length > 0) {
            selectedInput.value = list[0].id;
        }

        grid.innerHTML = list.map(item => {
            const isSelected = selectedInput.value === item.id;
            const imgUrl = item.url || item.localUrl || item.cloudinaryUrl || '';
            return `
                <div class="media-lib-item" id="media-item-${item.id}" onclick="selectMediaLibraryItem('${item.id}', '${imgUrl}')" style="display:flex; align-items:center; gap:10px; background:rgba(255,255,255,0.03); border:1px solid ${isSelected ? '#a78bfa' : 'rgba(255,255,255,0.1)'}; padding:8px; border-radius:8px; cursor:pointer; position:relative; transition: border 0.2s;">
                    <img src="${imgUrl}" style="width:40px; height:40px; object-fit:cover; border-radius:4px;" />
                    <div style="flex:1; overflow:hidden;">
                        <div style="font-size:12px; color:white; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:500;">${item.name}</div>
                        <div style="font-size:10px; color:var(--text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">ID: ${item.id}</div>
                    </div>
                    <i data-lucide="trash-2" style="width:14px; color:var(--error); cursor:pointer; margin-left: auto;" onclick="event.stopPropagation(); deleteMediaLibraryItem('${item.id}')"></i>
                </div>
            `;
        }).join('');
        lucide.createIcons();

        // Trigger preview update if auto-selected
        if (selectedInput.value) {
            const selectedItem = list.find(i => i.id === selectedInput.value);
            if (selectedItem) {
                const headerEl = document.getElementById('camp-prev-header');
                const imgUrl = selectedItem.url || selectedItem.localUrl || selectedItem.cloudinaryUrl || '';
                if (headerEl && !headerEl.innerHTML) {
                    headerEl.innerHTML = `<img src="${imgUrl}" style="width: 100%; border-radius: 6px; max-height: 180px; object-fit: cover; margin-bottom: 5px;">`;
                }
            }
        }
    } catch(err) {
        grid.innerHTML = '<div style="text-align:center; color:var(--error); font-size:12px; padding:20px;">Failed to load media library.</div>';
    }
}

function selectMediaLibraryItem(id, url) {
    const selectedInput = document.getElementById('selected-media-id');
    const items = document.querySelectorAll('.media-lib-item');
    items.forEach(el => el.style.borderColor = 'rgba(255,255,255,0.1)');

    if (selectedInput.value === id) {
        // Deselect
        selectedInput.value = '';
        document.getElementById('camp-prev-header').innerHTML = '';
    } else {
        selectedInput.value = id;
        const target = document.getElementById(`media-item-${id}`);
        if (target) target.style.borderColor = '#a78bfa';

        // Update live preview in campaign creator
        const headerEl = document.getElementById('camp-prev-header');
        if (headerEl) {
            headerEl.innerHTML = `<img src="${url}" style="width: 100%; border-radius: 6px; max-height: 180px; object-fit: cover; margin-bottom: 5px;">`;
        }
        // Hide auto-use badge since user made a manual selection
        document.getElementById('media-auto-use-badge').classList.add('hidden');
    }
}

async function deleteMediaLibraryItem(id) {
    if (!confirm('Are you sure you want to delete this image from your library?')) return;
    try {
        const res = await fetch(`/api/media-library/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            if (document.getElementById('selected-media-id').value === id) {
                document.getElementById('selected-media-id').value = '';
                document.getElementById('camp-prev-header').innerHTML = '';
            }
            loadMediaLibrary();
        }
    } catch(err) {
        alert('Failed to delete item: ' + err.message);
    }
}


function insertVariable() {
    const textarea = document.getElementById('tpl-body');
    const text = textarea.value;
    const existingVars = text.match(/\{\{(\d+)\}\}/g) || [];
    const nextNum = existingVars.length + 1;
    const pos = textarea.selectionStart;
    textarea.value = text.substring(0, pos) + `{{${nextNum}}}` + text.substring(pos);
    textarea.focus();
    updateLivePreview();
}

function renderWhatsAppFormatting(text) {
    if (!text) return '';
    let html = text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*([\s\S]+?)\*/g, '<b>$1</b>')
        .replace(/_([\s\S]+?)_/g, '<i>$1</i>')
        .replace(/~([\s\S]+?)~/g, '<s>$1</s>')
        .replace(/```([\s\S]+?)```/g, '<code style="background: rgba(0,0,0,0.3); padding: 2px 4px; border-radius: 3px; font-family: monospace;">$1</code>')
        .replace(/\{\{(\d+)\}\}/g, '<span style="background: rgba(0,168,132,0.2); color: var(--accent); padding: 1px 4px; border-radius: 3px;">{{$1}}</span>')
        .replace(/\n/g, '<br>');
    return html;
}

function stripWhatsAppFormatting(text) {
    if (!text) return '';
    return text
        .replace(/\*/g, '')
        .replace(/_/g, ' ')
        .replace(/~/g, '')
        .replace(/```/g, '')
        .replace(/\{\{\d+\}\}/g, '')
        .replace(/\n/g, ' ');
}

function updateLivePreview() {
    const headerType = document.getElementById('tpl-header-type').value;
    const headerText = document.getElementById('tpl-header-text').value;
    const bodyText = document.getElementById('tpl-body').value;
    const footerText = document.getElementById('tpl-footer').value;
    
    const headEl = document.getElementById('live-preview-header');
    if (headerType === 'NONE') {
        headEl.style.display = 'none';
    } else if (headerType === 'TEXT') {
        headEl.style.display = 'block';
        headEl.innerText = headerText || 'Header text...';
    } else if (headerType === 'IMAGE' && tplHeaderMediaPreviewUrl) {
        headEl.style.display = 'block';
        headEl.innerHTML = `<img src="${tplHeaderMediaPreviewUrl}" style="width: 100%; border-radius: 6px; max-height: 180px; object-fit: cover; margin-bottom: 5px;">`;
    } else if (headerType === 'VIDEO' && tplHeaderMediaPreviewUrl) {
        headEl.style.display = 'block';
        headEl.innerHTML = `<video src="${tplHeaderMediaPreviewUrl}" controls style="width: 100%; border-radius: 6px; max-height: 180px; object-fit: cover; margin-bottom: 5px;"></video>`;
    } else {
        headEl.style.display = 'block';
        const icon = headerType === 'VIDEO' ? '🎬 Video' : headerType === 'DOCUMENT' ? '📄 Document' : '📷 Image';
        headEl.innerHTML = `<div style="background: rgba(0,0,0,0.2); padding: 20px; text-align: center; border-radius: 6px; color: var(--text-dim); margin-bottom: 5px;">${icon} — Select a file</div>`;
    }
    
    const bodyEl = document.getElementById('live-preview-body');
    if (bodyText) {
        bodyEl.innerHTML = renderWhatsAppFormatting(bodyText);
    } else {
        bodyEl.innerHTML = '<span style="color: rgba(255,255,255,0.4);">Start typing to see preview...</span>';
    }
    
    const footEl = document.getElementById('live-preview-footer');
    if (footerText) {
        footEl.style.display = 'block';
        footEl.innerText = footerText;
    } else {
        footEl.style.display = 'none';
    }
    
    const btnsContainer = document.getElementById('live-preview-buttons');
    btnsContainer.innerHTML = '';
    const btnDivs = document.getElementById('tpl-buttons-container').children;
    for (let i = 0; i < btnDivs.length; i++) {
        const type = btnDivs[i].querySelector('.btn-type').value;
        const text = btnDivs[i].querySelector('.btn-text').value || `Button ${i+1}`;
        
        const btnObj = document.createElement('div');
        btnObj.style.cssText = "background-color: #202c33; padding: 10px; text-align: center; border-radius: 8px; color: #00a884; font-size: 14px; box-shadow: 0 1px 0.5px rgba(11, 20, 26, 0.13); display: flex; justify-content: center; align-items: center; gap: 8px;";
        let icon = '';
        if (type === 'URL') icon = '<i data-lucide="external-link" style="width:16px;"></i>';
        if (type === 'PHONE_NUMBER') icon = '<i data-lucide="phone" style="width:16px;"></i>';
        if (type === 'QUICK_REPLY') icon = '<i data-lucide="corner-up-left" style="width:16px;"></i>';
        
        btnObj.innerHTML = `${icon} ${text}`;
        btnsContainer.appendChild(btnObj);
    }
    lucide.createIcons();
}

function addTemplateButton() {
    const container = document.getElementById('tpl-buttons-container');
    if (container.children.length >= 3) return alert('Maximum 3 buttons allowed');
    
    const id = `btn-${Date.now()}`;
    const div = document.createElement('div');
    div.id = id;
    div.style.cssText = "display: flex; gap: 10px; align-items: center; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px;";
    div.innerHTML = `
        <select class="btn-type" style="width: 120px;" onchange="updateBtnFields('${id}'); updateLivePreview()">
            <option value="QUICK_REPLY">Quick Reply</option>
            <option value="URL">URL</option>
            <option value="PHONE_NUMBER">Phone</option>
        </select>
        <input type="text" class="btn-text" placeholder="Button Text (max 25)" maxlength="25" style="flex: 1; background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: white; padding: 8px; border-radius: 6px;" oninput="updateLivePreview()">
        <input type="text" class="btn-value hidden" placeholder="URL or Phone number" style="flex: 1; background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: white; padding: 8px; border-radius: 6px;">
        <i data-lucide="trash-2" style="color: var(--error); cursor: pointer; width: 18px;" onclick="document.getElementById('${id}').remove(); updateLivePreview()"></i>
    `;
    container.appendChild(div);
    lucide.createIcons();
    updateLivePreview();
}

function updateBtnFields(id) {
    const div = document.getElementById(id);
    const type = div.querySelector('.btn-type').value;
    const valInput = div.querySelector('.btn-value');
    if (type === 'QUICK_REPLY') {
        valInput.classList.add('hidden');
    } else {
        valInput.classList.remove('hidden');
        valInput.placeholder = type === 'URL' ? 'https://example.com' : '+1234567890';
    }
}

async function submitTemplate() {
    const name = document.getElementById('tpl-name').value.trim();
    if (!name) return alert('Template name is required');
    
    const category = document.getElementById('tpl-category').value;
    const language = document.getElementById('tpl-language').value.trim();
    
    const components = [];
    
    // Header
    const headerType = document.getElementById('tpl-header-type').value;
    if (headerType === 'TEXT') {
        const text = document.getElementById('tpl-header-text').value.trim();
        if (text) components.push({ type: 'HEADER', format: 'TEXT', text });
    } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType)) {
        components.push({ type: 'HEADER', format: headerType });
    }
    
    // Body
    const bodyText = document.getElementById('tpl-body').value.trim();
    if (!bodyText) return alert('Body text is required');
    components.push({ type: 'BODY', text: bodyText });
    
    // Footer
    const footerText = document.getElementById('tpl-footer').value.trim();
    if (footerText) components.push({ type: 'FOOTER', text: footerText });
    
    // Buttons
    const btnDivs = document.getElementById('tpl-buttons-container').children;
    if (btnDivs.length > 0) {
        const buttons = [];
        for (let i = 0; i < btnDivs.length; i++) {
            const type = btnDivs[i].querySelector('.btn-type').value;
            const text = btnDivs[i].querySelector('.btn-text').value.trim();
            const val = btnDivs[i].querySelector('.btn-value').value.trim();
            
            if (!text) return alert('All buttons must have text');
            if (type !== 'QUICK_REPLY' && !val) return alert('URL or Phone number is required for CTA buttons');
            
            const btnObj = { type: type, text: text };
            if (type === 'URL') btnObj.url = val;
            if (type === 'PHONE_NUMBER') btnObj.phone_number = val;
            
            buttons.push(btnObj);
        }
        components.push({ type: 'BUTTONS', buttons: buttons });
    }
    
    const payload = { name, category, language, components };
    
    document.getElementById('btn-submit-template').innerHTML = 'Submitting...';
    
    try {
        const res = await fetch('/api/templates/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        
        showToast('Template submitted successfully!', 'success');
        closeModal('create-template-modal');
        loadAllTemplates();
    } catch(e) {
        alert('Error: ' + e.message);
    } finally {
        document.getElementById('btn-submit-template').innerHTML = 'Submit for Approval';
    }
}

// Contacts Management
let globalContacts = {};
async function loadContacts() {
    const res = await fetch('/api/contacts');
    globalContacts = await res.json();
    renderContactsTable();
    updateTagFilterDropdown();
    document.getElementById('dash-contacts').innerText = Object.keys(globalContacts).length;
}

function updateTagFilterDropdown() {
    const select = document.getElementById('contacts-tag-filter');
    if (!select) return;
    
    const tags = new Set();
    Object.values(globalContacts).forEach(c => {
        if (c.tags) {
            c.tags.forEach(t => tags.add(t));
        }
    });
    
    const currentValue = select.value;
    select.innerHTML = '<option value="">All Tags</option>';
    Array.from(tags).sort().forEach(tag => {
        const opt = document.createElement('option');
        opt.value = tag;
        opt.innerText = tag;
        select.appendChild(opt);
    });
    select.value = currentValue;
}

function filterContactsList() {
    renderContactsTable();
}

function renderContactsTable() {
    const tbody = document.getElementById('contacts-body');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    const searchVal = document.getElementById('contacts-search').value.toLowerCase().trim();
    const tagFilter = document.getElementById('contacts-tag-filter').value;
    
    let entries = Object.entries(globalContacts);
    
    entries = entries.filter(([phone, contact]) => {
        const matchesSearch = !searchVal || 
            phone.includes(searchVal) || 
            (contact.name && contact.name.toLowerCase().includes(searchVal));
            
        const matchesTag = !tagFilter || 
            (contact.tags && contact.tags.includes(tagFilter));
            
        return matchesSearch && matchesTag;
    });

    // Update contact count badge
    const countEl = document.getElementById('contacts-count');
    if (countEl) countEl.innerText = entries.length;

    if (entries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-dim); padding: 30px;">No contacts match current filters.</td></tr>';
        return;
    }

    entries.forEach(([phone, contact]) => {
        const tr = document.createElement('tr');
        const tagsHtml = contact.tags?.map(t => `<span style="background: rgba(0, 168, 132, 0.1); color: var(--accent); padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-right: 4px;">${t}</span>`).join('') || '-';
        
        let attrsHtml = '-';
        if (contact.attributes && Object.keys(contact.attributes).length > 0) {
            attrsHtml = Object.entries(contact.attributes).map(([k, v]) => `
                <div style="font-size: 11px; margin-bottom: 2px;">
                    <strong style="color: var(--text-dim);">${k}:</strong> <span style="color: var(--text-main);">${v}</span>
                </div>
            `).join('');
        }
        
        tr.innerHTML = `
            <td style="font-weight: 600;">${contact.name}</td>
            <td style="color: var(--text-dim);">${phone}</td>
            <td>${tagsHtml}</td>
            <td><div style="max-height: 80px; overflow-y: auto;">${attrsHtml}</div></td>
            <td>
                <button class="btn btn-outline btn-sm" onclick="editContact('${phone}')">
                    <i data-lucide="edit" style="width:14px; margin:0;"></i> Edit
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    lucide.createIcons();
}

function showAddContactModal() {
    document.getElementById('contact-modal-title').innerText = 'Add New Contact';
    document.getElementById('contact-phone').readOnly = false;
    document.getElementById('contact-phone').value = '';
    document.getElementById('contact-name').value = '';
    document.getElementById('contact-tags').value = '';
    document.getElementById('contact-attributes-container').innerHTML = '';
    document.getElementById('contact-modal').classList.add('active');
}

function addContactAttributeRow(key = '', val = '') {
    const container = document.getElementById('contact-attributes-container');
    const rowId = 'attr-row-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const div = document.createElement('div');
    div.id = rowId;
    div.style.cssText = "display: flex; gap: 8px; align-items: center;";
    div.className = "attribute-row";
    div.innerHTML = `
        <input type="text" class="attr-key" placeholder="Key (e.g. Email)" value="${key}" style="flex: 1; font-size: 13px; background: rgba(0,0,0,0.2); border: 1px solid var(--border); color: white; padding: 6px 10px; border-radius: 6px;">
        <input type="text" class="attr-val" placeholder="Value" value="${val}" style="flex: 1.5; font-size: 13px; background: rgba(0,0,0,0.2); border: 1px solid var(--border); color: white; padding: 6px 10px; border-radius: 6px;">
        <i data-lucide="trash-2" style="color: var(--error); cursor: pointer; width: 16px;" onclick="document.getElementById('${rowId}').remove()"></i>
    `;
    container.appendChild(div);
    lucide.createIcons();
}

function editContact(phone) {
    document.getElementById('contact-modal-title').innerText = 'Edit Contact';
    document.getElementById('contact-phone').readOnly = true;
    document.getElementById('contact-phone').value = phone;
    document.getElementById('contact-name').value = globalContacts[phone].name;
    document.getElementById('contact-tags').value = globalContacts[phone].tags?.join(', ') || '';
    
    const container = document.getElementById('contact-attributes-container');
    container.innerHTML = '';
    const attributes = globalContacts[phone].attributes || {};
    Object.entries(attributes).forEach(([k, v]) => {
        addContactAttributeRow(k, v);
    });
    
    document.getElementById('contact-modal').classList.add('active');
}

async function saveContact() {
    const phone = document.getElementById('contact-phone').value.trim();
    const name = document.getElementById('contact-name').value.trim();
    const tags = document.getElementById('contact-tags').value.split(',').map(t => t.trim()).filter(t => t);
    
    const attributes = {};
    const rows = document.querySelectorAll('#contact-attributes-container .attribute-row');
    rows.forEach(row => {
        const k = row.querySelector('.attr-key').value.trim();
        const v = row.querySelector('.attr-val').value.trim();
        if (k && v) {
            attributes[k] = v;
        }
    });

    if (!phone) return alert('Phone number required');
    await fetch('/api/contacts', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ phone, name, tags, attributes }) 
    });
    showToast('Contact saved', 'success');
    closeModal('contact-modal');
    loadContacts();
    loadInboxList();
}

let selectedImportFile = null;

function showImportModal() {
    selectedImportFile = null;
    document.getElementById('import-file-input').value = '';
    document.getElementById('import-default-tags').value = '';
    document.getElementById('import-file-label').innerHTML = 'Click to browse or drag a <strong>.csv / .xlsx</strong> file';
    document.getElementById('btn-start-import').disabled = true;
    document.getElementById('import-modal').classList.add('active');
}

function onImportFileSelected(event) {
    const file = event.target.files[0];
    if (file) {
        selectedImportFile = file;
        document.getElementById('import-file-label').innerHTML = `<strong>Selected:</strong> ${file.name}`;
        document.getElementById('btn-start-import').disabled = false;
    }
}

async function startImport() {
    if (!selectedImportFile) return;
    
    const defaultTags = document.getElementById('import-default-tags').value.trim();
    const formData = new FormData();
    formData.append('file', selectedImportFile);
    if (defaultTags) {
        formData.append('defaultTags', defaultTags);
    }
    
    try {
        document.getElementById('btn-start-import').disabled = true;
        document.getElementById('btn-start-import').innerHTML = '<i data-lucide="loader-2" class="spin" style="width: 16px; margin-right: 4px; vertical-align: middle;"></i> Importing...';
        lucide.createIcons();
        
        showToast('Importing contacts...', 'info');
        const res = await fetch('/api/contacts/import', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        
        showToast(data.message || 'Contacts imported successfully!', 'success');
        loadContacts();
        loadInboxList();
        closeModal('import-modal');
    } catch(e) {
        alert('Import Error: ' + e.message);
    } finally {
        document.getElementById('btn-start-import').disabled = false;
        document.getElementById('btn-start-import').innerHTML = '<i data-lucide="upload" style="width: 16px; vertical-align: middle; margin-right: 4px;"></i> Import Contacts';
        lucide.createIcons();
    }
}

function exportContacts() {
    window.open('/api/contacts/export', '_blank');
}

// Chat Profile Right Sidebar Panel
// --- Mobile Navigation ---
function isMobile() { return window.innerWidth <= 768; }

function showChatList() {
    const chatList = document.querySelector('#tab-inbox > div:first-child');
    const chatPanel = document.querySelector('#tab-inbox > div:nth-child(2)');
    if (chatList) chatList.style.display = 'flex';
    if (chatPanel) {
        chatPanel.classList.remove('active-mobile');
        chatPanel.style.display = 'none';
    }
}

function showChatPanel() {
    const chatList = document.querySelector('#tab-inbox > div:first-child');
    const chatPanel = document.querySelector('#tab-inbox > div:nth-child(2)');
    if (isMobile()) {
        if (chatList) chatList.style.display = 'none';
        if (chatPanel) {
            chatPanel.style.display = 'flex';
            chatPanel.classList.add('active-mobile');
        }
    }
}

function toggleChatProfileSidebar(state = null) {
    const sidebar = document.getElementById('chat-profile-sidebar');
    const toggleBtn = document.getElementById('btn-toggle-profile');
    if (!sidebar) return;
    
    const isActive = state !== null ? state : sidebar.classList.contains('hidden');
    
    if (isActive) {
        sidebar.classList.remove('hidden');
        sidebar.classList.add('active');
        if (toggleBtn) toggleBtn.style.color = 'var(--accent)';
    } else {
        sidebar.classList.remove('active');
        sidebar.classList.add('hidden');
        if (toggleBtn) toggleBtn.style.color = 'var(--text-dim)';
    }
}

function renderChatProfileSidebar(phone) {
    const sidebarName = document.getElementById('sidebar-contact-name');
    const sidebarPhone = document.getElementById('sidebar-contact-phone');
    const tagsList = document.getElementById('sidebar-tags-list');
    const attrsList = document.getElementById('sidebar-attributes-list');
    const toggleBtn = document.getElementById('btn-toggle-profile');
    
    if (!sidebarName) return;
    
    if (toggleBtn) toggleBtn.classList.remove('hidden');
    
    const contact = globalContacts[phone] || { name: phone, tags: [], attributes: {} };
    
    sidebarName.innerText = contact.name || phone;
    sidebarPhone.innerText = phone;
    
    // Render Tags List
    tagsList.innerHTML = '';
    const tags = contact.tags || [];
    if (tags.length === 0) {
        tagsList.innerHTML = '<span style="font-size: 11px; color: var(--text-dim);">No tags added</span>';
    } else {
        tags.forEach(t => {
            const badge = document.createElement('span');
            badge.style.cssText = "background: rgba(0, 168, 132, 0.1); color: var(--accent); padding: 3px 8px; border-radius: 4px; font-size: 11px; display: inline-flex; align-items: center; gap: 4px; margin-bottom: 4px;";
            badge.innerHTML = `${t} <i data-lucide="x" style="width: 12px; cursor: pointer; color: var(--text-dim);" onclick="deleteSidebarTag('${t}')"></i>`;
            tagsList.appendChild(badge);
        });
    }
    
    // Render Custom Attributes list
    attrsList.innerHTML = '';
    const attrs = { ...(contact.attributes || {}) };
    
    const defaultFields = ['Email', 'City', 'Address', 'DOB'];
    defaultFields.forEach(f => {
        if (attrs[f] === undefined) attrs[f] = '';
    });
    
    Object.entries(attrs).forEach(([k, v]) => {
        const div = document.createElement('div');
        div.className = "sidebar-attr-row";
        div.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
        div.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <label style="font-size: 11px; color: var(--text-dim); font-weight: 500;">${k}</label>
                <i data-lucide="trash-2" style="width:12px; color:var(--error); cursor:pointer;" onclick="this.closest('.sidebar-attr-row').remove()"></i>
            </div>
            <input type="text" class="sidebar-attr-input" data-key="${k}" value="${v}" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border); color: white; padding: 6px 10px; border-radius: 6px; font-size: 12px;">
        `;
        attrsList.appendChild(div);
    });
    
    lucide.createIcons();
}

async function addSidebarTag() {
    if (!currentChatPhone) return;
    const input = document.getElementById('sidebar-add-tag-input');
    const val = input.value.trim();
    if (!val) return;
    
    const contact = globalContacts[currentChatPhone] || { tags: [] };
    const tags = Array.from(new Set([...(contact.tags || []), val]));
    
    await fetch('/api/contacts', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ phone: currentChatPhone, tags }) 
    });
    
    input.value = '';
    showToast('Tag added', 'success');
    loadContacts().then(() => renderChatProfileSidebar(currentChatPhone));
}

async function deleteSidebarTag(tag) {
    if (!currentChatPhone) return;
    
    const contact = globalContacts[currentChatPhone];
    if (!contact) return;
    
    const tags = (contact.tags || []).filter(t => t !== tag);
    
    await fetch('/api/contacts', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ phone: currentChatPhone, tags }) 
    });
    
    showToast('Tag removed', 'success');
    loadContacts().then(() => renderChatProfileSidebar(currentChatPhone));
}

function addSidebarAttributeRow() {
    const key = prompt('Enter custom attribute field name:');
    if (!key) return;
    
    const attrsList = document.getElementById('sidebar-attributes-list');
    const div = document.createElement('div');
    div.className = "sidebar-attr-row";
    div.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
    div.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <label style="font-size: 11px; color: var(--text-dim); font-weight: 500;">${key}</label>
            <i data-lucide="trash-2" style="width:12px; color:var(--error); cursor:pointer;" onclick="this.closest('.sidebar-attr-row').remove()"></i>
        </div>
        <input type="text" class="sidebar-attr-input" data-key="${key}" value="" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border); color: white; padding: 6px 10px; border-radius: 6px; font-size: 12px;">
    `;
    attrsList.appendChild(div);
    lucide.createIcons();
}

async function saveSidebarAttributes() {
    if (!currentChatPhone) return;
    
    const attributes = {};
    const rows = document.querySelectorAll('#sidebar-attributes-list .sidebar-attr-row');
    rows.forEach(row => {
        const input = row.querySelector('.sidebar-attr-input');
        if (input) {
            const k = input.getAttribute('data-key').trim();
            const v = input.value.trim();
            if (k) attributes[k] = v;
        }
    });
    
    await fetch('/api/contacts', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ phone: currentChatPhone, attributes }) 
    });
    
    showToast('Profile attributes updated!', 'success');
    loadContacts().then(() => renderChatProfileSidebar(currentChatPhone));
}

// Inbox Management
let globalChats = {};
let chatSearchQuery = '';

async function loadInboxList() {
    const res = await fetch('/api/chats');
    globalChats = await res.json();
    renderInboxList();
}

function filterChatList(query) {
    chatSearchQuery = query.toLowerCase();
    renderInboxList();
}

function renderInboxList() {
    const list = document.getElementById('chat-list');
    list.innerHTML = '';
    // Only show contacts who have at least one reply (incoming message)
    const engagedPhones = Object.keys(globalChats).filter(phone => {
        return globalChats[phone].some(msg => msg.from !== 'me');
    });
    // Update engaged count badge
    const countEl = document.getElementById('engaged-count');
    if (countEl) countEl.textContent = engagedPhones.length > 0 ? `${engagedPhones.length} engaged` : '';
    const sortedPhones = engagedPhones.sort((a, b) => {
        const lastA = globalChats[a][globalChats[a].length - 1]?.timestamp || 0;
        const lastB = globalChats[b][globalChats[b].length - 1]?.timestamp || 0;
        return lastB - lastA;
    });

    const filtered = chatSearchQuery
        ? sortedPhones.filter(phone => {
            const name = (globalContacts[phone]?.name || phone).toLowerCase();
            return name.includes(chatSearchQuery) || phone.includes(chatSearchQuery);
        })
        : sortedPhones;

    if (filtered.length === 0) {
        list.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: var(--text-dim); font-size: 13px;">
            <div style="width: 60px; height: 60px; border-radius: 50%; background: rgba(0,168,132,0.08); display: flex; align-items: center; justify-content: center; margin: 0 auto 12px auto;">
                <i data-lucide="${chatSearchQuery ? 'search-x' : 'message-circle'}" style="width: 28px; height: 28px; color: var(--accent); opacity: 0.6;"></i>
            </div>
            ${chatSearchQuery ? 'No chats found' : 'No replies yet — only contacts who reply will appear here'}
        </div>`;
        lucide.createIcons();
        return;
    }

    filtered.forEach(phone => {
        const msgs = globalChats[phone];
        const lastMsg = msgs[msgs.length - 1];
        const contactName = globalContacts[phone]?.name || phone;
        
        const div = document.createElement('div');
        div.className = `chat-list-item ${currentChatPhone === phone ? 'selected' : ''}`;
        div.onclick = () => openChat(phone);
        
        let preview = stripWhatsAppFormatting(lastMsg.text || '');
        if (preview.length > 42) preview = preview.substring(0, 42) + '...';
        
        const timeStr = new Date(lastMsg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const initials = contactName.split(' ').map(w => w[0]).join('').substring(0,2).toUpperCase();
        const isFromMe = lastMsg.from === 'me';
        
        // Determine tick status from last outgoing message
        let lastOutMsg = null;
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].from === 'me') { lastOutMsg = msgs[i]; break; }
        }
        const tickStatus = lastOutMsg?.status || 'sent';
        let tickSvg = '';
        if (lastOutMsg) {
            if (tickStatus === 'read') {
                tickSvg = '<svg width="18" height="16" viewBox="0 0 18 16" fill="none" style="flex-shrink:0;"><path d="M1.5 8.5L5 12L11.5 4" stroke="#53bdeb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 8.5L9.5 12L16 4" stroke="#53bdeb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            } else if (tickStatus === 'delivered') {
                tickSvg = '<svg width="18" height="16" viewBox="0 0 18 16" fill="none" style="flex-shrink:0;"><path d="M1.5 8.5L5 12L11.5 4" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 8.5L9.5 12L16 4" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            } else {
                tickSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;"><path d="M3 8.5L6.5 12L13 4" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            }
        }

        div.innerHTML = `
            <div class="avatar-circle" style="width: 48px; height: 48px; flex-shrink: 0; background: linear-gradient(135deg, rgba(0,168,132,0.2), rgba(0,168,132,0.05)); display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 600; color: var(--accent); letter-spacing: -0.5px;">
                ${initials}
            </div>
            <div style="flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: 5px; padding-right: 8px;">
                <div style="display:flex; justify-content: space-between; align-items: center;">
                    <span style="font-weight: 600; font-size: 15px; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: -0.2px;">${contactName}</span>
                    <span style="font-size: 11px; color: ${isFromMe ? 'var(--accent)' : 'var(--text-dim)'}; flex-shrink: 0; margin-left: 8px; font-weight: 500;">${timeStr}</span>
                </div>
                <div style="font-size: 13px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 4px;">
                    ${tickSvg}
                    <span>${preview}</span>
                </div>
            </div>
        `;
        list.appendChild(div);
    });
    lucide.createIcons();
}

// Open chat from Reports tab — switches to Inbox and opens the conversation
function openChatFromReport(phone) {
    // Switch to Inbox tab
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    const inboxBtn = document.querySelector('[data-tab="inbox"]');
    if (inboxBtn) inboxBtn.click();
    // Open the chat after a short delay to let inbox render
    setTimeout(() => openChat(phone), 150);
}

function openChat(phone) {
    currentChatPhone = phone;
    renderInboxList();
    const contactName = globalContacts[phone]?.name || phone;
    const isSidebarActive = document.getElementById('chat-profile-sidebar').classList.contains('active');
    const initials = contactName.split(' ').map(w => w[0]).join('').substring(0,2).toUpperCase();
    
    document.getElementById('chat-header').innerHTML = `
        <div style="display: flex; align-items: center; gap: 14px;">
            <button class="mobile-back-btn" onclick="showChatList()" style="display:none; background:none; border:none; color:var(--accent); cursor:pointer; padding:4px; margin-right:2px;">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <div class="avatar-circle" style="width: 42px; height: 42px; background: linear-gradient(135deg, rgba(0,168,132,0.2), rgba(0,168,132,0.05)); display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 600; color: var(--accent); letter-spacing: -0.5px; box-shadow: 0 2px 8px rgba(0,0,0,0.2);">
                ${initials}
            </div>
            <div style="display: flex; flex-direction: column;">
                <h3 style="margin: 0; font-size: 16px; color: var(--text-main); font-weight: 600; letter-spacing: -0.2px;">${contactName}</h3>
                <span style="font-size: 12px; color: var(--text-dim);">${phone}</span>
            </div>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
            <button class="btn btn-outline btn-sm" onclick="showInboxTemplateModal()" style="border-color: rgba(255,255,255,0.1); color: var(--text-dim); border-radius: var(--radius-pill); padding: 6px 14px; font-size: 12px; display: flex; align-items: center; gap: 6px;">
                <i data-lucide="send" style="width: 14px;"></i> Template
            </button>
            <button class="icon-btn" style="width: 36px; height: 36px; border-radius: 50%;">
                <i data-lucide="search" style="color: var(--text-dim); width: 18px;"></i>
            </button>
            <button class="icon-btn" id="btn-toggle-profile" style="width: 36px; height: 36px; border-radius: 50%;" onclick="toggleChatProfileSidebar()">
                <i data-lucide="user" style="color: ${isSidebarActive ? 'var(--accent)' : 'var(--text-dim)'}; width: 18px;"></i>
            </button>
            <button class="icon-btn" style="width: 36px; height: 36px; border-radius: 50%;">
                <i data-lucide="more-vertical" style="color: var(--text-dim); width: 18px;"></i>
            </button>
        </div>
    `;
    lucide.createIcons();
    document.getElementById('chat-input-area').classList.remove('hidden');
    
    renderChatHistory(phone);
    renderChatProfileSidebar(phone);
    showChatPanel();
}

function renderChatHistory(phone) {
    const history = document.getElementById('chat-history');
    history.innerHTML = '';
    const msgs = globalChats[phone] || [];
    
    let lastDate = '';
    
    msgs.forEach(msg => {
        const isMe = msg.from === 'me';
        
        const msgDate = new Date(msg.timestamp).toLocaleDateString();
        if (msgDate !== lastDate) {
            const dateDiv = document.createElement('div');
            dateDiv.style.cssText = 'align-self: center; background: #182229; color: var(--text-dim); padding: 5px 12px; border-radius: 6px; font-size: 12px; margin: 10px 0; box-shadow: 0 1px 0.5px rgba(11,20,26,0.13); text-transform: uppercase;';
            dateDiv.innerText = msgDate === new Date().toLocaleDateString() ? 'TODAY' : msgDate;
            history.appendChild(dateDiv);
            lastDate = msgDate;
        }

        const div = document.createElement('div');
        const isImageOnly = (msg.type === 'image' || msg.type === 'sticker') && msg.mediaUrl && !(msg.text || '').replace(/\[image\]|\[Image\]|\[sticker\]|\[Sticker\]/gi, '').trim();
        div.className = `msg-bubble ${isMe ? 'msg-sent' : 'msg-rcvd'}${isImageOnly ? ' msg-image' : ''}`;
        
        let statusIcon = '';
        if (isMe && msg.status) {
            if (msg.status === 'sent') statusIcon = ' <i data-lucide="check" style="width: 14px; color: rgba(255,255,255,0.6);"></i>';
            if (msg.status === 'delivered') statusIcon = ' <i data-lucide="check-check" style="width: 14px; color: rgba(255,255,255,0.6);"></i>';
            if (msg.status === 'read') statusIcon = ' <i data-lucide="check-check" style="width: 14px; color: #53bdeb;"></i>';
        }

        // Build message content based on type
        let contentHtml = '';
        const msgType = msg.type || 'text';

        if (msgType === 'image' || msgType === 'sticker') {
            if (msg.mediaUrl) {
                const proxyUrl = msg.mediaId ? `/media/proxy/${msg.mediaId}` : '';
                const onerror = proxyUrl ? `onerror="this.onerror=null;this.src='${proxyUrl}'"` : '';
                contentHtml = `<img src="${msg.mediaUrl}" ${onerror} style="max-width: 250px; border-radius: 8px; cursor: pointer; margin-bottom: 0;" onclick="window.open('${msg.mediaUrl}', '_blank')" />`;
                const caption = (msg.text || '').replace(/\[image\]|\[Image\]|\[sticker\]|\[Sticker\]/gi, '').trim();
                if (caption) {
                    contentHtml += `<span style="margin-top: 4px;">${renderWhatsAppFormatting(caption)}</span>`;
                }
            } else if (msg.mediaId) {
                const proxyUrl = `/media/proxy/${msg.mediaId}`;
                contentHtml = `<img src="${proxyUrl}" style="max-width: 250px; border-radius: 8px; cursor: pointer; margin-bottom: 0;" />`;
                const caption = (msg.text || '').replace(/\[image\]|\[Image\]|\[sticker\]|\[Sticker\]/gi, '').trim();
                if (caption) {
                    contentHtml += `<span style="margin-top: 4px;">${renderWhatsAppFormatting(caption)}</span>`;
                }
            } else {
                contentHtml = `<span style="opacity: 0.7;">📷 ${msg.text || 'Image'} (loading...)</span>`;
            }
        } else if (msgType === 'video') {
            if (msg.mediaUrl) {
                const proxyUrl = msg.mediaId ? `/media/proxy/${msg.mediaId}` : '';
                const onerror = proxyUrl ? `onerror="this.onerror=null;this.src='${proxyUrl}'"` : '';
                contentHtml = `<video src="${msg.mediaUrl}" ${onerror} controls style="max-width: 250px; border-radius: 8px; margin-bottom: 4px;"></video>`;
                if (msg.text && msg.text !== '[Video]') contentHtml += `<span style="margin-top: 4px;">${renderWhatsAppFormatting(msg.text)}</span>`;
            } else {
                contentHtml = `<span style="opacity: 0.7;">🎬 ${msg.text || 'Video'} (loading...)</span>`;
            }
        } else if (msgType === 'audio') {
            if (msg.mediaUrl) {
                contentHtml = `<audio src="${msg.mediaUrl}" controls style="max-width: 250px;"></audio>`;
            } else {
                contentHtml = `<span style="opacity: 0.7;">🎵 Audio (loading...)</span>`;
            }
        } else if (msgType === 'document') {
            const fileName = msg.filename || msg.text || 'Document';
            const fileExt = fileName.split('.').pop().toUpperCase() || 'FILE';
            
            if (msg.mediaUrl) {
                contentHtml = `
                <a href="${msg.mediaUrl}" target="_blank" download style="text-decoration: none; display: block; min-width: 200px; max-width: 280px; margin-bottom: 4px;">
                    <div style="background: rgba(0,0,0,0.2); border-radius: 8px; padding: 12px; display: flex; align-items: center; gap: 12px; transition: background 0.2s;">
                        <div style="background: #ef4444; width: 36px; height: 42px; border-radius: 4px; display: flex; align-items: center; justify-content: center; position: relative;">
                            <span style="color: white; font-size: 10px; font-weight: bold; position: absolute; bottom: 4px;">${fileExt.substring(0,3)}</span>
                            <div style="position: absolute; top: 0; right: 0; width: 0; height: 0; border-style: solid; border-width: 0 10px 10px 0; border-color: transparent rgba(0,0,0,0.1) transparent transparent;"></div>
                        </div>
                        <div style="flex: 1; overflow: hidden;">
                            <div style="color: ${isMe ? '#fff' : 'var(--text)'}; font-weight: 500; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px;">${fileName}</div>
                            <div style="color: ${isMe ? 'rgba(255,255,255,0.7)' : 'var(--text-dim)'}; font-size: 11px;">Document • ${fileExt}</div>
                        </div>
                    </div>
                </a>`;
            } else {
                contentHtml = `
                <div style="background: rgba(0,0,0,0.2); border-radius: 8px; padding: 12px; display: flex; align-items: center; gap: 12px; min-width: 200px; max-width: 280px; margin-bottom: 4px; opacity: 0.7;">
                    <div style="background: #ef4444; width: 36px; height: 42px; border-radius: 4px; display: flex; align-items: center; justify-content: center;">
                        <span style="color: white; font-size: 10px; font-weight: bold; padding-top: 14px;">${fileExt.substring(0,3)}</span>
                    </div>
                    <div style="flex: 1; overflow: hidden;">
                        <div style="color: ${isMe ? '#fff' : 'var(--text)'}; font-weight: 500; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px;">${fileName}</div>
                        <div style="color: ${isMe ? 'rgba(255,255,255,0.7)' : 'var(--text-dim)'}; font-size: 11px;">Loading...</div>
                    </div>
                </div>`;
            }
        } else if (msgType === 'location') {
            contentHtml = `<a href="https://maps.google.com/?q=${msg.latitude},${msg.longitude}" target="_blank" style="color: ${isMe ? '#fff' : 'var(--accent)'}; text-decoration: underline;">${renderWhatsAppFormatting(msg.text)}</a>`;
        } else if (msgType === 'template') {
            // Campaign template: show header image (if any) + text body
            if (msg.headerImageUrl) {
                contentHtml = `<img src="${msg.headerImageUrl}" style="max-width: 260px; border-radius: 8px; cursor: pointer; margin-bottom: 6px; display:block;" onclick="window.open('${msg.headerImageUrl}', '_blank')" />`;
            }
            contentHtml += `<span>${renderWhatsAppFormatting(msg.text)}</span>`;
        } else {
            contentHtml = `<span>${renderWhatsAppFormatting(msg.text)}</span>`;
        }
        
        div.innerHTML = `
            ${contentHtml}
            <span class="msg-meta">${new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}${statusIcon}</span>
        `;
        history.appendChild(div);
    });
    history.scrollTop = history.scrollHeight;
}

let currentChatMedia = null;

function handleChatMediaSelect(event) {
    const file = event.target.files[0];
    if (file) {
        currentChatMedia = file;
        const thumb = document.getElementById('chat-media-thumb');
        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (e) => {
                thumb.innerHTML = `<img src="${e.target.result}" style="max-height:220px;max-width:100%;border-radius:8px;display:block;" />`;
            };
            reader.readAsDataURL(file);
        } else if (file.type.startsWith('video/')) {
            thumb.innerHTML = `<div style="padding:40px;color:var(--accent);font-size:40px;">&#127909;</div>`;
        } else {
            thumb.innerHTML = `<div style="padding:40px;color:var(--accent);font-size:40px;">&#128196;</div>`;
        }
        document.getElementById('chat-media-preview').classList.remove('hidden');
    }
}

function clearChatMedia() {
    currentChatMedia = null;
    document.getElementById('chat-media-input').value = '';
    document.getElementById('chat-media-preview').classList.add('hidden');
}

async function sendChatReply() {
    if (!currentChatPhone) return;
    const input = document.getElementById('chat-reply-input');
    const text = input.value.trim();
    if (!text && !currentChatMedia) return;
    
    const btn = document.querySelector('#chat-input-area button');
    const originalBtnHTML = btn.innerHTML;
    btn.innerHTML = '<div class="loader" style="width: 16px; height: 16px; margin: 0; border-width: 2px;"></div>';
    
    try {
        let res;
        if (currentChatMedia) {
            const formData = new FormData();
            formData.append('phone', currentChatPhone);
            formData.append('text', text);
            formData.append('file', currentChatMedia);
            res = await fetch('/api/chat/send', { method: 'POST', body: formData });
        } else {
            res = await fetch('/api/chat/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: currentChatPhone, text }) });
        }
        const data = await res.json();
        if (!res.ok || data.error) {
            throw new Error(data.error || 'Send failed');
        }
        input.value = '';
        clearChatMedia();
        // Socket event 'chat_message_sent' will auto-refresh the chat
    } catch(e) { 
        showToast('❌ ' + (e.message || 'Failed to send message'), 'error'); 
    } finally {
        btn.innerHTML = originalBtnHTML;
    }
}

// Send Template from Inbox
function showInboxTemplateModal() {
    if (!currentChatPhone) return alert('Select a chat first');
    document.getElementById('inbox-template-modal').classList.add('active');
}

async function sendInboxTemplate() {
    const templateName = document.getElementById('inbox-template-select').value;
    if (!templateName) return alert('Select a template');
    
    try {
        await fetch('/api/chat/send-template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: currentChatPhone, templateName, languageCode: 'en' }) });
        closeModal('inbox-template-modal');
        showToast('Template sent!', 'success');
        loadInboxList().then(() => { if (currentChatPhone) openChat(currentChatPhone); });
    } catch(e) { showToast('Failed to send template', 'error'); }
}

// Campaign Execution (Queue-Aware)
let campaignBatchTotal = 0;
let campaignBatchSent = 0;
let currentAudienceTab = 'csv';

function switchAudienceTab(tab) {
    currentAudienceTab = tab;
    const csvPanel = document.getElementById('audience-csv-panel');
    const crmPanel = document.getElementById('audience-crm-panel');
    const csvBtn = document.getElementById('audience-tab-csv');
    const crmBtn = document.getElementById('audience-tab-crm');
    if (tab === 'csv') {
        csvPanel.classList.remove('hidden');
        crmPanel.classList.add('hidden');
        csvBtn.style.background = 'var(--accent)';
        csvBtn.style.color = '#fff';
        crmBtn.style.background = 'rgba(255,255,255,0.05)';
        crmBtn.style.color = 'var(--text-dim)';
    } else {
        csvPanel.classList.add('hidden');
        crmPanel.classList.remove('hidden');
        crmBtn.style.background = 'var(--accent)';
        crmBtn.style.color = '#fff';
        csvBtn.style.background = 'rgba(255,255,255,0.05)';
        csvBtn.style.color = 'var(--text-dim)';
        loadCRMTagOptions();
    }
}

async function loadCRMTagOptions() {
    const res = await fetch('/api/contacts');
    const contacts = await res.json();
    const tagSet = new Set();
    Object.values(contacts).forEach(c => (c.tags || []).forEach(t => tagSet.add(t)));
    const select = document.getElementById('crm-tag-filter');
    select.innerHTML = '<option value="">All Contacts</option>';
    tagSet.forEach(tag => {
        const opt = document.createElement('option');
        opt.value = tag; opt.text = tag;
        select.appendChild(opt);
    });
    select.onchange = () => updateCRMContactCount(contacts);
    updateCRMContactCount(contacts);
}

function updateCRMContactCount(contacts) {
    const tag = document.getElementById('crm-tag-filter').value;
    const all = Object.values(contacts);
    const filtered = tag ? all.filter(c => (c.tags || []).includes(tag)) : all;
    document.getElementById('crm-contact-count').innerText = `✅ ${filtered.length} contact${filtered.length !== 1 ? 's' : ''} will be targeted`;
}

async function startCampaign() {
    const templateName = document.getElementById('template-name').value;
    const templateLang = document.getElementById('template-lang').value;
    const templateMapping = document.getElementById('template-mapping').value;
    const campaignName = document.getElementById('campaign-name')?.value || '';
    const dailyLimit = parseInt(document.getElementById('campaign-daily-limit')?.value) || 0;
    const skipExisting = document.getElementById('campaign-skip-existing')?.checked || false;
    const skipInCRM = document.getElementById('campaign-skip-in-crm')?.checked || false;

    if (!templateName) return alert('Please select a template first.');

    // mapping is now stored as JSON by updateCampaignMapping()
    let mappingObj = {};
    try { mappingObj = templateMapping ? JSON.parse(templateMapping) : {}; } catch(e) {}

    let formData = new FormData();

    if (currentAudienceTab === 'crm') {
        // Build a CSV from CRM contacts and append it
        const res = await fetch('/api/contacts');
        const contacts = await res.json();
        const tag = document.getElementById('crm-tag-filter').value;
        let list = Object.entries(contacts).map(([phone, c]) => ({ ...c, phone }));
        if (tag) list = list.filter(c => (c.tags || []).includes(tag));
        if (list.length === 0) return alert('No CRM contacts match the selected filter.');
        // Build CSV string
        const csvRows = ['Phone,Name', ...list.map(c => `${c.phone},${(c.name || '').replace(/,/g, ' ')}`)].join('\n');
        const blob = new Blob([csvRows], { type: 'text/csv' });
        formData.append('file', blob, 'crm_contacts.csv');
    } else {
        const fileInput = document.getElementById('csv-file');
        if (!fileInput.files[0]) return alert('Upload a Contact List (CSV/Excel).');
        formData.append('file', fileInput.files[0]);
    }

    formData.append('templateName', templateName);
    
    // Pass the raw template body text to backend for better chat logs
    if (window.globalSyncedTemplates) {
        const t = window.globalSyncedTemplates.find(x => x.name === templateName);
        if (t) {
            let fullText = [];
            const headerComp = t.components?.find(c => c.type === 'HEADER');
            if (headerComp && headerComp.format === 'TEXT') fullText.push(`*${headerComp.text}*`);
            
            const bodyComp = t.components?.find(c => c.type === 'BODY');
            if (bodyComp) fullText.push(bodyComp.text);
            
            const footerComp = t.components?.find(c => c.type === 'FOOTER');
            if (footerComp) fullText.push(`_${footerComp.text}_`);
            
            if (fullText.length > 0) formData.append('templateBody', fullText.join('\n\n'));
        }
    }

    formData.append('languageCode', templateLang);
    formData.append('mapping', JSON.stringify(mappingObj));
    formData.append('campaignName', campaignName);
    formData.append('skipExisting', skipExisting);
    formData.append('skipInCRM', skipInCRM);
    if (dailyLimit > 0) formData.append('dailyLimit', dailyLimit);

    // Grab header media fields if required
    let headerType = '';
    if (window.globalSyncedTemplates) {
        const t = window.globalSyncedTemplates.find(x => x.name === templateName);
        const headerComp = t?.components?.find(c => c.type === 'HEADER');
        if (headerComp) headerType = headerComp.format;
    }

    const requiresHeader = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType);
    if (requiresHeader) {
        const savedMediaId = document.getElementById('selected-media-id')?.value || '';
        const headerFile = document.getElementById('campaign-header-file')?.files[0];
        const headerUrl = document.getElementById('campaign-header-url')?.value.trim() || '';

        if (savedMediaId) {
            formData.append('savedMediaId', savedMediaId);
        } else if (headerFile) {
            formData.append('headerFile', headerFile);
        } else if (headerUrl) {
            formData.append('headerUrl', headerUrl);
        } else {
            alert(`This template requires a ${headerType.toLowerCase()} header. Please select a saved image or upload a new one.`);
            return;
        }
        formData.append('headerType', headerType);
    }


    document.getElementById('start-btn').classList.add('hidden');
    document.getElementById('campaign-progress').classList.remove('hidden');
    document.getElementById('progress-text').innerText = 'Preparing...';

    try {
        const res = await fetch('/api/send', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (data.queued) {
            showToast(`Queue created! Sending first ${data.dailyLimit} of ${data.total} contacts now.`, 'success');
        } else {
            showToast('Campaign launched!', 'success');
        }
    } catch (e) {
        alert(e.message);
        document.getElementById('start-btn').classList.remove('hidden');
        document.getElementById('campaign-progress').classList.add('hidden');
    }
}

async function scheduleCampaign() {
    const scheduleTime = document.getElementById('schedule-time').value;
    if (!scheduleTime) return alert('Please pick a date and time to schedule.');

    const scheduleDate = new Date(scheduleTime);
    if (scheduleDate <= new Date()) return alert('Schedule time must be in the future.');

    const templateName = document.getElementById('template-name').value;
    const templateLang = document.getElementById('template-lang').value;
    const templateMapping = document.getElementById('template-mapping').value;
    const campaignName = document.getElementById('campaign-name')?.value || '';
    const dailyLimit = parseInt(document.getElementById('campaign-daily-limit')?.value) || 0;
    const skipExisting = document.getElementById('campaign-skip-existing')?.checked || false;
    const skipInCRM = document.getElementById('campaign-skip-in-crm')?.checked || false;

    if (!templateName) return alert('Please select a template first.');

    let mappingObj = {};
    try { mappingObj = templateMapping ? JSON.parse(templateMapping) : {}; } catch(e) {}

    let formData = new FormData();

    if (currentAudienceTab === 'crm') {
        const res = await fetch('/api/contacts');
        const contacts = await res.json();
        const tag = document.getElementById('crm-tag-filter').value;
        let list = Object.entries(contacts).map(([phone, c]) => ({ ...c, phone }));
        if (tag) list = list.filter(c => (c.tags || []).includes(tag));
        if (list.length === 0) return alert('No CRM contacts match the selected filter.');
        const csvRows = ['Phone,Name', ...list.map(c => `${c.phone},${(c.name || '').replace(/,/g, ' ')}`)].join('\n');
        const blob = new Blob([csvRows], { type: 'text/csv' });
        formData.append('file', blob, 'crm_contacts.csv');
    } else {
        const fileInput = document.getElementById('csv-file');
        if (!fileInput.files[0]) return alert('Upload a Contact List (CSV/Excel).');
        formData.append('file', fileInput.files[0]);
    }

    formData.append('templateName', templateName);

    if (window.globalSyncedTemplates) {
        const t = window.globalSyncedTemplates.find(x => x.name === templateName);
        if (t) {
            let fullText = [];
            const headerComp = t.components?.find(c => c.type === 'HEADER');
            if (headerComp && headerComp.format === 'TEXT') fullText.push(`*${headerComp.text}*`);
            const bodyComp = t.components?.find(c => c.type === 'BODY');
            if (bodyComp) fullText.push(bodyComp.text);
            const footerComp = t.components?.find(c => c.type === 'FOOTER');
            if (footerComp) fullText.push(`_${footerComp.text}_`);
            if (fullText.length > 0) formData.append('templateBody', fullText.join('\n\n'));
        }
    }

    formData.append('languageCode', templateLang);
    formData.append('mapping', JSON.stringify(mappingObj));
    formData.append('campaignName', campaignName || `Scheduled ${scheduleDate.toLocaleDateString()}`);
    formData.append('skipExisting', skipExisting);
    formData.append('skipInCRM', skipInCRM);
    if (dailyLimit > 0) formData.append('dailyLimit', dailyLimit);
    formData.append('scheduleTime', scheduleDate.toISOString());

    let headerType = '';
    if (window.globalSyncedTemplates) {
        const t = window.globalSyncedTemplates.find(x => x.name === templateName);
        const headerComp = t?.components?.find(c => c.type === 'HEADER');
        if (headerComp) headerType = headerComp.format;
    }

    const requiresHeader = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType);
    if (requiresHeader) {
        const savedMediaId = document.getElementById('selected-media-id')?.value || '';
        const headerFile = document.getElementById('campaign-header-file')?.files[0];
        const headerUrl = document.getElementById('campaign-header-url')?.value.trim() || '';
        if (savedMediaId) {
            formData.append('savedMediaId', savedMediaId);
        } else if (headerFile) {
            formData.append('headerFile', headerFile);
        } else if (headerUrl) {
            formData.append('headerUrl', headerUrl);
        } else {
            alert(`This template requires a ${headerType.toLowerCase()} header.`);
            return;
        }
        formData.append('headerType', headerType);
    }

    document.getElementById('schedule-btn').disabled = true;
    try {
        const res = await fetch('/api/schedule/create', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        showToast(`Campaign scheduled for ${scheduleDate.toLocaleString()} with ${data.total} contacts!`, 'success');
        document.getElementById('schedule-time').value = '';
        loadScheduledCampaigns();
    } catch (e) {
        alert(e.message);
    } finally {
        document.getElementById('schedule-btn').disabled = false;
    }
}

async function loadScheduledCampaigns() {
    try {
        const res = await fetch('/api/schedule/list');
        const list = await res.json();
        const container = document.getElementById('scheduled-list');
        if (!container) return;

        if (!list || list.length === 0) {
            container.innerHTML = '<div style="text-align:center; color:var(--text-dim); font-size:13px; padding:16px 0;">No scheduled campaigns</div>';
            return;
        }

        container.innerHTML = list.map(s => {
            const dt = new Date(s.scheduleTime);
            const timeStr = dt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const now = new Date();
            const diff = dt - now;
            let countdown = '';
            if (diff > 0) {
                const hours = Math.floor(diff / 3600000);
                const mins = Math.floor((diff % 3600000) / 60000);
                countdown = hours > 0 ? `in ${hours}h ${mins}m` : `in ${mins}m`;
            }
            let statusColor, statusBg, statusLabel;
            if (s.status === 'scheduled') { statusColor = '#fbbf24'; statusBg = 'rgba(251,191,36,0.12)'; statusLabel = `⏰ ${countdown}`; }
            else if (s.status === 'queued') { statusColor = '#a78bfa'; statusBg = 'rgba(167,139,250,0.12)'; statusLabel = '📋 Queued (auto-starts after current)'; }
            else if (s.status === 'sent') { statusColor = '#00a884'; statusBg = 'rgba(0,168,132,0.1)'; statusLabel = '✅ Sent'; }
            else if (s.status === 'running') { statusColor = '#53bdeb'; statusBg = 'rgba(83,189,235,0.1)'; statusLabel = '🔄 Running'; }
            else { statusColor = '#ef4444'; statusBg = 'rgba(239,68,68,0.1)'; statusLabel = '❌ Failed'; }

            const canCancel = s.status === 'scheduled';

            return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px; background:rgba(255,255,255,0.02); border:1px solid var(--border); border-radius:10px; gap:12px; flex-wrap:wrap;">
                <div style="flex:1; min-width:180px;">
                    <div style="font-size:14px; font-weight:600; color:var(--text-main);">${s.campaignName}</div>
                    <div style="font-size:12px; color:var(--text-dim); margin-top:3px;">${s.total} contacts • ${timeStr}</div>
                </div>
                <div style="display:flex; align-items:center; gap:10px;">
                    <span style="background:${statusBg}; color:${statusColor}; padding:4px 12px; border-radius:12px; font-size:11px; font-weight:600; white-space:nowrap;">${statusLabel}</span>
                    ${canCancel ? `<button onclick="cancelScheduled('${s.id}')" style="background:rgba(239,68,68,0.1); color:#ef4444; border:1px solid rgba(239,68,68,0.3); padding:5px 12px; border-radius:8px; cursor:pointer; font-size:11px; font-weight:600;">Cancel</button>` : ''}
                </div>
            </div>`;
        }).join('');
    } catch(e) {
        console.error('Failed to load scheduled campaigns', e);
    }
}

async function cancelScheduled(id) {
    if (!confirm('Cancel this scheduled campaign?')) return;
    try {
        await fetch(`/api/schedule/${id}`, { method: 'DELETE' });
        showToast('Campaign cancelled', 'success');
        loadScheduledCampaigns();
    } catch(e) {
        alert('Failed to cancel');
    }
}

async function stopCampaign() {
    await fetch('/api/queue/stop', { method: 'POST' });
    showToast('Stop signal sent. Current batch will finish the current message then stop.', 'info');
}

async function sendNextBatch() {
    const btn = document.getElementById('queue-run-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-2" class="spin" style="width:16px;"></i> Sending...'; lucide.createIcons(); }

    document.getElementById('campaign-progress').classList.remove('hidden');
    document.getElementById('start-btn').classList.add('hidden');

    try {
        const res = await fetch('/api/queue/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const data = await res.json();
        if (data.error) { showToast(data.error, 'error'); if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="play"></i> Send Today\'s Batch'; lucide.createIcons(); } }
        else showToast('Today\'s batch started!', 'success');
    } catch(e) {
        showToast('Failed to start batch: ' + e.message, 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="play"></i> Send Today\'s Batch'; lucide.createIcons(); }
    }
}

async function clearQueue() {
    if (!confirm('Are you sure you want to delete the campaign queue? This cannot be undone.')) return;
    await fetch('/api/queue/clear', { method: 'DELETE' });
    document.getElementById('queue-status-card').classList.add('hidden');
    document.getElementById('start-btn').classList.remove('hidden');
    document.getElementById('campaign-progress').classList.add('hidden');
    showToast('Campaign queue cleared.', 'success');
}

async function loadQueueStatus() {
    try {
        const res = await fetch('/api/queue/status');
        const q = await res.json();
        const card = document.getElementById('queue-status-card');
        if (!card) return;

        if (!q.exists || q.status === 'completed') {
            card.classList.add('hidden');
            document.getElementById('start-btn').classList.remove('hidden');
            if (q.status === 'completed') showToast('🎉 Campaign fully completed!', 'success');
            return;
        }

        card.classList.remove('hidden');
        document.getElementById('queue-campaign-name').innerText = q.campaignName || 'Campaign Queue';
        document.getElementById('queue-template-name').innerText = q.templateName || '—';

        const pct = q.total > 0 ? Math.round((q.sentIndex / q.total) * 100) : 0;
        document.getElementById('queue-progress-fill').style.width = pct + '%';
        document.getElementById('queue-progress-text').innerText = `${q.sentIndex.toLocaleString()} / ${q.total.toLocaleString()} sent`;
        document.getElementById('queue-stat-total').innerText = q.total.toLocaleString();
        document.getElementById('queue-stat-sent').innerText = q.sentIndex.toLocaleString();
        document.getElementById('queue-stat-remaining').innerText = q.remaining.toLocaleString();
        document.getElementById('queue-stat-days').innerText = q.daysRemaining;
        document.getElementById('queue-daily-limit').innerText = q.dailyLimit;
        document.getElementById('queue-last-run').innerText = q.lastRunAt
            ? new Date(q.lastRunAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            : 'Never';

        const badge = document.getElementById('queue-status-badge');
        if (q.status === 'paused') {
            badge.style.background = 'rgba(167,139,250,0.15)'; badge.style.color = '#a78bfa'; badge.innerText = 'Paused';
        } else if (q.status === 'running') {
            badge.style.background = 'rgba(0,168,132,0.15)'; badge.style.color = 'var(--accent)'; badge.innerText = 'Running';
        }

        lucide.createIcons();
    } catch(e) { console.error('Queue status error', e); }
}

// Socket events for campaign/queue
socket.on('campaign_started', (data) => {
    campaignBatchTotal = data.total;
    campaignBatchSent = 0;
    document.getElementById('campaign-progress').classList.remove('hidden');
    document.getElementById('start-btn').classList.add('hidden');
    document.getElementById('progress-text').innerText = `0 / ${data.total}`;
    document.getElementById('progress-fill').style.width = '0%';
    const statusEl = document.getElementById('progress-status-text');
    if (statusEl && data.grandTotal && data.grandTotal !== data.total) {
        statusEl.innerText = `Batch ${data.batchStart + 1}–${data.batchStart + data.total} of ${data.grandTotal} total`;
    } else if (statusEl) { statusEl.innerText = ''; }
    lucide.createIcons();
});

socket.on('message_sent', (data) => {
    campaignBatchSent++;
    const pct = campaignBatchTotal > 0 ? Math.round((campaignBatchSent / campaignBatchTotal) * 100) : 0;
    document.getElementById('progress-text').innerText = `${campaignBatchSent} / ${campaignBatchTotal}`;
    document.getElementById('progress-fill').style.width = pct + '%';
});

socket.on('message_failed', (data) => {
    campaignBatchSent++;
    const pct = campaignBatchTotal > 0 ? Math.round((campaignBatchSent / campaignBatchTotal) * 100) : 0;
    document.getElementById('progress-text').innerText = `${campaignBatchSent} / ${campaignBatchTotal}`;
    document.getElementById('progress-fill').style.width = pct + '%';
});

socket.on('campaign_stopped', (data) => {
    showToast(`Campaign stopped. ${data.sentSoFar || 0} messages sent so far.`, 'info');
    document.getElementById('start-btn').classList.remove('hidden');
    const btn = document.getElementById('queue-run-btn');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="play"></i> Send Today\'s Batch'; lucide.createIcons(); }
    loadQueueStatus();
});

socket.on('campaign_finished', (data) => {
    document.getElementById('campaign-progress').classList.add('hidden');
    document.getElementById('progress-fill').style.width = '0%';
    const btn = document.getElementById('queue-run-btn');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="play"></i> Send Today\'s Batch'; lucide.createIcons(); }
    if (data.completed) {
        showToast('🎉 All contacts sent! Campaign fully completed.', 'success');
    } else {
        showToast(`✅ Batch done! ${data.remaining?.toLocaleString() || 0} contacts remaining. Come back tomorrow for the next batch.`, 'success');
    }
    document.getElementById('start-btn').classList.remove('hidden');
    loadQueueStatus();
});

// Socket Realtime
// Notification sound using Web Audio API
function playNotificationSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(660, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);
    } catch(e) {}
}

socket.on('incoming_message', (data) => {
    playNotificationSound();
    showToast(`💬 New message from ${data.contact?.name || data.phone}`, 'info');
    loadContacts();
    loadInboxList().then(() => {
        if (currentChatPhone === data.phone) {
            openChat(data.phone);
        }
    });
});

// Fired when YOU send a reply — updates inbox instantly on all connected tabs
socket.on('chat_message_sent', (data) => {
    loadInboxList().then(() => {
        if (currentChatPhone === data.phone) {
            openChat(data.phone);
        }
    });
});

socket.on('contact_updated', (data) => {
    loadContacts().then(() => {
        if (currentChatPhone === data.phone) {
            renderChatProfileSidebar(data.phone);
            // Refresh main chat header name if changed
            const headerNameEl = document.querySelector('#chat-header h3');
            if (headerNameEl) {
                headerNameEl.innerText = data.contact?.name || data.phone;
            }
        }
    });
});

socket.on('message_status', (data) => {
    if (globalChats[data.recipient]) {
        const msgs = globalChats[data.recipient];
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].id === data.messageId) {
                msgs[i].status = data.status;
                break;
            }
        }
    }
    loadInboxList().then(() => {
        if (currentChatPhone === data.recipient) openChat(data.recipient);
    });
});

// --- Notifications System ---
async function loadNotifications() {
    const res = await fetch('/api/notifications');
    const notifications = await res.json();
    renderNotifications(notifications);
}

function getNotifStyle(type) {
    switch(type) {
        case 'success': return { border: '#00a884', icon: 'check-circle', iconColor: '#00a884', bg: 'rgba(0,168,132,0.08)' };
        case 'error':   return { border: '#ef4444', icon: 'x-circle',     iconColor: '#ef4444', bg: 'rgba(239,68,68,0.08)' };
        case 'warning': return { border: '#f59e0b', icon: 'alert-triangle',iconColor: '#f59e0b', bg: 'rgba(245,158,11,0.08)' };
        default:        return { border: '#53bdeb', icon: 'info',          iconColor: '#53bdeb', bg: 'rgba(83,189,235,0.08)' };
    }
}

function renderNotifications(notifications) {
    const list = document.getElementById('notifications-list');
    if (!list) return;
    if (!notifications || notifications.length === 0) {
        list.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--text-dim); background: var(--sidebar-bg); border-radius: 8px;">
            <i data-lucide="bell-off" style="width: 32px; height: 32px; margin-bottom: 10px; opacity: 0.4;"></i>
            <p style="margin: 0;">No system alerts yet. Meta will send notifications here when templates are approved, rejected, or when quality changes.</p>
        </div>`;
        lucide.createIcons();
        return;
    }

    list.innerHTML = notifications.map(n => {
        const s = getNotifStyle(n.type);
        const timeAgo = new Date(n.timestamp).toLocaleString();
        return `
        <div style="display: flex; gap: 16px; align-items: flex-start; background: ${s.bg}; border-left: 3px solid ${s.border}; border-radius: 8px; padding: 16px 20px;">
            <i data-lucide="${s.icon}" style="width: 22px; height: 22px; color: ${s.iconColor}; flex-shrink: 0; margin-top: 2px;"></i>
            <div style="flex: 1; min-width: 0;">
                <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 4px;">
                    <span style="font-weight: 600; font-size: 14px; color: var(--text-main);">${n.title}</span>
                    <span style="font-size: 11px; color: var(--text-dim); flex-shrink: 0;">${timeAgo}</span>
                </div>
                <p style="margin: 0; font-size: 13px; color: var(--text-dim); line-height: 1.5;">${n.message}</p>
                <span style="display: inline-block; margin-top: 6px; font-size: 10px; background: rgba(255,255,255,0.06); padding: 2px 8px; border-radius: 10px; color: var(--text-dim);">${n.field}</span>
            </div>
        </div>`;
    }).join('');
    lucide.createIcons();
}

async function clearNotifications() {
    if (!confirm('Clear all system alerts?')) return;
    await fetch('/api/notifications', { method: 'DELETE' });
    renderNotifications([]);
    showToast('Notifications cleared', 'success');
}

// Real-time notification socket handler
socket.on('notification', (notif) => {
    const s = getNotifStyle(notif.type);
    showToast(`<strong>${notif.title}</strong><br>${notif.message}`, notif.type || 'info');
    // Also update the list if the tab is open
    loadNotifications();
    // Show a badge on the bell icon (visual indicator)
    const bellBtn = document.querySelector('[data-tab="notifications"]');
    if (bellBtn) {
        bellBtn.style.position = 'relative';
        bellBtn.innerHTML = `<i data-lucide="bell" style="color: #f59e0b;"></i> <span class="nav-text">Alerts</span> <span style="position: absolute; top: 6px; right: 8px; width: 8px; height: 8px; background: #ef4444; border-radius: 50%; border: 1px solid var(--sidebar-bg);"></span>`;
        lucide.createIcons();
    }
});

socket.on('media_ready', (data) => {
    // Refresh chat if we're viewing the chat that received media
    loadInboxList().then(() => {
        if (currentChatPhone === data.phone) openChat(data.phone);
    });
});

// --- Reports & Insights ---
let chartTimeline = null;
let chartFunnel = null;
let chartHourly = null;
let chartTagConversion = null;
let chartTagVolume = null;
let globalReportData = null;

async function loadReports() {
    try {
        const [res, tagRes, campRes, stuckRes] = await Promise.all([
            fetch('/api/reports/insights'),
            fetch('/api/reports/tags'),
            fetch('/api/reports/campaigns'),
            fetch('/api/verify-stuck/count')
        ]);
        const stats = await res.json();
        const tagData = await tagRes.json();
        const campData = await campRes.json();
        const stuckData = await stuckRes.json();
        globalReportData = stats;

        // KPI Cards
        document.getElementById('stat-sent').innerText = stats.totalSent;
        document.getElementById('stat-delivered').innerText = stats.totalDelivered;
        document.getElementById('stat-read').innerText = stats.totalRead;
        document.getElementById('stat-replied').innerText = stats.totalReplies;
        document.getElementById('stat-stuck').innerText = stuckData.stuckCount || 0;

        // Rate bars
        setRateBar('delivery', stats.deliveryRate);
        setRateBar('read', stats.readRate);
        setRateBar('reply', stats.replyRate);

        // Funnel percentages
        const s = stats.totalSent || 1;
        document.getElementById('funnel-delivered-pct').innerText = stats.deliveryRate + '%';
        document.getElementById('funnel-read-pct').innerText = stats.readRate + '%';
        document.getElementById('funnel-reply-pct').innerText = stats.replyRate + '%';
        document.getElementById('funnel-failed-pct').innerText = Math.round((stats.totalFailed / s) * 100) + '%';

        // Timeline Chart (14 days)
        const dates = Object.keys(stats.timeline).sort();
        const shortDates = dates.map(d => {
            const dt = new Date(d);
            return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        });
        const sentData = dates.map(d => stats.timeline[d].sent);
        const readData = dates.map(d => stats.timeline[d].read);
        const replyData = dates.map(d => stats.timeline[d].replies || 0);

        if (chartTimeline) chartTimeline.destroy();
        const ctxTimeline = document.getElementById('chart-timeline').getContext('2d');
        chartTimeline = new Chart(ctxTimeline, {
            type: 'line',
            data: {
                labels: shortDates,
                datasets: [
                    { label: 'Sent', data: sentData, borderColor: '#00a884', backgroundColor: 'rgba(0,168,132,0.08)', fill: true, tension: 0.4, pointRadius: 3 },
                    { label: 'Read', data: readData, borderColor: '#53bdeb', backgroundColor: 'rgba(83,189,235,0.08)', fill: true, tension: 0.4, pointRadius: 3 },
                    { label: 'Replies', data: replyData, borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.08)', fill: true, tension: 0.4, pointRadius: 3 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                    y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true }
                }
            }
        });

        // Funnel Doughnut Chart
        if (chartFunnel) chartFunnel.destroy();
        const ctxFunnel = document.getElementById('chart-funnel').getContext('2d');
        chartFunnel = new Chart(ctxFunnel, {
            type: 'doughnut',
            data: {
                labels: ['Delivered', 'Read', 'Replied', 'Failed'],
                datasets: [{
                    data: [stats.totalDelivered, stats.totalRead, stats.totalReplies, stats.totalFailed],
                    backgroundColor: ['rgba(0,168,132,0.7)', 'rgba(83,189,235,0.7)', 'rgba(167,139,250,0.7)', 'rgba(239,68,68,0.7)'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                cutout: '72%'
            }
        });

        // Hourly Activity Bar Chart
        const hourLabels = Array.from({length: 24}, (_, i) => i === 0 ? '12am' : i < 12 ? `${i}am` : i === 12 ? '12pm' : `${i-12}pm`);
        if (chartHourly) chartHourly.destroy();
        const ctxHourly = document.getElementById('chart-hourly').getContext('2d');
        
        // Highlight peak hours
        const maxActivity = Math.max(...stats.hourlyActivity, 1);
        const barColors = stats.hourlyActivity.map(v => {
            const intensity = v / maxActivity;
            if (intensity > 0.7) return 'rgba(0,168,132,0.9)';
            if (intensity > 0.3) return 'rgba(0,168,132,0.5)';
            return 'rgba(0,168,132,0.2)';
        });

        chartHourly = new Chart(ctxHourly, {
            type: 'bar',
            data: {
                labels: hourLabels,
                datasets: [{
                    label: 'Messages',
                    data: stats.hourlyActivity,
                    backgroundColor: barColors,
                    borderRadius: 3,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { callbacks: { title: (items) => `${hourLabels[items[0].dataIndex]}` } } },
                scales: {
                    x: { ticks: { color: '#94a3b8', font: { size: 9 }, maxRotation: 0 }, grid: { display: false } },
                    y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true }
                }
            }
        });

        // Top Repliers
        const topList = document.getElementById('top-repliers-list');
        if (stats.topRepliers.length === 0) {
            topList.innerHTML = '<div style="text-align:center; color:var(--text-dim); font-size:13px; padding:20px 0;">No replies received yet</div>';
        } else {
            const maxReplies = stats.topRepliers[0].replies;
            topList.innerHTML = stats.topRepliers.map((r, i) => {
                const pct = Math.round((r.replies / maxReplies) * 100);
                const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
                return `
                <div style="display:flex; flex-direction:column; gap:4px; cursor:pointer; padding:6px 8px; border-radius:8px; transition: background 0.2s;" onmouseover="this.style.background='rgba(167,139,250,0.1)'" onmouseout="this.style.background='transparent'" onclick="openChatFromReport('${r.phone}')">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-size:13px; font-weight:500; color:var(--text-main);">${medals[i]} ${r.name}</span>
                        <span style="font-size:12px; color:#a78bfa; font-weight:600;">${r.replies} replies</span>
                    </div>
                    <div style="height:3px; background:rgba(255,255,255,0.06); border-radius:2px;">
                        <div style="height:100%; background:#a78bfa; border-radius:2px; width:${pct}%;"></div>
                    </div>
                </div>`;
            }).join('');
        }

        // Per-Contact Log Table
        renderReportLog(stats.contactLog);

        // Cost Summary
        renderCostSummary(stats.cost);

        // Campaign Comparison Table
        renderCampaignComparison(campData.campaigns);

        // Tag Conversion Charts
        renderTagCharts(tagData.tags);

    } catch(e) {
        console.error('Failed to load reports', e);
        showToast('Failed to load report data', 'error');
    }
}

function setRateBar(id, rate) {
    const bar = document.getElementById(`bar-${id}`);
    const label = document.getElementById(`rate-${id}`);
    if (bar) bar.style.width = Math.min(rate, 100) + '%';
    if (label) label.innerText = rate + '%';
}

let reportLogFilter = 'all';
let selectedReportPhones = new Set();

function renderCostSummary(cost) {
    const container = document.getElementById('cost-summary-content');
    if (!container || !cost) return;

    const categories = [
        { key: 'marketing', label: 'Marketing', color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
        { key: 'utility', label: 'Utility', color: '#00a884', bg: 'rgba(0,168,132,0.1)' },
        { key: 'authentication', label: 'Authentication', color: '#53bdeb', bg: 'rgba(83,189,235,0.1)' },
        { key: 'service', label: 'Service', color: '#a78bfa', bg: 'rgba(167,139,250,0.1)' }
    ];

    const breakdownHtml = categories.map(cat => {
        const count = cost.countByCategory[cat.key] || 0;
        const amt = cost.byCategory[cat.key] || 0;
        if (count === 0) return '';
        return `
        <div style="flex:1; min-width:140px; background:${cat.bg}; border-radius:10px; padding:14px 16px;">
            <div style="font-size:12px; color:${cat.color}; font-weight:600; margin-bottom:6px;">${cat.label}</div>
            <div style="font-size:22px; font-weight:700; color:${cat.color};">${count}</div>
            <div style="font-size:11px; color:var(--text-dim); margin-top:4px;">messages × ₹${cost.rates[cat.key]}</div>
            <div style="font-size:13px; font-weight:600; color:${cat.color}; margin-top:4px;">₹${amt.toFixed(2)}</div>
        </div>`;
    }).filter(Boolean).join('');

    container.innerHTML = `
    <div style="flex:2; min-width:200px;">
        <div style="display:flex; gap:14px; flex-wrap:wrap; margin-bottom:16px;">
            ${breakdownHtml || '<div style="color:var(--text-dim); font-size:13px;">No billable messages yet</div>'}
        </div>
        <div style="border-top:1px solid var(--border); padding-top:12px; display:flex; gap:24px; flex-wrap:wrap; align-items:center;">
            <div>
                <div style="font-size:11px; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.5px;">Subtotal</div>
                <div style="font-size:16px; font-weight:700; color:var(--text-main);">₹${cost.subtotal.toFixed(2)}</div>
            </div>
            <div>
                <div style="font-size:11px; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.5px;">GST (${cost.gstRate}%)</div>
                <div style="font-size:16px; font-weight:700; color:var(--text-main);">₹${cost.gst.toFixed(2)}</div>
            </div>
            <div style="background:rgba(251,191,36,0.1); border:1px solid rgba(251,191,36,0.2); border-radius:10px; padding:10px 18px;">
                <div style="font-size:11px; color:#fbbf24; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">Total Estimated Cost</div>
                <div style="font-size:24px; font-weight:800; color:#fbbf24;">₹${cost.total.toFixed(2)}</div>
            </div>
            <div style="font-size:11px; color:var(--text-dim); max-width:200px; line-height:1.5;">
                * Based on delivered + read messages only. Failed messages are not charged. Rates as of Jan 2026.
            </div>
        </div>
    </div>`;
}

function renderReportLog(contactLog) {
    const tbody = document.getElementById('report-log-body');
    if (!tbody) return;

    if (!contactLog || contactLog.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; color:var(--text-dim); padding:30px;">No messages sent yet. Launch a campaign to see results here.</td></tr>';
        return;
    }

    const statusConfig = {
        read:      { color: '#53bdeb', bg: 'rgba(83,189,235,0.1)',   label: '✓✓ Read' },
        delivered: { color: '#00a884', bg: 'rgba(0,168,132,0.1)',    label: '✓✓ Delivered' },
        sent:      { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)',  label: '✓ Sent' },
        failed:    { color: '#ef4444', bg: 'rgba(239,68,68,0.1)',    label: '❌ Failed' }
    };

    tbody.innerHTML = contactLog.map(c => {
        const sc = statusConfig[c.lastStatus] || statusConfig['sent'];
        const timeStr = c.lastTime ? new Date(c.lastTime).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';
        const repliedBadge = c.replied
            ? `<span style="background:rgba(167,139,250,0.15); color:#a78bfa; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600;">✓ ${c.replyCount}</span>`
            : `<span style="color:var(--text-dim); font-size:12px;">—</span>`;
        const isChecked = selectedReportPhones.has(c.phone) ? 'checked' : '';
        const statusBadge = c.lastStatus === 'failed' && c.lastError
            ? `<span style="background:${sc.bg}; color:${sc.color}; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; cursor:help;" title="${c.lastError.replace(/"/g, '&quot;')}">${sc.label}</span>`
            : `<span style="background:${sc.bg}; color:${sc.color}; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600;">${sc.label}</span>`;
        return `
        <tr style="cursor:pointer;" onclick="openChatFromReport('${c.phone}')">
            <td style="text-align:center;" onclick="event.stopPropagation();"><input type="checkbox" class="rpt-checkbox" data-phone="${c.phone}" ${isChecked} onchange="toggleReportSelect('${c.phone}', this.checked)" style="cursor:pointer;"></td>
            <td style="font-weight:500; color:var(--accent);">${c.name}</td>
            <td style="color:var(--text-dim); font-size:12px;">${c.phone}</td>
            <td style="text-align:center; font-weight:600;">${c.sent}</td>
            <td style="text-align:center; color:var(--accent);">${c.delivered}</td>
            <td style="text-align:center; color:#53bdeb;">${c.read}</td>
            <td style="text-align:center;">${repliedBadge}</td>
            <td style="text-align:center;">${statusBadge}</td>
            <td style="text-align:center; font-size:11px;">${c.billable === true ? '<span style="background:rgba(251,191,36,0.12); color:#fbbf24; padding:2px 8px; border-radius:10px; font-weight:600;">' + (c.pricingCategory || 'marketing') + '</span>' : c.billable === false ? '<span style="background:rgba(0,168,132,0.1); color:var(--accent); padding:2px 8px; border-radius:10px; font-weight:600;">Free</span>' : '<span style="color:var(--text-dim);">—</span>'}</td>
            <td style="color:var(--text-dim); font-size:12px;">${timeStr}</td>
        </tr>`;
    }).join('');
}

function filterReportByStatus(status) {
    reportLogFilter = status;
    // Update button styles
    document.querySelectorAll('#report-status-filters button').forEach(btn => {
        btn.style.border = '1px solid rgba(255,255,255,0.1)';
        btn.style.background = 'rgba(255,255,255,0.03)';
    });
    const activeBtn = document.getElementById(`rpt-filter-${status}`);
    if (activeBtn) {
        activeBtn.style.border = '1px solid ' + (activeBtn.style.color || 'var(--accent)');
        activeBtn.style.background = (activeBtn.style.color || 'var(--accent)') + '22';
    }
    filterReportLog();
}

function filterReportLog() {
    if (!globalReportData) return;
    const q = document.getElementById('report-search').value.toLowerCase().trim();
    let filtered = globalReportData.contactLog;

    if (q) {
        filtered = filtered.filter(c => c.name.toLowerCase().includes(q) || c.phone.includes(q));
    }
    if (reportLogFilter !== 'all') {
        filtered = filtered.filter(c => c.lastStatus === reportLogFilter);
    }
    renderReportLog(filtered);
    updateSelectedCount();
}

function toggleReportSelect(phone, checked) {
    if (checked) {
        selectedReportPhones.add(phone);
    } else {
        selectedReportPhones.delete(phone);
    }
    updateSelectedCount();
}

function toggleSelectAllReport(checkbox) {
    const checkboxes = document.querySelectorAll('.rpt-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = checkbox.checked;
        const phone = cb.dataset.phone;
        if (checkbox.checked) {
            selectedReportPhones.add(phone);
        } else {
            selectedReportPhones.delete(phone);
        }
    });
    updateSelectedCount();
}

function updateSelectedCount() {
    const btn = document.getElementById('delete-selected-btn');
    const countEl = document.getElementById('selected-count');
    if (btn && countEl) {
        countEl.textContent = selectedReportPhones.size;
        btn.style.display = selectedReportPhones.size > 0 ? 'inline-flex' : 'none';
    }
}

async function deleteSelectedContacts() {
    if (selectedReportPhones.size === 0) return;
    const count = selectedReportPhones.size;
    if (!confirm(`Delete ${count} contact(s) and all their messages? This cannot be undone.`)) return;

    try {
        const res = await fetch('/api/contacts/bulk-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phones: Array.from(selectedReportPhones) })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Deleted ${count} contact(s)`, 'success');
            selectedReportPhones.clear();
            updateSelectedCount();
            loadReports();
            loadContacts();
            loadInboxList();
        } else {
            showToast('Delete failed: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch(e) {
        showToast('Delete failed', 'error');
    }
}

function exportReportCSV() {
    if (!globalReportData || !globalReportData.contactLog.length) {
        return showToast('No report data to export', 'error');
    }
    let csv = 'Name,Phone,Sent,Delivered,Read,Replied,Reply Count,Last Status,Last Activity\n';
    globalReportData.contactLog.forEach(c => {
        const timeStr = c.lastTime ? new Date(c.lastTime).toLocaleString() : '';
        csv += `"${c.name}","${c.phone}",${c.sent},${c.delivered},${c.read},${c.replied ? 'Yes' : 'No'},${c.replyCount},"${c.lastStatus}","${timeStr}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `report_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    showToast('Report exported!', 'success');
}

function renderCampaignComparison(campaigns) {
    const tbody = document.getElementById('campaign-comparison-body');
    if (!tbody) return;
    if (!campaigns || campaigns.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--text-dim); padding:20px;">No campaign data yet. Launch a campaign with tags to see comparison.</td></tr>';
        return;
    }
    tbody.innerHTML = campaigns.map(c => {
        const tagsHtml = c.tags.length > 0
            ? c.tags.map(t => `<span style="background:rgba(0,168,132,0.1); color:var(--accent); padding:2px 6px; border-radius:4px; font-size:11px; margin-right:3px;">${t}</span>`).join('')
            : '<span style="color:var(--text-dim); font-size:11px;">—</span>';
        const replyRateColor = c.replyRate >= 15 ? '#00a884' : c.replyRate >= 8 ? '#53bdeb' : c.replyRate > 0 ? '#f59e0b' : 'var(--text-dim)';
        const dateStr = c.lastTime ? new Date(c.lastTime).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
        return `
        <tr style="cursor:pointer;" onclick="openCampaignDrilldown('${btoa(unescape(encodeURIComponent(c.name)))}')">
            <td><div style="font-weight:500;">${c.name}</div>${dateStr ? `<div style="font-size:11px; color:var(--text-dim); margin-top:2px;">${dateStr}</div>` : ''}</td>
            <td>${tagsHtml}</td>
            <td style="text-align:center;">${c.uniqueContacts}</td>
            <td style="text-align:center; font-weight:600;">${c.sent}</td>
            <td style="text-align:center; color:var(--accent);">${c.delivered}</td>
            <td style="text-align:center; color:#53bdeb;">${c.read}</td>
            <td style="text-align:center; color:#a78bfa;">${c.replied}</td>
            <td style="text-align:center;"><span style="background:${replyRateColor}22; color:${replyRateColor}; padding:3px 10px; border-radius:12px; font-size:12px; font-weight:700; cursor:pointer;" onclick="event.stopPropagation(); openTagDrilldown('${c.tags[0] || btoa(unescape(encodeURIComponent(c.name)))}')">${c.replyRate}%</span></td>
        </tr>`;
    }).join('');
}

function renderTagCharts(tags) {
    if (!tags || tags.length === 0) return;

    const labels = tags.map(t => t.tag);
    const replyRates = tags.map(t => t.replyRate);
    const sentCounts = tags.map(t => t.sent);

    const barColors = replyRates.map(r => {
        if (r >= 15) return 'rgba(0,168,132,0.8)';
        if (r >= 8) return 'rgba(83,189,235,0.8)';
        return 'rgba(245,158,11,0.8)';
    });

    // Reply Rate by Tag chart (clickable)
    if (chartTagConversion) chartTagConversion.destroy();
    const ctx1 = document.getElementById('chart-tag-conversion');
    if (ctx1) {
        chartTagConversion = new Chart(ctx1.getContext('2d'), {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Reply Rate %',
                    data: replyRates,
                    backgroundColor: barColors,
                    borderRadius: 6,
                    borderWidth: 0,
                    barPercentage: 0.6
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                indexAxis: 'y',
                onClick: (evt, elements) => {
                    if (elements.length > 0) {
                        const idx = elements[0].index;
                        const tag = labels[idx];
                        openTagDrilldown(tag);
                    }
                },
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.raw}% — Click to view contacts` } } },
                scales: {
                    x: { ticks: { color: '#94a3b8', font: { size: 11 }, callback: v => v + '%' }, grid: { color: 'rgba(255,255,255,0.04)' }, max: 100 },
                    y: { ticks: { color: '#e9edef', font: { size: 12, cursor: 'pointer' } }, grid: { display: false } }
                }
            }
        });
    }

    // Messages Sent by Tag chart
    if (chartTagVolume) chartTagVolume.destroy();
    const ctx2 = document.getElementById('chart-tag-volume');
    if (ctx2) {
        const volumeColors = ['#00a884', '#53bdeb', '#a78bfa', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6', '#ec4899'];
        chartTagVolume = new Chart(ctx2.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: sentCounts,
                    backgroundColor: labels.map((_, i) => volumeColors[i % volumeColors.length] + 'cc'),
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                cutout: '55%',
                plugins: {
                    legend: { position: 'right', labels: { color: '#e9edef', font: { size: 11 }, padding: 12, usePointStyle: true, pointStyleWidth: 8 } }
                }
            }
        });
    }
}

// --- Drill-Down Functions ---
let drilldownContacts = [];

async function openTagDrilldown(tag) {
    document.getElementById('drilldown-title').textContent = `Tag: ${tag}`;
    document.getElementById('drilldown-subtitle').textContent = 'Loading contacts...';
    document.getElementById('drilldown-stats').innerHTML = '';
    document.getElementById('drilldown-filters').innerHTML = '';
    document.getElementById('drilldown-body').innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-dim);">Loading...</td></tr>';
    openModal('drilldown-modal');

    try {
        const res = await fetch(`/api/reports/tags/${encodeURIComponent(tag)}/contacts`);
        const data = await res.json();
        drilldownContacts = data.contacts;

        document.getElementById('drilldown-subtitle').textContent = `All contacts tagged "${tag}"`;

        document.getElementById('drilldown-stats').innerHTML = `
            <div style="background:rgba(0,168,132,0.1); border:1px solid rgba(0,168,132,0.2); border-radius:8px; padding:8px 14px; font-size:13px;">
                <span style="color:var(--text-dim);">Total:</span> <strong style="color:var(--text-main);">${data.total}</strong>
            </div>
            <div style="background:rgba(83,189,235,0.1); border:1px solid rgba(83,189,235,0.2); border-radius:8px; padding:8px 14px; font-size:13px;">
                <span style="color:var(--text-dim);">Messaged:</span> <strong style="color:#53bdeb;">${data.messaged}</strong>
            </div>
            <div style="background:rgba(167,139,250,0.1); border:1px solid rgba(167,139,250,0.2); border-radius:8px; padding:8px 14px; font-size:13px;">
                <span style="color:var(--text-dim);">Replied:</span> <strong style="color:#a78bfa;">${data.replied}</strong>
            </div>
        `;

        renderDrilldownFilters(data);
        renderDrilldownTable(drilldownContacts);
    } catch(e) {
        document.getElementById('drilldown-body').innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#ef4444;">Failed to load data</td></tr>';
    }
}

async function openCampaignDrilldown(encodedName) {
    const campaignName = decodeURIComponent(escape(atob(encodedName)));
    document.getElementById('drilldown-title').textContent = `Campaign: ${campaignName}`;
    document.getElementById('drilldown-subtitle').textContent = 'Loading contacts...';
    document.getElementById('drilldown-stats').innerHTML = '';
    document.getElementById('drilldown-filters').innerHTML = '';
    document.getElementById('drilldown-body').innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-dim);">Loading...</td></tr>';
    openModal('drilldown-modal');

    try {
        const res = await fetch(`/api/reports/campaigns/${encodeURIComponent(campaignName)}/contacts`);
        const data = await res.json();
        drilldownContacts = data.contacts;

        document.getElementById('drilldown-subtitle').textContent = `Contacts messaged by "${campaignName}"`;

        document.getElementById('drilldown-stats').innerHTML = `
            <div style="background:rgba(0,168,132,0.1); border:1px solid rgba(0,168,132,0.2); border-radius:8px; padding:8px 14px; font-size:13px;">
                <span style="color:var(--text-dim);">Total:</span> <strong style="color:var(--text-main);">${data.total}</strong>
            </div>
            <div style="background:rgba(167,139,250,0.1); border:1px solid rgba(167,139,250,0.2); border-radius:8px; padding:8px 14px; font-size:13px;">
                <span style="color:var(--text-dim);">Replied:</span> <strong style="color:#a78bfa;">${data.replied}</strong>
            </div>
        `;

        renderDrilldownFilters(data);
        renderDrilldownTable(drilldownContacts);
    } catch(e) {
        document.getElementById('drilldown-body').innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#ef4444;">Failed to load data</td></tr>';
    }
}

function renderDrilldownFilters(data) {
    const replied = data.replied || drilldownContacts.filter(c => c.hasReplied).length;
    const read = drilldownContacts.filter(c => c.lastStatus === 'read' && !c.hasReplied).length;
    const delivered = drilldownContacts.filter(c => c.lastStatus === 'delivered' && !c.hasReplied).length;
    const sent = drilldownContacts.filter(c => c.lastStatus === 'sent' && !c.hasReplied).length;
    const notMessaged = drilldownContacts.filter(c => c.lastStatus === 'not_sent' || c.sent === 0).length;

    const filters = [
        { label: 'All', count: drilldownContacts.length, color: 'var(--text-main)', bg: 'rgba(255,255,255,0.06)', filter: 'all' },
        { label: 'Replied', count: replied, color: '#a78bfa', bg: 'rgba(167,139,250,0.15)', filter: 'replied' },
        { label: 'Read', count: read, color: '#53bdeb', bg: 'rgba(83,189,235,0.15)', filter: 'read' },
        { label: 'Delivered', count: delivered, color: '#00a884', bg: 'rgba(0,168,132,0.15)', filter: 'delivered' },
        { label: 'Sent', count: sent, color: '#94a3b8', bg: 'rgba(148,163,184,0.15)', filter: 'sent' },
    ];
    if (notMessaged > 0) {
        filters.push({ label: 'Not Messaged', count: notMessaged, color: '#ef4444', bg: 'rgba(239,68,68,0.1)', filter: 'not_sent' });
    }

    const filtersHtml = filters.map(f => `
        <button onclick="filterDrilldown('${f.filter}')" id="drilldown-filter-${f.filter}"
            style="display:flex; align-items:center; gap:6px; padding:6px 14px; border-radius:20px; border:1px solid ${f.color}33; background:${f.bg}; color:${f.color}; font-size:12px; font-weight:600; cursor:pointer; transition: all 0.2s;"
            onmouseover="this.style.borderColor='${f.color}'" onmouseout="this.style.borderColor='${f.color}33'">
            ${f.label} <span style="background:${f.color}22; padding:1px 6px; border-radius:8px; font-size:11px;">${f.count}</span>
        </button>
    `).join('');
    document.getElementById('drilldown-filters').innerHTML = filtersHtml;

    // Highlight "All" as active by default
    const allBtn = document.getElementById('drilldown-filter-all');
    if (allBtn) { allBtn.style.border = '1px solid var(--text-main)'; allBtn.style.fontWeight = '700'; }
}

function filterDrilldown(filterType) {
    // Update button styles
    document.querySelectorAll('#drilldown-filters button').forEach(btn => {
        btn.style.border = '1px solid ' + (btn.style.color || 'var(--text-dim)') + '33';
        btn.style.fontWeight = '600';
    });
    const activeBtn = document.getElementById(`drilldown-filter-${filterType}`);
    if (activeBtn) { activeBtn.style.border = '1px solid ' + activeBtn.style.color; activeBtn.style.fontWeight = '700'; }

    let filtered;
    if (filterType === 'all') {
        filtered = drilldownContacts;
    } else if (filterType === 'replied') {
        filtered = drilldownContacts.filter(c => c.hasReplied);
    } else if (filterType === 'read') {
        filtered = drilldownContacts.filter(c => c.lastStatus === 'read' && !c.hasReplied);
    } else if (filterType === 'delivered') {
        filtered = drilldownContacts.filter(c => c.lastStatus === 'delivered' && !c.hasReplied);
    } else if (filterType === 'sent') {
        filtered = drilldownContacts.filter(c => c.lastStatus === 'sent' && !c.hasReplied);
    } else if (filterType === 'not_sent') {
        filtered = drilldownContacts.filter(c => c.lastStatus === 'not_sent' || c.sent === 0);
    } else {
        filtered = drilldownContacts;
    }
    renderDrilldownTable(filtered);
}

function renderDrilldownTable(contacts) {
    const tbody = document.getElementById('drilldown-body');
    if (!contacts || contacts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-dim);">No contacts found</td></tr>';
        return;
    }
    tbody.innerHTML = contacts.map(c => {
        const tagsHtml = (c.tags || []).map(t => `<span style="background:rgba(0,168,132,0.1); color:var(--accent); padding:1px 5px; border-radius:3px; font-size:10px; margin-right:2px;">${t}</span>`).join('');
        let statusBadge;
        if (c.hasReplied) {
            statusBadge = `<span style="background:rgba(167,139,250,0.15); color:#a78bfa; padding:3px 10px; border-radius:12px; font-size:11px; font-weight:600;">Replied (${c.replied})</span>`;
        } else if (c.lastStatus === 'read') {
            statusBadge = `<span style="background:rgba(83,189,235,0.15); color:#53bdeb; padding:3px 10px; border-radius:12px; font-size:11px; font-weight:600;">Read</span>`;
        } else if (c.lastStatus === 'delivered') {
            statusBadge = `<span style="background:rgba(0,168,132,0.15); color:var(--accent); padding:3px 10px; border-radius:12px; font-size:11px; font-weight:600;">Delivered</span>`;
        } else if (c.lastStatus === 'sent') {
            statusBadge = `<span style="background:rgba(148,163,184,0.15); color:#94a3b8; padding:3px 10px; border-radius:12px; font-size:11px; font-weight:600;">Sent</span>`;
        } else {
            statusBadge = `<span style="color:var(--text-dim); font-size:11px;">Not messaged</span>`;
        }
        let billingBadge;
        if (c.billable === true) {
            billingBadge = `<span style="background:rgba(251,191,36,0.12); color:#fbbf24; padding:3px 10px; border-radius:12px; font-size:11px; font-weight:600;">💰 ${c.pricingCategory || 'marketing'}</span>`;
        } else if (c.billable === false) {
            billingBadge = `<span style="background:rgba(0,168,132,0.1); color:var(--accent); padding:3px 10px; border-radius:12px; font-size:11px; font-weight:600;">Free</span>`;
        } else {
            billingBadge = `<span style="color:var(--text-dim); font-size:11px;">—</span>`;
        }
        return `
        <tr style="cursor: pointer;" onclick="window.open('/?chat=${c.phone}', '_blank')">
            <td style="font-weight:500;">${c.name}</td>
            <td style="color:var(--text-dim); font-size:12px;">${c.phone}</td>
            <td>${tagsHtml || '<span style="color:var(--text-dim);">—</span>'}</td>
            <td style="text-align:center; font-weight:600;">${c.sent || 0}</td>
            <td style="text-align:center; color:#53bdeb;">${c.read || 0}</td>
            <td style="text-align:center;">${statusBadge}</td>
            <td style="text-align:center;">${billingBadge}</td>
        </tr>`;
    }).join('');
}

// Verify stuck messages — query Meta API for actual status
async function verifyStuckMessages() {
    const btn = document.getElementById('btn-verify-stuck');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader" style="width:12px; animation: spin 1s linear infinite;"></i> Verifying...';
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
    try {
        const res = await fetch('/api/verify-stuck', { method: 'POST' });
        const data = await res.json();
        if (data.checking) {
            showToast(`Verifying stuck messages... ${data.message}`, 'info');
        } else {
            showToast(data.message || 'No stuck messages found', 'success');
        }
        // Refresh stuck count after verification
        setTimeout(async () => {
            try {
                const countRes = await fetch('/api/verify-stuck/count');
                const countData = await countRes.json();
                document.getElementById('stat-stuck').innerText = countData.stuckCount || 0;
            } catch(e) {}
        }, 35000);
    } catch(e) {
        showToast('Verification failed: ' + e.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i data-lucide="refresh-cw" style="width:12px;"></i> Verify Now';
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }
    }
}

// Listen for bulk status updates from server
if (typeof io !== 'undefined') {
    const socket = io();
    socket.on('message_status_bulk_updated', (data) => {
        showToast(`Verified ${data.checked} messages, ${data.updated} updated`, 'success');
        loadReports();
    });
}

// Init
window.onload = () => {
    loadSettings();
    loadWebhookUrl();
    loadContacts();
    loadInboxList();
    loadNotifications();
    loadQueueStatus();
    loadCampaignTemplates();
    loadScheduledCampaigns();
    // Ensure audience tab starts on CSV
    switchAudienceTab('csv');
};

