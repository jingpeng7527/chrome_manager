// Thin wrappers over the Chrome extension APIs, shared by the service worker
// and the popup so both execute commands identically. Kept separate from
// lib.js, which must stay free of chrome.* to remain importable by tests.

export async function collectTabState() {
  const rawTabs = await chrome.tabs.query({ currentWindow: true });
  const tabs = rawTabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
    groupId: tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? tab.groupId : null,
  }));

  // Query every group and keep the ones these tabs belong to, rather than
  // filtering on windowId: "the current window" resolves differently from a
  // popup than from the service worker, and Chrome drops empty groups anyway,
  // so this yields the same set from either caller.
  const inUse = new Set(tabs.map((t) => t.groupId).filter((id) => id != null));
  const groups = (await chrome.tabGroups.query({}))
    .filter((g) => inUse.has(g.id))
    .map((g) => ({ id: g.id, title: g.title }));

  return { tabs, groups };
}

export async function executeCommands(commands) {
  let failed = 0;
  for (const command of commands) {
    try {
      await executeChromeCommand(command);
    } catch (error) {
      failed++;
      console.error('Command failed:', command.action, error?.message ?? String(error));
    }
  }
  return { succeeded: commands.length - failed, failed };
}

async function executeChromeCommand(command) {
  const action = command.action ?? command.command;
  switch (action) {
    case 'group': {
      const options = { tabIds: command.tabIds };
      if (command.groupId) options.groupId = command.groupId;
      const groupId = await chrome.tabs.group(options);
      if (!command.groupId) {
        await chrome.tabGroups.update(groupId, { title: command.title || 'AI Group' });
      }
      break;
    }
    case 'ungroup':
      await chrome.tabs.ungroup(command.tabIds);
      break;
    case 'duplicate':
      await chrome.tabs.duplicate(command.tabId);
      break;
    case 'remove':
      await chrome.tabs.remove(command.tabId);
      break;
    default:
      console.warn('Unknown action:', action, command);
  }
}
