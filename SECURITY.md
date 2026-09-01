# Security Policy

SVB is designed so a malformed or hostile file is rejected cleanly — never crash, hang, or emit broken output. If you find a way past that contract, we want to hear about it.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | ✅        |
| 0.1.x   | ❌ — upgrade; the format itself is unchanged, hardening only |

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security tab → Report a vulnerability) rather than a public issue.

Include, if you can:

- The minimal `.svg` or `.svb` file that triggers the behavior.
- The command (CLI/API/browser) and what happened — crash, hang, OOM, malformed output.
- Your Node version.

You do not need to check whether the bug is new or already known — report it anyway. Known hardening history (EOF guards, declared-count bounds, decompression cap, expansion budget) is documented in [SPEC §12](SPEC.md#12-security) and [DESIGN.md](DESIGN.md); duplicates just get closed with a pointer.

## Scope

- **In scope**: the reference encoder, decoder, validator, and CLI in `src/`; the demo Service Worker.
- **By design, not a vulnerability**: the format carries no executable constructs and cannot carry scripts, event handlers, CSS, or `foreignObject` — that is the point of the format, see [SPEC §1](SPEC.md).
- **Known limits**: the reference implementation is JavaScript (memory-safe runtime); DoS-style findings are still valid reports and welcome.

## Bug bounty

None — this is a small open-source project. Credit in the release notes and the changelog is what we can offer, and it is given gladly.
