# Security Policy

Honeycrisp runs on your own Mac with Full Disk Access and Automation rights and
drives your real mail, calendar, notes, and messages. The code is the trust
boundary — there is no App Store review or OS sandbox behind it. Security
reports are taken seriously.

## Reporting a vulnerability

Please report privately via **GitHub Security Advisories**
(the "Report a vulnerability" button under the repository's Security tab) rather
than a public issue. Include steps to reproduce and the affected package/version.

## Threat model

The design intent and the highest-risk surfaces are documented in
[`docs/07_security_review.md`](docs/07_security_review.md) — a guide for
reviewers, not a guarantee. The core promise under review: even a
prompt-injected model or a stolen remote token cannot cause an unapproved
consequential action.

## Scope

In scope: approval-gate bypass, script injection, remote-gateway auth/scope
escape, prompt-injection escaping the fence, undeclared network egress, secret
leakage. Out of scope: an attacker who already has filesystem or root access to
the machine (they own the Mac).
