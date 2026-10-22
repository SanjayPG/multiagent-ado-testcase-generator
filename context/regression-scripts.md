# Regression Scripts Reference

## Instructions
Replace this file with your existing regression test names and brief descriptions.
The coordinator uses this to tag generated TCs that overlap with existing regression coverage.

## Format (one test per line or section)
```
test_login_with_valid_credentials — verifies successful login flow
test_login_invalid_password_returns_401 — verifies 401 on wrong password
test_session_expires_after_timeout — verifies session expiry logic
```

Or paste your existing test class/method names as-is.
Coordinator will map them to generated TCs and add "regression" tag automatically.
