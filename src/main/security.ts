import { pathToFileURL } from 'node:url';
export function trustedRendererURL(url: string, rendererFile: string, devURL?: string) {
  try {
    if (devURL) return new URL(url).origin === new URL(devURL).origin;
    return url === pathToFileURL(rendererFile).href;
  } catch {
    return false;
  }
}

/** A response header also constrains the renderer's static meta policy. */
export function rendererCSP(development: boolean): string {
  return (
    "default-src 'none'; script-src 'self'; style-src 'self'" +
    (development ? " 'nonce-ensemble-development-style'" : '') +
    "; img-src 'self' data:; " +
    "font-src 'self'; connect-src 'self'" +
    (development ? ' ws://localhost:* ws://127.0.0.1:*' : '') +
    "; base-uri 'none'; form-action 'none'; object-src 'none'"
  );
}
