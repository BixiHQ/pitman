export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface HttpHeader {
  key: string;
  value: string;
  enabled: boolean;
}

export interface HttpParam {
  key: string;
  value: string;
  enabled: boolean;
}

export interface MultipartField {
  type: 'text' | 'file';
  key: string;
  value: string;
  filePath: string;
  enabled: boolean;
}

export type AuthConfig =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKey'; placement: 'header' | 'query'; key: string; value: string };

export type BodyConfig =
  | { type: 'none' }
  | { type: 'json'; value: string }
  | { type: 'text'; value: string }
  | { type: 'form'; fields: HttpParam[] }
  | { type: 'multipart'; fields: MultipartField[] };

export interface HttpRequest {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  params: HttpParam[];
  headers: HttpHeader[];
  auth: AuthConfig;
  body: BodyConfig;
  docs: string;
}

export interface HttpCollection {
  name: string;
  /** Logical env IDs associated with this collection. Undefined = all envs shown. */
  environments?: string[];
  requests: HttpRequest[];
}

export interface HttpEnvironment {
  name: string;
  variables: Record<string, string>;
}

export interface PitmanSettings {
  defaultCollection: string;
  defaultEnvironment: string;
  timeoutMs: number;
  followRedirects: boolean;
  verifyTls: boolean;
  historyBodyPreviewLimit: number;
  redactHeaders: string[];
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
  sizeBytes: number;
  requestHeaders: Record<string, string>;
  /** Fully resolved URL that was actually sent (variables substituted). */
  resolvedUrl: string;
}

export interface HistoryEntry {
  id: string;
  timestamp: string;
  collectionId: string;
  requestId: string;
  environmentId: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  status: number;
  statusText: string;
  durationMs: number;
  sizeBytes: number;
  responseHeaders: Record<string, string>;
  responseBodyPreview: string;
  error?: string;
}

/** Raw per-environment data for the Environment Manager (public + private split). */
export interface RawEnvironmentData {
  publicName: string;
  publicVars: Record<string, string>;
  privateVars: Record<string, string>;
  hasPrivateFile: boolean;
}
