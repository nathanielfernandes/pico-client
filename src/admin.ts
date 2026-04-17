export interface PicoAdminOptions {
  url?: string;
  token: string;
}

export interface CreateTokenRequest {
  namespace: string;
  read_pattern?: string;
  write_pattern?: string;
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
  namespace: string;
  manage_tokens: boolean;
  create_namespaces: boolean;
  admin: boolean;
  persist: boolean;
  view_stores: boolean;
  read_pattern?: string;
  write_pattern?: string;
  reads_per_sec?: number;
  writes_per_sec?: number;
  max_tokens?: number;
  max_namespaces?: number;
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

  async createToken(request: CreateTokenRequest): Promise<TokenSummary> {
    const res = await fetch(`${this._url}/api/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this._token}`,
      },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      throw new Error(`${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  async listTokens(): Promise<TokenSummary[]> {
    const res = await fetch(`${this._url}/api/tokens`, {
      headers: {
        Authorization: `Bearer ${this._token}`,
      },
    });
    if (!res.ok) {
      throw new Error(`${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  async listStores(namespace: string): Promise<string[]> {
    const res = await fetch(`${this._url}/api/stores/${namespace}`, {
      headers: {
        Authorization: `Bearer ${this._token}`,
      },
    });
    if (!res.ok) {
      throw new Error(`${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  async revokeToken(id: number): Promise<void> {
    const res = await fetch(`${this._url}/api/tokens/${id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this._token}`,
      },
    });
    if (!res.ok) {
      throw new Error(`${res.status}: ${await res.text()}`);
    }
  }

  async createNamespace(namespace: string, request: CreateNamespaceRequest): Promise<void> {
    const res = await fetch(`${this._url}/api/namespaces/${namespace}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this._token}`,
      },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      throw new Error(`${res.status}: ${await res.text()}`);
    }
  }

  async deleteNamespace(namespace: string): Promise<void> {
    const res = await fetch(`${this._url}/api/namespaces/${namespace}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this._token}`,
      },
    });
    if (!res.ok) {
      throw new Error(`${res.status}: ${await res.text()}`);
    }
  }
}
