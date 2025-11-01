// Background service worker for Content Collector extension

const DB_NAME = 'ContentCollectorDB';
const DB_VERSION = 1;
const STORE_NAME = 'fileHandles';

// Initialize IndexedDB
async function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}


// Retrieve file handle from IndexedDB
async function getFileHandle() {
  try {
    const db = await initDB();
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    
    return new Promise((resolve, reject) => {
      const request = store.get('currentFileHandle');
      request.onsuccess = () => {
        if (request.result) {
          resolve(request.result.fileHandle);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('Error retrieving file handle:', error);
    throw error;
  }
}

// Read file content
async function readFile(fileHandle) {
  try {
    // Check if handle is valid
    if (!fileHandle) {
      throw new Error('Invalid file handle');
    }
    
    const file = await fileHandle.getFile();
    if (!file) {
      throw new Error('Could not access file. The file may have been moved or deleted.');
    }
    
    const text = await file.text();
    return text;
  } catch (error) {
    console.error('Error reading file:', error);
    // Re-throw permission errors as-is (will be handled by caller)
    if (error.name === 'NotFoundError' || error.name === 'NotAllowedError') {
      throw error;
    }
    throw error;
  }
}

// Write content to file
async function writeFile(fileHandle, content) {
  try {
    if (!fileHandle) {
      throw new Error('Invalid file handle');
    }
    
    const writable = await fileHandle.createWritable();
    if (!writable) {
      throw new Error('Could not create writable stream');
    }
    
    await writable.write(content);
    await writable.close();
  } catch (error) {
    console.error('Error writing file:', error);
    // Re-throw permission errors as-is (will be handled by caller)
    if (error.name === 'NotAllowedError' || error.name === 'NotFoundError') {
      throw error;
    }
    throw error;
  }
}

// Append URL and text to JSON file
async function appendToFile(url, text) {
  try {
    const fileHandle = await getFileHandle();
    
    if (!fileHandle) {
      throw new Error('No file selected. Please select a file first.');
    }

    // Read existing content
    // File handles stored in IndexedDB should maintain permissions
    // If permission is lost, the read operation will fail and we'll catch it
    let existingContent = '{}';
    try {
      existingContent = await readFile(fileHandle);
      // Validate JSON (allow empty file)
      if (existingContent.trim()) {
        JSON.parse(existingContent);
      }
    } catch (error) {
      // Check if it's a permission error
      if (error.name === 'NotAllowedError' || 
          error.name === 'NotFoundError' ||
          (error.message && error.message.toLowerCase().includes('permission'))) {
        throw new Error('File access permission lost. Please select the file again from the extension popup.');
      }
      
      // If file is empty, that's fine
      if (!existingContent.trim()) {
        existingContent = '{}';
      } else if (error instanceof SyntaxError) {
        console.warn('Invalid JSON in file, starting fresh');
        existingContent = '{}';
      } else {
        throw new Error(`Error reading file: ${error.message}`);
      }
    }

    // Parse and update JSON
    const data = existingContent.trim() ? JSON.parse(existingContent) : {};
    data[url] = text;

    // Write back to file
    const updatedContent = JSON.stringify(data, null, 2);
    try {
      await writeFile(fileHandle, updatedContent);
    } catch (error) {
      // Check if it's a permission error during write
      if (error.name === 'NotAllowedError' || 
          error.name === 'NotFoundError' ||
          (error.message && error.message.toLowerCase().includes('permission'))) {
        throw new Error('File write permission denied. Please select the file again from the extension popup.');
      }
      throw error;
    }

    return true;
  } catch (error) {
    console.error('Error appending to file:', error);
    throw error;
  }
}

// Handle scraping current tab
async function scrapeCurrentTab(tabId) {
  return new Promise((resolve) => {
    let resolved = false;

    // Set up listener FIRST before injecting script to avoid race condition
    const listener = (message, sender, sendResponse) => {
      // Match message from content script - accept any scrapedData from the target tab
      // Since we only process one scrape at a time per tab, this is safe
      const matchesTab = sender.tab?.id === tabId;
      
      // Debug logging (can be removed in production)
      if (message.action === 'scrapedData') {
        console.log('Received scrapedData message:', {
          senderTabId: sender.tab?.id,
          expectedTabId: tabId,
          matches: matchesTab,
          resolved: resolved
        });
      }
      
      if (message.action === 'scrapedData' && matchesTab && !resolved) {
        resolved = true;
        chrome.runtime.onMessage.removeListener(listener);
        
        if (message.success) {
          // Send scraped data to popup for file writing (file handles work better in popup context)
          chrome.runtime.sendMessage({
            action: 'scrapeComplete',
            success: true,
            url: message.url,
            text: message.text,
            needsFileWrite: true
          }).catch(() => {}); // Ignore errors if popup is closed
          resolve({ success: true, url: message.url, text: message.text });
        } else {
          // Notify popup of scraping error
          chrome.runtime.sendMessage({
            action: 'scrapeComplete',
            success: false,
            error: message.error || 'Failed to scrape page'
          }).catch(() => {});
          resolve({ success: false, error: message.error || 'Failed to scrape page' });
        }
        sendResponse({ received: true });
        return true;
      }
    };

    // Add listener BEFORE injecting script
    chrome.runtime.onMessage.addListener(listener);

    // Inject content script AFTER listener is set up
    console.log('Setting up listener and injecting script for tab:', tabId);
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    }).then((results) => {
      console.log('Content script injected, results:', results);
      if (!results || results.length === 0) {
        if (resolved) return;
        resolved = true;
        chrome.runtime.onMessage.removeListener(listener);
        const error = 'Failed to inject content script';
        chrome.runtime.sendMessage({
          action: 'scrapeComplete',
          success: false,
          error: error
        }).catch(() => {});
        resolve({ success: false, error: error });
      }
      // Script injected, now waiting for content script to send message
    }).catch((error) => {
      console.error('Error injecting content script:', error);
      if (resolved) return;
      resolved = true;
      chrome.runtime.onMessage.removeListener(listener);
      const errorMsg = `Failed to inject content script: ${error.message}`;
      chrome.runtime.sendMessage({
        action: 'scrapeComplete',
        success: false,
        error: errorMsg
      }).catch(() => {});
      resolve({ success: false, error: errorMsg });
    });

    // Timeout after 15 seconds
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      chrome.runtime.onMessage.removeListener(listener);
      chrome.runtime.sendMessage({
        action: 'scrapeComplete',
        success: false,
        error: 'Scraping timeout'
      }).catch(() => {});
      resolve({ success: false, error: 'Scraping timeout' });
    }, 15000);
  });
}

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.action === 'scrapeCurrentTab') {
        const result = await scrapeCurrentTab(message.tabId);
        sendResponse(result);
      } else if (message.action === 'appendToFile') {
        try {
          await appendToFile(message.url, message.text);
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      } else {
        sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
  })();

  // Return true to indicate we will send a response asynchronously
  return true;
});

