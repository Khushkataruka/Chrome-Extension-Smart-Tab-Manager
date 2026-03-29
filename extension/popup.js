// Smart Tab Manager — Popup Logic
// Handles tab analysis, display, and close operations

const BACKEND_URL = 'https://chrome-extension-smart-tab-manager.onrender.com';

// --- DOM References ---
const analyzeBtn = document.getElementById('analyzeBtn');
const closeBtn = document.getElementById('closeBtn');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const errorTextEl = document.getElementById('errorText');
const resultsEl = document.getElementById('results'); // This is the main container for results
const groupsContainer = document.getElementById('groupsContainer'); // Specific container for tab groups
const closeInfoEl = document.getElementById('closeInfo');
const closeCountEl = document.getElementById('closeCount');
const tabBadge = document.getElementById('tabBadge'); // Original tab badge
const settingsBtn = document.getElementById('settingsBtn');
const settingsDrawer = document.getElementById('settingsDrawer');
const modelSelector = document.getElementById('modelSelector');
const apiKeySection = document.getElementById('apiKeySection');
const apiKeyInput = document.getElementById('apiKey');
const ollamaUrlSection = document.getElementById('ollamaUrlSection');
const ollamaUrlInput = document.getElementById('ollamaUrl');
const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
const settingsStatus = document.getElementById('settingsStatus');

let tabsToClose = [];
let allTabs = []; // cache of the last fetched tabs for favicon lookup
let currentSettings = {
  provider: 'keywords',
  geminiKey: '',
  groqKey: '',
  ollamaUrl: 'http://localhost:11434/api/generate'
};

// --- Extension Context Check ---
if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
  showError('This extension must be loaded in Chrome to work correctly. Please load the "extension" folder at chrome://extensions/ and click the toolbar icon.');
  analyzeBtn.disabled = true;
}

// --- Event Listeners ---
analyzeBtn.addEventListener('click', handleAnalyze);
closeBtn.addEventListener('click', handleCloseTabs);
settingsBtn.addEventListener('click', toggleSettings);
saveApiKeyBtn.addEventListener('click', handleSaveConfig);
modelSelector.addEventListener('change', updateSettingsVisibility);

// --- Initialization ---
loadSettings();

function toggleSettings() {
  settingsDrawer.classList.toggle('hidden');
}

function updateSettingsVisibility() {
  const provider = modelSelector.value;
  
  // Hide all sections first
  apiKeySection.classList.add('hidden');
  ollamaUrlSection.classList.add('hidden');

  if (provider === 'gemini' || provider === 'groq') {
    apiKeySection.classList.remove('hidden');
    // Set placeholder contextually
    apiKeyInput.placeholder = provider === 'gemini' ? 'Enter Gemini API Key...' : 'Enter Groq API Key...';
    // Load existing key for this provider
    apiKeyInput.value = provider === 'gemini' ? currentSettings.geminiKey : currentSettings.groqKey;
  } else if (provider === 'ollama') {
    ollamaUrlSection.classList.remove('hidden');
    ollamaUrlInput.value = currentSettings.ollamaUrl;
  }
}

async function handleSaveConfig() {
  const provider = modelSelector.value;
  currentSettings.provider = provider;

  if (provider === 'gemini') currentSettings.geminiKey = apiKeyInput.value.trim();
  if (provider === 'groq') currentSettings.groqKey = apiKeyInput.value.trim();
  if (provider === 'ollama') currentSettings.ollamaUrl = ollamaUrlInput.value.trim();

  try {
    await chrome.storage.local.set({ extensionSettings: currentSettings });
    showSettingsStatus('Configuration saved!', 'success');
    setTimeout(() => toggleSettings(), 1200);
  } catch (error) {
    showSettingsStatus('Failed to save settings.', 'error');
  }
}

