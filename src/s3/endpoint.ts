export interface ParsedEndpoint {
  scheme: string;
  /** Host, plus the port when it isn't the scheme's default. */
  host: string;
  /** Any path in the endpoint URL, without a trailing slash (usually ""). */
  basePath: string;
}

/**
 * Parses the endpoint by hand, the same way on every platform. A bare host
 * ("s3.example.com") is treated as HTTPS, as on the Mac.
 */
export function parseEndpoint(raw: string): ParsedEndpoint | null {
  let value = raw.trim();
  if (!value) return null;
  if (!value.includes('://')) value = `https://${value}`;
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)([^?#]*)/i.exec(value);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  let host = match[2].toLowerCase();
  if ((scheme === 'https' && host.endsWith(':443')) || (scheme === 'http' && host.endsWith(':80'))) {
    host = host.slice(0, host.lastIndexOf(':'));
  }
  const basePath = match[3].replace(/\/+$/, '');
  return { scheme, host, basePath };
}
