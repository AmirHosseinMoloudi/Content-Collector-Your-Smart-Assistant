// Content script for extracting text from web pages

(function() {
  'use strict';

  try {
    // Extract text from the page body
    // Using innerText to get visible text while excluding script and style elements
    const extractedText = document.body.innerText || document.body.textContent || '';

    // Clean up the text: remove excessive whitespace while preserving paragraph breaks
    const cleanedText = extractedText
      .replace(/\s+/g, ' ')  // Replace multiple spaces with single space
      .replace(/\n\s*\n\s*\n/g, '\n\n')  // Replace multiple newlines with double newline
      .trim();

    // Get the current page URL
    const url = window.location.href;

    // Send data back to background script
    chrome.runtime.sendMessage({
      action: 'scrapedData',
      success: true,
      url: url,
      text: cleanedText
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Error sending scraped data:', chrome.runtime.lastError);
      }
    });

  } catch (error) {
    console.error('Error extracting text:', error);
    chrome.runtime.sendMessage({
      action: 'scrapedData',
      success: false,
      error: error.message
    });
  }
})();