async function loadSettings() {
  try {
    const result = await chrome.storage.local.get(['extensionSettings']);
    if (result.extensionSettings) {
      currentSettings = { ...currentSettings, ...result.extensionSettings };
      modelSelector.value = currentSettings.provider;
    }
    updateSettingsVisibility();
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

function showSettingsStatus(msg, type) {
  settingsStatus.textContent = msg;
  settingsStatus.className = `status-message ${type}`;
  settingsStatus.classList.remove('hidden');
  setTimeout(() => {
    settingsStatus.classList.add('hidden');
  }, 3000);
}

// --- Main Analyze Flow ---
async function handleAnalyze() {
  setLoading(true);
  hideError();
  hideResults();
  closeBtn.disabled = true;

  try {
    const tabs = await getTabs();
    allTabs = tabs;

    if (tabs.length === 0) {
      showError('No tabs found to analyze.');
      setLoading(false);
      return;
    }

    // Update tab badge
    tabBadge.textContent = `${tabs.length} tab${tabs.length !== 1 ? 's' : ''}`;
    tabBadge.classList.remove('hidden');

    const analysis = await analyzeTabs(tabs);

    displayResults(analysis);

    tabsToClose = analysis.close_tabs || [];

    if (tabsToClose.length > 0) {
      closeBtn.disabled = false;
      closeCountEl.textContent = tabsToClose.length;
      closeInfoEl.classList.remove('hidden');
    } else {
      closeInfoEl.classList.add('hidden');
    }

  } catch (error) {
    const message = error.message.includes('fetch')
      ? 'Cannot connect to backend. Is the server running on localhost:3000?'
      : `Failed to analyze tabs: ${error.message}`;
    showError(message);
  } finally {
    setLoading(false);
  }
}

// --- Get Tabs from Background ---
async function getTabs() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'GET_TABS' }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.error) {
        reject(new Error(response.error));
      } else if (response && response.tabs) {
        resolve(response.tabs);
      } else {
        reject(new Error('Invalid response from background script'));
      }
    });
  });
}

