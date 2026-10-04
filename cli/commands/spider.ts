/**
 * cli/commands/spider.ts — interceptor spider <url> [options]
 *
 * Automated dynamic web spider & crawler for Interceptor:
 * - Real browser driving with live visual execution
 * - Clicks every button on visited pages
 * - Follows all in-scope links, forms, and SPA router routes
 * - Discovers and downloads all code (HTML, scripts, webpack chunks, foreign-domain assets)
 * - Extracts API endpoints from discovered JavaScript
 * - Captures all network traffic locally
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { sendCommand, sendCommandWs, type DaemonResponse } from "../transport"
import { buildTabCreateAction } from "./compound"

type Action = { type: string; [key: string]: unknown }
type Result = { success: boolean; error?: string; data?: unknown; tabId?: number }

function unwrap(resp: DaemonResponse): Result {
  return resp.result
}

async function send(action: Action, tabId?: number, useWs = false, contextId?: string): Promise<Result> {
  try {
    const resp = useWs
      ? await sendCommandWs(action, tabId, contextId)
      : await sendCommand(action, tabId, contextId)
    return unwrap(resp)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : undefined
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(0, 150)
}

function normalizeUrl(rawUrl: string, baseOrigin: string): string | null {
  try {
    const u = new URL(rawUrl, baseOrigin)
    // Strip hash fragments unless it's a SPA hash route (e.g. /#/admin)
    if (u.hash && !u.hash.startsWith("#/")) {
      u.hash = ""
    }
    // Remove marketing/tracking parameters that cause crawl explosion
    const stripParams = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "fbclid", "gclid"]
    for (const p of stripParams) {
      u.searchParams.delete(p)
    }
    return u.toString()
  } catch {
    return null
  }
}

function getDomain(urlStr: string): string {
  try {
    return new URL(urlStr).hostname.toLowerCase()
  } catch {
    return ""
  }
}

function getRootDomain(hostname: string): string {
  const parts = hostname.split(".")
  if (parts.length <= 2) return hostname
  return parts.slice(-2).join(".")
}

function isUrlInScope(targetUrl: string, startUrl: string, scope: "domain" | "origin" | "all"): boolean {
  if (scope === "all") return true
  try {
    const targetObj = new URL(targetUrl)
    const startObj = new URL(startUrl)
    if (targetObj.protocol !== "http:" && targetObj.protocol !== "https:") return false

    if (scope === "origin") {
      return targetObj.origin.toLowerCase() === startObj.origin.toLowerCase()
    }
    // scope === "domain"
    const targetHost = targetObj.hostname.toLowerCase()
    const startHost = startObj.hostname.toLowerCase()
    if (targetHost === startHost) return true
    const rootStart = getRootDomain(startHost)
    return targetHost.endsWith(`.${rootStart}`)
  } catch {
    return false
  }
}

// In-page script evaluated to extract page links, scripts, buttons, and webpack chunks
const EXTRACT_PAGE_DATA_SCRIPT = `
(() => {
  try {
    const currentUrl = window.location.href;
    const origin = window.location.origin;

    // 1. Discover Links
    const rawLinks = [];
    document.querySelectorAll("a[href], area[href]").forEach(el => {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:") && !href.startsWith("mailto:") && !href.startsWith("tel:")) {
        try { rawLinks.push(new URL(href, currentUrl).href); } catch (e) {}
      }
    });

    // SPA Router Links & data-urls
    document.querySelectorAll("[data-url], [data-href], [routerlink], [ng-reflect-router-link]").forEach(el => {
      const u = el.getAttribute("data-url") || el.getAttribute("data-href") || el.getAttribute("routerlink") || el.getAttribute("ng-reflect-router-link");
      if (u) {
        try { rawLinks.push(new URL(u, currentUrl).href); } catch (e) {}
      }
    });

    // Form actions
    document.querySelectorAll("form[action]").forEach(el => {
      const act = el.getAttribute("action");
      if (act) {
        try { rawLinks.push(new URL(act, currentUrl).href); } catch (e) {}
      }
    });

    // 2. Discover Scripts & Preloads
    const scripts = [];
    document.querySelectorAll("script[src]").forEach(el => {
      const src = el.getAttribute("src");
      if (src) {
        try { scripts.push({ url: new URL(src, currentUrl).href, inline: false }); } catch (e) {}
      }
    });
    document.querySelectorAll("link[rel='modulepreload'], link[rel='preload'][as='script']").forEach(el => {
      const href = el.getAttribute("href");
      if (href) {
        try { scripts.push({ url: new URL(href, currentUrl).href, inline: false, preloaded: true }); } catch (e) {}
      }
    });

    // Inline script bodies (for chunk & endpoint regex mining)
    const inlineScripts = [];
    document.querySelectorAll("script:not([src])").forEach(el => {
      const content = el.textContent || "";
      if (content.trim()) inlineScripts.push(content);
    });

    // 3. Webpack Runtime & Chunk Discovery
    const discoveredChunks = [];
    try {
      // Check webpack chunk globals
      const webpackKeys = Object.keys(window).filter(k => k.startsWith("webpackChunk") || k === "webpackJsonp");
      for (const k of webpackKeys) {
        const val = window[k];
        if (Array.isArray(val)) {
          val.forEach(entry => {
            if (Array.isArray(entry) && Array.isArray(entry[0])) {
              entry[0].forEach(chunkId => {
                discoveredChunks.push(String(chunkId));
              });
            }
          });
        }
      }
    } catch (e) {}

    // 4. Discover Clickable Buttons
    const buttons = [];
    const btnElements = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], [role='button'], a.btn, a.button, .btn, .button"));
    btnElements.forEach((el, index) => {
      // Check visibility
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || el.hasAttribute("disabled")) return;
      const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
      const id = el.id || "";
      const className = el.className || "";
      const tagName = el.tagName.toLowerCase();
      buttons.push({
        index,
        text: text.slice(0, 80),
        id,
        tagName,
        className: typeof className === "string" ? className.slice(0, 100) : "",
        type: el.getAttribute("type") || ""
      });
    });

    return {
      title: document.title || "",
      url: currentUrl,
      links: Array.from(new Set(rawLinks)),
      scripts,
      inlineScripts,
      discoveredChunks: Array.from(new Set(discoveredChunks)),
      buttons
    };
  } catch (err) {
    return { error: err.message };
  }
})()
`

// In-page script to click a specific button by index and observe state changes
function buildClickButtonScript(index: number): string {
  return `
(() => {
  try {
    const btnElements = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], [role='button'], a.btn, a.button, .btn, .button"));
    const visibleBtns = btnElements.filter(el => {
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && !el.hasAttribute("disabled");
    });
    const target = visibleBtns[${index}];
    if (!target) return { success: false, error: "button index not found" };

    target.scrollIntoView({ behavior: "instant", block: "center" });

    // Dispatch simulated trusted-like mouse click
    const opts = { bubbles: true, cancelable: true, view: window };
    target.dispatchEvent(new MouseEvent("mousedown", opts));
    target.dispatchEvent(new MouseEvent("mouseup", opts));
    target.click();

    return {
      success: true,
      text: (target.innerText || target.value || "").trim().slice(0, 80),
      urlAfterClick: window.location.href
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
})()
`
}

// In-page script to dismiss any modal or popup that opened after a click
const CLOSE_MODAL_SCRIPT = `
(() => {
  try {
    // Attempt Escape key
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
    // Look for standard close buttons
    const closeButtons = document.querySelectorAll("[aria-label*='Close' i], [aria-label*='dismiss' i], [title*='Close' i], button.close, .modal-close, .dialog-close");
    if (closeButtons.length > 0) {
      const btn = closeButtons[closeButtons.length - 1];
      if (btn && typeof btn.click === "function") btn.click();
    }
    return { closed: true };
  } catch (e) {
    return { closed: false, error: e.message };
  }
})()
`

// Regex scanning patterns for chunk discovery and endpoint extraction
const CHUNK_PATTERNS = [
  /(?:["'`])([a-zA-Z0-9_\-\.\/]+(?:\.chunk|\.bundle|\.min)?\.js(?:\?[a-zA-Z0-9_\-=]+)?)(?:["'`])/g,
  /(?:["'`])(static\/js\/[a-zA-Z0-9_\-\.]+\.js)(?:["'`])/g,
  /(?:["'`])(assets\/[a-zA-Z0-9_\-\.]+\.js)(?:["'`])/g,
  /(?:["'`])(chunks?\/[a-zA-Z0-9_\-\.]+\.js)(?:["'`])/g,
  /(?:["'`])(https?:\/\/[a-zA-Z0-9_\-\.]+\/[a-zA-Z0-9_\-\.\/]+\.js(?:\?[a-zA-Z0-9_\-=]+)?)(?:["'`])/g
]

const ENDPOINT_PATTERNS = [
  /(?:["'`])(\/(?:api|v[0-9]|rest|graphql|auth|admin|user|v1|v2|v3)\/[a-zA-Z0-9_\-\/\.\{\}]+)(?:["'`])/g,
  /(?:["'`])(https?:\/\/[a-zA-Z0-9_\-\.]+\/(?:api|v[0-9]|rest|graphql|auth|admin|user)[a-zA-Z0-9_\-\/\.\{\}\?=&]*)(?:["'`])/g,
  /(?:fetch|axios\.(?:get|post|put|delete|patch)|apiClient\.[a-z]+)\s*\(\s*["'`](\/[a-zA-Z0-9_\-\/\.\{\}]+)["'`]/g
]

export async function runSpiderCommand(
  filtered: string[],
  opts: { jsonMode?: boolean; useWs?: boolean; globalTabId?: number; contextId?: string }
): Promise<void> {
  const rawUrl = filtered[1] && !filtered[1].startsWith("-") ? filtered[1] : (flagValue(filtered, "--url") || filtered.find(a => a.startsWith("http://") || a.startsWith("https://")))
  if (!rawUrl) {
    console.error("error: interceptor spider requires a starting URL.")
    console.error("Usage: interceptor spider <url> [options]")
    console.error("       interceptor open <url> --spider [options]")
    process.exit(1)
  }

  let startUrl = rawUrl
  if (!startUrl.startsWith("http://") && !startUrl.startsWith("https://")) {
    startUrl = "https://" + startUrl
  }

  // Parse flags
  const maxDepth = parseInt(flagValue(filtered, "--max-depth") || "2", 10)
  const maxPages = parseInt(flagValue(filtered, "--max-pages") || "40", 10)
  const delayMs = parseInt(flagValue(filtered, "--delay") || "500", 10)
  const scopeArg = (flagValue(filtered, "--scope") || "domain").toLowerCase()
  const scope: "domain" | "origin" | "all" = (scopeArg === "origin" || scopeArg === "all") ? scopeArg : "domain"
  const activate = filtered.includes("--activate") || filtered.includes("--visual")
  const skipDownload = filtered.includes("--no-download")
  const skipButtons = filtered.includes("--no-buttons")
  const allButtons = filtered.includes("--all-buttons")
  const jsonMode = opts.jsonMode || filtered.includes("--json")

  const targetHost = getDomain(startUrl)
  const defaultOutDir = `./spider_output_${sanitizeFilename(targetHost)}`
  const outDir = resolve(flagValue(filtered, "--out") || flagValue(filtered, "--save-dir") || defaultOutDir)

  // Create directories
  const scriptsDir = join(outDir, "scripts")
  const pagesDir = join(outDir, "pages")
  if (!skipDownload) {
    mkdirSync(scriptsDir, { recursive: true })
    mkdirSync(pagesDir, { recursive: true })
  }

  const trafficFile = join(outDir, "traffic.jsonl")
  const endpointsFile = join(outDir, "endpoints.json")
  const endpointsTxtFile = join(outDir, "endpoints.txt")
  const summaryFile = join(outDir, "summary.json")

  if (!jsonMode) {
    console.log(`=== Interceptor Dynamic Spider ===`)
    console.log(`Start URL:     ${startUrl}`)
    console.log(`Scope:         ${scope}`)
    console.log(`Max Depth:     ${maxDepth}`)
    console.log(`Max Pages:     ${maxPages}`)
    console.log(`Action Delay:  ${delayMs}ms`)
    console.log(`Output Dir:    ${outDir}`)
    console.log(`Visual Mode:   ${activate ? "ON (foreground tab)" : "OFF (background)"}`)
    console.log(`Button Clicks: ${skipButtons ? "Disabled" : allButtons ? "All buttons" : "Safe buttons (filtered logouts)"}`)
    console.log(`Code Download: ${skipDownload ? "Disabled" : "Enabled (HTML, JS, Chunks, Maps)"}`)
    console.log(`------------------------------------------------------------\n`)
  }

  // Step 1: Open initial tab in browser
  const createAction = buildTabCreateAction(
    [activate ? "--activate" : "--no-reuse", "--reuse"],
    startUrl,
    { policyDefault: false }
  )
  if (activate) createAction.active = true

  const createResult = await send(createAction, opts.globalTabId, opts.useWs, opts.contextId)
  if (!createResult.success) {
    console.error(`error: failed to create browser tab for spider: ${createResult.error || "unknown error"}`)
    process.exit(1)
  }

  const dataObj = (typeof createResult.data === "object" && createResult.data) ? createResult.data as Record<string, unknown> : {}
  const tabId = (dataObj.tabId as number) || createResult.tabId || opts.globalTabId

  // Turn on network monitoring to capture all traffic
  await send({ type: "net_monitor", enabled: true }, tabId, opts.useWs, opts.contextId)

  // Crawler state
  const visitedUrls = new Set<string>()
  const enqueuedUrls = new Set<string>()
  const downloadedScripts = new Set<string>()
  const discoveredEndpoints = new Set<string>()
  const clickedButtons = new Set<string>()
  const discoveredForeignScripts = new Set<string>()
  let totalCapturedTraffic = 0

  type QueueItem = { url: string; depth: number; parentUrl?: string }
  const queue: QueueItem[] = [{ url: startUrl, depth: 0 }]
  enqueuedUrls.add(startUrl)

  // Dangerous button patterns to skip by default (to avoid logging out or destroying test accounts)
  const DANGEROUS_BTN_REGEX = /log\s*out|sign\s*out|delete\s*account|terminate|cancel\s*subscription|remove\s*all/i

  // Helper to download code from URL
  async function downloadScript(scriptUrl: string, baseOrigin: string) {
    if (skipDownload) return
    if (downloadedScripts.has(scriptUrl)) return
    downloadedScripts.add(scriptUrl)

    try {
      const u = new URL(scriptUrl, baseOrigin)
      const isForeign = u.origin.toLowerCase() !== new URL(baseOrigin).origin.toLowerCase()
      if (isForeign) discoveredForeignScripts.add(scriptUrl)

      // Fetch script content
      const resp = await fetch(u.toString(), {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InterceptorSpider/1.0" },
        signal: AbortSignal.timeout(10000)
      })
      if (!resp.ok) return
      const text = await resp.text()

      // Save to disk
      const hostSubdir = join(scriptsDir, sanitizeFilename(u.hostname))
      mkdirSync(hostSubdir, { recursive: true })
      const scriptFilename = sanitizeFilename(u.pathname.split("/").pop() || "script.js")
      const localPath = join(hostSubdir, `${Date.now()}_${scriptFilename}`)
      writeFileSync(localPath, text, "utf-8")

      if (!jsonMode) {
        const flagTag = isForeign ? "[EXTERNAL-JS]" : "[CHUNK-JS]"
        console.log(`  ${flagTag} Downloaded: ${u.toString().slice(0, 90)} -> ${localPath}`)
      }

      // Analyze script content for endpoints and nested chunks
      extractEndpointsFromText(text)
      scanTextForChunks(text, u.origin)

      // Check for source maps
      const smMatch = text.match(/\/\/#\s*sourceMappingURL=([^\s]+)/)
      if (smMatch && smMatch[1]) {
        const smUrl = new URL(smMatch[1], u.toString()).toString()
        try {
          const smResp = await fetch(smUrl, { signal: AbortSignal.timeout(8000) })
          if (smResp.ok) {
            const smText = await smResp.text()
            writeFileSync(`${localPath}.map`, smText, "utf-8")
            if (!jsonMode) console.log(`  [SOURCEMAP] Downloaded: ${smUrl.slice(0, 80)}`)
          }
        } catch {}
      }
    } catch {}
  }

  function extractEndpointsFromText(text: string) {
    for (const pattern of ENDPOINT_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const ep = match[1]
        if (ep && !ep.endsWith(".js") && !ep.endsWith(".css") && !ep.endsWith(".png") && !ep.endsWith(".jpg")) {
          discoveredEndpoints.add(ep)
        }
      }
    }
  }

  function scanTextForChunks(text: string, baseOrigin: string) {
    for (const pattern of CHUNK_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const chunkCandidate = match[1]
        if (chunkCandidate && (chunkCandidate.endsWith(".js") || chunkCandidate.includes(".js?"))) {
          try {
            const resolvedChunkUrl = new URL(chunkCandidate, baseOrigin).toString()
            if (!downloadedScripts.has(resolvedChunkUrl)) {
              downloadScript(resolvedChunkUrl, baseOrigin)
            }
          } catch {}
        }
      }
    }
  }

  // Main Crawling Loop
  while (queue.length > 0 && visitedUrls.size < maxPages) {
    const item = queue.shift()!
    const canonical = normalizeUrl(item.url, startUrl)
    if (!canonical || visitedUrls.has(canonical)) continue

    visitedUrls.add(canonical)
    const pageNum = visitedUrls.size
    if (!jsonMode) {
      console.log(`[PAGE ${pageNum}/${maxPages}] [Depth ${item.depth}] Navigating: ${canonical}`)
    }

    // Navigate to URL
    await send({ type: "navigate", url: canonical }, tabId, opts.useWs, opts.contextId)

    // Wait for DOM stability
    try {
      await send({ type: "wait_stable", ms: 250, timeout: 5000 }, tabId, opts.useWs, opts.contextId)
    } catch {}
    if (delayMs > 0) {
      await Bun.sleep(delayMs)
    }

    // Save page HTML snapshot
    if (!skipDownload) {
      try {
        const htmlRes = await send({ type: "extract_html" }, tabId, opts.useWs, opts.contextId)
        if (htmlRes.success && typeof htmlRes.data === "string") {
          const safeName = sanitizeFilename(new URL(canonical).pathname.replace(/\//g, "_") || "root")
          const pagePath = join(pagesDir, `${pageNum}_${safeName}.html`)
          writeFileSync(pagePath, htmlRes.data, "utf-8")
        }
      } catch {}
    }

    // Extract page links, scripts, buttons, and chunks via in-page evaluate
    const evalRes = await send({ type: "evaluate", code: EXTRACT_PAGE_DATA_SCRIPT, world: "MAIN" }, tabId, opts.useWs, opts.contextId)
    if (!evalRes.success || !evalRes.data) {
      continue
    }

    const pageData = evalRes.data as {
      title?: string
      url?: string
      links?: string[]
      scripts?: Array<{ url: string; preloaded?: boolean }>
      inlineScripts?: string[]
      discoveredChunks?: string[]
      buttons?: Array<{ index: number; text: string; id: string; tagName: string; className: string; type: string }>
    }

    const currentOrigin = new URL(canonical).origin

    // 1. Process and download discovered scripts
    if (Array.isArray(pageData.scripts)) {
      for (const s of pageData.scripts) {
        if (s.url) await downloadScript(s.url, currentOrigin)
      }
    }

    // Process inline scripts for chunks and endpoints
    if (Array.isArray(pageData.inlineScripts)) {
      for (const inlineCode of pageData.inlineScripts) {
        extractEndpointsFromText(inlineCode)
        scanTextForChunks(inlineCode, currentOrigin)
      }
    }

    // Process webpack discovered chunks
    if (Array.isArray(pageData.discoveredChunks)) {
      for (const chunkId of pageData.discoveredChunks) {
        // Synthesize standard chunk filename patterns if not already a URL
        const candidates = [
          `${currentOrigin}/static/js/${chunkId}.chunk.js`,
          `${currentOrigin}/assets/${chunkId}.js`,
          `${currentOrigin}/chunks/${chunkId}.js`,
          `${currentOrigin}/${chunkId}.js`
        ]
        for (const cand of candidates) {
          if (!downloadedScripts.has(cand)) {
            downloadScript(cand, currentOrigin)
          }
        }
      }
    }

    // 2. Execute button clicks ("execute every button click")
    if (!skipButtons && Array.isArray(pageData.buttons) && pageData.buttons.length > 0) {
      const pageButtons = pageData.buttons
      if (!jsonMode) {
        console.log(`  [BUTTONS] Discovered ${pageButtons.length} interactive buttons on page`)
      }

      for (let bIdx = 0; bIdx < pageButtons.length; bIdx++) {
        const btn = pageButtons[bIdx]
        const btnSig = `${canonical}::${btn.tagName}#${btn.id}.${btn.className}[${btn.text}]`
        if (clickedButtons.has(btnSig)) continue
        clickedButtons.add(btnSig)

        if (!allButtons && DANGEROUS_BTN_REGEX.test(btn.text)) {
          if (!jsonMode) console.log(`  [BUTTON-SKIP] Skipped potentially destructive button: "${btn.text}"`)
          continue
        }

        if (!jsonMode) {
          console.log(`  [CLICK] Executing click on button [${bIdx + 1}/${pageButtons.length}]: "${btn.text || btn.tagName}"`)
        }

        // Execute click
        const clickRes = await send({ type: "evaluate", code: buildClickButtonScript(btn.index), world: "MAIN" }, tabId, opts.useWs, opts.contextId)
        if (delayMs > 0) {
          await Bun.sleep(Math.min(delayMs, 500))
        }

        // Check if URL changed after button click
        if (clickRes.success && clickRes.data) {
          const clickData = clickRes.data as { urlAfterClick?: string }
          if (clickData.urlAfterClick && clickData.urlAfterClick !== canonical) {
            const nextUrl = normalizeUrl(clickData.urlAfterClick, startUrl)
            if (nextUrl && !enqueuedUrls.has(nextUrl) && isUrlInScope(nextUrl, startUrl, scope)) {
              enqueuedUrls.add(nextUrl)
              queue.push({ url: nextUrl, depth: item.depth + 1, parentUrl: canonical })
              if (!jsonMode) console.log(`  [BUTTON-ROUTE] Button click transitioned route to: ${nextUrl}`)
            }
          }
        }

        // Check if new modal opened, extract new links, then close modal
        try {
          const modalEval = await send({ type: "evaluate", code: EXTRACT_PAGE_DATA_SCRIPT, world: "MAIN" }, tabId, opts.useWs, opts.contextId)
          if (modalEval.success && modalEval.data) {
            const modalData = modalEval.data as { links?: string[]; scripts?: Array<{ url: string }> }
            if (Array.isArray(modalData.links)) {
              for (const l of modalData.links) {
                const normL = normalizeUrl(l, startUrl)
                if (normL && !enqueuedUrls.has(normL) && isUrlInScope(normL, startUrl, scope)) {
                  enqueuedUrls.add(normL)
                  queue.push({ url: normL, depth: item.depth + 1, parentUrl: canonical })
                }
              }
            }
          }
          // Dismiss modal if open
          await send({ type: "evaluate", code: CLOSE_MODAL_SCRIPT, world: "MAIN" }, tabId, opts.useWs, opts.contextId)
        } catch {}
      }
    }

    // 3. Process discovered links ("go to every link no matter what")
    if (Array.isArray(pageData.links)) {
      for (const l of pageData.links) {
        const normL = normalizeUrl(l, startUrl)
        if (!normL) continue
        if (enqueuedUrls.has(normL)) continue
        if (!isUrlInScope(normL, startUrl, scope)) continue
        if (item.depth + 1 > maxDepth) continue

        enqueuedUrls.add(normL)
        queue.push({ url: normL, depth: item.depth + 1, parentUrl: canonical })
      }
    }

    // 4. Collect captured traffic so far
    try {
      const netLogRes = await send({ type: "net_log", limit: 300 }, tabId, opts.useWs, opts.contextId)
      if (netLogRes.success && Array.isArray(netLogRes.data)) {
        for (const entry of netLogRes.data as Array<Record<string, unknown>>) {
          appendFileSync(trafficFile, JSON.stringify(entry) + "\n", "utf-8")
          totalCapturedTraffic++
          if (entry.url && typeof entry.url === "string") {
            try {
              const u = new URL(entry.url)
              if (u.pathname && u.pathname !== "/") {
                discoveredEndpoints.add(`${entry.method || "GET"} ${u.pathname}`)
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  // Write endpoints to file
  const sortedEndpoints = Array.from(discoveredEndpoints).sort()
  writeFileSync(endpointsFile, JSON.stringify(sortedEndpoints, null, 2), "utf-8")
  writeFileSync(endpointsTxtFile, sortedEndpoints.join("\n") + "\n", "utf-8")

  const summary = {
    target: startUrl,
    scope,
    totalPagesVisited: visitedUrls.size,
    totalLinksDiscovered: enqueuedUrls.size,
    totalButtonsClicked: clickedButtons.size,
    totalScriptsDownloaded: downloadedScripts.size,
    totalForeignScriptsDiscovered: discoveredForeignScripts.size,
    totalEndpointsDiscovered: discoveredEndpoints.size,
    totalTrafficRequests: totalCapturedTraffic,
    visitedUrls: Array.from(visitedUrls),
    foreignScripts: Array.from(discoveredForeignScripts),
    outputDirectory: outDir
  }

  writeFileSync(summaryFile, JSON.stringify(summary, null, 2), "utf-8")

  if (jsonMode) {
    console.log(JSON.stringify({ success: true, data: summary }, null, 2))
    return
  }

  console.log(`\n============================================================`)
  console.log(`Interceptor Spider Run Complete`)
  console.log(`============================================================`)
  console.log(`Target:                     ${startUrl}`)
  console.log(`Pages Visited:              ${visitedUrls.size} / ${maxPages}`)
  console.log(`Links Discovered:           ${enqueuedUrls.size}`)
  console.log(`Buttons Clicked:            ${clickedButtons.size}`)
  console.log(`Scripts & Chunks Saved:     ${downloadedScripts.size}`)
  console.log(`External Scripts Found:     ${discoveredForeignScripts.size}`)
  console.log(`API Endpoints Discovered:   ${discoveredEndpoints.size}`)
  console.log(`Traffic Requests Captured:  ${totalCapturedTraffic}`)
  console.log(`------------------------------------------------------------`)
  console.log(`Output Directory:           ${outDir}`)
  console.log(`  - Page Snapshots:         ${pagesDir}`)
  console.log(`  - Downloaded JS Chunks:   ${scriptsDir}`)
  console.log(`  - Captured Traffic:       ${trafficFile}`)
  console.log(`  - Discovered Endpoints:   ${endpointsFile} (${endpointsTxtFile})`)
  console.log(`  - Run Summary:            ${summaryFile}`)
  console.log(`============================================================\n`)
}
