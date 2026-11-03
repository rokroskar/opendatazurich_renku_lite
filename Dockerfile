# Stage 1: build the static JupyterLite site.
FROM python:3.12-slim-bookworm AS build
# Node is only needed to compile the JupyterLab extension (jlpm ships with jupyterlab).
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /src

# curl is used to fetch the Pyodide release tarball below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY build/requirements.txt build/
RUN pip install -r build/requirements.txt

COPY extension/odz-launcher extension/odz-launcher
RUN pip install --no-build-isolation ./extension/odz-launcher

COPY opendata_lite opendata_lite
COPY build/wheels.txt build/
RUN pip wheel --no-deps -w wheels ./opendata_lite \
 && pip download --no-deps --only-binary=:all: -d wheels -r build/wheels.txt

# Bundle the Pyodide runtime + distribution packages into the site, so the
# browser loads them same-origin instead of from cdn.jsdelivr.net. The version
# must match what jupyterlite-pyodide-kernel expects
# (jupyterlite_pyodide_kernel.constants.PYODIDE_VERSION).
ARG PYODIDE_VERSION=314.0.6
RUN curl -fsSLo /tmp/pyodide.tar.bz2 \
      "https://github.com/pyodide/pyodide/releases/download/${PYODIDE_VERSION}/pyodide-${PYODIDE_VERSION}.tar.bz2"

COPY jupyter_lite_config.json jupyter-lite.json overrides.json ./
COPY content content
# --pyodide unpacks the tarball into static/pyodide/ and rewrites pyodideUrl to
# that relative path, so no runtime CDN fetch is needed.
RUN jupyter lite build --pyodide /tmp/pyodide.tar.bz2 --output-dir /site

# Stage 2: serve it. Non-root nginx listening on 8080 (Renku app port).
FROM nginxinc/nginx-unprivileged:1.29-alpine
# Lets the entrypoint render ${NGINX_LOCAL_RESOLVERS} from /etc/resolv.conf
# (cluster DNS on Kubernetes) for the /proxy/ upstreams.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1

# Add .mjs to the javascript entry in mime.types. The nginx-alpine base image
# ships mime.types without it, so pyodide.mjs would otherwise be served as
# application/octet-stream and the browser would refuse to load it as an ES
# module (strict MIME-type checking for module scripts). The regex tolerates
# either `application/javascript` or `text/javascript` and tab/space separators;
# `grep -q` makes the build fail loudly if the pattern no longer matches.
USER root
# BusyBox sed in Alpine parses `|` inside an s||| expression as a separator,
# so the alternation (application|text) must live inside a different delimiter.
RUN sed -i -E 's#((application|text)/javascript[[:space:]]+)js;#\1js mjs;#' /etc/nginx/mime.types \
 && grep -Eq '(application|text)/javascript[[:space:]]+js mjs;' /etc/nginx/mime.types

COPY nginx/templates/ /etc/nginx/templates/
COPY --from=build /site /usr/share/nginx/html

USER 101
EXPOSE 8080
