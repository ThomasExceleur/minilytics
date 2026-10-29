/**
 * Bots that the user agent check misses: they look like a normal Chrome but either fake a referrer
 * (referral spam) or run from a hosting provider rather than a home or office connection.
 */

// Domains that send fake visits to show up in referrer reports. Add new ones here.
const SPAM_REFERRERS = ['aocr.org'];

// Hosting and cloud providers (autonomous system numbers, as Cloudflare reports them in request.cf.asn).
// Cloudflare (13335), Akamai and Fastly are left out: iCloud Private Relay and WARP users browse through them.
const DATACENTER_ASNS = new Set([
  16509, 14618, // Amazon AWS
  15169, 396982, // Google, Google Cloud
  8075, // Microsoft Azure
  14061, // DigitalOcean
  63949, // Akamai Connected Cloud (Linode)
  20473, // Vultr
  24940, // Hetzner
  16276, // OVH
  12876, // Scaleway
  51167, // Contabo
  31898, // Oracle Cloud
  45102, // Alibaba Cloud
  132203, // Tencent Cloud
  136907, // Huawei Cloud
  60781, 28753, // Leaseweb
  9009, // M247
  212238, // Datacamp (CDN77)
]);

/** Is the referrer one of the known referral-spam domains (or a subdomain of one)? */
export function isSpamReferrer(referrer: string | undefined | null): boolean {
  if (!referrer) return false;
  let host: string;
  try {
    host = new URL(referrer).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return false;
  }
  return SPAM_REFERRERS.some((d) => host === d || host.endsWith('.' + d));
}

/** Does the request come from a hosting provider? Real visitors browse from home, office or mobile networks. */
export function isDatacenter(asn: unknown): boolean {
  return typeof asn === 'number' && DATACENTER_ASNS.has(asn);
}