// --- Send Tabs to Backend for Analysis ---
async function analyzeTabs(tabs) {
  const headers = {
    'Content-Type': 'application/json',
    'x-model-type': currentSettings.provider
  };

  if (currentSettings.provider === 'gemini' && currentSettings.geminiKey) {
    headers['x-api-key'] = currentSettings.geminiKey;
  } else if (currentSettings.provider === 'groq' && currentSettings.groqKey) {
    headers['x-api-key'] = currentSettings.groqKey;
  } else if (currentSettings.provider === 'ollama' && currentSettings.ollamaUrl) {
    headers['x-ollama-url'] = currentSettings.ollamaUrl;
  }

  const response = await fetch(`${BACKEND_URL}/analyze`, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ tabs })
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Server responded with ${response.status}${errorBody ? ': ' + errorBody : ''}`);
  }

  return await response.json();
}

// --- Display Results ---
function displayResults(analysis) {
  groupsContainer.innerHTML = '';

  if (!analysis.groups || analysis.groups.length === 0) {
    showError('No groups returned from analysis.');
    return;
  }

  analysis.groups.forEach(group => {
    const groupEl = createGroupElement(group);
    groupsContainer.appendChild(groupEl);
  });

  resultsEl.classList.remove('hidden');
}

function createGroupElement(group) {
  const groupEl = document.createElement('div');
  groupEl.className = 'group';

  const tabCount = group.tabs ? group.tabs.length : 0;

  groupEl.innerHTML = `
    <div class="group-header">
      <div class="group-title-info">
        <span class="group-name">${escapeHtml(group.name)}</span>
        <span class="group-count">${tabCount} tab${tabCount !== 1 ? 's' : ''}</span>
      </div>
      <button class="btn-small group-tabs-btn" data-group-name="${escapeHtml(group.name)}">
        <svg class="btn-icon" viewBox="0 0 20 20" fill="currentColor">
          <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM14 11a1 1 0 011 1v1h1a1 1 0 110 2h-1v1a1 1 0 11-2 0v-1h-1a1 1 0 110-2h1v-1a1 1 0 011-1z" />
        </svg>
        Group in Browser
      </button>
    </div>
    <p class="group-summary">${escapeHtml(group.summary)}</p>
    <ul class="tab-list">
      ${group.tabs ? group.tabs.map(tab => createTabItem(tab)).join('') : ''}
    </ul>
  `;

  // Add click-to-navigate for each tab item
  groupEl.querySelectorAll('.tab-item').forEach((item, index) => {
    if (group.tabs && group.tabs[index]) {
      item.addEventListener('click', () => switchToTab(group.tabs[index].id));
    }
  });

  // Add click handler for Grouping button
  const groupBtn = groupEl.querySelector('.group-tabs-btn');
  if (groupBtn) {
    groupBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tabIds = group.tabs.map(t => t.id).filter(id => id !== undefined);
      handleGroupTabsInBrowser(tabIds, group.name, groupBtn);
    });
  }

  return groupEl;
}

async function handleGroupTabsInBrowser(tabIds, groupName, button) {
  if (!tabIds || tabIds.length === 0) return;

  const originalContent = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Grouping...';

  try {
    const response = await groupTabs(tabIds, groupName);
    if (response.success) {
      button.textContent = 'Tabs Grouped!';
      button.classList.add('btn-success');
      setTimeout(() => {
        button.innerHTML = originalContent;
        button.disabled = false;
        button.classList.remove('btn-success');
      }, 2000);
    } else {
      throw new Error(response.error || 'Failed to group tabs');
    }
  } catch (error) {
    console.error('Grouping error:', error);
    button.textContent = 'Error';
    setTimeout(() => {
      button.innerHTML = originalContent;
      button.disabled = false;
    }, 2000);
  }
}

function groupTabs(tabIds, groupName) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'GROUP_TABS', tabIds, groupName }, (response) => {
      resolve(response || { success: false, error: 'No response from background' });
    });
  });
}

function createTabItem(tab) {
  const isSuggestedClose = tabsToClose.includes(tab.id);
  const faviconUrl = tab.favIconUrl || getFaviconFallback(tab.url);

  return `
    <li class="tab-item ${isSuggestedClose ? 'suggested-close' : ''}" title="${escapeHtml(tab.url || '')}">
      <img class="tab-favicon" src="${escapeHtml(faviconUrl)}" alt="" onerror="this.style.display='none'">
      <span class="tab-title">${escapeHtml(tab.title || 'Untitled')}</span>
      ${isSuggestedClose ? '<span class="close-tag">Close</span>' : ''}
    </li>
  `;
}

function getFaviconFallback(url) {
  try {
    const urlObj = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
  } catch {
    return '';
  }
}

// --- Switch to Tab ---
function switchToTab(tabId) {
  chrome.runtime.sendMessage({ action: 'SWITCH_TO_TAB', tabId }, (response) => {
    if (response && response.error) {
      console.warn('Could not switch to tab:', response.error);
    }
  });
}

// --- Close Tabs ---
async function handleCloseTabs() {
  if (tabsToClose.length === 0) return;

  closeBtn.disabled = true;
  closeBtn.innerHTML = `
    <div class="spinner" style="width:14px;height:14px;border-width:2px;"></div>
    Closing...
  `;

  try {
    const result = await closeTabs(tabsToClose);

    // Clear stale state
    tabsToClose = [];
    closeInfoEl.classList.add('hidden');

    closeBtn.innerHTML = `
      <svg class="btn-icon" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
      </svg>
      Closed ${result.closedCount} tab${result.closedCount !== 1 ? 's' : ''}!
    `;

    // Re-analyze after a short delay to refresh the UI
    setTimeout(() => {
      resetCloseButton();
      handleAnalyze();
    }, 1500);

  } catch (error) {
    showError(`Failed to close tabs: ${error.message}`);
    resetCloseButton();
  }
}

function resetCloseButton() {
  closeBtn.disabled = true;
  closeBtn.innerHTML = `
    <svg class="btn-icon" viewBox="0 0 20 20" fill="currentColor">
      <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/>
    </svg>
    Close Suggested Tabs
  `;
}

function closeTabs(tabIds) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'CLOSE_TABS', tabIds }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.success) {
        resolve(response);
      } else if (response && response.error) {
        reject(new Error(response.error));
      } else {
        reject(new Error('Failed to close tabs'));
      }
    });
  });
}

// --- UI Helpers ---
function setLoading(isLoading) {
  if (isLoading) {
    loadingEl.classList.remove('hidden');
    analyzeBtn.disabled = true;
  } else {
    loadingEl.classList.add('hidden');
    analyzeBtn.disabled = false;
  }
}

function showError(message) {
  errorTextEl.textContent = message;
  errorEl.classList.remove('hidden');
}

function hideError() {
  errorEl.classList.add('hidden');
}

function hideResults() {
  resultsEl.classList.add('hidden');
  closeInfoEl.classList.add('hidden');
  tabBadge.classList.add('hidden');
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
