/** Builds every public URL. Never concatenate hostnames elsewhere. */
export class PublicUrlService {
  private readonly app: URL;
  private readonly api: URL;
  private readonly cdn: URL;

  constructor(opts: { appUrl: string; apiUrl: string; cdnUrl: string }) {
    this.app = PublicUrlService.normalize(opts.appUrl);
    this.api = PublicUrlService.normalize(opts.apiUrl);
    this.cdn = PublicUrlService.normalize(opts.cdnUrl);
  }

  private static normalize(u: string) {
    const url = new URL(u);
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url;
  }

  private static join(base: URL, path: string, query?: Record<string, string>) {
    const clean = path.replace(/^\/+/, "");
    const url = new URL(clean, base);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    return url.toString();
  }

  appUrl(path = "", query?: Record<string, string>) {
    return PublicUrlService.join(this.app, path, query);
  }
  apiUrl(path = "", query?: Record<string, string>) {
    return PublicUrlService.join(this.api, path, query);
  }
  cdnUrl(path = "", query?: Record<string, string>) {
    return PublicUrlService.join(this.cdn, path, query);
  }
  assetUrl(assetId: string, variant?: string) {
    return this.cdnUrl(`a/${encodeURIComponent(assetId)}`, variant ? { v: variant } : undefined);
  }
  passwordResetUrl(token: string) {
    return this.appUrl("reset-password", { token });
  }
  inviteUrl(token: string) {
    return this.appUrl("invite", { token });
  }
  get appOrigin() {
    return this.app.origin;
  }
}
