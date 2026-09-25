/**
 * Saves generated content via a temporary object URL and <a download>.
 * Requires no "downloads" permission; the browser shows its normal save flow.
 */
export function downloadText(filename: string, content: string, mime = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(0, 80) || 'export';
}

export function openInTab(url: string): void {
  void chrome.tabs.create({ url });
}
