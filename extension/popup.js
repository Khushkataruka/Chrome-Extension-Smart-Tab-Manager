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
async function init() {
  await loadSettings();
  
  try {
    const session = await chrome.storage.session.get(['cachedAnalysis', 'cachedTabsToClose', 'cachedAllTabs']);
    if (session.cachedAnalysis) {
      allTabs = session.cachedAllTabs || [];
      tabsToClose = session.cachedTabsToClose || [];
      
      displayResults(session.cachedAnalysis);
      
      tabBadge.textContent = `${allTabs.length} tab${allTabs.length !== 1 ? 's' : ''}`;
      tabBadge.classList.remove('hidden');
      
      if (tabsToClose.length > 0) {
        closeBtn.disabled = false;
        closeCountEl.textContent = tabsToClose.length;
        closeInfoEl.classList.remove('hidden');
      }
    }
  } catch (err) {
    console.warn('Session storage not available:', err);
  }
}
init();

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

    let validCachedTabIds = new Set();
    let cachedAnalysis = null;
    let mergedAnalysis = { groups: [], close_tabs: [], total_tabs: 0 };

    try {
      const session = await chrome.storage.session.get(['cachedAnalysis', 'cachedAllTabs']);
      if (session.cachedAnalysis && session.cachedAllTabs) {
        cachedAnalysis = session.cachedAnalysis;
        const cachedTabsMap = new Map(session.cachedAllTabs.map(t => [t.id, t.url]));

        tabs.forEach(t => {
          if (cachedTabsMap.has(t.id) && cachedTabsMap.get(t.id) === t.url) {
            validCachedTabIds.add(t.id);
          }
        });

        // Retain only valid tabs in the merged structure
        for (const group of cachedAnalysis.groups || []) {
          const validIds = (group.tab_ids || []).filter(id => validCachedTabIds.has(id));
          if (validIds.length > 0) {
            mergedAnalysis.groups.push({
              name: group.name,
              summary: group.summary,
              tab_ids: validIds,
              tabs: (group.tabs || []).filter(t => validIds.includes(t.id))
            });
          }
        }
        mergedAnalysis.close_tabs = (cachedAnalysis.close_tabs || []).filter(id => validCachedTabIds.has(id));
      }
    } catch (err) {
      console.warn('Session cache unavailable:', err);
    }

    const tabsToAnalyze = tabs.filter(t => !validCachedTabIds.has(t.id));
    let analysis = mergedAnalysis;

    if (tabsToAnalyze.length > 0) {
      console.log(`Analyzing ${tabsToAnalyze.length} new/changed tabs...`);
      const newAnalysis = await analyzeTabs(tabsToAnalyze);
      analysis.mode = newAnalysis.mode || 'mixed';
      
      // Merge new close_tabs
      analysis.close_tabs.push(...(newAnalysis.close_tabs || []));
      
      // Merge new groups
      for (const newGroup of newAnalysis.groups || []) {
        const existingGroup = analysis.groups.find(g => g.name === newGroup.name);
        if (existingGroup) {
          existingGroup.tab_ids.push(...(newGroup.tab_ids || []));
          existingGroup.tabs.push(...(newGroup.tabs || []));
        } else {
          analysis.groups.push(newGroup);
        }
      }
    } else {
      console.log('All tabs loaded from cache. No new analysis needed.');
    }

    analysis.total_tabs = tabs.length;

    displayResults(analysis);

    tabsToClose = analysis.close_tabs || [];

    if (tabsToClose.length > 0) {
      closeBtn.disabled = false;
      closeCountEl.textContent = tabsToClose.length;
      closeInfoEl.classList.remove('hidden');
    } else {
      closeInfoEl.classList.add('hidden');
    }

    // Cache the results until Chrome is closed
    try {
      await chrome.storage.session.set({
        cachedAnalysis: analysis,
        cachedTabsToClose: tabsToClose,
        cachedAllTabs: allTabs
      });
    } catch (err) {
      console.warn('Failed to cache analysis in session:', err);
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
      <div style="display: flex; align-items: center;">
        <button class="btn-small group-tabs-btn" data-group-name="${escapeHtml(group.name)}">
          <svg class="btn-icon" viewBox="0 0 20 20" fill="currentColor">
            <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM14 11a1 1 0 011 1v1h1a1 1 0 110 2h-1v1a1 1 0 11-2 0v-1h-1a1 1 0 110-2h1v-1a1 1 0 011-1z" />
          </svg>
          Group in Browser
        </button>
        <button class="close-group-btn" title="Close all tabs in this group">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 18L18 6M6 6l12 12" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
    <p class="group-summary">${escapeHtml(group.summary)}</p>
    <ul class="tab-list" data-group="${escapeHtml(group.name)}">
      ${group.tabs ? group.tabs.map(tab => createTabItem(tab, group.name)).join('') : ''}
    </ul>
  `;

  // Add click-to-navigate and drag events for each tab item
  groupEl.querySelectorAll('.tab-item').forEach((item, index) => {
    const currentTab = group.tabs && group.tabs[index];
    if (currentTab) {
      item.addEventListener('click', () => switchToTab(currentTab.id));
      
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ tabId: currentTab.id, sourceGroup: group.name }));
        setTimeout(() => item.classList.add('dragging'), 10);
      });
      
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      });
    }
  });

  // Add drop listeners to the tab list container
  const tabListEl = groupEl.querySelector('.tab-list');
  if (tabListEl) {
    tabListEl.addEventListener('dragover', (e) => {
      e.preventDefault(); // allow drop
      tabListEl.classList.add('drag-over');
    });

    tabListEl.addEventListener('dragleave', () => {
      tabListEl.classList.remove('drag-over');
    });

    tabListEl.addEventListener('drop', (e) => {
      e.preventDefault();
      tabListEl.classList.remove('drag-over');
      try {
        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
        if (data && data.tabId && data.sourceGroup !== group.name) {
          handleMoveTab(data.tabId, data.sourceGroup, group.name);
        }
      } catch (err) {
        console.error('Drop error:', err);
      }
    });
  }

  // Add click handler for Grouping button
  const groupBtn = groupEl.querySelector('.group-tabs-btn');
  if (groupBtn) {
    groupBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tabIds = group.tabs.map(t => t.id).filter(id => id !== undefined);
      handleGroupTabsInBrowser(tabIds, group.name, groupBtn);
    });
  }

  // Add click handler for Close Group button
  const closeGroupBtn = groupEl.querySelector('.close-group-btn');
  if (closeGroupBtn) {
    closeGroupBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tabIds = group.tabs.map(t => t.id).filter(id => id !== undefined);
      if (tabIds.length === 0) return;
      
      closeGroupBtn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px;border-color:var(--danger) transparent var(--danger) transparent"></div>';
      try {
        await closeTabs(tabIds); // Use existing close tabs from background
        handleRemoveGroupLocally(group.name);
      } catch (err) {
        showError(`Failed to close group: ${err.message}`);
        closeGroupBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }
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

function createTabItem(tab, groupName) {
  const isSuggestedClose = tabsToClose.includes(tab.id);
  const faviconUrl = tab.favIconUrl || getFaviconFallback(tab.url);

  return `
    <li class="tab-item ${isSuggestedClose ? 'suggested-close' : ''}" title="${escapeHtml(tab.url || '')}" draggable="true" data-tab-id="${tab.id}">
      <img class="tab-favicon" src="${escapeHtml(faviconUrl)}" alt="" onerror="this.style.display='none'">
      <span class="tab-title">${escapeHtml(tab.title || 'Untitled')}</span>
      ${isSuggestedClose ? '<span class="close-tag">Close</span>' : ''}
    </li>
  `;
}

// --- State Modifiers ---
async function handleMoveTab(tabId, sourceGroupName, targetGroupName) {
  try {
    const session = await chrome.storage.session.get(['cachedAnalysis']);
    let analysis = session.cachedAnalysis;
    if (!analysis) return;

    const sourceGroup = analysis.groups.find(g => g.name === sourceGroupName);
    const targetGroup = analysis.groups.find(g => g.name === targetGroupName);

    if (sourceGroup && targetGroup) {
      // Find the tab object
      const tabObj = sourceGroup.tabs.find(t => t.id === tabId);
      if (tabObj) {
        // Remove from source
        sourceGroup.tab_ids = sourceGroup.tab_ids.filter(id => id !== tabId);
        sourceGroup.tabs = sourceGroup.tabs.filter(t => t.id !== tabId);
        
        // Add to target
        if (!targetGroup.tab_ids.includes(tabId)) {
          targetGroup.tab_ids.push(tabId);
          targetGroup.tabs.push(tabObj);
        }

        // Save state and silently re-render UI
        await chrome.storage.session.set({ cachedAnalysis: analysis });
        displayResults(analysis);
      }
    }
  } catch (err) {
    console.error('Failed to move tab state:', err);
  }
}

async function handleRemoveGroupLocally(groupName) {
  try {
    const session = await chrome.storage.session.get(['cachedAnalysis']);
    let analysis = session.cachedAnalysis;
    if (!analysis) return;

    // Remove the group entirely
    analysis.groups = analysis.groups.filter(g => g.name !== groupName);
    
    await chrome.storage.session.set({ cachedAnalysis: analysis });
    displayResults(analysis);
    
    // Also re-fetch global browser open tabs to update the overall tab count locally
    const currentOpenTabs = await getTabs();
    allTabs = currentOpenTabs;
    tabBadge.textContent = `${allTabs.length} tab${allTabs.length !== 1 ? 's' : ''}`;
    await chrome.storage.session.set({ cachedAllTabs: allTabs });
    
  } catch (err) {
    console.error('Failed to update UI after closing group:', err);
  }
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
