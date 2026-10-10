# Provider networking

Native provider requests use one process-local network configuration. The first
provider operation reads `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`; lowercase
names take precedence, and `ALL_PROXY` is a fallback for unset protocol-specific
values. HTTP and HTTPS proxy URLs are supported. Proxy URLs are never embedded
in a book, model profile, or diagnostic error message.

Environment proxy support requires Node.js 24.14 or newer with
`http.setGlobalProxyFromEnv`. Packaged desktop builds use their bundled Node.js.
Without proxy variables, the existing default route remains in use. Proxy settings
are captured once per process; restart after changing them. The application does
not edit environment variables or the system proxy. Loopback addresses bypass the
proxy so local model endpoints stay local; other `NO_PROXY` exclusions are retained.

Model discovery, capability checks, connection preflight, and native generation
use the same configured HTTP/fetch route. External CLI workers retain their own
network configuration. Networking code stays in the desktop main process.

## Before translation

The book runner performs a fresh read-only `GET /models` check before acquiring
its run lease or reserving model tokens. Native Pi sessions reuse the successful
runtime check. Resuming through the book runner refreshes it. There is a bounded
15-second timeout, and cancellation remains effective.

Authentication rejection, TLS errors, and unavailable connections stop preflight
without a generation request. A `404` or `405` only establishes endpoint
reachability for services without a model catalogue; it does not certify model
availability or compatibility. The capability probe remains a separate check.

Runtime decorators can retain this startup contract with
`inheritProviderPreflight(originalStream, wrappedStream)`. Custom integrations can
also explicitly await `runtime.preflight()` before dispatching their own work.

## Explicit handshake compatibility

Some proxy routes cannot reliably carry the default hybrid TLS key share. After
confirming that failure separately from authentication and certificate errors,
set `FOLIOLOOM_TLS_COMPATIBILITY=classical` for the FolioLoom process, or pass
`tlsCompatibility: "classical"` to `createProviderRuntime`. The default remains
`default`; unknown values are rejected. A runtime captures its selection once.

Classical mode offers X25519, P-256 and P-384 for the selected provider requests.
It opts out of hybrid/post-quantum key exchange on those requests, but retains
TLS version negotiation (including TLS 1.3), hostname checks and certificate
validation. It uses the existing proxy snapshot and loopback exclusions, does not
change global TLS defaults, and cannot change an unrelated concurrent request's
transport. Preflight and generation use the same selected compatibility policy.
This is an explicit compatibility option, not an automatic retry or TLS fallback.

## Certificate validation failures

Certificate validation remains enabled. Nested TLS failures such as
`SELF_SIGNED_CERT_IN_CHAIN`, expired certificates, and hostname mismatches retain
their allowlisted error code as `PROVIDER_TLS`. Model discovery does not hide these
failures behind a fallback catalogue. Native streams retain the code through the
SDK wrapper, with request-local isolation for concurrent calls.

TLS and proxy configuration failures are non-retryable. Native SDK retries are
disabled; ordinary bounded book recovery remains responsible for eligible
transient failures. No retry can authorize an unknown certificate or reconcile
missing provider usage.

Verify the certificate issuer and network route before changing trust. If an
authorized inspection gateway requires an additional CA, configure only a verified
CA through the appropriate Node.js trust settings. Do not disable TLS validation
or automatically trust a certificate received from a failed connection.

References: [Node.js network configuration](https://nodejs.org/learn/http/enterprise-network-configuration)
and [Node.js certificate options](https://nodejs.org/download/release/v24.19.0/docs/api/cli.html#node_extra_ca_certsfile).
