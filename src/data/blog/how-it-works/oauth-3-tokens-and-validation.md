---
author: Anant Agarwal
pubDatetime: 2026-10-22T14:30:00Z
title: "How Does OAuth 2.0 Work? Part 3: Tokens, Cryptographic Validation, and Revocation"
featured: true
draft: false
tags:
  - oauth
  - jwt
  - security
  - api-gateway
  - kong
  - how-it-works
description: "A systems-level examination of the OAuth 2.0 token plane: OpenID Connect identity tokens, reference vs self-encoded tokens, RFC 9068, remote introspection, JWKS local validation, RFC 9470 step-up authentication challenges, and the distributed revocation problem."
---

Once an authorization flow completes, the protocol shifts from the control plane to the data plane. The client holds a set of credentials and begins transmitting them across network boundaries to access protected endpoints.

How does a Resource Server know an incoming token is legitimate? How does it verify who issued it without grinding central identity databases to a halt? What happens when a user changes their password or revokes an application while an access token is still active?

In [Part 1](/posts/how-it-works/oauth-1-architecture), we established the foundational architecture and system roles. In [Part 2](/posts/how-it-works/oauth-2-flows-and-runtimes), we explored grant types across diverse client environments.

In this installment, we dissect the internal mechanics of tokens:
1. OpenID Connect identity tokens versus OAuth access tokens
2. Reference (opaque) tokens versus self-encoded (JWT) tokens
3. Remote Token Introspection ([RFC 7662](https://datatracker.ietf.org/doc/html/rfc7662)) versus local JWKS verification ([RFC 7517](https://datatracker.ietf.org/doc/html/rfc7517))
4. The hybrid API Gateway pattern using Kong
5. Step-Up Authentication challenge protocol ([RFC 9470](https://datatracker.ietf.org/doc/html/rfc9470))
6. Sender-constrained tokens (DPoP and mTLS)
7. Token lifetimes and the distributed revocation dilemma

## Table of contents

## OpenID Connect: Identity Tokens vs Access Tokens

In Part 1, we introduced the hotel keycard analogy. Here, we examine the cryptographic and architectural differences between an **ID Token** and an **Access Token**.

| Dimension | OpenID Connect ID Token | OAuth 2.0 Access Token |
| :--- | :--- | :--- |
| **Primary Audience (`aud`)** | The Client Application | The Resource Server (API) |
| **Intended Consumer** | Parsed and verified by client code | Treated as opaque by client code |
| **Core Purpose** | Proves identity and session authentication | Grants delegated access to resources |
| **Format Standard** | Strictly JSON Web Token (JWT) | Undefined by RFC 6749 (opaque or JWT) |
| **Standard Specification** | OpenID Connect Core 1.0 | RFC 6749 / RFC 9068 |
| **Contains User Profile?** | Identity claims (`sub`, `auth_time`, `acr`); profile claims are often served via UserInfo instead (see below) | Minimal or internal claims only |

### Obtaining an ID Token
To upgrade a standard OAuth 2.0 flow to OpenID Connect, the client includes the reserved scope `openid` in the authorization request:

```http
GET /authorize?
  response_type=code&
  client_id=web-portal-91&
  redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback&
  scope=openid%20profile%20email&
  state=af0ifjsldkj&
  nonce=n-0S6_WzA2Mj&
  code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&
  code_challenge_method=S256 HTTP/1.1
Host: auth.example.com
```

Standard OIDC scopes request sets of user claims:
- `openid`: Mandatory trigger for OpenID Connect processing.
- `profile`: Requests default profile claims, e.g. `name`, `family_name`, `given_name`, `nickname`, `preferred_username`, `picture`, `locale`, `zoneinfo`, `updated_at`.
- `email`: Requests `email` and `email_verified`.
- `phone`: Requests `phone_number` and `phone_number_verified`.
- `address`: Requests structured physical postal address claims.

Where those claims are delivered matters. Per [OpenID Connect Core Section 5.4](https://openid.net/specs/openid-connect-core-1_0.html#ScopeClaims), when the flow issues an access token (as the code flow does), claims requested via these scopes are returned from the **UserInfo endpoint**, not embedded in the ID token. They appear in the ID token only when no access token is issued, or when explicitly requested via the `claims` parameter. Many providers include them in the ID token anyway, but that is provider behavior, not a guarantee of the spec.

When the client exchanges the authorization code at the token endpoint, the Authorization Server returns both an `access_token` and an `id_token`:

```json
{
  "access_token": "2YotnFZFEjr1zCsicMWpAA",
  "token_type": "Bearer",
  "expires_in": 3600,
  "id_token": "eyJhbGciOiJSUzI1NiIsImtpZCI6ImstMjAyNi1wcm9kLTA0In0.eyJpc3MiOiJodHRwczovL2F1dGguZXhhbXBsZS5jb20iLCJzdWIiOiJ1c2VyXzk0ODIwMTkiLCJhdWQiOiJ3ZWItcG9ydGFsLTkxIiwiZXhwIjoxNzA5MTIyNDAwLCJpYXQiOjE3MDkxMTg4MDAsIm5vbmNlIjoibi0wUzZfV3pBMk1qIn0.c2lnbmF0dXJl..."
}
```

### Hybrid Flows
In standard flows, the response type is `code`. OpenID Connect defines hybrid flows allowing clients to request multiple artifacts simultaneously in the front channel:
- `response_type=code id_token`: Returns the authorization code and an ID token immediately in the front channel redirect.

Use hybrid flows with caution. They put a token back in the front channel, so `nonce` becomes mandatory and the client must validate the `c_hash` claim to bind the ID token to the code. Today they are rarely recommended; their main real-world use was as a "detached signature" protecting the authorization response in FAPI 1.0. For most applications, the plain code flow with PKCE is the right choice.

### Validating an ID Token
The client application must strictly validate the ID token before trusting any embedded claims ([OIDC Core Section 3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)):
1. **Algorithm check.** Ensure `alg` matches the algorithm registered for this client (`id_token_signed_response_alg`, by default `RS256`). Always reject `none`. (OIDC also permits `HS256` signed with the client secret, but only if that is what was registered.)
2. **Cryptographic signature.** Fetch the public keys from the provider's JWKS endpoint and verify the digital signature *before* trusting any claim. (For the code flow, OIDC permits relying on the TLS connection to the token endpoint instead, but most libraries verify the signature anyway, and you should too.)
3. **Issuer check.** Assert that `iss` exactly matches the Authorization Server's issuer identifier.
4. **Audience check.** Assert that `aud` contains the client's own `client_id`. If `aud` contains multiple audiences, the `azp` (authorized party) claim **MUST** be present. If an `azp` claim is present (regardless of whether `aud` is a single string or an array), verify that it exactly equals your `client_id`.
5. **Expiration check.** Assert that current system time is strictly less than `exp` (with allowable clock skew, typically 60 seconds), and that `iat` is reasonable.
6. **Nonce check.** Assert that `nonce` matches the value sent in the authorization request.
7. **Authentication time.** If `max_age` was requested, verify `auth_time` is recent enough.
8. **Hash claims.** In hybrid flows, verify `c_hash` (and `at_hash` if an access token was returned from the authorization endpoint). If using the authorization code flow and the ID token includes an `at_hash` claim, verify that it matches the SHA-256 hash of the issued access token.

## Access Token Types: Reference vs Self-Encoded

RFC 6749 intentionally declined to standardize the internal structure of access tokens. In production systems, access tokens fall into two distinct architectural patterns.

```mermaid
flowchart TB
  subgraph ref["Reference token (opaque string)"]
    direction LR
    T1["Random high-entropy string<br/>splat-48201-abc-91823"]
    DB1[("Central token database<br/>Redis / SQL session store")]
    T1 -.->|Pointer lookup| DB1
  end
  subgraph val["Self-encoded token (JWT)"]
    direction LR
    T2["Structured JSON payload<br/>BASE64URL(Header).BASE64URL(Payload).BASE64URL(Sig)"]
    K2["Public key (JWKS)<br/>Local cryptographic math"]
    T2 -.->|Verified via| K2
  end
```

### 1. Reference Tokens (Opaque Tokens)
A reference token is a cryptographically random, high-entropy string containing no encoded data (e.g., at least 128 bits of randomness, such as 32 random bytes encoded with base64url). It acts as a database pointer.

When an API receives a reference token, it cannot extract any user details or scopes directly. It must query the central Authorization Server or a shared datastore (such as a shared Redis cluster) to resolve the token to an active session.

- **Advantage: Immediate Revocation.** Because the token is a pointer to a database row, invalidating a token is instantaneous. Deleting or flagging the database record causes every *subsequent* request carrying that token to be rejected, provided resource servers do not cache lookup results.
- **Disadvantage: Network Bottleneck and Latency.** Every single incoming API request across every microservice triggers a synchronous network hop to the token database. If an API cluster processes 50,000 requests per second, the token database must handle 50,000 queries per second with sub-millisecond latency.

### 2. Self-Encoded Tokens (Value Tokens / JWTs)
A self-encoded token contains the identity claims, granted scopes, and expiration timestamp embedded directly within the token string, cryptographically signed by the Authorization Server's private key.

- **Advantage: Horizontal Scalability.** Resource servers validate tokens locally using asymmetric cryptography. No database lookups or inter-service network calls are required. Services scale independently without placing load on the central identity infrastructure.
- **Disadvantage: Delayed Revocation.** Once signed and issued, a self-encoded token remains valid until its expiration timestamp (`exp`) passes. If an administrator revokes a user's permissions, APIs validating the token locally will continue honoring it until it expires.

## Anatomy of a JWT Access Token (RFC 9068)

While early implementations formatted access tokens ad-hoc, [RFC 9068 (JSON Web Token Profile for OAuth 2.0 Access Tokens)](https://datatracker.ietf.org/doc/html/rfc9068) formalizes an explicit standard profile.

A JWT consists of three Base64URL-encoded segments separated by periods:

```text
JWT = Base64URL(Header) . Base64URL(Payload) . Base64URL(Signature)
```

### 1. The Header
Declares the cryptographic algorithm and key identifier used to sign the token:

```json
{
  "typ": "at+jwt",
  "alg": "RS256",
  "kid": "k-2026-prod-04"
}
```

- `typ`: [RFC 9068 Section 2.1](https://datatracker.ietf.org/doc/html/rfc9068#section-2.1) mandates `at+jwt` (Access Token + JWT), and [Section 4](https://datatracker.ietf.org/doc/html/rfc9068#section-4) requires resource servers to verify it. The value `application/at+jwt` is equivalent, so compare case-insensitively and accept the optional `application/` prefix. This prevents token confusion attacks where an attacker presents an ID token (or another JWT) to an API expecting an access token.
- `alg`: The cryptographic algorithm (e.g., `RS256`, `ES256`).
- `kid`: Key ID. Identifies which public key in the Authorization Server's key set should be used to verify the signature.

### 2. The Payload (Claims)
Contains the authorization assertions:

```json
{
  "iss": "https://auth.example.com",
  "sub": "user_9482019",
  "aud": "https://api.example.com/orders",
  "client_id": "web-portal-91",
  "exp": 1709122400,
  "iat": 1709118800,
  "jti": "b982c7a1-8d23-41a4-92e1-45c9281a8123",
  "scope": "read:orders write:orders"
}
```

- `iss` (Issuer): The URI of the Authorization Server that minted the token.
- `sub` (Subject): The unique identifier of the Resource Owner.
- `aud` (Audience): The intended recipient. Resource servers must verify that their own service identifier matches `aud`.
- `client_id`: The identifier of the application that requested the token.
- `exp` (Expiration Time): Unix epoch timestamp after which the token must be rejected.
- `iat` (Issued At): Unix epoch timestamp of token creation.
- `jti` (JWT ID): A unique string identifying this individual token. It enables revocation tracking and audit logging. (Bearer access tokens are *meant* to be presented many times, so `jti` is not a replay defense here; replay detection via `jti` applies to one-time assertions such as client assertions and DPoP proofs.)
- `scope`: Space-separated list of authorized permissions.

### 3. The Cryptographic Signature
The signature is generated over the combined header and payload using the Authorization Server's private key:

```text
Signature = Sign(K_private, Base64URL(Header) + "." + Base64URL(Payload))
```

The Resource Server verifies the signature using the matching public key `K_public`.

## Token Validation: Remote Introspection vs Local JWKS

Resource Servers choose between two distinct validation mechanics.

```mermaid
flowchart TB
  subgraph introspection["Remote introspection (RFC 7662)"]
    direction LR
    RSI["Resource server"]
    ASI["Authorization server<br/>POST /introspect"]
    RSI <-->|"HTTP roundtrip per call (unless cached)<br/>Checks active status"| ASI
  end
  subgraph jwks["Local cryptographic validation (RFC 7517)"]
    direction LR
    RSJ["Resource server<br/>In-memory key cache"]
    ASJ["Authorization server<br/>GET jwks_uri"]
    ASJ -.->|Periodic fetch / TTL cache| RSJ
    RSJ -->|Local CPU math<br/>Zero network hops| RSJ
  end
```

### Approach 1: Remote Token Introspection (RFC 7662)
In the introspection model, the Resource Server does not validate the token locally. It sends the token to the Authorization Server's introspection endpoint over HTTPS. This works for opaque reference tokens, and also for JWT access tokens when the RS needs an authoritative, up-to-date revocation check.

```http
POST /oauth/introspect HTTP/1.1
Host: auth.example.com
Authorization: Basic YXBpLWdhdGV3YXk6c2VjcmV0
Content-Type: application/x-www-form-urlencoded

token=splat-48201-abc-91823&token_type_hint=access_token
```

The Authorization Server inspects its active database state and returns a JSON payload:

```json
{
  "active": true,
  "scope": "read:orders",
  "client_id": "web-portal-91",
  "sub": "user_9482019",
  "aud": "https://api.example.com/orders",
  "iss": "https://auth.example.com",
  "exp": 1709122400
}
```

If the token was revoked, expired, or tampered with, the server returns `{"active": false}`.

**Pros:**
- Detects revocation immediately (as long as results are not cached).
- Resource servers require no cryptographic libraries or key rotation logic.

**Cons:**
- Significant performance penalty: every client API request incurs a synchronous HTTP request to the Authorization Server. [RFC 7662 Section 4](https://datatracker.ietf.org/doc/html/rfc7662#section-4) allows resource servers to cache introspection responses, which trades this latency against a revocation delay equal to the cache lifetime.
- Creates a single point of failure and bottleneck across the entire backend infrastructure.

### Approach 2: Local Cryptographic Validation via JWKS (RFC 7517)
In the local validation model, the Authorization Server publishes its public verification keys as a **JSON Web Key Set (JWKS)** at an unauthenticated, publicly reachable URL. There is no standardized path for this file. Resource servers discover it through the `jwks_uri` field of the AS metadata document, published at `/.well-known/openid-configuration` ([OpenID Connect Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html)) or `/.well-known/oauth-authorization-server` ([RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414)):

```json
{
  "issuer": "https://auth.example.com",
  "jwks_uri": "https://auth.example.com/oauth/jwks"
}
```

A standard JWKS response contains an array of public cryptographic keys:

```json
{
  "keys": [
    {
      "kty": "RSA",
      "use": "sig",
      "alg": "RS256",
      "kid": "k-2026-prod-04",
      "n": "u1W1x...[Base64URL encoded RSA modulus]...",
      "e": "AQAB"
    }
  ]
}
```

#### Verification Pipeline on the Resource Server:
1. **Cache keys in memory.** On startup, the Resource Server fetches the JWKS from `jwks_uri` and parses the RSA or elliptic curve public keys into an in-memory key cache.
2. **Inspect token header.** When an API request arrives with `Authorization: Bearer <JWT>`, the server reads the unverified header, checks that `typ` is `at+jwt`, and extracts the `kid` (Key ID).
3. **Lookup public key.** The server locates the public key matching `kid` in its cache. If the key is missing (indicating an in-flight key rotation), it re-fetches the JWKS, but **rate-limits these re-fetches** (e.g. at most once per minute). Otherwise an attacker can send tokens with random `kid` values and turn every request into a load spike on the Authorization Server.
4. **Verify signature.** The server pins the algorithm to the one expected for that key (never trusting the token's `alg` header blindly, which blocks RS256→HS256 key-confusion attacks) and verifies the signature over the encoded header and payload.
5. **Assert claims.** The server validates `exp > now` and `nbf <= now` (with small clock skew), `iss == expected_issuer`, that `aud` (which may be an array) contains `my_service_id`, and that `scope` includes the permissions required by the endpoint.

**Performance characteristics:** Local validation requires zero network I/O. Verification is a pure CPU-bound mathematical operation executed in microseconds.

## The Best of Both Worlds: API Gateway Architecture (Kong)

In modern microservice architectures, forcing every individual backend service to download keys, validate signatures, and parse scopes leads to massive code duplication and inconsistent security posture.

The enterprise solution is the **API Gateway Pattern**, positioned at the ingress boundary of the private service mesh.

```mermaid
flowchart TB
  subgraph external["External public traffic"]
    EXT["Public client request<br/>Bearer JWT Access Token"]
  end
  subgraph perimeter["Perimeter edge"]
    KONG["Kong API gateway<br/>Validates JWT / JWKS<br/>Checks rate limits and IP"]
  end
  subgraph mesh["Internal service network"]
    SVC1["Order service"]
    SVC2["Payment service"]
    SVC3["Inventory service"]
  end
  EXT ==> KONG
  KONG -->|Enriched headers<br/>X-User-Id: user_9482019<br/>X-Scopes: read:orders| SVC1
  KONG -->|Enriched headers| SVC2
  KONG -->|Enriched headers| SVC3
  classDef control stroke-width:2px;
  classDef data stroke-width:2px;
  class KONG control;
  class SVC1,SVC2,SVC3 data;
```

### The Kong Gateway Implementation
Kong Gateway sits as a reverse proxy in front of the application cluster:

1. **Edge JWT Verification.** Which plugin you use matters:
   - The open-source **`jwt` plugin** verifies signatures against keys pre-registered on Kong *Consumers*, matched by a claim such as `iss`. It does **not** fetch JWKS automatically and does **not** enforce scopes.
   - The Kong Enterprise **`openid-connect` plugin** performs JWKS discovery and caching from the issuer's metadata, signature and algorithm enforcement, expiration checks, and (optionally) introspection.
2. **Perimeter Scope Enforcement.** With the `openid-connect` plugin (e.g. its `scopes_required` setting), Kong validates that the incoming token possesses the required scopes for the matching route before allowing the request into the internal network. With the OSS `jwt` plugin, scope checks must be added separately.
3. **Identity Header Injection.** Upon successful verification, Kong injects trusted internal headers for the upstream services:
   ```http
   X-User-Id: user_9482019
   X-Client-Id: web-portal-91
   X-Authorized-Scopes: read:orders write:orders
   ```
4. **Reduced Cryptographic Overhead Upstream.** The upstream microservices (written in Go, Python, or Java) do not need JWT validation libraries or JWKS polling logic. They read identity claims from the headers injected by the gateway.

This pattern is only safe if two invariants hold:
- **The gateway strips any client-supplied identity headers** (`X-User-*`, `X-Client-Id`, and so on) before injecting its own. Otherwise an attacker simply sends `X-User-Id: admin`.
- **Services accept traffic only from the gateway**, enforced with mTLS or network policy. If anything else on the network can reach a service directly, it can forge the headers.

For a genuinely zero-trust posture, forward the original JWT (or a short-lived internal token signed by the gateway) so each service can verify the identity cryptographically instead of trusting plain headers.

## Step-Up Authentication: The RFC 9470 Challenge Protocol

We have seen how a Resource Server or API Gateway validates signatures, expiration timestamps, and authorized scopes. But real-world authorization policies are rarely binary.

Consider a banking application:
- A user logs in with a password and browses their recent checking account balance.
- Five minutes later, the user clicks "Transfer \$25,000 to External Account" or "Add New Wire Recipient".

Should the application force the user to complete a hardware security key (FIDO2/WebAuthn) prompt or biometric verification simply to view their transaction feed? Doing so creates intolerable friction and degrades user experience. Conversely, should the API permit a high-value wire transfer using an access token that was minted under basic single-factor authentication two hours ago? Doing so exposes the user to catastrophic account takeovers and session hijacking.

The security requirement is **adaptive, step-up authentication**: low-assurance interactions proceed with minimal friction, but privileged or high-risk endpoints require an elevated level of authentication assurance (e.g., Multi-Factor Authentication) or recent authentication freshness (e.g., authenticated within the last 5 minutes).

Until recently, OAuth 2.0 lacked a standardized mechanism for an API to instruct a client to elevate its authentication context. In October 2023, the IETF published **[RFC 9470: OAuth 2.0 Step-Up Authentication Challenge Protocol](https://datatracker.ietf.org/doc/html/rfc9470)**, formalizing this handshake across Resource Servers, Clients, and Authorization Servers.

### The RFC 6750 Gap

Standard OAuth 2.0 Bearer Token Usage ([RFC 6750 Section 3.1](https://datatracker.ietf.org/doc/html/rfc6750#section-3.1)) defines only three standard error codes for the `WWW-Authenticate` response header:

1. `invalid_request`: The request is missing a parameter or is otherwise malformed.
2. `invalid_token`: The access token is expired, revoked, malformed, or has an invalid signature.
3. `insufficient_scope`: The token is valid, but lacks the OAuth scope required for the resource (e.g., the token has `read:account` but the endpoint requires `write:transfers`).

Notice what was missing. If a client presents a valid token that has the `write:transfers` scope, but the underlying authentication was single-factor rather than multi-factor, none of the RFC 6750 errors apply:
- The request is not an `invalid_request`.
- The token is not an `invalid_token` (its cryptographic signature, issuer, and expiration are perfectly valid).
- It is not an `insufficient_scope` problem (the user already granted consent for the `write:transfers` scope).

Before RFC 9470, engineering teams improvised proprietary workarounds—returning generic `403 Forbidden` statuses, ad-hoc JSON payloads like `{"error": "mfa_required"}`, or non-standard HTTP headers. Clients had no vendor-neutral, machine-readable protocol to determine:
1. *Why* the operation was rejected.
2. *What* exact authentication strength (`acr`) the resource requires.
3. *How fresh* the authentication session (`max_age`) must be.
4. *How* to invoke the Authorization Server to satisfy the requirement without breaking existing sessions.

### Extending RFC 6750: The `insufficient_user_authentication` Error

RFC 9470 cleanly resolves this dilemma by extending RFC 6750 with a fourth standardized error code:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="insufficient_user_authentication",
  error_description="Multi-factor authentication and fresh login required",
  acr_values="https://refeds.org/profile/mfa urn:example:auth:fido2",
  max_age="300"
```

RFC 9470 defines two dedicated challenge attributes in the `WWW-Authenticate` header:

- **`acr_values` (Authentication Context Class Reference):** A space-separated list of string identifiers specifying the acceptable authentication classes, ordered by preference. These correspond directly to the `acr` claim defined in OpenID Connect and [RFC 9068 Section 2.2.1](https://datatracker.ietf.org/doc/html/rfc9068#section-2.2.1) (e.g., `https://refeds.org/profile/mfa`, `phr`, or organizational values like `gold`).
- **`max_age` (Authentication Freshness):** A non-negative integer specifying the maximum allowable elapsed time in seconds between the user's authentication event (`auth_time`) and the current request. If the user authenticated 20 minutes ago and `max_age=300` (5 minutes), the authentication is too stale for this sensitive operation.

> [!IMPORTANT]
> **Why HTTP 401 instead of 403?**
> A common point of confusion is HTTP status semantics. Developers often assume that because the token is syntactically valid, the response should be `403 Forbidden`. However, in HTTP architecture ([RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.2) and RFC 6750), the `WWW-Authenticate` challenge header is strictly defined for `401 Unauthorized` responses. An HTTP 403 status conveys a permanent refusal that does not invite re-authentication with new credentials. RFC 9470 mandates HTTP 401 because the client can remediate the challenge and retry the request.

### The End-to-End Challenge-Response Flow

RFC 9470 establishes a clear multi-party sequence involving the Client, Resource Server, Authorization Server, and End User:

```mermaid
sequenceDiagram
  autonumber
  actor User as End User
  participant Client as Client Application
  participant RS as Resource Server (API)
  participant AS as Authorization Server

  Note over User,Client: User logged in via basic password (acr="pwd")
  Client->>RS: POST /api/v1/transfers (Bearer token with acr="pwd")
  Note over RS: Policy check: Endpoint requires<br/>acr="https://refeds.org/profile/mfa" and max_age="300".<br/>Token has acr="pwd" -> Insufficient!
  RS-->>Client: 401 Unauthorized<br/>WWW-Authenticate: Bearer error="insufficient_user_authentication",<br/>acr_values="https://refeds.org/profile/mfa", max_age="300"

  Note over Client: Client parses challenge,<br/>extracts acr_values and max_age
  Client->>AS: Authorization Request (GET /authorize or PAR)<br/>?client_id=...&acr_values=https://refeds.org/profile/mfa&max_age=300
  
  Note over AS,User: AS detects session lacks required MFA.<br/>Prompts user for step-up factor (e.g. FIDO2 / WebAuthn).
  AS->>User: Challenge: Present Security Key or Biometric
  User-->>AS: User completes FIDO2 WebAuthn ceremony
  
  AS-->>Client: Authorization Code redirect
  Client->>AS: POST /oauth/token (code + code_verifier)
  AS-->>Client: New Access Token (JWT with acr="https://refeds.org/profile/mfa", auth_time=now)
  
  Client->>RS: POST /api/v1/transfers (New Bearer token)
  Note over RS: Evaluates new token:<br/>acr satisfies policy AND (now - auth_time) <= 300.<br/>Policy satisfied!
  RS-->>Client: 200 OK {"transfer_id": "tx_91823", "status": "approved"}
```

### Deep Dive: Protocol Wire Messages

To see how the protocol operates in practice, trace the actual HTTP messages exchanged across the boundaries:

#### 1. The Initial API Request
The client attempts to execute a high-risk operation using an access token that was issued when the user initially logged in with a single password:

```http
POST /api/v1/wire-transfers HTTP/1.1
Host: api.bank.example.com
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6ImF0K2p3dCIsImtpZCI6ImsyMDI2LTA0In0.eyJpc3MiOiJodHRwczovL2F1dGguYmFuay5leGFtcGxlLmNvbSIsInN1YiI6InVzZXJfOTQ4MjAxOSIsImF1ZCI6Imh0dHBzOi8vYXBpLmJhbmsuZXhhbXBsZS5jb20iLCJzY29wZSI6InRyYW5zZmVyczp3cml0ZSIsImFjciI6InB3ZCIsImF1dGhfdGltZSI6MTcwOTExODAwMCwiZXhwIjoxNzA5MTI1MjAwfQ.d7K...
Content-Type: application/json

{
  "recipient_iban": "NL91ABNA0417164300",
  "amount": 25000.00,
  "currency": "EUR"
}
```

#### 2. The Resource Server Challenge
The Resource Server (or API Gateway) checks the token. While the signature is verified, the token is not expired, and the scope `transfers:write` is present, the local policy requires `acr` of `https://refeds.org/profile/mfa` and an authentication within the last 300 seconds (`max_age=300`). 

The RS responds with the RFC 9470 challenge:

```http
HTTP/1.1 401 Unauthorized
Date: Wed, 28 Feb 2024 11:35:00 GMT
WWW-Authenticate: Bearer error="insufficient_user_authentication",
  error_description="A multi-factor authentication event within the last 5 minutes is required to execute wire transfers.",
  acr_values="https://refeds.org/profile/mfa",
  max_age="300"
```

#### 3. Client Step-Up Authorization Request
The client catches the `401 Unauthorized`, extracts the `error` parameter, and recognizes `insufficient_user_authentication`. It reads `acr_values` and `max_age` and constructs an authorization request to the Authorization Server. 

In modern deployments using Pushed Authorization Requests ([RFC 9126](https://datatracker.ietf.org/doc/html/rfc9126), detailed in Part 4), the client pushes these parameters directly to the back-channel endpoint, but the parameters can also be sent via front-channel query parameters:

```http
GET /authorize?response_type=code
  &client_id=web-banking-portal
  &redirect_uri=https%3A%2F%2Fbank.example.com%2Fcallback
  &scope=transfers%3Awrite
  &state=xyz987654321
  &code_challenge=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
  &code_challenge_method=S256
  &acr_values=https%3A%2F%2Frefeds.org%2Fprofile%2Fmfa
  &max_age=300 HTTP/1.1
Host: auth.bank.example.com
```

Alternatively, OpenID Connect clients can request these constraints using the structured `claims` parameter ([OIDC Core 1.0 Section 5.5](https://openid.net/specs/openid-connect-core-1_0.html#ClaimsParameter)), marking the `acr` claim as `essential`:

```json
{
  "id_token": {
    "acr": { "essential": true, "values": ["https://refeds.org/profile/mfa"] },
    "auth_time": { "essential": true }
  }
}
```

> [!NOTE]
> While the OIDC `claims` parameter traditionally requests claims for the ID token and userinfo endpoint, the Authorization Server must mirror the fulfilled `acr` and `auth_time` into the issued **access token** (or introspection response) so the Resource Server can verify compliance. For standard OAuth 2.0 API protection, passing `acr_values` and `max_age` directly as top-level parameters (or via PAR) is the preferred approach.

#### 4. Authorization Server Evaluation
When the Authorization Server receives the request:
- If the user's active session at the identity provider already meets the requested `acr` and freshness requirements (for instance, if the user recently performed WebAuthn for another enterprise service in the same browser session), the AS does not prompt the user at all. It immediately issues an authorization code.
- If the current session falls short (e.g. the session only used a password, or `auth_time` was 35 minutes ago), the AS triggers the required authentication flow—prompting the user for their FIDO2 passkey, security key, or TOTP code.
- **Handling refusal or missing factors:** If the user cancels the challenge, fails authentication, or lacks the necessary credentials to satisfy the requested `acr`, the AS must not issue a token with lower assurance. Instead, per [RFC 9470 Section 5](https://datatracker.ietf.org/doc/html/rfc9470#section-5), the AS returns `error=unmet_authentication_requirements` to the client's redirect URI, terminating the flow cleanly and preventing an infinite redirect loop (`RS 401` &rarr; `Client AS redirect` &rarr; `AS re-issues weak token` &rarr; `RS 401`).

Once the factor is verified, the AS issues an authorization code, which the client exchanges at the token endpoint for a new access token.

#### 5. Upgraded Access Token
The newly minted access token reflects the elevated authentication context in compliance with [RFC 9068 Section 2.2.1](https://datatracker.ietf.org/doc/html/rfc9068#section-2.2.1):

```json
{
  "iss": "https://auth.bank.example.com",
  "sub": "user_9482019",
  "aud": "https://api.bank.example.com",
  "client_id": "web-banking-portal",
  "scope": "transfers:write",
  "acr": "https://refeds.org/profile/mfa",
  "amr": ["pwd", "fido"],
  "auth_time": 1709121300,
  "iat": 1709121305,
  "exp": 1709124905,
  "jti": "e4f8a29b-90c1-4b72-841f-817290bcda71"
}
```

Notice the key claims:
- `"acr": "https://refeds.org/profile/mfa"` satisfies the requested authentication class.
- `"amr": ["pwd", "fido"]` (Authentication Methods References) documents that both a password and a FIDO credential were provided.
- `"auth_time": 1709121300` records the exact Unix epoch timestamp of the step-up event, well within the 300-second window.

#### 6. Successful Retry
The client replays the original `POST /api/v1/wire-transfers` request with the upgraded token. The Resource Server validates the token signature, checks that `now - auth_time <= 300`, and verifies that `acr == "https://refeds.org/profile/mfa"`. The request succeeds with `200 OK`.

### Step-Up with Opaque Reference Tokens (Introspection)

What if the Resource Server does not use self-encoded JWTs, but instead validates tokens using remote token introspection ([RFC 7662](https://datatracker.ietf.org/doc/html/rfc7662))?

[RFC 9470 Section 6.2](https://datatracker.ietf.org/doc/html/rfc9470#section-6.2) specifically addresses this architecture. It extends the token introspection response schema by adding top-level `acr` and `auth_time` attributes:

```http
POST /oauth/introspect HTTP/1.1
Host: auth.bank.example.com
Authorization: Basic YXBpLWdhdGV3YXk6c2VjcmV0
Content-Type: application/x-www-form-urlencoded

token=splat-94820-ref-token&token_type_hint=access_token
```

The Authorization Server returns the active metadata including the authentication context:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "active": true,
  "scope": "transfers:write",
  "client_id": "web-banking-portal",
  "sub": "user_9482019",
  "aud": "https://api.bank.example.com",
  "iss": "https://auth.bank.example.com",
  "exp": 1709124905,
  "iat": 1709121305,
  "auth_time": 1709121300,
  "acr": "https://refeds.org/profile/mfa"
}
```

This allows API Gateways and microservices using reference tokens to enforce identical step-up policies without sacrificing the immediate revocation benefits of centralized introspection.

### Interaction with DPoP and Sender Constraints

Step-up authentication is completely orthogonal to whether an access token is a bearer token or a sender-constrained token:

- When using **DPoP ([RFC 9449](https://datatracker.ietf.org/doc/html/rfc9449))**, the Resource Server issues the challenge under the `DPoP` authentication scheme:
  ```http
  HTTP/1.1 401 Unauthorized
  WWW-Authenticate: DPoP error="insufficient_user_authentication",
    acr_values="https://refeds.org/profile/mfa",
    max_age="300"
  ```
  The client performs the step-up flow with the Authorization Server and binds the new upgraded access token to its existing DPoP keypair (`cnf.jkt`).
- When using **Mutual TLS ([RFC 8705](https://datatracker.ietf.org/doc/html/rfc8705))**, the step-up challenge uses the `Bearer` or `mTLS` scheme over the existing mTLS connection, and the newly minted access token is bound to the client's certificate thumbprint (`cnf.x5t#S256`).

By separating *how a token is constrained* from *the authentication assurance level of the user who authorized it*, OAuth maintains clean composability: DPoP protects the token from exfiltration, while RFC 9470 protects sensitive endpoints from under-authenticated actions.

While step-up authentication ensures that tokens carrying high privileges were authorized under strong, recent authentication factors, standard access tokens are still *bearer* tokens by default: whoever captures the token can replay it against the API until it expires. To close the exfiltration vector completely, high-security architectures turn to sender-constrained tokens.

## Sender-Constrained Tokens: Beyond Bearer

Everything above assumes **bearer tokens**: whoever holds the token can use it ([RFC 6750](https://datatracker.ietf.org/doc/html/rfc6750)). Short lifetimes and revocation limit the damage of theft, but they do not prevent it. **Sender-constrained tokens** close this gap by binding a token to a cryptographic key that only the legitimate client holds. A stolen token is useless without that key.

### DPoP: Demonstrating Proof of Possession (RFC 9449)
[DPoP](https://datatracker.ietf.org/doc/html/rfc9449) works at the application layer, which makes it usable from SPAs and mobile apps:
1. The client generates an asymmetric key pair. In a browser, this can be a **non-extractable** WebCrypto key, so even XSS cannot export it.
2. On every token request and every API call, the client sends a `DPoP` header containing a short-lived JWT (the *DPoP proof*) signed with its private key. The proof covers the HTTP method, the URL, a timestamp, a unique `jti`, and (for API calls) a hash of the access token.
3. The Authorization Server binds the issued tokens to the key's thumbprint, recorded in the access token's `cnf.jkt` claim, and uses the token type `DPoP` instead of `Bearer`.
4. The Resource Server verifies that the proof is signed by the key named in `cnf.jkt`, matches the current request, is fresh, and has not been replayed (using the proof's `jti`).

### Mutual TLS Certificate-Bound Tokens (RFC 8705)
With [mTLS-bound tokens](https://datatracker.ietf.org/doc/html/rfc8705#section-3), the client authenticates with an X.509 certificate during the TLS handshake. The AS embeds the certificate's SHA-256 thumbprint in the token's `cnf.x5t#S256` claim, and the Resource Server checks that the presented client certificate matches. This is a natural fit for server-to-server and M2M traffic, where certificates are already managed.

The Security BCP ([RFC 9700](https://datatracker.ietf.org/doc/html/rfc9700)) recommends sender-constraining access tokens, and requires refresh tokens issued to public clients to be either sender-constrained or rotated.

## Choosing Token Lifetimes

Designing token lifetimes requires balancing operational risk against user friction.

```mermaid
flowchart LR
  subgraph short["Short lifetime (5–15 minutes)"]
    S1["High security<br/>Small exposure window"]
    S2["Requires frequent refresh<br/>Higher auth server load"]
  end
  subgraph long["Long lifetime (days–weeks)"]
    L1["Low auth server load<br/>Seamless user UX"]
    L2["High vulnerability<br/>Cannot revoke quickly"]
  end
```

### Short Token Lifetimes (5 to 15 Minutes)
Setting access token lifespans between 300 and 900 seconds is the standard for high-security environments:
- **Minimizes the blast radius of exfiltration.** If an access token is intercepted via network monitoring or memory dumps, it becomes useless within minutes.
- **Enforces frequent policy re-evaluation.** To continue working, the client must use its refresh token, allowing the Authorization Server to check if the user account is locked, suspended, or flagged for suspicious activity.

### Long Token Lifetimes (Hours to Days)
Longer lifetimes reduce CPU load on the Authorization Server and handle offline or intermittent connectivity gracefully. However, they drastically expand the vulnerability window.

### Contextual and Sliding Lifetimes
Modern identity providers employ dynamic, risk-based token lifespans:
- **High-risk contexts.** If an access token request originates from an unrecognized IP address, a new device fingerprint, or an anomalous geographical location, the server issues a short token (e.g., 2 minutes) and restricts scopes.
- **Low-risk contexts.** Internal corporate workstations on managed networks receive standard 60-minute tokens.
- **Step-up re-authentication ([RFC 9470](https://datatracker.ietf.org/doc/html/rfc9470)).** When invoking high-value operations (e.g., changing wire transfer routing or generating API credentials), the resource server validates the token's `acr` (authentication context) and `auth_time` claims against local policy. If authentication is too weak or too stale, the server challenges the client with `WWW-Authenticate: Bearer error="insufficient_user_authentication"` alongside the required `acr_values` and `max_age`, sending the user through the step-up flow detailed in the [Step-Up Authentication section](#step-up-authentication-the-rfc-9470-challenge-protocol) above.

## Handling Revoked and Invalidated Access Tokens

Why does an access token need to be revoked before its scheduled expiration?
1. The user logs out of their session.
2. The user changes their master password (whether this revokes existing tokens is a policy decision of the Authorization Server).
3. An administrator terminates employee privileges or disables an account.
4. Security telemetry detects anomalous token use from multiple continents simultaneously.
5. The user revokes third-party app consent via an account settings portal.

### The Problem with Local Validation: The Staleness Window
Herein lies the fundamental trade-off of self-encoded tokens. If an access token is a stateless JWT validated locally via JWKS, **the Resource Server has no idea the token was revoked.**

If an access token has a lifetime of 60 minutes and the user is fired at minute 5, the access token continues to work against all resource servers for another 55 minutes. This delay is known as the **staleness window** or **revocation lag**.

```mermaid
sequenceDiagram
  autonumber
  actor Admin as Administrator
  participant AS as Authorization Server
  actor Mal as Malicious Actor (Compromised JWT)
  participant RS as Resource Server (Local JWKS)

  Admin->>AS: Revoke user account (Time = 0m)
  Note over AS: User marked disabled in DB
  Mal->>RS: GET /api/sensitive with JWT (exp = 60m)
  Note over RS: Checks local signature & exp.<br/>Signature is valid! exp > now!<br/>RS has no knowledge of revocation!
  RS-->>Mal: 200 OK (Confidential Data Leaked!)
```

### Mitigations: Solving the Distributed Revocation Problem

Engineering teams employ three primary strategies to handle token revocation without destroying system scalability:

#### 1. Short TTLs with Refresh Token Rotation
The most common approach relies on very short access token lifetimes (e.g., 5 minutes) paired with stateful refresh token management:
- Access tokens cannot be revoked instantly, but their maximum window of vulnerability is capped at 5 minutes.
- Revocation occurs at the Authorization Server by revoking the **Refresh Token** ([RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009)). If the AS supports it, revoking a refresh token should also revoke the access tokens issued from it, though locally validated JWTs will not notice until they expire.
- When the client attempts to renew the access token 5 minutes later, the refresh request is denied, halting further API access permanently.

#### 2. Distributed Revocation Lists (Blocklists via Redis)
When sub-second revocation is an absolute compliance requirement, architectures introduce an out-of-band invalidation channel:
- When a token is revoked, the Authorization Server writes the token's unique identifier (`jti`) into a distributed, in-memory Redis cluster with a Time-To-Live (TTL) equal to the token's remaining lifespan.
- When Resource Servers (or the API Gateway) validate an incoming JWT, they verify the cryptographic signature locally, then execute a sub-millisecond check against Redis:
  ```text
  EXISTS revoked:tokens:b982c7a1-8d23-41a4-92e1-45c9281a8123
  ```
- Because keys auto-expire in Redis when the token's original `exp` arrives, memory overhead remains bounded and predictable.

Two refinements are common in practice:
- **Per-subject "not-before" timestamps.** A per-`jti` blocklist cannot handle "disable this user", because the Authorization Server rarely knows every outstanding `jti`. Instead, store `revoked_before:{sub} = <timestamp>` and reject any token for that subject whose `iat` is earlier.
- **Push instead of pull.** A Redis lookup on every request brings back the network dependency that JWTs were meant to remove. Many teams instead publish revocation events over pub/sub and keep an in-process cache (or Bloom filter) on each resource server.

#### 3. Backchannel Logout (OpenID Connect)
In federated environments, [OpenID Connect Back-Channel Logout 1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html) establishes direct server-to-server notifications. When a user logs out at the identity provider, the Authorization Server fires HTTP POST requests containing a `logout_token` directly to registered **client applications (relying parties)**, triggering local session destruction.

Note its scope: back-channel logout ends *client sessions*. It does **not** invalidate access tokens that resource servers are already accepting. To push revocation and security events to resource servers, look at the [OpenID Shared Signals Framework](https://openid.net/wg/sharedsignals/) and its Continuous Access Evaluation Profile (CAEP), which let an identity provider stream events such as "session revoked" or "credential changed" to any subscribed service.

## Recap: The Three Layers of OAuth 2.0

Across the first three parts of this series, we have deconstructed OAuth 2.0 from foundational theory to low-level cryptographic execution:

1. **Part 1: The Core Architecture.** We separated authorization from authentication, established the five system roles, explored front versus back communication channels, and tracked why insecure legacy flows like Implicit were discarded.
2. **Part 2: Flow Dynamics.** We traced how the Authorization Code Grant with PKCE adapts to the physical constraints of server backends, native mobile binaries, browser SPAs, IoT devices, and machine daemons.
3. **Part 3: The Data Plane.** We unpacked the mechanics of bearer tokens, mapped OpenID Connect claims, weighed reference versus self-encoded tokens, configured gateway offloading with Kong, handled dynamic step-up authentication challenges with RFC 9470, moved beyond bearer with sender-constrained tokens, and analyzed distributed revocation strategies.

OAuth 2.0 is not a monolithic product; it is an extensible protocol framework. By structuring authorization around zero-trust client profiles, rigorous channel separation, and asymmetric cryptography, it provides the backbone for modern distributed system security.

In **[Part 4](/posts/how-it-works/oauth-4-advanced-security)**, we harden every message in the flow for high-assurance environments: PAR, issuer identification, `private_key_jwt`, DPoP and mTLS sender constraints, and message signing as profiled by FAPI 2.0.

## References and Further Reading

- [RFC 6749: The OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749)
- [RFC 6750: Bearer Token Usage](https://datatracker.ietf.org/doc/html/rfc6750)
- [RFC 7517: JSON Web Key (JWK)](https://datatracker.ietf.org/doc/html/rfc7517)
- [RFC 7519: JSON Web Token (JWT)](https://datatracker.ietf.org/doc/html/rfc7519)
- [RFC 7636: Proof Key for Code Exchange by OAuth Public Clients (PKCE)](https://datatracker.ietf.org/doc/html/rfc7636)
- [RFC 7662: OAuth 2.0 Token Introspection](https://datatracker.ietf.org/doc/html/rfc7662)
- [RFC 7009: OAuth 2.0 Token Revocation](https://datatracker.ietf.org/doc/html/rfc7009)
- [RFC 8252: OAuth 2.0 for Native Apps](https://datatracker.ietf.org/doc/html/rfc8252)
- [RFC 8414: OAuth 2.0 Authorization Server Metadata](https://datatracker.ietf.org/doc/html/rfc8414)
- [RFC 8628: OAuth 2.0 Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628)
- [RFC 8705: OAuth 2.0 Mutual-TLS Client Authentication and Certificate-Bound Access Tokens](https://datatracker.ietf.org/doc/html/rfc8705)
- [RFC 9068: JSON Web Token (JWT) Profile for OAuth 2.0 Access Tokens](https://datatracker.ietf.org/doc/html/rfc9068)
- [RFC 9126: OAuth 2.0 Pushed Authorization Requests](https://datatracker.ietf.org/doc/html/rfc9126)
- [RFC 9207: OAuth 2.0 Authorization Server Issuer Identification](https://datatracker.ietf.org/doc/html/rfc9207)
- [RFC 9449: OAuth 2.0 Demonstrating Proof of Possession (DPoP)](https://datatracker.ietf.org/doc/html/rfc9449)
- [RFC 9470: OAuth 2.0 Step Up Authentication Challenge Protocol](https://datatracker.ietf.org/doc/html/rfc9470)
- [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://datatracker.ietf.org/doc/html/rfc9700)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [OAuth 2.0 for Browser-Based Applications (Draft)](https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/)
- [OAuth 2.1 Framework (Draft)](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/)
