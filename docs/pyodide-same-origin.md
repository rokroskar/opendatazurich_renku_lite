# Serving Pyodide same-origin in `opendatazurich_renku_lite`

**Status:** Implemented (branch `feature/include-pyodide`, 2026-10).
**Original author:** opendata@zuerich.ch
**Scope:** [opendatazurich/opendatazurich_renku_lite](https://github.com/opendatazurich/opendatazurich_renku_lite) (fork of `rokroskar/opendatazurich_renku_lite`).

---

## 1. Summary

The upstream JupyterLite app fetched the Pyodide runtime and its Python packages at runtime from `cdn.jsdelivr.net`. From networks with a web proxy / TLS interception that fails with CORS errors; the Pyodide kernel refuses to start and the notebook is unusable.

Fix: bundle Pyodide into the image at `jupyter lite build` time, so the browser loads every Pyodide file from the same origin as the app. No runtime CDN dependency, no CORS, no risk from corporate proxies.

---

## 2. Problem

### 2.1 Symptom

Opening a notebook (e.g. `…/?package_id=prd_ssz_ogd_katalog_inventar&resource_id=…`) crashed the Pyodide kernel at startup:

```
Fatal Python error: Failed to import encodings module
Python runtime state: core initialized
ModuleNotFoundError: No module named 'encodings'
Current thread 0x003d3b20 (most recent call first):
  <no Python frame>
Program terminated with exit(1)
```

In the browser console, accompanied by many messages like:

```
Access to fetch at 'https://cdn.jsdelivr.net/pyodide/v314.0.6/full/python_stdlib.zip'
from origin 'https://open-data-zuerich-datasets-app-908k7ab8.renkulab.app'
has been blocked by CORS policy:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

### 2.2 Affected users

Any visitor from a network with TLS interception or header rewriting in the web proxy — typical for corporate and government networks, including the City of Zurich's network. Users on unrestricted networks were not affected.

---

## 3. Diagnosis

### 3.1 Checks performed

| Check | Result |
|---|---|
| `curl -I https://cdn.jsdelivr.net/pyodide/v314.0.6/full/python_stdlib.zip` from the corporate network | **HTTP/200**, `Access-Control-Allow-Origin: *` present, `content-type: application/wasm`. File exists and is served correctly. |
| Same request from the browser on the same machine | CORS error, `Access-Control-Allow-Origin` missing in the browser-visible response. |
| Pyodide `v314.0.6` on jsDelivr | Exists, response headers clean. |

### 3.2 Root cause

`curl.exe` on Windows ignores WPAD/PAC-based system proxy settings by default and goes directly to the Internet. The browser respects the organisation's PAC file and routes through a filtering web proxy. That proxy **modifies the response** (TLS interception plus a policy that strips CORS headers or injects an error page for certain content types). The result is the CORS error quoted above.

Because `encodings` is one of the first modules Python loads from `python_stdlib.zip` at startup, the kernel aborts immediately when any of those files fails to come through cleanly.

### 3.3 Rejected alternatives

- **Have IT whitelist `cdn.jsdelivr.net`.** Cleanest in principle, but in practice slow, not guaranteed, and fragile — any proxy policy change can break it again.
- **Switch the Pyodide URL to a different CDN.** Only moves the problem elsewhere.

---

## 4. Solution: bundle Pyodide at build time

### 4.1 Principle

`jupyter lite build` accepts `--pyodide <path-or-url>`. Passing it a downloaded Pyodide tarball makes the build unpack Pyodide (including all distribution packages) into `static/pyodide/` in the site output and rewrite `pyodideUrl` to that relative path. At runtime the browser fetches every Pyodide file same-origin — CORS does not apply.

### 4.2 Pyodide version pin

**`314.0.6`** — the exact version `jupyterlite-pyodide-kernel 0.8.6` was built against. The authoritative source is `jupyterlite_pyodide_kernel.constants.PYODIDE_VERSION` inside the installed wheel. Any mismatch makes `jupyter lite build` fail with a lock-file hash error.

### 4.3 Dockerfile changes

Three additions in stage 1 bundle the tarball, two additions in stage 2 fix a MIME-type gap. See [Dockerfile](../Dockerfile) for the full file.

```dockerfile
# Stage 1 — add curl and download the Pyodide tarball.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG PYODIDE_VERSION=314.0.6
RUN curl -fsSLo /tmp/pyodide.tar.bz2 \
      "https://github.com/pyodide/pyodide/releases/download/${PYODIDE_VERSION}/pyodide-${PYODIDE_VERSION}.tar.bz2"

# ... the existing `jupyter lite build` line gets `--pyodide /tmp/pyodide.tar.bz2`
```

```dockerfile
# Stage 2 — teach nginx that .mjs is JavaScript.
# nginx-alpine's /etc/nginx/mime.types has no entry for .mjs, so pyodide.mjs
# (Pyodide ≥ 314's ES-module loader) would be served as application/octet-stream
# and the browser would refuse to load it as a module (strict MIME check for
# module scripts).
USER root
RUN sed -i -E 's#((application|text)/javascript[[:space:]]+)js;#\1js mjs;#' /etc/nginx/mime.types \
 && grep -Eq '(application|text)/javascript[[:space:]]+js mjs;' /etc/nginx/mime.types
USER 101
```

Notes:

- `PYODIDE_VERSION` is a build arg: `docker build --build-arg PYODIDE_VERSION=314.0.6 …` makes future bumps a one-liner.
- The `.mjs` MIME-type patch is specific to Pyodide ≥ 314.x, which switched its loader to an ES module. For older Pyodide versions (`.js` entry) the patch is harmless.
- The sed delimiter is `#` on purpose. BusyBox sed in Alpine parses `|` inside `s|…|…|` as the separator and would reject the alternation `(application|text)` with "bad option in substitution expression".
- The `grep -Eq` after `sed` makes the build fail loudly if a future base-image mime.types layout no longer matches the pattern.

### 4.4 `jupyter-lite.json`

**No change required.** `jupyter lite build --pyodide …` writes the relative `pyodideUrl` for us. The existing `loadPyodideOptions.packages` list is unaffected.

### 4.5 Renku launcher configuration (critical)

Discovered during roll-out: the launcher settings in Renku's UI are load-bearing. The following combination works. **UID 1000** (the Renku UI default) *appears* to work — the container starts and serves healthy — but Renku's Istio layer then applies different routing (`GET /` is rewritten to `/index.html` server-side with query parameters stripped; nginx redirects contain the internal service port `:8080`), which silently breaks the `odz-launcher` URL shape.

| Field | Value |
|---|---|
| Container Image | `ghcr.io/opendatazurich/opendatazurich_renku_lite:<tag>` |
| Default URL | `/lab` |
| Port | `8080` |
| Mount Directory | `/tmp/renku-work` |
| Working Directory | `/tmp` |
| UID | **101** |
| GID | **101** |
| Command (ENTRYPOINT) | `["/docker-entrypoint.sh"]` |
| Command Arguments (CMD) | `["nginx","-g","daemon off;"]` |
| Strip session URL path prefix | off |

UID/GID 101 match the `nginx` user inside `nginxinc/nginx-unprivileged:1.29-alpine`.

### 4.6 Trade-offs

| Aspect | Before | After |
|---|---|---|
| Runtime network dependencies | `cdn.jsdelivr.net`, `data.stadt-zuerich.ch`, `www.ogd.stadt-zuerich.ch` | Only `data.stadt-zuerich.ch`, `www.ogd.stadt-zuerich.ch` |
| Image size | ~50 MB | ~600 MB |
| Build time | ~1–2 min | +~1 min (download + extract) |
| Kernel start latency | 1× DNS/TLS to jsDelivr + downloads | Same-origin, HTTP/2 multiplexing, no third-party DNS |
| Pyodide upgrade | Transitive via `jupyterlite-pyodide-kernel` bump | Also bump `PYODIDE_VERSION` + rebuild image |
| Resilience to jsDelivr outage | Affected | Unaffected |

### 4.7 Impact on users without network restrictions

Practically no downside:

- **Cache-sharing was never a factor.** All major browsers (Chrome ≥ 85, Firefox ≥ 85, Safari) partition the HTTP cache by top-level site since ~2020. A visit to `pyodide.org` would not have cached Pyodide for this app anyway.
- **Latency** is marginally better same-origin: no extra DNS lookup, no second TLS session, HTTP/2 multiplexing on the same connection.
- **First-visit data volume** is unchanged (same ~20 MB core, packages on demand).

---

## 5. Validation

### 5.1 Local

```bash
docker build --build-arg PYODIDE_VERSION=314.0.6 -t odz-lite:local .
docker run --rm -p 18080:8080 odz-lite:local

# Site + proxy allowlist
tests/test_proxy.sh http://localhost:18080

# Playwright smoke test against real datasets
uv run playwright install chromium
uv run python tests/smoke_playwright.py http://localhost:18080
```

Also check manually:
- Browser DevTools → **Network** → filter `jsdelivr`. **No requests** must go to `cdn.jsdelivr.net`.
- All `pyodide*` requests go to `http://localhost:18080/static/pyodide/…` and return `200`.
- `pyodide.mjs` is served with `Content-Type: application/javascript` (or `text/javascript`), not `application/octet-stream`.

### 5.2 In the target network

Deploy the image to a Renku app under a **new name** so the existing app keeps running, and open the link from a machine in the corporate network:

```
https://<new-app-host>/?package_id=prd_ssz_ogd_katalog_inventar&resource_id=a74e6cb5-6683-4ea1-89ed-0dfdc96c6048
```

Acceptance criteria:
- Kernel starts without `ModuleNotFoundError: No module named 'encodings'`.
- `Run → Run All Cells` on the example notebook runs to the end.
- No CORS errors in the browser console.
- No requests to `cdn.jsdelivr.net` in the Network tab.

### 5.3 CI

[`.github/workflows/build.yaml`](../.github/workflows/build.yaml) builds the image on every PR and runs [`tests/test_proxy.sh`](../tests/test_proxy.sh) against the started container. No test changes required — the preloaded wheel list is unaffected.

---

## 6. Rollback

Pure configuration:

1. Drop the `--pyodide /tmp/pyodide.tar.bz2` argument from the `jupyter lite build` call.
2. Remove the Dockerfile additions (apt-get curl, `ARG PYODIDE_VERSION`, `RUN curl`, and the mime.types patch).
3. Rebuild and redeploy.

The kernel then loads from jsDelivr as before. No data loss, no migration, no schema change.

---

## 7. Follow-ups

- **Automate Pyodide version bumps.** The `PYODIDE_VERSION` default could come from a small file (e.g. `build/pyodide-version.txt`) that a GitHub Actions workflow keeps in sync with `jupyterlite-pyodide-kernel`. Not part of this change.
- **IT request in parallel.** The interception is independent of this workaround and remains a latent risk for other WASM apps on the same network. Worth asking IT for a clean TLS allowlist for `cdn.jsdelivr.net/pyodide/*` without response rewriting — with this fix as the interim solution.