// Create context menu items
chrome.runtime.onInstalled.addListener(() => {
  console.log('Content Collector extension installed');
  
  // Create context menu item for clipboard copy only
  chrome.contextMenus.create({
    id: 'content-collector-copy',
    title: 'Copy Page Text to Clipboard',
    contexts: ['page', 'selection']
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'content-collector-copy') {
      // Copy to clipboard
      if (tab.id) {
        // Inject content script
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });

          // Listen for scraped data
          const listener = (message, sender, sendResponse) => {
            if (message.action === 'scrapedData' && sender.tab?.id === tab.id) {
              chrome.runtime.onMessage.removeListener(listener);
              if (message.success && message.text && message.url) {
                // Format as JSON: {"url":"content"}
                const jsonData = {
                  [message.url]: message.text
                };
                const jsonString = JSON.stringify(jsonData, null, 2);
                
                // Use chrome.scripting.executeScript to write to clipboard
                // (Clipboard API needs to be called from page context)
                chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  func: (jsonText) => {
                    navigator.clipboard.writeText(jsonText).then(() => {
                      console.log('Text copied to clipboard as JSON');
                    }).catch(err => {
                      console.error('Failed to copy:', err);
                    });
                  },
                  args: [jsonString]
                }).catch(err => {
                  console.error('Failed to copy to clipboard:', err);
                });
              }
              sendResponse({ received: true });
              return true;
            }
          };
          chrome.runtime.onMessage.addListener(listener);
          
          // Timeout after 10 seconds
          setTimeout(() => {
            chrome.runtime.onMessage.removeListener(listener);
          }, 10000);
        } catch (error) {
          console.error('Failed to copy text:', error);
        }
      }
    }
  } catch (error) {
    console.error('Context menu action failed:', error);
  }
});

