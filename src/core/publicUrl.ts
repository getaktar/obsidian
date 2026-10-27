/**
 * Separated from uploading: publicURL = publicBaseURL + objectKey.
 * The S3 upload endpoint and the public serving URL are never assumed to be the same host.
 */

// Characters Foundation's `urlPathAllowed` leaves alone, so links match the Mac app's byte for byte.
const PATH_ALLOWED = /%(21|24|26|27|28|29|2A|2B|2C|3A|3B|3D|40)/gi;

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(PATH_ALLOWED, (match) => decodeURIComponent(match));
}

/**
 * Users commonly enter a bare domain (e.g. "img.example.com") without a
 * scheme. Assume HTTPS in that case, since a schemeless URL can't be loaded.
 */
export function normalizeBaseURL(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('://')) return trimmed;
  return `https://${trimmed}`;
}

export function resolvePublicURL(baseURL: string, objectKey: string): string {
  let base = normalizeBaseURL(baseURL);
  if (base.endsWith('/')) base = base.slice(0, -1);
  const encodedKey = objectKey.split('/').map(encodePathSegment).join('/');
  return `${base}/${encodedKey}`;
}

/** Records saved with a schemeless base URL are treated as HTTPS. */
export function openableURL(urlString: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(urlString) ? urlString : `https://${urlString}`;
}

export function displayURL(urlString: string): string {
  return urlString.replace('https://', '').replace('http://', '');
}

/** The host of an http(s) address (a bare domain counts, as https), lowercased, without a port; null when there's none. */
function httpHost(raw: string): string | null {
  const authority = /^https?:\/\/([^/?#]+)/i.exec(normalizeBaseURL(raw))?.[1];
  if (!authority) return null;
  const host = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase();
  const bare = host.startsWith('[') ? host.slice(1, host.indexOf(']') === -1 ? undefined : host.indexOf(']')) : host.replace(/:\d*$/, '');
  return bare || null;
}

const PROVIDER_DOMAINS = ['r2.dev', 'amazonaws.com', 'backblazeb2.com', 'digitaloceanspaces.com'];

/**
 * The host of `baseURL` when it's a domain of the user's own, not one the
 * provider made: the endpoint's host (or a bucket under it), r2.dev, or an
 * S3, Backblaze or DigitalOcean bucket host. Null otherwise. Same rule as
 * the Mac app.
 */
export function ownDomainHost(baseURL: string, endpoint: string): string | null {
  if (!baseURL.trim()) return null;
  const host = httpHost(baseURL);
  if (!host) return null;
  const providerHosts = [...PROVIDER_DOMAINS];
  const endpointHost = endpoint.trim() ? httpHost(endpoint) : null;
  if (endpointHost) providerHosts.push(endpointHost);
  return providerHosts.some((provider) => host === provider || host.endsWith(`.${provider}`)) ? null : host;
}
