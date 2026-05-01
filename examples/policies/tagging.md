# Policy: Required Resource Tags

All cloud resources must carry the following tags:

| Tag         | Required | Notes                                     |
|-------------|----------|-------------------------------------------|
| `owner`     | yes      | Team email or service account.            |
| `cost_center` | yes    | Finance code, e.g. `cc-1234`.             |
| `env`       | yes      | One of `prod`, `staging`, `dev`, `sandbox`. |
| `data_class`| yes      | One of `public`, `internal`, `confidential`, `restricted`. |
| `expires_at`| if `env=sandbox` | RFC3339 timestamp. Sandbox resources expire. |

## Rationale
Tagging drives cost allocation, ownership routing for incidents, and automatic
cleanup of sandbox resources. Untagged resources break all three.

## Enforcement
Enforced via `examples/policies/tagging.rego` (run with conftest).
