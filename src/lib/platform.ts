/** Running in the Android build's webview. */
export const isAndroid = typeof navigator !== 'undefined' && /\bAndroid\b/.test(navigator.userAgent)
