# Policy: Network Exposure

Workloads handling `confidential` or `restricted` data must not be reachable
from the public internet without an approved ingress path.

- Public load balancers must front a WAF.
- Security groups may not allow `0.0.0.0/0` on ports other than 80/443.
- Database resources may never have `publicly_accessible = true`.
- Cross-account access requires an external ID and an exception ticket.

Violations: file an exception via `tool_registry(invoke, exception_tool, …)`
including a justification and a duration.
