# Copyright (c) 2020 Gitpod GmbH. All rights reserved.
# Licensed under the GNU Affero General Public License (AGPL).
# See License-AGPL.txt in the project root for license information.

FROM caddy/caddy:2.4.0-beta.2-alpine

# Debug convenience
ENV TERM=xterm
ENV SHELL=/bin/bash

# Update alpine packages
RUN apk upgrade --no-cache

RUN apk add --no-cache \
  bash

COPY conf/* /etc/caddy/
