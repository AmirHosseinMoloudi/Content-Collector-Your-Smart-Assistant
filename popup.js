// Popup script for Content Collector extension

document.addEventListener('DOMContentLoaded', async () => {
  const selectFileBtn = document.getElementById('selectFileBtn');
  const scrapeBtn = document.getElementById('scrapeBtn');
  const copyToClipboardBtn = document.getElementById('copyToClipboardBtn');
  const fileInfo = document.getElementById('fileInfo');
  const status = document.getElementById('status');

  // Load and display current file selection
  await loadFileInfo();

  // Set up persistent listener for context menu actions
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'contextMenuScrapeComplete') {
      // Handle scrape from context menu
      if (message.success && message.needsFileWrite && message.url && message.text) {
        showStatus('Saving to file (from right-click)...', 'info');
        (async () => {
          try {
            const fileHandle = await getFileHandleFromIndexedDB();
            if (!fileHandle) {
              showStatus('No file selected. Please select a file first.', 'error');
              return;
            }

            let hasWritePermission = false;
            if (fileHandle.queryPermission) {
              try {
                const permission = await fileHandle.queryPermission({ mode: 'readwrite' });
                hasWritePermission = permission === 'granted';
                
                if (!hasWritePermission && fileHandle.requestPermission) {
                  try {
                    const requestedPerm = await fileHandle.requestPermission({ mode: 'readwrite' });
                    hasWritePermission = requestedPerm === 'granted';
                  } catch (requestError) {
                    console.log('Permission request failed, will attempt write anyway:', requestError);
                  }
                }
              } catch (queryError) {
                console.log('Permission query failed, will attempt write anyway:', queryError);
              }
            } else {
              hasWritePermission = true;
            }

            await appendToFileInPopup(message.url, message.text, fileHandle);
            showStatus(`Saved! (from ${new URL(message.url).hostname})`, 'success');
          } catch (error) {
            console.error('File write error from context menu:', error);
            showStatus(`Error: ${error.message}`, 'error');
          }
        })();
      } else if (!message.success) {
        showStatus(`Error: ${message.error}`, 'error');
      }
      sendResponse({ received: true });
      return true;
    }
  });

  // File selection button handler
  selectFileBtn.addEventListener('click', async () => {
    try {
      if (!window.showOpenFilePicker || !window.showSaveFilePicker) {
        showStatus('File System Access API is not supported in this browser. Please use Microsoft Edge.', 'error');
        return;
      }

      // Use showSaveFilePicker instead of showOpenFilePicker to ensure write permission
      // According to MDN: showOpenFilePicker only grants read permission
      // showSaveFilePicker automatically grants write permission (required for Edge)
      // We'll suggest the previously selected filename if available
      let suggestedName = 'content-collector.json';
      
      // Try to get previously selected filename
      try {
        const storage = await chrome.storage.local.get(['selectedFileName']);
        if (storage.selectedFileName) {
          suggestedName = storage.selectedFileName;
        }
      } catch (e) {
        // Ignore errors, use default name
      }

      // STRATEGY: When selecting an existing file, we need to preserve its content
      // showSaveFilePicker might truncate existing files, so we use a two-step approach:
      // 1. Try to open the file first to read its content
      // 2. Then use showSaveFilePicker to get write permission
      let existingFileContent = null;
      
      // First, try to open the file to read existing content (if it exists)
      try {
        const openHandle = await window.showOpenFilePicker({
          types: [{
            description: 'JSON Files',
            accept: {
              'application/json': ['.json']
            }
          }],
          multiple: false
        });
        
        if (openHandle && openHandle.length > 0) {
          const file = await openHandle[0].getFile();
          if (file.size > 0) {
            existingFileContent = await file.text();
            console.log('Read existing file content during selection:', existingFileContent.length, 'chars');
          }
        }
      } catch (openError) {
        // File might not exist or user cancelled - that's fine
        console.log('Could not open file (might be new or cancelled):', openError);
      }

      // Now use showSaveFilePicker to get write permission
      // This ensures we have write access (required for Edge)
      const handle = await window.showSaveFilePicker({
        suggestedName: suggestedName,
        types: [{
          description: 'JSON Files',
          accept: {
            'application/json': ['.json']
          }
        }]
      });
      
      const fileName = handle.name;

      if (handle) {
        try {
          // If we read existing content, verify it's still there or restore it
          if (existingFileContent) {
            // Verify the file still has content after showSaveFilePicker
            try {
              const verifyFile = await handle.getFile();
              if (verifyFile.size === 0 || verifyFile.size < existingFileContent.length) {
                // File was truncated - we need to restore it immediately
                console.warn('File was truncated during selection, restoring content...');
                const writable = await handle.createWritable();
                await writable.write(existingFileContent);
                await writable.close();
                console.log('File content restored');
              }
            } catch (verifyError) {
              console.warn('Could not verify/restore file content:', verifyError);
            }
            
            // Show status with entry count
            try {
              const parsed = JSON.parse(existingFileContent);
              showStatus(`File selected: ${fileName} (${Object.keys(parsed).length} entries preserved)`, 'success');
            } catch (e) {
              showStatus(`File selected: ${fileName} (existing content preserved)`, 'success');
            }
          } else {
            showStatus(`File selected: ${fileName} (new file)`, 'success');
          }

          // Store file handle in IndexedDB directly (handles are not serializable via messages)
          // Using showSaveFilePicker ensures write permission is granted
          await storeFileHandleInIndexedDB(handle, fileName);

          // Store metadata in chrome.storage.local
          await chrome.storage.local.set({ selectedFileName: fileName });
          fileInfo.textContent = fileName;
          fileInfo.classList.remove('empty');
          scrapeBtn.disabled = false;
        } catch (error) {
          console.error('Error storing file handle:', error);
          showStatus(`Error storing file: ${error.message}`, 'error');
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        // User cancelled file selection
        return;
      }
      console.error('File selection error:', error);
      showStatus(`Error selecting file: ${error.message}`, 'error');
    }
  });

  // Copy to clipboard button handler
  copyToClipboardBtn.addEventListener('click', async () => {
    try {
      copyToClipboardBtn.disabled = true;
      showStatus('Copying text to clipboard...', 'info');

      // Get active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab) {
        throw new Error('No active tab found');
      }

      // Check if tab URL is accessible
      if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('chrome-extension://')) {
        throw new Error('Cannot copy text from browser internal pages');
      }

      // Inject content script and get text
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });

      if (!results || results.length === 0) {
        throw new Error('Failed to inject content script');
      }

      // Wait for content script to send message
      const scrapeResult = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Copy operation timed out'));
        }, 10000);

        chrome.runtime.onMessage.addListener(function listener(message, sender, sendResponse) {
          if (message.action === 'scrapedData' && sender.tab?.id === tab.id) {
            clearTimeout(timeout);
            chrome.runtime.onMessage.removeListener(listener);
            resolve(message);
          }
          return true;
        });
      });

      if (scrapeResult.success && scrapeResult.text && scrapeResult.url) {
        // Format as JSON: {"url":"content"}
        const jsonData = {
          [scrapeResult.url]: scrapeResult.text
        };
        const jsonString = JSON.stringify(jsonData, null, 2);
        
        // Copy to clipboard
        await navigator.clipboard.writeText(jsonString);
        showStatus(`Text copied to clipboard as JSON! (${scrapeResult.text.length} characters)`, 'success');
      } else {
        throw new Error(scrapeResult.error || 'Failed to extract text');
      }
    } catch (error) {
      console.error('Copy error:', error);
      showStatus(`Error: ${error.message}`, 'error');
    } finally {
      copyToClipboardBtn.disabled = false;
    }
  });

  // Scrape button handler
  scrapeBtn.addEventListener('click', async () => {
    try {
      scrapeBtn.disabled = true;
      showStatus('Scraping tab...', 'info');

      // Get active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab) {
        throw new Error('No active tab found');
      }

      // Check if tab URL is accessible (chrome://, edge://, etc. cannot be scraped)
      if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('chrome-extension://')) {
        throw new Error('Cannot scrape from browser internal pages');
      }

      // Wait for background script to process and return result
      // The background script will set up listener, inject content script, and handle file writing
      const scrapeResult = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Scraping operation timed out'));
        }, 15000);

        // Listen for response from background script
        chrome.runtime.onMessage.addListener(function listener(message, sender, sendResponse) {
          if (message.action === 'scrapeComplete') {
            clearTimeout(timeout);
            chrome.runtime.onMessage.removeListener(listener);
            resolve(message);
          }
          return true; // Keep channel open for async response
        });

        // Trigger scraping via background script - it will handle injection
        chrome.runtime.sendMessage({
          action: 'scrapeCurrentTab',
          tabId: tab.id
        }).catch(reject);
      });

      if (scrapeResult.success) {
        // If file write is needed, do it in popup context where file handle has permissions
        if (scrapeResult.needsFileWrite && scrapeResult.url && scrapeResult.text) {
          showStatus('Saving to file...', 'info');
          try {
            // Get file handle immediately while we're still in user gesture context
            const fileHandle = await getFileHandleFromIndexedDB();
            if (!fileHandle) {
              throw new Error('No file selected. Please select a file first.');
            }

            // Check and request permission if needed
            // Edge may require explicit permission for write operations
            let hasWritePermission = false;
            if (fileHandle.queryPermission) {
              try {
                const permission = await fileHandle.queryPermission({ mode: 'readwrite' });
                hasWritePermission = permission === 'granted';
                
                // If not granted, try to request it
                if (!hasWritePermission && fileHandle.requestPermission) {
                  try {
                    const requestedPerm = await fileHandle.requestPermission({ mode: 'readwrite' });
                    hasWritePermission = requestedPerm === 'granted';
                  } catch (requestError) {
                    // Permission request might fail - we'll try to write anyway
                    // Some browsers grant permission implicitly on first write attempt
                    console.log('Permission request failed, will attempt write anyway:', requestError);
                  }
                }
              } catch (queryError) {
                // queryPermission might not be available - try write anyway
                console.log('Permission query failed, will attempt write anyway:', queryError);
              }
            } else {
              // queryPermission not available - assume we can try writing
              hasWritePermission = true;
            }

            // Note: Even if permission check fails, we'll attempt the write
            // Some browsers grant permission implicitly on the first write

            // Now append to file
            await appendToFileInPopup(scrapeResult.url, scrapeResult.text, fileHandle);
            showStatus(`Successfully scraped and saved content from ${new URL(scrapeResult.url).hostname}`, 'success');
          } catch (error) {
            console.error('File write error:', error);
            // Check if it's a permission/user agent error that requires re-selecting the file
            if (error.message && (
              error.message.includes('not allowed') || 
              error.message.includes('user agent') ||
              error.message.includes('platform') ||
              error.name === 'NotAllowedError'
            )) {
              // The file handle may have lost its user gesture context
              // Suggest user to re-select the file
              showStatus('File handle expired. Please click "Select JSON File" again, then try scraping.', 'error');
              // Optionally, we could automatically trigger file selection here
              // but that requires another user gesture, so we'll just inform the user
            } else {
              showStatus(`Error saving to file: ${error.message}`, 'error');
            }
          }
        } else {
          showStatus(`Successfully scraped and saved content from ${new URL(scrapeResult.url).hostname}`, 'success');
        }
      } else {
        showStatus(`Error: ${scrapeResult.error}`, 'error');
      }
    } catch (error) {
      console.error('Scraping error:', error);
      showStatus(`Error: ${error.message}`, 'error');
    } finally {
      scrapeBtn.disabled = false;
    }
  });

  // Store file handle in IndexedDB
  async function storeFileHandleInIndexedDB(fileHandle, fileName) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ContentCollectorDB', 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        
        // Create object store if it doesn't exist
        if (!db.objectStoreNames.contains('fileHandles')) {
          db.close();
          const upgradeRequest = indexedDB.open('ContentCollectorDB', 1);
          upgradeRequest.onupgradeneeded = (event) => {
            const upgradeDb = event.target.result;
            upgradeDb.createObjectStore('fileHandles', { keyPath: 'id' });
          };
          upgradeRequest.onsuccess = () => {
            const upgradeDb = upgradeRequest.result;
            const transaction = upgradeDb.transaction(['fileHandles'], 'readwrite');
            const store = transaction.objectStore('fileHandles');
            const data = {
              id: 'currentFileHandle',
              fileHandle: fileHandle,
              fileName: fileName
            };
            const putRequest = store.put(data);
            putRequest.onsuccess = () => resolve();
            putRequest.onerror = () => reject(putRequest.error);
          };
        } else {
          const transaction = db.transaction(['fileHandles'], 'readwrite');
          const store = transaction.objectStore('fileHandles');
          const data = {
            id: 'currentFileHandle',
            fileHandle: fileHandle,
            fileName: fileName
          };
          const putRequest = store.put(data);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        }
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('fileHandles')) {
          db.createObjectStore('fileHandles', { keyPath: 'id' });
        }
      };
    });
  }

  // Load file information from storage
  async function loadFileInfo() {
    try {
      const result = await chrome.storage.local.get(['selectedFileName']);
      if (result.selectedFileName) {
        // Verify file handle still exists in IndexedDB
        // Don't validate accessibility here - file handles can be valid but not immediately accessible
        // We'll validate when actually trying to use it
        const handleExists = await verifyFileHandleExists();
        if (handleExists) {
          // Just check that the handle exists in IndexedDB
          // Don't try to access it here - that might fail due to timing/permissions
          // The handle will be validated when we actually try to use it for writing
          fileInfo.textContent = result.selectedFileName;
          fileInfo.classList.remove('empty');
          scrapeBtn.disabled = false;
        } else {
          // Handle doesn't exist in IndexedDB, clear the stored file name
          await chrome.storage.local.remove(['selectedFileName']);
          fileInfo.textContent = 'No file selected';
          fileInfo.classList.add('empty');
          scrapeBtn.disabled = true;
        }
      }
    } catch (error) {
      console.error('Error loading file info:', error);
      // Don't clear the handle on error - it might still be valid
    }
  }

  // Clear file handle from IndexedDB
  async function clearFileHandleFromIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ContentCollectorDB', 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('fileHandles')) {
          resolve();
          return;
        }
        
        const transaction = db.transaction(['fileHandles'], 'readwrite');
        const store = transaction.objectStore('fileHandles');
        const deleteRequest = store.delete('currentFileHandle');
        
        deleteRequest.onsuccess = () => resolve();
        deleteRequest.onerror = () => reject(deleteRequest.error);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('fileHandles')) {
          db.createObjectStore('fileHandles', { keyPath: 'id' });
        }
      };
    });
  }

  // Append URL and text to JSON file (in popup context where file handle has permissions)
  // fileHandle parameter is optional - if not provided, will retrieve from IndexedDB
  async function appendToFileInPopup(url, text, fileHandle = null) {
    try {
      // Retrieve file handle from IndexedDB if not provided
      if (!fileHandle) {
        fileHandle = await getFileHandleFromIndexedDB();
        if (!fileHandle) {
          throw new Error('No file selected. Please select a file first.');
        }
      }

      // Read existing content and "activate" the handle by calling getFile()
      // CRITICAL: When using showSaveFilePicker on an existing file, we MUST read the file
      // BEFORE creating a writable stream, otherwise the file will be truncated/overwritten
      // The file handle from showSaveFilePicker might point to an empty file if not read first
      // IMPORTANT: In Edge, file handles must be used in the same synchronous execution context
      // after retrieval to maintain user gesture context. Do not add delays between operations.
      let existingContent = '{}';
      let file;
      
      // CRITICAL: Read the file FIRST to preserve existing content
      // This is essential - without reading first, showSaveFilePicker may have truncated the file
      console.log('Reading existing file content before writing...');
      try {
        // Get the file - this reads the current state of the file
        file = await fileHandle.getFile();
        console.log('File retrieved, size:', file.size, 'bytes');
        
        // Check file size - if it's 0 bytes, file is empty or newly created
        if (file.size > 0) {
          // File has content - read it to preserve it
          existingContent = await file.text();
          console.log('Read existing content, length:', existingContent.length, 'characters');
          
          // Validate JSON (allow empty file)
          if (existingContent.trim()) {
            try {
              const parsed = JSON.parse(existingContent);
              console.log('Existing JSON is valid, has', Object.keys(parsed).length, 'entries');
            } catch (parseError) {
              // Invalid JSON - log warning but continue with existing content
              console.warn('File contains invalid JSON, will try to preserve:', parseError);
              // Don't clear existingContent - try to use it anyway or merge what we can
              if (!(parseError instanceof SyntaxError)) {
                // Non-syntax error - might be more serious
                console.error('Serious JSON parse error:', parseError);
                existingContent = '{}';
              }
              // For syntax errors, we'll try to merge with the existing content
            }
          }
        } else {
          // File is empty (new file or was cleared)
          console.log('File is empty (0 bytes)');
          existingContent = '{}';
        }
      } catch (error) {
        // Check if it's a permission/access error - this means handle is invalid
        if (error.name === 'NotAllowedError' || 
            error.name === 'NotFoundError' ||
            (error.message && error.message.toLowerCase().includes('permission'))) {
          // Handle is invalid - clear it and ask user to re-select
          console.error('File handle is invalid:', error);
          await chrome.storage.local.remove(['selectedFileName']);
          await clearFileHandleFromIndexedDB().catch(() => {});
          throw new Error('File access permission lost. Please select the file again from the extension popup.');
        }
        
        // For other errors (like network issues, etc.), try to continue with empty content
        console.warn('Error reading file, will start with empty content:', error);
        existingContent = '{}';
      }

      // Parse and update JSON
      const data = existingContent.trim() ? JSON.parse(existingContent) : {};
      data[url] = text;
      const updatedContent = JSON.stringify(data, null, 2);

      // CRITICAL: Create writable stream IMMEDIATELY without any async gaps
      // Edge requires createWritable() to be called in the same user gesture context
      // Note: Permission may be granted implicitly on first write attempt in some browsers
      try {
        // Attempt to create writable - this will fail if permission is denied
        // but we've already checked/requested permission above
        const writable = await fileHandle.createWritable();
        
        if (!writable) {
          throw new Error('Failed to create writable stream');
        }
        
        await writable.write(updatedContent);
        await writable.close();
      } catch (writeError) {
        // More specific error handling for write operations
        if (writeError.name === 'NotAllowedError' || 
            writeError.message && writeError.message.includes('not allowed') ||
            writeError.message && writeError.message.includes('user agent') ||
            writeError.message && writeError.message.includes('platform') ||
            writeError.message && writeError.message.includes('current context')) {
          // This is the Edge-specific permission denied error
          // The file handle has lost its user gesture context or permission was never granted
          throw new Error('File write failed due to Edge security restrictions. Please click "Select JSON File" again to refresh the file handle, then try scraping.');
        }
        throw writeError;
      }
    } catch (error) {
      console.error('Error appending to file:', error);
      throw error;
    }
  }

  // Retrieve file handle from IndexedDB
  async function getFileHandleFromIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ContentCollectorDB', 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('fileHandles')) {
          resolve(null);
          return;
        }
        
        const transaction = db.transaction(['fileHandles'], 'readonly');
        const store = transaction.objectStore('fileHandles');
        const getRequest = store.get('currentFileHandle');
        
        getRequest.onsuccess = () => {
          if (getRequest.result) {
            resolve(getRequest.result.fileHandle);
          } else {
            resolve(null);
          }
        };
        getRequest.onerror = () => reject(getRequest.error);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('fileHandles')) {
          db.createObjectStore('fileHandles', { keyPath: 'id' });
        }
      };
    });
  }

  // Verify file handle exists in IndexedDB
  async function verifyFileHandleExists() {
    return new Promise((resolve) => {
      const request = indexedDB.open('ContentCollectorDB', 1);
      
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('fileHandles')) {
          resolve(false);
          return;
        }
        
        const transaction = db.transaction(['fileHandles'], 'readonly');
        const store = transaction.objectStore('fileHandles');
        const getRequest = store.get('currentFileHandle');
        
        getRequest.onsuccess = () => {
          resolve(!!getRequest.result);
        };
        getRequest.onerror = () => resolve(false);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('fileHandles')) {
          db.createObjectStore('fileHandles', { keyPath: 'id' });
        }
      };
    });
  }

  // Show status message
  function showStatus(message, type) {
    status.textContent = message;
    status.className = `status ${type}`;
    
    // Auto-hide success messages after 3 seconds
    if (type === 'success') {
      setTimeout(() => {
        status.className = 'status';
        status.textContent = '';
      }, 3000);
    }
  }
});

