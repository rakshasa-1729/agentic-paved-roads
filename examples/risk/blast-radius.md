# Risk Context: Blast Radius

When evaluating a change, score blast radius along these axes:

- **Environment**: `prod` (1.0) > `staging` (0.5) > `dev` (0.2) > `sandbox` (0.1).
- **Account scope**: shared infra account > app account > sandbox account.
- **Tenancy**: multi-tenant data plane > single-tenant > internal-only.
- **Reachability**: internet-facing > VPN-only > private subnet > air-gapped.

Use this to weight whether a change should be auto-approved, queued for human
review, or hard-blocked. See `examples/risk/exception-thresholds.md`.
