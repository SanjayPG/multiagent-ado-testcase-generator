# High Level Design — User Authentication System

## 1. Overview

This document describes the high-level design of the User Authentication module.
It covers the login flow, system components, API contracts, session management, and security constraints.
This HLD is the reference document for generating test cases against login-related PBIs.

---

## 2. System Components

```
Browser (React SPA)
    ↓ HTTPS POST
API Gateway (Kong)
    ↓ routes /api/v1/auth/*
Auth Service (Node.js / Express)
    ↓ queries
User DB (PostgreSQL)
    ↓ stores sessions
Redis (Session Store)
```

### Component responsibilities

| Component | Responsibility |
|---|---|
| React SPA | Login form rendering, client-side email format validation, masked password input, redirect on success |
| API Gateway | Rate limiting (10 req/min per IP), TLS termination, route forwarding |
| Auth Service | Credential validation, session creation, JWT issuance, error response formatting |
| PostgreSQL | Stores user records: id, email, password_hash (bcrypt, cost=12), account_status, failed_attempt_count, locked_until |
| Redis | Stores active sessions: key = session_id, value = {user_id, created_at, last_active_at}, TTL = 1800s |

---

## 3. Login API Contract

### Endpoint
```
POST /api/v1/auth/login
Content-Type: application/json
```

### Request body
```json
{
  "email": "user@example.com",
  "password": "PlainTextPassword1!"
}
```

### Success response — HTTP 200
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 1800,
  "redirect_url": "/dashboard"
}
```

### Failure response — HTTP 401 (invalid credentials)
```json
{
  "error": "invalid_credentials",
  "message": "The email or password you entered is incorrect."
}
```
> Note: The message is intentionally generic — it must NOT reveal whether the email exists or the password was wrong.

### Validation failure — HTTP 422 (malformed request)
```json
{
  "error": "validation_failed",
  "fields": {
    "email": "Invalid email format"
  }
}
```

### Rate limit exceeded — HTTP 429
```json
{
  "error": "too_many_requests",
  "retry_after": 60
}
```

---

## 4. Authentication Flow

```
User submits form
    → Client validates email format (regex: RFC 5322)
    → If invalid: show inline error, block submission
    → If valid: POST /api/v1/auth/login

API Gateway receives request
    → Check rate limit (10 req/min per IP via Redis counter)
    → If exceeded: return 429
    → Forward to Auth Service

Auth Service receives request
    → Validate request body schema
    → Query PostgreSQL: SELECT * FROM users WHERE email = $1
    → If user not found: return 401 (generic message)
    → If account locked (locked_until > NOW()): return 401 (generic message)
    → bcrypt.compare(password, user.password_hash)
    → If mismatch: increment failed_attempt_count, return 401
    → If failed_attempt_count >= 5: set locked_until = NOW() + 15min, return 401
    → On success: reset failed_attempt_count = 0
    → Generate JWT (HS256, secret from env SECRET_KEY, exp = now + 1800s)
    → Create session in Redis: SET session:{uuid} {user_id, now} EX 1800
    → Return 200 with token + redirect_url

Browser receives 200
    → Store JWT in httpOnly cookie (NOT localStorage)
    → Redirect to /dashboard
```

---

## 5. Session Management

| Property | Value |
|---|---|
| Session store | Redis |
| Session TTL | 1800 seconds (30 minutes) |
| Inactivity reset | Each authenticated API call resets TTL via EXPIRE session:{id} 1800 |
| Expiry behaviour | On TTL expiry, Redis auto-deletes the key. Next request returns 401. Client redirects to /login. |
| Cookie flags | HttpOnly, Secure, SameSite=Strict |
| Token storage | httpOnly cookie only — never exposed to JavaScript |

---

## 6. Security Constraints

| Constraint | Implementation |
|---|---|
| Password masking | HTML input type=password — browser handles masking |
| Generic error messages | Auth Service never distinguishes email not found vs wrong password in responses |
| bcrypt cost factor | 12 (approx 300ms hash time — balances security vs UX) |
| Account lockout | 5 failed attempts locked for 15 minutes |
| Rate limiting | 10 login attempts per IP per minute at API Gateway |
| HTTPS only | API Gateway enforces TLS; HTTP requests redirected to HTTPS |
| CSRF protection | SameSite=Strict cookie + CSRF token header required on login endpoint |

---

## 7. Performance SLAs

| Metric | Target |
|---|---|
| P95 login response time | < 800ms (includes bcrypt hash ~300ms) |
| P99 login response time | < 1500ms |
| Throughput | 200 concurrent login requests without degradation |
| Error rate under load | < 0.5% |
| Redis session write latency | < 10ms P95 |

---

## 8. Database Schema (relevant fields)

```sql
CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               VARCHAR(254) UNIQUE NOT NULL,
  password_hash       VARCHAR(60) NOT NULL,
  account_status      VARCHAR(20) DEFAULT 'active',
  failed_attempt_count INT DEFAULT 0,
  locked_until        TIMESTAMP,
  created_at          TIMESTAMP DEFAULT NOW(),
  last_login_at       TIMESTAMP
);
```

Field constraints relevant for test cases:
- email: max 254 characters (RFC 5321), must match regex before DB query
- password: no max enforced at DB level — enforced at API layer (max 128 chars)
- account_status: only active accounts can authenticate

---

## 9. Integration Points

| System | Integration type | Used for |
|---|---|---|
| Redis | TCP, ioredis client | Session storage + rate limit counters |
| PostgreSQL | TCP, pg client (connection pool, max 20) | User lookup |
| API Gateway (Kong) | Reverse proxy | Rate limiting, TLS, routing |
| Frontend (React) | REST over HTTPS | Login form to API call to redirect |

---

## 10. Known Edge Cases for Testing

- Email at exactly 254 character maximum length
- Password at exactly 128 character maximum length
- Simultaneous login from same account on two browsers
- Login attempt immediately after lockout expiry (locked_until = NOW())
- Redis session TTL boundary: request at 1799s vs 1801s
- Account with account_status = suspended (distinct from locked — no unlock timer)
- Email with valid format but non-existent domain (e.g. user@notarealdomain12345.com)
- Special characters in password: !@#$%^&*()<>?/\|{}~
- SQL injection attempt in email field: admin'--
- XSS payload in email field: <script>alert(1)</script>@test.com
