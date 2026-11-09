/** CLI diagnostics may print a Studio launch URL. Only open_editor returns credentials. */
export function redactLaunchUrls(text) {
  return text.replace(/https?:\/\/[^\s<>"']+/g, (value) => {
    try {
      const url = new URL(value);
      if (url.searchParams.has('key') || new URLSearchParams(url.hash.slice(1)).has('harness')) {
        return `${url.origin}${url.pathname} [private launch URL omitted]`;
      }
    } catch {}
    return value;
  });
}
