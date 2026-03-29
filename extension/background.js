// Smart Tab Manager — Background Service Worker
// Handles tab queries and tab closing via message passing from popup.js

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'GET_TABS') {
    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      const tabData = tabs.map(tab => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        favIconUrl: tab.favIconUrl || ''
      }));
      sendResponse({ tabs: tabData });
    });
    return true; // keep message channel open for async response
  }

  if (request.action === 'CLOSE_TABS') {
    const tabIdsToClose = request.tabIds;

    if (!Array.isArray(tabIdsToClose) || tabIdsToClose.length === 0) {
      sendResponse({ success: false, error: 'No tab IDs provided' });
      return true;
    }

    // Use Promise.allSettled to close all tabs and track individual results
    const closePromises = tabIdsToClose.map(tabId =>
      chrome.tabs.remove(tabId).catch(err => {
        console.warn(`Failed to close tab ${tabId}:`, err.message);
        return { failed: true, tabId, error: err.message };
      })
    );

    Promise.allSettled(closePromises).then(results => {
      const failedCount = results.filter(
        r => r.status === 'rejected' || (r.value && r.value.failed)
      ).length;
      const closedCount = tabIdsToClose.length - failedCount;

      sendResponse({
        success: true,
        closedCount,
        failedCount,
        totalRequested: tabIdsToClose.length
      });
    });

    return true; // keep message channel open for async response
  }

  if (request.action === 'SWITCH_TO_TAB') {
    const tabId = request.tabId;
    chrome.tabs.update(tabId, { active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        chrome.windows.update(tab.windowId, { focused: true });
        sendResponse({ success: true });
      }
    });
    return true;
  }

  if (request.action === 'GROUP_TABS') {
    const { tabIds, groupName } = request;

    if (!Array.isArray(tabIds) || tabIds.length === 0) {
      sendResponse({ success: false, error: 'No tab IDs provided for grouping' });
      return true;
    }

    chrome.tabs.group({ tabIds }, (groupId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
        return;
      }

      // Map group name to a valid Chrome group color
      const colorMap = {
        'Study': 'blue',
        'Shopping': 'pink',
        'Social': 'green',
        'Work': 'red',
        'Entertainment': 'purple',
        'AI Tools': 'cyan',
        'Other': 'grey'
      };

      chrome.tabGroups.update(groupId, {
        title: groupName,
        color: colorMap[groupName] || 'cyan'
      }, () => {
        sendResponse({ success: true, groupId });
      });
    });
    return true; // async
  }

  // Unknown action
  sendResponse({ error: `Unknown action: ${request.action}` });
  return true;
});
