export interface PicoAdminOptions {
  url?: string;
  token: string;
}

export interface CreateTokenRequest {
  namespaces?: string[];
  read_patterns?: string[];
  write_patterns?: string[];
  manage_tokens?: boolean;
  create_namespaces?: boolean;
  admin?: boolean;
  persist?: boolean;
  view_stores?: boolean;
  reads_per_sec?: number;
  writes_per_sec?: number;
  max_tokens?: number;
  max_namespaces?: number;
}

export interface TokenSummary {
  id: number;
  token: string;
  namespaces: string[];
  read_patterns: string[];
  write_patterns: string[];
  manage_tokens: boolean;
  create_namespaces: boolean;
  admin: boolean;
  persist: boolean;
  view_stores: boolean;
  reads_per_sec?: number;
  writes_per_sec?: number;
  max_tokens?: number;
  max_namespaces?: number;
}

export interface TokenPage {
  tokens: TokenSummary[];
  next_after?: number;
}

export interface ListTokensParams {
  after?: number;
  limit?: number;
}

export interface CreateNamespaceRequest {
  persist: boolean;
}

export class PicoAdmin {
  private _url: string;
  private _token: string;

  constructor(options: PicoAdminOptions) {
    this._url = (options.url ?? "http://127.0.0.1:6001").replace(/\/+$/, "");
    this._token = options.token;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this._url}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${this._token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`${res.status}: ${await res.text()}`);
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return res.json() as Promise<T>;
  }

  async createToken(request: CreateTokenRequest): Promise<TokenSummary> {
    return this.request("/api/tokens", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async listTokensPage(params: ListTokensParams = {}): Promise<TokenPage> {
    const q = new URLSearchParams();
    if (params.after !== undefined) q.set("after", String(params.after));
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    const qs = q.toString();
    return this.request(`/api/tokens${qs ? `?${qs}` : ""}`);
  }

  async listTokens(): Promise<TokenSummary[]> {
    const all: TokenSummary[] = [];
    let after: number | undefined;
    while (true) {
      const page = await this.listTokensPage({ after, limit: 200 });
      all.push(...page.tokens);
      if (page.next_after === undefined || page.next_after === null) break;
      after = page.next_after;
    }
    return all;
  }

  async listStores(namespace: string): Promise<string[]> {
    return this.request(`/api/stores/${namespace}`);
  }

  async revokeToken(id: number): Promise<void> {
    await this.request<void>(`/api/tokens/${id}`, { method: "DELETE" });
  }

  async createNamespace(namespace: string, request: CreateNamespaceRequest): Promise<void> {
    await this.request<void>(`/api/namespaces/${namespace}`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async deleteNamespace(namespace: string): Promise<void> {
    await this.request<void>(`/api/namespaces/${namespace}`, { method: "DELETE" });
  }
}
