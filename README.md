# Pulsecheck

Outage tracker with no third-party dependencies and no Downdetector data.

Run (Node 18 or newer):

    node server.js
    open http://localhost:3000

Data sources:
1. Each service's own public status feed (Atlassian Statuspage JSON), polled every 60 seconds.
2. Problem reports submitted by visitors to your server. One report per visitor per service per 10 minutes.
   A service is flagged when 10 or more reports arrive within 15 minutes.

Test data without network: DEMO=1 node server.js

Settings (environment variables): PORT, POLL_MS, SPIKE_15MIN, SERVICES_FILE, TRUST_PROXY (set to 1 behind a hosting proxy), ALLOW_ADD (set to 0 to stop visitors adding services).

Add a service: append an entry to services.json. Any status page whose address ends in
/api/v2/summary.json works. Services without a public status feed (Netflix, Instagram, and
most large consumer apps) can only be covered by user reports, which needs a real audience.

Limits: reports and history are kept in data/state.json for 24 hours. The rate limit is
per IP address, so put the server behind a proxy that sets the right client address before
exposing it publicly, and add stronger spam protection if it gets traffic.
