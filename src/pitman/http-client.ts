import * as fs from 'fs';
import * as path from 'path';
import { fetch as undiciFetch, Agent, FormData } from 'undici';
import type { HttpRequest, HttpResponse, PitmanSettings } from './schemas';
import { resolveVariables } from './variables';

// Agents are intentionally module-level singletons. Creating a new Agent per
// request causes V8 to GC it while the response body stream is still open,
// which terminates the socket mid-read and throws "terminated".
const agentVerifyTls = new Agent({ connect: { rejectUnauthorized: true } });
const agentSkipTls = new Agent({ connect: { rejectUnauthorized: false } });

function resolve(input: string, vars: Record<string, string>): string {
  return resolveVariables(input, vars);
}

export async function sendHttpRequest(
  request: HttpRequest,
  environmentVariables: Record<string, string>,
  settings: PitmanSettings,
): Promise<HttpResponse> {
  const vars = environmentVariables;

  // Resolve all variables in the URL first, then append query params.
  let resolvedUrl = resolve(request.url, vars);

  const enabledParams = request.params.filter(p => p.enabled && p.key);
  if (enabledParams.length > 0) {
    const qs = enabledParams
      .map(
        p =>
          `${encodeURIComponent(resolve(p.key, vars))}=${encodeURIComponent(resolve(p.value, vars))}`,
      )
      .join('&');
    resolvedUrl += (resolvedUrl.includes('?') ? '&' : '?') + qs;
  }

  const headers: Record<string, string> = {};
  for (const h of request.headers) {
    if (h.enabled && h.key) {
      headers[resolve(h.key, vars)] = resolve(h.value, vars);
    }
  }

  const auth = request.auth;
  if (auth.type === 'bearer') {
    headers['Authorization'] = `Bearer ${resolve(auth.token, vars)}`;
  } else if (auth.type === 'basic') {
    const creds = Buffer.from(
      `${resolve(auth.username, vars)}:${resolve(auth.password, vars)}`,
    ).toString('base64');
    headers['Authorization'] = `Basic ${creds}`;
  } else if (auth.type === 'apiKey') {
    if (auth.placement === 'header') {
      headers[resolve(auth.key, vars)] = resolve(auth.value, vars);
    } else {
      resolvedUrl +=
        (resolvedUrl.includes('?') ? '&' : '?') +
        `${encodeURIComponent(resolve(auth.key, vars))}=${encodeURIComponent(resolve(auth.value, vars))}`;
    }
  }

  let bodyInit: string | FormData | undefined;
  const body = request.body;

  if (body.type === 'json') {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    bodyInit = resolve(body.value, vars);
  } else if (body.type === 'text') {
    headers['Content-Type'] = headers['Content-Type'] ?? 'text/plain';
    bodyInit = resolve(body.value, vars);
  } else if (body.type === 'form') {
    const form = new URLSearchParams();
    for (const field of body.fields) {
      if (field.enabled && field.key) {
        form.append(resolve(field.key, vars), resolve(field.value, vars));
      }
    }
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/x-www-form-urlencoded';
    bodyInit = form.toString();
  } else if (body.type === 'multipart') {
    const form = new FormData();
    for (const field of body.fields) {
      if (!field.enabled || !field.key) {
        continue;
      }
      if (field.type === 'file' && field.filePath) {
        try {
          const fileData = fs.readFileSync(field.filePath);
          // Use a named Blob so the multipart part carries the filename.
          const blob = new Blob([fileData]);
          form.append(resolve(field.key, vars), blob, path.basename(field.filePath));
        } catch (err) {
          throw new Error(
            `Could not read file for field "${field.key}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        form.append(resolve(field.key, vars), resolve(field.value, vars));
      }
    }
    bodyInit = form;
  }

  const dispatcher = settings.verifyTls ? agentVerifyTls : agentSkipTls;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);

  const start = Date.now();
  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    response = await undiciFetch(resolvedUrl, {
      method: request.method,
      headers,
      body: bodyInit as string | FormData,
      signal: controller.signal,
      redirect: settings.followRedirects ? 'follow' : 'manual',
      dispatcher,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${settings.timeoutMs}ms`);
    }
    throw err;
  }

  clearTimeout(timeout);

  const durationMs = Date.now() - start;
  // Read the body BEFORE the dispatcher goes out of scope.
  const responseBody = await response.text();
  const sizeBytes = Buffer.byteLength(responseBody, 'utf8');

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    // Skip set-cookie here — handled separately below because HTTP allows
    // multiple Set-Cookie headers and forEach joins them lossily with ", ".
    if (key.toLowerCase() !== 'set-cookie') {
      responseHeaders[key] = value;
    }
  });

  // getSetCookie() returns each Set-Cookie header as a distinct array element.
  // Store them newline-joined so the existing string schema is preserved;
  // the UI splits on "\n" to render each cookie as its own row.
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) {
    responseHeaders['set-cookie'] = setCookies.join('\n');
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body: responseBody,
    durationMs,
    sizeBytes,
    requestHeaders: headers,
    resolvedUrl,
  };
}
