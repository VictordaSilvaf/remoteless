export function trustedFrameUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'msm:' && url.hostname === 'app' && !url.username && !url.password && !url.port;
  } catch { return false; }
}
