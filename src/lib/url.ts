const base = import.meta.env.BASE_URL.replace(/\/$/, "");

export function siteLink(path: string): string {
  if (!path.startsWith("/")) path = `/${path}`;
  return `${base}${path}`;
}

const SITE_ORIGIN = "https://satory074.github.io";

/** base path 込みの絶対 URL（RSS / OGP など host が必須の場面で使う）。 */
export function absUrl(path: string): string {
  return `${SITE_ORIGIN}${siteLink(path)}`;
}
