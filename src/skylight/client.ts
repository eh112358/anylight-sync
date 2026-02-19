// HTTP client for the Skylight API.
// Handles authentication (login + token caching), automatic re-login on 401,
// and wraps fetch with consistent error handling and logging.

import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const BASE_URL = 'https://app.ourskylight.com';

export class SkylightClient {
  private token: string | null = null;
  private userId: string | null = null;

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly frameId: string
  ) {}

  // --- Authentication ---

  async login(): Promise<void> {
    logger.info('Logging in to Skylight');

    const response = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });

    if (!response.ok) {
      throw new Error(`Skylight login failed with status ${response.status}. Check SKYLIGHT_EMAIL and SKYLIGHT_PASSWORD.`);
    }

    const body = await response.json() as {
      data: { id: string; attributes: { token: string } };
    };

    this.userId = body.data.id;
    this.token = body.data.attributes.token;
    logger.info('Skylight login successful', { userId: this.userId });
  }

  private getAuthHeader(): string {
    if (!this.userId || !this.token) {
      throw new Error('Skylight client is not logged in. Call login() first.');
    }
    const encoded = Buffer.from(`${this.userId}:${this.token}`).toString('base64');
    return `Basic ${encoded}`;
  }

  // --- Core request method ---

  // Makes an authenticated request. On 401, re-logs in once and retries.
  // The {frameId} placeholder in path strings is replaced automatically.
  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    if (!this.token) {
      await this.login();
    }

    const url = `${BASE_URL}${path.replace('{frameId}', this.frameId)}`;

    logger.debug('Skylight API request', { method: options.method ?? 'GET', url });

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.getAuthHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });

    // If the token expired, log in again and retry once
    if (response.status === 401) {
      logger.warn('Skylight returned 401 — re-authenticating');
      this.token = null;
      await this.login();
      return this.request<T>(path, options);
    }

    // 204 No Content (e.g. successful DELETE) has no body to parse
    if (response.status === 204) {
      return undefined as unknown as T;
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(could not read error body)');
      throw new Error(`Skylight API error: ${response.status} ${options.method ?? 'GET'} ${url} — ${errorBody}`);
    }

    return response.json() as Promise<T>;
  }

  // --- Convenience methods ---

  get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const fullPath = params ? `${path}?${new URLSearchParams(params)}` : path;
    return withRetry(
      () => this.request<T>(fullPath, { method: 'GET' }),
      { operationName: `GET ${path}` }
    );
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return withRetry(
      () => this.request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
      { operationName: `POST ${path}`, maxAttempts: 2 }
    );
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return withRetry(
      () => this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
      { operationName: `PUT ${path}`, maxAttempts: 2 }
    );
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return withRetry(
      () => this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
      { operationName: `PATCH ${path}`, maxAttempts: 2 }
    );
  }

  delete(path: string): Promise<void> {
    return withRetry(
      () => this.request<void>(path, { method: 'DELETE' }),
      { operationName: `DELETE ${path}`, maxAttempts: 2 }
    );
  }
}
