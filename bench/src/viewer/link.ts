export interface ViewerLink {
  /** `http(s)://host:port`, no path. */
  origin: string;
  token: string;
}

/**
 * Finds the first URL in a tool answer that has a non-empty `token` query parameter, whatever its
 * path (VIEWER-PROTOCOL fixes only /stream and /ws; Tapline serves the page at /viewer, Tapwright
 * at /). Null when there is none.
 */
export function parseViewerLink(text: string): ViewerLink | null {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const token = url.searchParams.get("token");
    if (token) return { origin: url.origin, token };
  }
  return null;
}

/** Replaces every `token=<value>` and, when known, the bare token, so nothing secret is printed or written. */
export function redactToken(text: string, token?: string): string {
  let out = text.replace(/token=[^&\s"'<>)\]]+/gi, "token=<hidden>");
  if (token) out = out.split(token).join("<hidden>");
  return out;
}
