# Content Collector - Your Smart Assistant

A Microsoft Edge extension that allows you to scrape text content from web pages and save it to a local JSON file in a structured, LLM-friendly format.

## Features

- **File Selection**: Choose a local JSON file where scraped content will be stored
- **Persistent Storage**: File selection is remembered across browser sessions
- **Text Scraping**: Extract all visible text from any webpage with a single click
- **Structured JSON Format**: Content is stored with URLs as keys and scraped text as values
- **Automatic Appending**: New content is added to existing JSON without overwriting previous data

## Installation

1. Clone or download this repository
2. Open Microsoft Edge
3. Navigate to `edge://extensions/`
4. Enable "Developer mode" (toggle in the bottom left)
5. Click "Load unpacked"
6. Select the folder containing this extension

**Note**: You'll need to add icon files (`icon16.png`, `icon48.png`, `icon128.png`) to the `icons/` folder for the extension to load properly.

## Usage

1. **Select a JSON File**:
   - Click the extension icon in the toolbar
   - Click "Select JSON File"
   - Choose or create a JSON file on your computer
   - The selected file name will be displayed

2. **Scrape Content**:
   - Navigate to any webpage you want to scrape
   - Click the extension icon
   - Click "Scrape Current Tab"
   - The extension will extract all visible text and append it to your JSON file

3. **JSON Format**:
   The scraped content is stored in the following format:
   ```json
   {
     "https://example.com/page1": "scraped text content...",
     "https://example.com/page2": "scraped text content...",
     ...
   }
   ```

## Technical Details

- **Manifest Version**: 3
- **File System Access**: Uses the File System Access API (requires Microsoft Edge or Chromium-based browsers)
- **Storage**: File handles stored in IndexedDB, metadata in chrome.storage.local
- **Permissions**: Requires `storage`, `activeTab`, `scripting`, and host permissions

## Limitations

- File System Access API is only available in Chromium-based browsers (Edge, Chrome)
- Cannot scrape browser internal pages (chrome://, edge://, etc.)
- Requires user interaction to select files (security requirement)

## Error Handling

The extension handles various error scenarios:
- File not selected
- Invalid or moved/deleted files
- File access permission issues
- Content script injection failures
- Invalid JSON in target file (auto-recovered)

## Browser Compatibility

- Microsoft Edge (recommended)
- Google Chrome
- Other Chromium-based browsers with File System Access API support

