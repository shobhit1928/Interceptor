# Dynamic Web Application Spidering

Use `interceptor spider <url>` (or `interceptor open <url> --spider`) to automatically crawl a target web application, trigger interactive UI buttons, discover and download all code assets and chunk JavaScript, and capture all network traffic locally.

## When To Use

- **Security Reconnaissance / Bug Bounty**: Discover hidden routes, forgot-password endpoints, admin panels, and unlinked views.
- **Client-Side Code Audit**: Download all JavaScript code, chunks, webpack bundles, and source maps to disk for static analysis.
- **Traffic Capture without Burp/Caido**: Record all XHR, fetch, and WebSocket traffic directly to local JSONL files while maintaining your real logged-in session.
- **Single Page Application (SPA) Deep Crawl**: Extract dynamic pushState router routes and state-dependent controls.

## Basic Usage

```bash
# Standard domain crawl (stays on target.com and subdomains)
interceptor spider https://target.com

# Visual live drive on another monitor (brings tab forward)
interceptor spider https://target.com --activate

# Sugar alias through open
interceptor open https://target.com --spider --scope domain
```

## Options & Flags

| Flag | Default | Description |
|---|---|---|
| `--max-depth <n>` | `2` | Maximum link traversal depth |
| `--max-pages <n>` | `40` | Maximum distinct routes to visit |
| `--delay <ms>` | `500` | Delay between actions to allow dynamic SPAs to settle |
| `--scope <domain\|origin\|all>` | `domain` | Crawl scope boundary |
| `--out <dir>` | `./spider_output_<host>` | Output folder for all downloaded files and logs |
| `--no-download` | `false` | Skip saving HTML snapshots and JS scripts to disk |
| `--no-buttons` | `false` | Skip button clicks (link traversal only) |
| `--all-buttons` | `false` | Click all buttons (including logout/delete buttons) |
| `--activate` | `false` | Foreground tab for visual monitoring |
| `--json` | `false` | Output machine-readable JSON summary |

## Output Structure

The spider creates a structured local folder:

```text
spider_output_target_com/
├── pages/                  # HTML snapshots of visited views
│   ├── 1_root.html
│   ├── 2_login.html
│   └── 3_forgot_password.html
├── scripts/                # Downloaded JavaScript files & chunks
│   ├── target.com/
│   │   ├── main.bundle.js
│   │   └── chunk-admin-tools.js
│   └── cdn.thirdparty.com/ # Chunks loaded from other domains
│       └── widget.min.js
├── traffic.jsonl           # Local record of all HTTP requests/responses
├── endpoints.json          # API endpoints discovered from scripts & traffic
├── endpoints.txt           # Line-delimited endpoints list
└── summary.json            # Run statistics and visited URLs
```

## Example Workflow

```bash
# 1. Ensure Interceptor extension is connected to your signed-in browser
interceptor status

# 2. Run the spider with visual observation enabled
interceptor spider https://app.example.com --scope domain --activate --out ./recon-app

# 3. Inspect captured endpoints
cat ./recon-app/endpoints.txt

# 4. Search for sensitive terms in downloaded code
grep -rn "admin" ./recon-app/scripts/
```
