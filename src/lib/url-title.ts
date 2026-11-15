import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import * as tls from "node:tls";
import ipaddr from "ipaddr.js";
import { load } from "cheerio";

function trustedCertificates() {
  // Respect certificates trusted by the local OS (e.g. corporate HTTPS proxy),
  // while keeping normal TLS certificate and hostname verification enabled.
  try {
    return [
      ...tls.rootCertificates,
      ...(typeof tls.getCACertificates === "function"
        ? tls.getCACertificates("system")
        : []),
    ];
  } catch {
    return [...tls.rootCertificates];
  }
}

export async function resolveAddresses(hostname: string, signal: AbortSignal) {
  // Never turn a literal private/benchmark address into a remote DNS query.
  if (ipaddr.isValid(hostname) && !isPublicAddress(hostname)) return [];
  let addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(new Error("Title fetch timed out"));
      else
        signal.addEventListener(
          "abort",
          () => reject(new Error("Title fetch timed out")),
          { once: true },
        );
    }),
  ]);
  // Some local proxies return RFC 2544 Fake-IP addresses. Resolve the original
  // hostname through a fixed HTTPS resolver, then connect ONLY to its validated
  // public answer. Do not connect to, or whitelist, the synthetic address range.
  if (
    addresses.length &&
    addresses.every((a) => /^198\.(18|19)\./.test(a.address))
  ) {
    const endpoint = new URL("https://cloudflare-dns.com/dns-query");
    endpoint.searchParams.set("name", hostname);
    endpoint.searchParams.set("type", "A");
    const response = await fetch(endpoint, {
      headers: { Accept: "application/dns-json" },
      signal,
      redirect: "error",
    });
    if (!response.ok) return [];
    const result = (await response.json()) as {
      Status?: number;
      Answer?: { type: number; data: string }[];
    };
    if (result.Status !== 0) return [];
    addresses = (result.Answer || [])
      .filter((a) => a.type === 1)
      .map((a) => ({ address: a.data, family: 4 }));
  }
  return addresses;
}

export function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

export function parseUrlTitle(html: string) {
  const $ = load(html);
  const title =
    $("title").first().text().trim() ||
    $('meta[property="og:title"]').attr("content");
  return title?.replace(/\s+/g, " ").trim().slice(0, 240) || null;
}

export async function fetchUrlTitle(raw: string): Promise<string | null> {
  const signal = AbortSignal.timeout(8000);
  try {
    let url = new URL(raw);
    for (let redirects = 0; redirects < 4; redirects++) {
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        (url.port && !["80", "443"].includes(url.port))
      )
        return null;
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = await resolveAddresses(hostname, signal);
      if (
        signal.aborted ||
        !addresses.length ||
        addresses.some((a) => !isPublicAddress(a.address))
      )
        return null;
      const address = addresses[0];
      const result = await new Promise<{ redirect?: string; html?: string }>(
        (resolve, reject) => {
          const request = (url.protocol === "https:" ? https : http).get(
            url,
            {
              signal,
              ca: trustedCertificates(),
              // Pin the validated DNS result; re-check every redirect to prevent SSRF.
              lookup: (_host, options, callback) =>
                options.all
                  ? callback(null, [address])
                  : callback(null, address.address, address.family),
              headers: {
                "User-Agent": "Spark/0.1 (personal bookmark title fetcher)",
                Accept: "text/html",
                "Accept-Encoding": "identity",
              },
            },
            (response) => {
              if (
                [301, 302, 303, 307, 308].includes(response.statusCode || 0)
              ) {
                response.resume();
                resolve({ redirect: response.headers.location });
                return;
              }
              if (
                response.statusCode !== 200 ||
                !response.headers["content-type"]?.includes("text/html")
              ) {
                response.resume();
                resolve({});
                return;
              }
              const chunks: Buffer[] = [];
              let size = 0;
              response.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > 512 * 1024) {
                  request.destroy();
                  resolve({});
                } else chunks.push(chunk);
              });
              response.on("end", () =>
                resolve({ html: Buffer.concat(chunks).toString("utf8") }),
              );
              response.on("error", reject);
            },
          );
          request.on("error", reject);
        },
      );
      if (result.redirect) {
        url = new URL(result.redirect, url);
        continue;
      }
      if (!result.html) return null;
      return parseUrlTitle(result.html);
    }
  } catch {
    /* Unreachable pages must never block a saved entry. */
  }
  return null;
}
